/* =========================================================
   Reader for /entry and /contents (see pageShell in lib/render.js).

   1. Pagination. The entry flow (server-rendered into
      <template id="book-source">) is cut into fixed-size .page sheets.
      Every page's .body is a two-column, `column-fill: auto` box
      exactly as tall as the room left on that page, so the browser's
      own multi-column layout makes every line, orphan/widow and
      break-inside decision — and whatever it pushes past the second
      column IS the next page. Column breaks and page breaks are one
      mechanism; this script only finds where the third column starts
      and cuts the DOM there (Range.extractContents clones the elements
      the cut passes through, so a split paragraph or list simply
      continues on the next page).

   2. Viewing. Finished pages are grouped into spreads of one or two
      pages, each scaled as a unit to fit the screen, one spread on
      screen at a time. Pages turn with a paper fold that follows the
      trackpad or finger (keys play it through). Pages are always measured at their
      real, unscaled size in an offscreen staging box first, so nothing
      about the screen ever changes what's on a page.
   ========================================================= */

(() => {
  "use strict";

  const source = document.getElementById("book-source");
  const book = document.getElementById("book");
  if (!source || !book) return;

  const root = document.documentElement;
  const tocDialog = document.getElementById("toc-dialog");
  // /contents lists entries oldest-first but opens on the newest one's
  // first page (see renderContentsPage in server.js).
  const latestSlug = document.querySelector(".entry-page")?.dataset.latestSlug || "";

  const range = document.createRange();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const indexOf = node => Array.prototype.indexOf.call(node.parentNode.childNodes, node);

  // =========================================================
  // Pagination
  // =========================================================

  // A block with one of these break-after values stays on the same page
  // as whatever follows it (titles, teasers — see book.css).
  const KEEP_WITH_NEXT = new Set(["avoid", "avoid-page"]);
  // Titles, teasers and lifted //span figures (break-after: avoid-page in
  // book.css) — named here too, since Firefox doesn't know avoid-page and
  // reports "auto".
  const KEEPS_WITH_NEXT = ".title, .teaser-slot, .span-placed";

  function keepsWithNext(el) {
    return el.matches(KEEPS_WITH_NEXT) || KEEP_WITH_NEXT.has(getComputedStyle(el).breakAfter);
  }

  // Leaves that can't be cut into: the page break goes before them.
  const ATOMIC = "img, svg, video, iframe, hr, .references-spacer, math";

  // Image srcs that failed to load — drawn as placeholders from then on.
  const failedImages = new Set();

  function isOutOfFlow(el) {
    const { position, display } = getComputedStyle(el);
    return position === "absolute" || position === "fixed" || display === "none";
  }

  // Column boxes are what get cut into pages. A one-column layout (phone,
  // tablet spread) is still one: a column-width wider than the box
  // gives a single column, and — unlike column-count: 1, which WebKit
  // lays out as a plain block — still pushes overflow sideways.
  function isColumns(el) {
    const style = getComputedStyle(el);
    return parseInt(style.columnCount, 10) > 1 || style.columnWidth !== "auto";
  }

  function isBlank(el) {
    return !el.firstElementChild && !el.textContent.trim();
  }

  function newPage() {
    const page = document.createElement("section");
    page.className = "page";
    const area = document.createElement("div");
    area.className = "page-area";
    page.appendChild(area);
    return page;
  }

  function imagePlaceholder(img) {
    const placeholder = document.createElement("div");
    placeholder.className = "image-placeholder";
    placeholder.textContent = img.alt || "image unavailable";
    return placeholder;
  }

  // Pagination needs every image's height. Managed PNGs carry their
  // real width/height from the server (see addManagedImageSizes); for
  // the rest, wait until the browser has read enough of the file to
  // know its natural size — not for the whole download.
  async function waitForImageSizes(container, timeout = 8000) {
    const pending = Array.from(container.querySelectorAll("img"))
      .filter(img => !(img.getAttribute("width") && img.getAttribute("height")));
    const deadline = performance.now() + timeout;
    while (pending.some(img => !img.naturalWidth && !img.complete) && performance.now() < deadline) {
      await sleep(50);
    }
  }

  // Adobe's kit (the Chinese serif, see pageShell) subsets its font to
  // the text on the page when it starts, then fetches glyphs for text
  // added later. Letting it start before any entry text is in the page
  // keeps that first fetch small (base glyphs, well under a second);
  // the entry's own glyphs can take Adobe many seconds, and trigger a
  // re-cut when they land (see start()). The kit drops .wf-loading from
  // <html> once it's done, or its loader gives up after 3s.
  async function waitForAdobeKit(timeout = 3000) {
    const deadline = performance.now() + timeout;
    while (root.classList.contains("wf-loading") && performance.now() < deadline) await sleep(50);
  }

  // A display equation wider than its column is set smaller until it
  // fits. (Not a sideways-scrolling box: Safari misplaces scroll boxes in
  // multi-column text.)
  function fitDisplayMath(container) {
    for (const display of container.querySelectorAll(".math-block")) {
      display.style.fontSize = "";
      const math = display.querySelector("math");
      if (!math) continue;
      for (let i = 0; i < 4; i++) {
        const width = Math.max(math.getBoundingClientRect().width, math.scrollWidth, display.scrollWidth);
        const ratio = width / Math.max(1, display.clientWidth);
        if (ratio <= 1.001) break;
        const current = parseFloat(display.style.fontSize) || 100;
        display.style.fontSize = (current / ratio) * 0.99 + "%";
      }
    }
  }

  // Tables' column widths (static/table-fit.js), fitted before anything
  // is measured for cutting — so the page cut, the screen and printing
  // all use the same widths — at the width each will be shown at: its
  // column, or (a //span table) the full text width. Remembered per
  // width and table, so re-cutting doesn't search again.
  const tableFits = new Map();

  function fitTables(area) {
    const fit = window.md2bookTableFit;
    const tables = area.querySelectorAll(".body figure.md-table > table");
    if (!fit || !tables.length) return;
    // Hidden copies are laid out here: a .body of its own, so they're
    // styled like the real thing, but without columns.
    const host = document.createElement("div");
    host.className = "body";
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;columns:auto;column-count:auto;column-width:auto;height:auto;";
    area.appendChild(host);
    for (const table of tables) {
      const figure = table.parentElement;
      const width = Math.floor(figure.classList.contains("span-table") ? area.clientWidth : columnsOf(figure.closest(".body")).width);
      const key = width + "\u0000" + table.innerHTML;
      if (!tableFits.has(key)) {
        host.style.width = width + "px";
        let fitted = null;
        try {
          if (fit.fitTable(table, width, host)) fitted = table.querySelector(":scope > colgroup").outerHTML;
        } catch { /* the browser's own widths stay */ }
        tableFits.set(key, fitted);
        continue;
      }
      const fitted = tableFits.get(key);
      if (fitted) {
        table.insertAdjacentHTML("afterbegin", fitted);
        table.classList.add("table--fitted");
      }
    }
    host.remove();
  }

  // Justified text (layout rows with `justify`) is set by Justif
  // (https://github.com/lyallcooper/justif, MIT): it breaks each
  // paragraph's lines as a whole, TeX-style, and writes them out as
  // plain spans with fixed spacing. It runs once the flow is laid out at
  // its real column width, before anything is measured for cutting;
  // those spans are then kept as they are (the controller lets go of
  // them), so cutting pages and moving paragraphs around can't make it
  // set them again. A paragraph it declines keeps the browser's own
  // justification.
  let justifModules = null;
  // Justif sits next to static/ (/vendor/justif on the server), found
  // from this script's own address so it loads wherever md2book is served.
  const JUSTIF_BASE = new URL("../vendor/justif/", document.currentScript ? document.currentScript.src : location.href);

  async function justifyText(area) {
    let justify, hyphenateEnUS;
    try {
      justifModules ||= Promise.all([import(new URL("index.js", JUSTIF_BASE).href), import(new URL("hyphenate/en-us.js", JUSTIF_BASE).href)]);
      [{ justify }, { hyphenateEnUS }] = await justifModules;
    } catch {
      justifModules = null;
      return;
    }
    const controller = justify(area.querySelectorAll(".body p, .body li:not(.references li)"), {
      hyphenate: hyphenateEnUS,
      observeResize: false,
      cleanClipboard: false
    });
    await Promise.race([controller.ready, sleep(3000)]);
    const set = controller.managed.map(el => [el, el.cloneNode(true)]);
    controller.destroy();
    for (const [el, copy] of set) el.replaceWith(copy);
  }

  // Fills `area` with a fresh copy of the flow and readies it for
  // measuring. Returns the running bylines it set aside (article →
  // byline), which go in their entry's first page foot, not the flow.
  async function prepareFlow(area) {
    await waitForAdobeKit();

    const flow = document.importNode(source.content, true);
    for (const img of flow.querySelectorAll("img")) {
      if (failedImages.has(img.getAttribute("src"))) img.replaceWith(imagePlaceholder(img));
      // Every page's images are needed up front; lazy ones in hidden
      // or offscreen boxes never even start loading on iOS.
      else img.loading = "eager";
    }
    // Phone and tablet pages keep a margin for side comments only when
    // there are any (see book.css).
    root.classList.toggle("has-notes", !!flow.querySelector(".comment-marker"));
    area.appendChild(flow);

    // Laying the text out makes it request the web font faces it uses;
    // they change text metrics, so wait for them too.
    void area.offsetHeight;
    await Promise.all([
      waitForImageSizes(area),
      Promise.race([document.fonts.ready, sleep(3000)])
    ]);

    // An image whose size still isn't known is laid out without it; its
    // pages are cut again once it's known (see watchImages).
    for (const img of area.querySelectorAll("img")) {
      if (!img.naturalWidth && !(img.getAttribute("width") && img.getAttribute("height"))) img.dataset.unsized = "";
    }

    fitDisplayMath(area);
    fitTables(area);
    if (root.classList.contains("justify")) await justifyText(area);

    for (const img of area.querySelectorAll("img")) {
      if (img.complete && !img.naturalWidth) {
        failedImages.add(img.getAttribute("src"));
        img.replaceWith(imagePlaceholder(img));
      }
    }

    const running = new Map();
    for (const byline of area.querySelectorAll(".byline-footer--running")) {
      running.set(byline.closest("article"), byline);
      byline.remove();
    }

    // Pinned References sit absolutely at the bottom-right of the page
    // their entry ends on, so reserve their height in the flow right
    // where they are (see renderEntryBody in server.js for where that
    // is): if the spacer doesn't fit after the entry's last line, the
    // References go on a page of their own.
    for (const refs of area.querySelectorAll(".references:not(.references--inline)")) {
      const spacer = document.createElement("div");
      spacer.className = "references-spacer";
      spacer.setAttribute("aria-hidden", "true");
      // Rounded up: a fraction short, and they'd overlap the last line.
      spacer.style.height = Math.ceil(refs.getBoundingClientRect().height) + "px";
      refs.before(spacer);
    }

    return running;
  }

  function rectsOf(node) {
    let rects;
    if (node.nodeType === Node.TEXT_NODE) {
      range.selectNodeContents(node);
      rects = range.getClientRects();
    } else {
      rects = node.getClientRects();
    }
    return Array.from(rects).filter(r => r.width || r.height);
  }

  // In-flow leaves of `node` in document order: non-blank text and
  // atomic elements. Margin notes and pinned References (absolutely
  // positioned) take no room, so they're skipped.
  function collectLeaves(node, out) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.data.trim()) out.push(child);
      } else if (child.nodeType === Node.ELEMENT_NODE && !isOutOfFlow(child)) {
        if (child.matches(ATOMIC)) out.push(child);
        else collectLeaves(child, out);
      }
    }
    return out;
  }

  // First character of `text` the browser laid out at or past `limit`.
  // Collapsed whitespace has no box; it counts as wherever the next
  // visible character is. A character that starts a wrapped line can
  // also report an empty box at the end of the line before (WebKit) —
  // only its own, non-empty box counts.
  function firstOffsetPast(text, limit) {
    const past = i => {
      for (let j = i; j < text.length; j++) {
        range.setStart(text, j);
        range.setEnd(text, j + 1);
        const rects = Array.from(range.getClientRects()).filter(r => r.width > 0);
        if (rects.length) return rects[rects.length - 1].left >= limit;
      }
      return true;
    };
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (past(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // Lays a multi-column block out `height` tall, filling column after
  // column, and finds the first point the browser put past its last
  // column (or, when little room is left, hanging below it). Returns
  // { point, atStart } — atStart meaning nothing of it fits — or null
  // if it all fits.
  // Column geometry of a laid-out multi-column block.
  function columnsOf(block) {
    const box = block.getBoundingClientRect();
    const style = getComputedStyle(block);
    const gap = parseFloat(style.columnGap) || 0;
    const count = parseInt(style.columnCount, 10) ||
      Math.max(1, Math.floor((box.width + gap) / (parseFloat(style.columnWidth) + gap)));
    const width = (box.width - gap * (count - 1)) / count;
    return { box, gap, count, width, of: x => Math.floor((x - box.left + gap / 2) / (width + gap)) };
  }

  const HEADINGS = ":scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6";

  // A heading keeps at least this many lines of its own text under it in
  // its column (or all of it, if its section is shorter).
  const MIN_LINES_AFTER_HEADING = 3;

  // How many lines of text follow heading `h` in its column `col` before
  // the content continues in a later column (or past the page). Headings
  // right after it don't count as its text; a figure, table or other
  // block without text lines counts as enough.
  function linesAfterHeading(h, cols, col) {
    const tops = new Set();
    const r = document.createRange();
    for (let el = h.nextElementSibling; el; el = el.nextElementSibling) {
      if (isOutOfFlow(el) || !el.getClientRects().length) continue;
      const heading = /^H[2-6]$/.test(el.tagName);
      r.selectNodeContents(el);
      const rects = Array.from(r.getClientRects()).filter(rect => rect.width && rect.height);
      if (!rects.length) {
        const box = el.getBoundingClientRect();
        if (cols.of(box.left) > col) return { lines: tops.size, continues: true };
        return { lines: Infinity, continues: false };
      }
      for (const rect of rects) {
        if (cols.of(rect.left) > col) return { lines: tops.size, continues: true };
        if (!heading) tops.add(Math.round(rect.top / 3));
      }
      if (!heading && tops.size >= MIN_LINES_AFTER_HEADING) break;
    }
    return { lines: tops.size, continues: false };
  }

  // How many lines of text multi-column `block` has before `point`, in
  // all its columns. Boxes on one line (bold, a raised footnote number)
  // start within half a line of each other.
  function linesBefore(block, point) {
    const cols = columnsOf(block);
    const half = (parseFloat(getComputedStyle(block).lineHeight) || 14) / 2;
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(point.node, point.offset);
    const tops = new Map();
    for (const rect of r.getClientRects()) {
      if (!rect.width || rect.height < 5) continue;
      const col = cols.of(rect.left);
      if (!tops.has(col)) tops.set(col, []);
      tops.get(col).push(rect.top);
    }
    let lines = 0;
    for (const list of tops.values()) {
      list.sort((a, b) => a - b);
      let last = -Infinity;
      for (const top of list) {
        if (top - last > half) {
          lines++;
          last = top;
        }
      }
    }
    return lines;
  }

  // What moves when a whole table moves over: its figure, when the table
  // opens it (a continued part moves on its own).
  function tableBox(row) {
    const table = row.closest("table");
    const figure = table.parentElement;
    return figure.matches("figure.md-table") && figure.firstElementChild === table ? figure : table;
  }

  // Where a table row's content was laid out, in document order — its
  // text lines (WebKit reports a split row itself as one box).
  function rowRects(tr) {
    const r = document.createRange();
    r.selectNodeContents(tr);
    return Array.from(r.getClientRects()).filter(rect => rect.width && rect.height);
  }

  // A table row that would straddle two columns: the table is split
  // there instead — the rest becomes its own table, header repeated,
  // starting the next column. (Rows can't take a forced break in WebKit;
  // a table can.)
  function splitTableAt(row) {
    const table = row.closest("table");
    const rest = table.cloneNode(false);
    rest.setAttribute("data-row-split", "");
    const colgroup = table.querySelector(":scope > colgroup");
    if (colgroup) rest.appendChild(colgroup.cloneNode(true));
    if (table.tHead) rest.appendChild(table.tHead.cloneNode(true));
    const body = document.createElement("tbody");
    for (let r = row; r; ) {
      const next = r.nextElementSibling;
      body.appendChild(r);
      r = next;
    }
    rest.appendChild(body);
    table.after(rest);
    setColumnBreak(rest, true);
  }

  // Undoes splitTableAt, so each layout decides afresh.
  function joinSplitTables(block) {
    for (const part of Array.from(block.querySelectorAll("table[data-row-split]")).reverse()) {
      const prev = part.previousElementSibling;
      if (!prev || prev.tagName !== "TABLE" || !prev.tBodies[0]) {
        part.removeAttribute("data-row-split");
        setColumnBreak(part, false);
        continue;
      }
      prev.tBodies[0].append(...part.tBodies[0].rows);
      part.remove();
    }
  }

  function setColumnBreak(el, on) {
    el.style.breakBefore = on ? "column" : "";
    el.style.setProperty("-webkit-column-break-before", on ? "always" : "");
  }

  // No heading may end a column (or a page) with its text starting in
  // the next one, and no table row may straddle two columns: CSS asks
  // for both (break-after: avoid-column, break-inside: avoid), but WebKit
  // ignores them in multi-column boxes. Each offender gets a forced
  // column break before it, so it moves over whole / with its text —
  // repeated, since moving one can orphan the heading above it.
  function keepHeadingsWithText(block) {
    for (const el of block.querySelectorAll(HEADINGS)) setColumnBreak(el, false);
    joinSplitTables(block);
    for (const el of block.querySelectorAll("table, figure.md-table")) setColumnBreak(el, false);
    for (let pass = 0; pass < 12; pass++) {
      relayoutColumns(block);
      const cols = columnsOf(block);
      const splitRow = Array.from(block.querySelectorAll("tbody tr")).find(tr => {
        const rects = rowRects(tr);
        if (!rects.length) return false;
        const prev = tr.previousElementSibling;
        // A row that starts a new column (the table runs on there):
        // split, so the rest repeats the header.
        if (prev) {
          const before = rowRects(prev);
          if (before.length && cols.of(rects[0].left) > cols.of(before[before.length - 1].left)) return true;
        }
        if (rects.length < 2 || cols.of(rects[rects.length - 1].left) <= cols.of(rects[0].left)) return false;
        if (prev) return true;
        // The first row: the whole table moves over — unless it already
        // starts a column.
        const mover = tableBox(tr);
        return mover.style.breakBefore !== "column" &&
          mover.getBoundingClientRect().top - cols.box.top > 2;
      });
      if (splitRow) {
        if (splitRow.previousElementSibling) splitTableAt(splitRow);
        else setColumnBreak(tableBox(splitRow), true);
        continue;
      }
      const orphan = Array.from(block.querySelectorAll(HEADINGS)).reverse().find(h => {
        if (h.style.breakBefore === "column" || !h.previousElementSibling) return false;
        // One right after another heading moves with it: only a run's
        // first heading is ever moved (its text is counted past the
        // run). WebKit can still report the next one where it was, and
        // moving it too would strand the first.
        if (/^H[2-6]$/.test(h.previousElementSibling.tagName)) return false;
        const own = rectsOf(h);
        if (!own.length) return false;
        // Already at the top of its column: moving it gains nothing.
        if (own[0].top - cols.box.top < 2) return false;
        const after = linesAfterHeading(h, cols, cols.of(own[own.length - 1].left));
        return after.continues && after.lines < MIN_LINES_AFTER_HEADING;
      });
      if (!orphan) return;
      setColumnBreak(orphan, true);
    }
  }

  function findColumnBreak(block, height) {
    height = Math.max(0, height);
    block.style.columnFill = "auto";
    block.style.height = height + "px";
    keepHeadingsWithText(block);

    const { box, count, width, gap } = columnsOf(block);
    const limit = box.left + count * (width + gap) - gap / 2;
    const floor = box.top + height + 1;

    const items = laidOutLeaves(block);
    const lo = firstLeafPast(items, limit);

    for (let i = 0; i < lo; i++) {
      if (items[i].rects.some(r => r.bottom > floor)) {
        return { point: { node: items[i].node.parentNode, offset: indexOf(items[i].node) }, atStart: i === 0 };
      }
    }
    if (lo === items.length) return null;
    return { point: pointPast(items[lo], limit), atStart: lo === 0 };
  }

  // A block's in-flow leaves with where each was laid out.
  function laidOutLeaves(block) {
    const items = [];
    for (const node of collectLeaves(block, [])) {
      const rects = rectsOf(node);
      if (rects.length) items.push({ node, rects });
    }
    return items;
  }

  // Columns fill in document order, so "reaches past x = `limit`" is
  // false up to some leaf and true from there on: that leaf's index.
  function firstLeafPast(items, limit) {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const rects = items[mid].rects;
      if (rects[rects.length - 1].left >= limit) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // Where leaf `item`, the first to reach past `limit`, crosses it.
  function pointPast({ node, rects }, limit) {
    if (node.nodeType === Node.TEXT_NODE && rects[0].left < limit) {
      return { node, offset: firstOffsetPast(node, limit) };
    }
    return { node: node.parentNode, offset: indexOf(node) };
  }

  // How a page's share of a .body is shown: filled column by column down
  // to the page foot (`column-fill: auto`, normal entries) or balanced
  // (`column-fill: balance`, zine) — and balanced whenever a full-width
  // byline/References row follows it on the page, the way a column-
  // spanning element would.
  // `settled`: the page is cut, and its layout (split tables, forced
  // breaks) must stay the one the cut was measured on.
  function styleColumns(block, space, balance, room = space, settled = false) {
    block.style.height = "";
    block.style.columnFill = balance ? "balance" : "";
    const balanced = getComputedStyle(block).columnFill === "balance";
    if (!balanced) block.style.height = space + "px";
    if (settled) {
      relayoutColumns(block);
      return;
    }
    keepHeadingsWithText(block);
    // Balanced columns grow to fit a forced break; if that would run
    // past the page, keep the unforced layout instead.
    if (balanced && block.getBoundingClientRect().height > room + 1) {
      for (const el of block.querySelectorAll(HEADINGS)) setColumnBreak(el, false);
      joinSplitTables(block);
      relayoutColumns(block);
    }
  }

  // WebKit keeps a multi-column box's old column layout after its
  // height or column-fill changes (e.g. it stays cut to a fixed height
  // after going back to balanced), so every measurement after such a
  // change would read stale positions. Taking the box out of layout
  // for a moment makes every engine lay its columns out afresh.
  function relayoutColumns(block) {
    block.style.display = "none";
    void block.offsetHeight;
    block.style.display = "";
  }

  // Fits a multi-column block into the room left above `bottom`,
  // together with `tail` — the blocks after it that must share its
  // last page (byline, References). Returns null if it all fits, or
  // where to cut.
  function fitColumns(block, bottom, tail) {
    const blockBottom = block.getBoundingClientRect().bottom;
    const space = Math.max(0, bottom - block.getBoundingClientRect().top);
    const tailHeight = tail.length ? tail[tail.length - 1].getBoundingClientRect().bottom - blockBottom : 0;

    let height = space - tailHeight;
    let cut = findColumnBreak(block, height);
    if (cut && tailHeight) {
      // It runs on past this page anyway, so its tail won't be here:
      // use the full height.
      const full = findColumnBreak(block, space);
      if (full) {
        cut = full;
        height = space;
      } else {
        // Everything but the tail fits: move on only as few of the last
        // lines as it takes to keep the tail with them — the tallest
        // height that still leaves something over.
        let lo = space - tailHeight;
        let hi = space;
        while (hi - lo > 2) {
          const mid = (lo + hi) / 2;
          const midCut = findColumnBreak(block, mid);
          if (midCut) {
            cut = midCut;
            lo = mid;
            height = mid;
          } else {
            hi = mid;
          }
        }
      }
    }
    // Measure the chosen cut last, so the layout it points into is the
    // one that stays.
    if (cut) cut = findColumnBreak(block, height);
    styleColumns(block, space, !cut && tail.length > 0, space - tailHeight, !!cut);
    return cut;
  }

  // Cuts the page at `point`: everything from there to the end of
  // `area` moves into a fragment for the next page. Returns that
  // fragment's elements.
  function split(area, point) {
    const chain = [];
    for (let n = point.node; n !== area; n = n.parentNode) {
      if (n.nodeType === Node.ELEMENT_NODE) chain.push(n);
    }

    range.setStart(point.node, point.offset);
    range.setEnd(area, area.childNodes.length);
    const rest = range.extractContents();

    // The cut elements' clones lead the fragment, outermost first.
    const clones = [];
    let clone = rest.firstChild;
    for (let i = chain.length - 1; i >= 0; i--) {
      clones[i] = clone;
      clone = clone && clone.firstChild;
    }

    // Innermost first: an element the cut left empty on this page just
    // goes (its clone starts fresh on the next); otherwise its clone is
    // a continuation — no second drop cap, no second list marker for a
    // split item, and a split <ol> keeps counting.
    let innerKept = false;
    // Only the innermost block cut through runs on mid-line (a list
    // around it doesn't; its other items end as usual).
    let runsOnMarked = !(point.node.nodeType === Node.TEXT_NODE || (chain[0] && /^inline/.test(getComputedStyle(chain[0]).display)));
    for (let i = 0; i < chain.length; i++) {
      const orig = chain[i];
      const copy = clones[i];
      if (isBlank(orig)) {
        // A block cut at its very start: it all goes on, nothing runs on
        // mid-line here.
        if (!/^inline/.test(getComputedStyle(orig).display)) runsOnMarked = true;
        orig.remove();
        innerKept = false;
        continue;
      }
      copy.setAttribute("data-continued", "");
      // (A copy of one marked by an earlier cut doesn't run on itself.)
      copy.removeAttribute("data-runs-on");
      if (!runsOnMarked && /^(block|list-item)$/.test(getComputedStyle(orig).display)) {
        orig.setAttribute("data-runs-on", "");
        runsOnMarked = true;
      }
      copy.classList.remove("drop-cap");
      if (orig.tagName === "OL") {
        copy.start = orig.start + orig.querySelectorAll(":scope > li").length - (innerKept ? 1 : 0);
      }
      if (orig.tagName === "TABLE") {
        // A table running over repeats its header row; one left with
        // nothing but its header moves over whole.
        const head = orig.tHead;
        if (head && !copy.tHead) copy.prepend(head.cloneNode(true));
        // And keeps its fitted column widths (see fitTables).
        const colgroup = orig.querySelector(":scope > colgroup");
        if (colgroup && !copy.querySelector(":scope > colgroup")) copy.prepend(colgroup.cloneNode(true));
        if (!orig.querySelector("tbody tr")) {
          orig.remove();
          copy.removeAttribute("data-continued");
          copy.removeAttribute("data-runs-on");
          innerKept = false;
          continue;
        }
      }
      innerKept = true;
    }

    for (const el of rest.querySelectorAll("h2, h3, h4, h5, h6, table, figure")) setColumnBreak(el, false);
    return Array.from(rest.children);
  }

  // Breaks before blocks[i], first walking back over blocks that must
  // stay with what follows them — unless that would leave the page
  // empty, in which case they stay here after all.
  function breakBefore(area, article, blocks, i) {
    const first = article === area.firstElementChild;
    let j = i;
    while (j > 0 && keepsWithNext(blocks[j - 1])) j--;
    if (j === 0 && first) j = i;
    if (j === 0) {
      // Doesn't fit even at the top of an empty page: let it overflow.
      if (first) return [];
      return split(area, { node: area, offset: indexOf(article) });
    }
    return split(area, { node: article, offset: indexOf(blocks[j]) });
  }

  // A "//span" figure (see server.js) that lands on this page leaves the
  // columns and spans their full width: an image at the top of the
  // page's share of the text, a table above everything of its entry on
  // the page (title included). Moves the first one found on this page
  // (before `cut`, if the text runs on) and says whether it did; the
  // page is then laid out again, which may pull up the next one.
  // //span figures found not to fit on the page being filled (see
  // liftSpanFigure); started afresh with each page. `carried`: those
  // taken out of it, to start the next page's share of their entry.
  let deferredLifts = new Set();
  let carried = [];

  function liftSpanFigure(block, cut, area, bottom, tail) {
    if (cut && cut.atStart) return false;
    let limit = null;
    if (cut) {
      limit = document.createRange();
      limit.setStart(cut.point.node, cut.point.offset);
    }
    const figure = Array.from(block.querySelectorAll(":scope > figure.span-figure"))
      .find(fig => !deferredLifts.has(fig) && (!limit || limit.comparePoint(fig, 0) < 0));
    if (!figure) return false;
    const home = figure.nextSibling;
    // Its place in the text, to see whether that stays on this page.
    const mark = document.createElement("span");
    figure.before(mark);
    // A table split to fit the columns goes up whole.
    joinSplitTables(figure);
    for (const el of [figure, ...figure.querySelectorAll("table")]) setColumnBreak(el, false);
    figure.classList.add("span-placed");
    const putBack = () => {
      figure.classList.remove("span-placed");
      block.insertBefore(figure, home);
    };
    if (!figure.classList.contains("span-table")) {
      block.before(figure);
    } else {
      const article = block.parentElement;
      const placed = article.querySelectorAll(":scope > .span-table.span-placed");
      if (placed.length) placed[placed.length - 1].after(figure);
      else article.prepend(figure);
      // A table too tall to head a page stays in the columns instead of
      // being cut off.
      if (figure.getBoundingClientRect().height > area.clientHeight * 0.7) {
        mark.remove();
        putBack();
        figure.classList.remove("span-figure");
        return true;
      }
    }
    // With it at the top, its place in the text must still be on this
    // page — else the page would show it ahead of the text it belongs to
    // (and what it pushes on can leave gaps). A trial fit says; if not,
    // it waits for the page its place lands on.
    // (One with nothing before it here — carried over, say — stays.)
    const first = !Array.from(block.childNodes).some(n => n !== mark && (n.nodeType === Node.ELEMENT_NODE || n.data.trim()) && mark.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING);
    const trial = first ? null : fitColumns(block, bottom, tail);
    let stays = true;
    if (trial) {
      const r = document.createRange();
      r.setStart(trial.point.node, trial.point.offset);
      stays = !trial.atStart && r.comparePoint(mark, 0) < 0;
    }
    mark.remove();
    if (!stays) {
      putBack();
      deferredLifts.add(figure);
      // Out of this page altogether (see paginate): in the columns here
      // it would show at column width.
      figure.remove();
      carried.push(figure);
    }
    // Either way the layout changed: the page is fitted again.
    return true;
  }

  // Lays out `article` (the last thing in `area`) and cuts it where the
  // page runs out. Returns what goes on the next page.
  function fitArticle(area, article) {
    const bottom = area.getBoundingClientRect().top + area.clientHeight;
    const blocks = Array.from(article.children).filter(el => !isOutOfFlow(el));

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (isColumns(block)) {
        // The byline (and the zine layout's inline References) must share a page
        // with the text's last lines. Pinned References only need their
        // spacer to fit somewhere: when it doesn't fit under the text,
        // it moves on to a page of its own like any other block, so it
        // isn't part of this tail.
        const after = blocks.slice(i + 1);
        const spacerAt = after.findIndex(el => el.matches(".references-spacer"));
        const tail = spacerAt === -1 ? after : after.slice(0, spacerAt);
        const cut = fitColumns(block, bottom, tail);
        if (liftSpanFigure(block, cut, area, bottom, tail)) return fitArticle(area, article);
        if (cut) {
          // An entry's title (and teaser) stays at the foot of a page only
          // with a few lines of its text under it, like a heading does.
          const opening = blocks.slice(0, i).every(keepsWithNext);
          const tooFew = !cut.atStart && opening && linesBefore(block, cut.point) < MIN_LINES_AFTER_HEADING;
          const rest = cut.atStart || tooFew ? breakBefore(area, article, blocks, i) : split(area, cut.point);
          if (block.isConnected) relayoutColumns(block);
          return rest;
        }
        i += tail.length;
        continue;
      }
      if (block.getBoundingClientRect().bottom > bottom + 0.5) {
        return breakBefore(area, article, blocks, i);
      }
    }
    return [];
  }

  // Once a page is cut, its columns are made plain: each multi-column
  // .body becomes side-by-side boxes holding exactly what the browser
  // put in each column, so the page looks the same but nothing is left
  // to lay out as columns again. (Printing does: Safari prints a
  // multi-column box inside a printed page as one wide column.)
  function freezeColumns(block) {
    // WebKit may still show an older column layout (see relayoutColumns).
    relayoutColumns(block);
    const cols = columnsOf(block);
    const items = laidOutLeaves(block);
    // Every column's start is measured before anything moves.
    const points = [];
    for (let k = 1; k < cols.count; k++) {
      const limit = cols.box.left + k * (cols.width + cols.gap) - cols.gap / 2;
      const i = firstLeafPast(items, limit);
      points.push(i < items.length ? pointPast(items[i], limit) : null);
    }
    // Cut from the last column back, so earlier points stay put.
    const parts = points.reverse().map(point => (point ? split(block, point) : [])).reverse();
    const boxes = [Array.from(block.children), ...parts].map(children => {
      const column = document.createElement("div");
      column.className = "body-column";
      column.append(...children);
      return column;
    });
    block.replaceChildren(...boxes);
    block.classList.add("body--columns");
    // Forced column breaks mean nothing now; printed, they could be
    // taken for page breaks.
    for (const el of block.querySelectorAll("*")) {
      if (el.style.breakBefore === "column") setColumnBreak(el, false);
    }
  }

  // Distributes the prepared flow's articles over as many pages as it
  // takes, appending each page to `staging`.
  function paginate(flow, running, staging) {
    const pages = [];
    let page;
    let area;
    const startPage = () => {
      deferredLifts = new Set();
      page = newPage();
      // Left- or right-hand page of a two-page spread: the tablet layout
      // mirrors its margins (wider outer margin for side comments).
      page.classList.add(pages.length % 2 ? "page--right" : "page--left");
      area = page.firstChild;
      staging.appendChild(page);
      pages.push(page);
    };

    const queue = Array.from(flow.children);
    startPage();
    while (queue.length) {
      const article = queue.shift();
      area.appendChild(article);
      if (article.previousElementSibling && getComputedStyle(article).breakBefore === "page") {
        startPage();
        area.appendChild(article);
      }

      const rest = fitArticle(area, article);

      // //span figures put off to the next page (see liftSpanFigure)
      // start it; if the entry ends here, they get a page of their own.
      if (carried.length) {
        let body = rest[0] && rest[0].querySelector(":scope > .body");
        if (!body) {
          const shell = article.cloneNode(false);
          shell.setAttribute("data-continued", "");
          body = document.createElement("main");
          body.className = "body";
          shell.appendChild(body);
          rest.unshift(shell);
        }
        body.prepend(...carried.map(figure => (figure.classList.remove("span-placed"), figure)));
        carried = [];
      }

      const byline = running.get(article);
      if (byline && article.parentNode === area) {
        const foot = document.createElement("div");
        foot.className = "page-foot";
        foot.appendChild(byline);
        page.appendChild(foot);
        running.delete(article);
      }

      if (rest.length) {
        queue.unshift(...rest);
        startPage();
      }
    }
    return pages;
  }

  // "01/09"-style number on every page.
  function numberPages(pages) {
    const digits = Math.max(2, String(pages.length).length);
    const pad = n => String(n).padStart(digits, "0");
    pages.forEach((page, i) => {
      const label = document.createElement("div");
      label.className = "page-number";
      label.setAttribute("aria-hidden", "true");
      label.textContent = pad(i + 1) + "/" + pad(pages.length);
      page.appendChild(label);
    });
  }

  // Margin comments (see .comment-margin-marker in book.css): each
  // note moves out of the text into its page's .page-comments layer, at
  // the height of its anchor, in the margin nearest the anchor's column.
  // A note that would overlap the one above it in the same margin is
  // nudged down just enough to clear it.
  // Two columns: the margin next to the anchor's column. One column:
  // the page's outer margin — right on a phone, and on a tablet spread
  // the left page's left edge and the right page's right edge.
  function noteSide(page, inLeftHalf) {
    const layout = root.dataset.layout;
    if (layout === "phone") return "right";
    if (layout === "tablet") return page.classList.contains("page--left") ? "left" : "right";
    return inLeftHalf ? "left" : "right";
  }

  function placeMarginNotes(page) {
    const notes = Array.from(page.querySelectorAll(".page-area .comment-margin-marker"));
    if (!notes.length) return;

    const box = page.getBoundingClientRect();
    const originTop = box.top + page.clientTop;
    const midX = box.left + box.width / 2;

    // Measured before anything moves. .comment-number is the anchor's
    // small, stable part (the note itself still holds its whole text).
    const items = notes.map(note => {
      const anchor = note.closest(".comment-marker")?.querySelector(".comment-number") || note;
      const rect = anchor.getBoundingClientRect();
      return { note, top: rect.top - originTop, side: noteSide(page, rect.left < midX) };
    });

    const layer = document.createElement("div");
    layer.className = "page-comments";
    page.appendChild(layer);
    for (const item of items) {
      item.note.classList.add("comment-margin-marker--" + item.side);
      layer.appendChild(item.note);
    }

    // Notes stay between the first and last line of the text area.
    const area = page.querySelector(".page-area").getBoundingClientRect();
    const topLimit = area.top - originTop;
    const bottomLimit = area.bottom - originTop;
    const GAP = 6;
    for (const side of ["left", "right"]) {
      const column = items.filter(item => item.side === side);
      const heights = column.map(item => item.note.offsetHeight);
      const tops = column.map(item => item.top);
      // 1. Down: each note level with its anchor, or just below the note
      //    above it.
      for (let i = 0, cursor = topLimit; i < tops.length; i++) {
        tops[i] = Math.max(tops[i], cursor);
        cursor = tops[i] + heights[i] + GAP;
      }
      // 2. Up: a note running past the bottom moves up (giving up being
      //    level with its anchor), pushing the ones above it up too —
      //    but none above the first line.
      for (let i = tops.length - 1, limit = bottomLimit; i >= 0; i--) {
        tops[i] = Math.max(topLimit, Math.min(tops[i], limit - heights[i]));
        limit = tops[i] - GAP;
      }
      // 3. If they still don't all fit, keep them from overlapping and let
      //    the last one run off the bottom.
      for (let i = 0, cursor = topLimit; i < tops.length; i++) {
        tops[i] = Math.max(tops[i], cursor);
        cursor = tops[i] + heights[i] + GAP;
      }
      column.forEach((item, i) => { item.note.style.top = tops[i] + "px"; });
    }
    // Phone: only a page with notes moves its text over to make room for
    // them (see book.css).
    page.classList.add("page--notes");
  }

  // Images still downloading get a flat loading background (their box
  // is already the right size). One that fails, or that had no known
  // size when the pages were cut, re-cuts the pages once it settles.
  function watchImages(pages) {
    for (const page of pages) {
      for (const img of page.querySelectorAll("img")) {
        // Cut without its size: again as soon as the size is in — which
        // can be well before the whole file is, or already.
        if (img.hasAttribute("data-unsized")) {
          const poll = () => {
            if (!img.isConnected) return;
            if (img.naturalWidth) scheduleRender();
            else if (!img.complete) setTimeout(poll, 200);
          };
          poll();
        }
        if (img.complete) continue;
        img.classList.add("is-loading");
        img.addEventListener("load", () => {
          img.classList.remove("is-loading");
        }, { once: true });
        img.addEventListener("error", () => {
          failedImages.add(img.getAttribute("src"));
          img.replaceWith(imagePlaceholder(img));
          scheduleRender();
        }, { once: true });
      }
    }
  }

  // What a set of pages shows: each page's text, and where its margin
  // notes sit.
  function layoutSignature(list) {
    return list.map(page =>
      page.textContent + Array.from(page.querySelectorAll(".page-comments > *"), n => n.style.top).join()
    ).join("\u0000");
  }

  let renderRun = 0;

  async function render(force = false) {
    const run = ++renderRun;
    const staging = document.createElement("div");
    staging.className = "book-staging";
    staging.setAttribute("aria-hidden", "true");
    document.body.appendChild(staging);

    try {
      const next = await cutPages(staging, () => run !== renderRun);
      if (!next) return;
      // A re-cut (late font or image) that lands every line where it
      // already is changes nothing on screen — keep the pages showing.
      if (!force && pages.length && layoutSignature(next) === layoutSignature(pages)) return;
      watchImages(next);
      setPages(next);
      schedulePrintPages();
    } finally {
      staging.remove();
    }
  }

  // Cuts a fresh copy of the flow into finished pages inside `staging`
  // (an offscreen .book-staging; pages take any page-size variables set
  // on it). Null if `stale()` says a newer cut has started meanwhile.
  async function cutPages(staging, stale) {
    const prep = newPage();
    staging.appendChild(prep);
    const running = await prepareFlow(prep.firstChild);
    if (stale()) return null;

    const next = paginate(prep.firstChild, running, staging);
    prep.remove();
    for (const page of next) {
      for (const block of page.querySelectorAll(".body")) if (isColumns(block)) freezeColumns(block);
    }
    // Pinned References stay exactly where and as wide as they are:
    // Safari prints their percentage width narrower, and the longer list
    // ran up over the text.
    for (const refs of staging.querySelectorAll(".references:not(.references--inline)")) {
      refs.style.width = refs.getBoundingClientRect().width + "px";
    }
    if (!root.classList.contains("no-page-numbers")) numberPages(next);
    next.forEach(placeMarginNotes);
    return next;
  }

  // How far a printed page of `width` x `height` is zoomed (print.css):
  // to fill a Letter sheet (816x1056 at 96dpi), a hair under so rounding
  // never spills a page onto a second sheet. Safari prints inside the
  // printer's margins rather than print.css's (on a Mac's default Letter
  // setup, WebKit then has about 900px of height per sheet), so for it,
  // to fit 720x890 — with room to spare, margins or none.
  function setPrintZoom(el, width, height) {
    el.style.setProperty("--print-zoom", Math.floor(Math.min(816 / width, 1056 / height) * 1000) / 1000 - 0.002);
    // (Safari's pages print with a 72px strip on top, see print.css.)
    el.style.setProperty("--print-zoom-safari", Math.floor(Math.min(720 / width, 890 / (height + 72)) * 1000) / 1000);
  }

  // Pages for printing. The book page has a sheet's proportions already,
  // but phone and tablet pages are cut to the screen's: printed, they'd
  // leave a wide strip of every sheet empty. In those layouts a second
  // set is cut in the background — the same layout, on pages as wide as
  // the screen's and as tall as a Letter sheet's proportions make them —
  // and printed instead (print.css). Printing before it's ready prints
  // the pages on screen.
  const printBook = div("print-book");
  printBook.setAttribute("aria-hidden", "true");
  document.body.appendChild(printBook);
  let printRun = 0;
  let printTimer = null;

  function schedulePrintPages() {
    clearTimeout(printTimer);
    printRun++;
    root.classList.remove("has-print-book");
    printBook.replaceChildren();
    if (root.dataset.layout !== "book") printTimer = setTimeout(cutPrintPages, 800);
  }

  async function cutPrintPages() {
    const run = ++printRun;
    const width = pageWidth;
    const height = Math.floor(width * 1056 / 816);
    const staging = div("book-staging");
    staging.setAttribute("aria-hidden", "true");
    staging.style.setProperty("--paper-width", width + "px");
    staging.style.setProperty("--page-height", height + "px");
    // On paper, Chrome's and Safari's prints of these pages look heavy
    // at the foot: some of the bottom margin moves to the top. (Firefox
    // prints them evenly as they are.)
    if (!/Firefox\//.test(navigator.userAgent)) {
      const style = getComputedStyle(root);
      const top = parseFloat(style.getPropertyValue("--pad-top"));
      const bottom = parseFloat(style.getPropertyValue("--pad-bottom"));
      const shift = Math.round(bottom * 0.3);
      staging.style.setProperty("--pad-top", top + shift + "px");
      staging.style.setProperty("--pad-bottom", bottom - shift + "px");
    }
    // Worked out on :root from its page size; again here, from these.
    staging.style.setProperty("--area-width", "calc(var(--paper-width) - var(--pad-left) - var(--pad-right))");
    staging.style.setProperty("--area-height", "calc(var(--page-height) - var(--pad-top) - var(--pad-bottom))");
    document.body.appendChild(staging);
    try {
      const next = await cutPages(staging, () => run !== printRun);
      if (!next) return;
      printBook.style.cssText = staging.style.cssText;
      setPrintZoom(printBook, width, height);
      printBook.replaceChildren(...next);
      root.classList.add("has-print-book");
    } finally {
      staging.remove();
    }
  }

  let renderTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 150);
  }

  // =========================================================
  // Viewer
  // =========================================================

  // Touch devices (phones, iPads) swipe through pages instead. Detected
  // by the primary pointer being a finger rather than by screen width,
  // so a landscape iPad counts too; maxTouchPoints also catches iPadOS
  // Safari, which presents itself as a desktop Mac.
  const isTouch =
    matchMedia("(pointer: coarse)").matches ||
    matchMedia("(hover: none)").matches ||
    navigator.maxTouchPoints > 1;
  // Tablets show a two-page spread in landscape, one page in portrait;
  // phones always one. Every iPad's short side is >= 744 CSS px, every
  // phone's well under 600.
  const isTablet = isTouch && Math.min(screen.width, screen.height) >= 600;
  // Safari (and every iOS browser — all WebKit) prints differently (see
  // print.css).
  root.classList.toggle("is-webkit-print", navigator.vendor === "Apple Computer, Inc.");
  root.classList.toggle("is-touch", isTouch);

  // Which page geometry to cut for (see book.css):
  // - "book": the fixed two-column page, scaled to fit — desktop, and a
  //   portrait tablet.
  // - "phone": the page IS the screen, one column, larger type.
  // - "tablet": a landscape tablet's two-page spread, each page half the
  //   screen, one column.
  // Only "book" pages are independent of the screen; the other two are
  // cut again whenever the screen's shape changes.
  // Desktop: opens on the book page, or — layout rows with one column
  // (.desktop-tablet) — on the tablet-style spread. The backslash key
  // switches between the two for this visit only: a reload opens the
  // page as the settings lay it out again.
  let wantsTablet = root.classList.contains("desktop-tablet");

  function layoutFor() {
    if (!isTouch) return wantsTablet ? "tablet" : "book";
    if (!isTablet) return "phone";
    return viewportWidth() > viewportHeight() ? "tablet" : "book";
  }

  let layoutKey = "";

  // Sets the layout and screen-derived page size; true if they changed.
  function applyLayout() {
    const layout = layoutFor();
    const w = viewportWidth();
    const h = viewportHeight();
    const key = layout === "book" ? layout : `${layout}:${w}x${h}`;
    if (key === layoutKey) return false;
    layoutKey = key;
    root.dataset.layout = layout;
    if (layout === "book") {
      root.style.removeProperty("--paper-width");
      root.style.removeProperty("--page-height");
    } else {
      root.style.setProperty("--paper-width", Math.floor(layout === "tablet" ? w / 2 : w) + "px");
      root.style.setProperty("--page-height", Math.floor(h) + "px");
    }
    return true;
  }

  let pages = [];
  // The .page size from book.css, read while pages are still laid
  // out in staging — on screen, all but the current spread are hidden.
  let pageWidth = 0;
  let pageHeight = 0;
  let spreads = [];
  let perSpread = 1;
  let current = 0;
  // Desktop's two-page spread ('/' toggles it).
  let wantsDouble = true;
  // Until the reader moves, a re-cut (late font/image) reopens at the
  // same place the first cut did.
  let navigated = false;

  // Screen width in CSS px — not innerWidth, which on iOS is the visual
  // viewport and changes with pinch/auto zoom.
  function viewportWidth() {
    return root.clientWidth || window.innerWidth;
  }

  // 100svh: the height with the mobile address bar shown. It stays put
  // while the bar slides in and out, unlike innerHeight, whose constant
  // changes would feed a resize -> rescale loop.
  function viewportHeight() {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:0;height:100svh;width:0;visibility:hidden;";
    document.body.appendChild(probe);
    const h = probe.offsetHeight || root.clientHeight || window.innerHeight;
    probe.remove();
    return h;
  }

  function pagesPerSpread() {
    if (pages.length <= 1) return 1;
    if (isTouch) return root.dataset.layout === "tablet" ? 2 : 1;
    return wantsDouble ? 2 : 1;
  }

  // Every spread scaled as a unit (transform, not zoom: Safari's zoom
  // shrinks a box without shrinking the text painted in it).
  let viewScale = 1;

  function fit() {
    if (!pages.length) return;
    // Phone and tablet pages are already cut to the screen.
    viewScale = root.dataset.layout !== "book" ? 1 : Math.min(
      viewportWidth() / (pageWidth * perSpread),
      viewportHeight() / pageHeight
    );
    for (const spread of spreads) spread.firstElementChild.style.transform = `scale(${viewScale})`;
    if (turn) turn.stage.style.transform = `scale(${viewScale})`;
  }

  // The pages shown side by side in each spread. An odd last page in a
  // two-page view gets a blank right-hand page, so it still reads as a
  // book opening.
  let spreadPages = [];

  function buildSpreads() {
    cancelTurn();
    perSpread = pagesPerSpread();
    spreads = [];
    spreadPages = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < pages.length; i += perSpread) {
      const group = pages.slice(i, i + perSpread);
      if (perSpread === 2 && group.length === 1) {
        const blank = document.createElement("div");
        blank.className = "page page-blank page--right";
        blank.setAttribute("aria-hidden", "true");
        group.push(blank);
      }
      const spread = document.createElement("div");
      spread.className = "spread";
      const inner = document.createElement("div");
      inner.className = "spread-inner" + (perSpread === 2 ? " is-double" : "");
      inner.append(...group);
      spread.appendChild(inner);
      frag.appendChild(spread);
      spreads.push(spread);
      spreadPages.push(group);
    }
    book.replaceChildren(frag);
    fit();
  }

  function show(index) {
    if (!spreads.length) return;
    cancelTurn();
    current = Math.min(Math.max(index, 0), spreads.length - 1);
    spreads.forEach((spread, i) => spread.classList.toggle("is-current", i === current));
  }

  // Shows the spread where element `id` starts: a note in a collection
  // (id="card-<slug>") or a heading (id="sec-N"). A split element's
  // continuations carry the same id; the first in page order is where
  // it starts.
  function jumpTo(id) {
    const marker = book.querySelector("#" + CSS.escape(id));
    const page = marker && marker.closest(".page");
    if (page) show(Math.floor(pages.indexOf(page) / perSpread));
  }

  function openingPosition() {
    show(0);
    if (latestSlug) jumpTo("card-" + latestSlug);
  }

  function setPages(next) {
    // Where the reader is, as a share of the book — a re-cut for a new
    // screen shape changes how many pages there are.
    const progress = pages.length ? (current * perSpread) / pages.length : 0;
    pageWidth = next[0].offsetWidth;
    pageHeight = next[0].offsetHeight;
    setPrintZoom(root, pageWidth, pageHeight);
    pages = next;
    buildSpreads();
    if (navigated) show(Math.floor(Math.round(progress * pages.length) / perSpread));
    else openingPosition();
    requestAnimationFrame(() => root.classList.remove("reader-loading"));
  }

  // Regroups (keeping the same page in view) when the pages-per-spread
  // changes — '/' on desktop — else just rescales.
  function relayout() {
    const firstPage = current * perSpread;
    if (pagesPerSpread() !== perSpread) buildSpreads();
    else fit();
    show(Math.floor(firstPage / perSpread));
  }

  // New page geometry (rotation, new window size, backslash): cut again,
  // behind the loader, rather than show pages cut for the old shape.
  function recut() {
    root.classList.add("reader-loading");
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => render(true), 150);
  }

  // Printing lays the document out at paper size, which fires resize
  // too: the pages already cut are what gets printed (see print.css), so
  // nothing is re-cut or re-sized for it — a phone or tablet layout would
  // otherwise squeeze its pages to the paper's width mid-print.
  const printMedia = matchMedia("print");
  let printing = false;

  function onResize() {
    if (printing || printMedia.matches) return;
    if (applyLayout()) recut();
    else relayout();
  }

  window.addEventListener("resize", onResize);
  window.addEventListener("beforeprint", () => { printing = true; });
  window.addEventListener("afterprint", () => {
    printing = false;
    onResize();
  });

  function toggleTabletLayout() {
    wantsTablet = !wantsTablet;
    if (applyLayout()) recut();
  }

  function toggleDouble() {
    wantsDouble = !wantsDouble;
    relayout();
  }

  // =========================================================
  // Page turning
  // A turn folds the page like paper: its free corner is carried
  // across (by the finger, or along a natural arc), and the page folds
  // on the line halfway between where the corner was and where it is
  // now. The part past the fold is flipped over, showing the page's back
  // — in a two-page spread, the next spread's facing page — and uncovers
  // the next page underneath. With one page per screen the back is plain
  // paper and the uncovered page is the next one. Turns are driven by
  // `progress` (0 = not started, 1 = done), so a finger on the trackpad
  // or screen can hold a page part-way and let go.
  // =========================================================

  let turn = null;

  function div(className) {
    const el = document.createElement("div");
    el.className = className;
    return el;
  }

  // The part of polygon `poly` on the side of the line through `m`
  // that normal `n` points to.
  function clipHalfPlane(poly, m, n) {
    const side = p => (p[0] - m[0]) * n[0] + (p[1] - m[1]) * n[1];
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const sa = side(a);
      const sb = side(b);
      if (sa >= 0) out.push(a);
      if ((sa >= 0) !== (sb >= 0)) {
        const k = sa / (sa - sb);
        out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
      }
    }
    return out;
  }

  const polygon = pts => pts.length > 2
    ? `polygon(${pts.map(p => `${p[0].toFixed(2)}px ${p[1].toFixed(2)}px`).join(",")})`
    : "polygon(0 0, 0 0, 0 0)";

  // Paper can't stretch: the corner stays within reach of both ends of
  // the spine.
  function withinReach(p, center, radius) {
    const dx = p[0] - center[0];
    const dy = p[1] - center[1];
    const d = Math.hypot(dx, dy);
    return d <= radius ? p : [center[0] + dx * radius / d, center[1] + dy * radius / d];
  }

  // A soft shade band along the fold, fading out in direction `g`.
  function drawBand(el, at, g, width, background) {
    const len = 2 * Math.hypot(pageWidth, pageHeight);
    el.style.width = len + "px";
    el.style.height = width + "px";
    el.style.background = background;
    el.style.transform =
      `translate(${at[0]}px, ${at[1]}px) rotate(${Math.atan2(-g[0], g[1])}rad) translate(${-len / 2}px, 0)`;
  }

  // `grabY`: page height at which the page was taken (touch) — the
  // corner nearest it is the one that turns.
  function beginTurn(dir, grabY = null) {
    const to = current + dir;
    if (!spreads.length || to < 0 || to >= spreads.length) return null;
    navigated = true;

    const from = current;
    const double = perSpread === 2;
    const A = spreadPages[from];
    const B = spreadPages[to];
    const fromInner = spreads[from].firstElementChild;
    const W = pageWidth;
    const H = pageHeight;

    const stage = div("turn-stage" + (double ? " is-double" : ""));
    stage.style.transform = `scale(${viewScale})`;
    const slot = page => {
      const el = div("turn-slot");
      el.appendChild(page);
      stage.appendChild(el);
    };

    let sheetX;      // where the turning page sits in the stage
    let hingeX;      // its bound edge, in its own coordinates
    let frontPage;
    let backPage;
    if (double) {
      if (dir > 0) {
        slot(A[0]);
        slot(B[1]);
        sheetX = W;
        hingeX = 0;
        frontPage = A[1];
        backPage = B[0];
      } else {
        slot(B[0]);
        slot(A[1]);
        sheetX = 0;
        hingeX = W;
        frontPage = A[0];
        backPage = B[1];
      }
    } else {
      slot(dir > 0 ? B[0] : A[0]);
      sheetX = 0;
      hingeX = 0;
      frontPage = dir > 0 ? A[0] : B[0];
      backPage = div("turn-paper");
    }

    const sheet = div("turn-sheet");
    sheet.style.left = sheetX + "px";
    const front = div("turn-front");
    const frontBand = div("turn-band");
    front.append(frontPage, frontBand);
    const cast = div("turn-cast");
    const castBand = div("turn-band");
    cast.append(castBand);
    const back = div("turn-back");
    const backBand = div("turn-band");
    back.append(backPage, backBand);
    sheet.append(front, cast, back);
    stage.appendChild(sheet);

    fromInner.style.display = "none";
    spreads[from].appendChild(stage);

    turn = {
      dir, from, to, stage, double, hingeX,
      front, back, cast, frontBand, backBand, castBand,
      corner: grabY !== null && grabY < H / 2 ? 0 : H,
      // Backward with one page per screen: the previous page comes back
      // over the current one — a forward turn of it, run in reverse.
      reversed: !double && dir < 0,
      progress: 0,
      yBias: 0,
      anim: null
    };
    drawTurn(0);
    return turn;
  }

  function drawTurn(progress) {
    const t = turn;
    t.progress = Math.min(1, Math.max(0, progress));
    const p = t.reversed ? 1 - t.progress : t.progress;
    const W = pageWidth;
    const H = pageHeight;
    const freeX = W - t.hingeX;
    const endX = 2 * t.hingeX - freeX;
    const cy = t.corner;

    // The corner's path: across to the far side of the spine, lifting
    // off the page edge on the way (or wherever the finger holds it).
    let P = [
      freeX + (endX - freeX) * p,
      cy + (cy ? -1 : 1) * H * 0.1 * Math.sin(Math.PI * p) + t.yBias * Math.sin(Math.PI * p)
    ];
    P = withinReach(P, [t.hingeX, cy], W);
    P = withinReach(P, [t.hingeX, H - cy], Math.hypot(W, H));

    const C = [freeX, cy];
    const dx = P[0] - C[0];
    const dy = P[1] - C[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.5) {
      t.front.style.clipPath = "";
      t.back.style.visibility = t.cast.style.visibility = "hidden";
      return;
    }
    t.back.style.visibility = t.cast.style.visibility = "";

    // Fold line: through M, normal n (pointing away from the corner).
    const n = [dx / len, dy / len];
    const M = [(C[0] + P[0]) / 2, (C[1] + P[1]) / 2];
    const page = [[0, 0], [W, 0], [W, H], [0, H]];
    const kept = clipHalfPlane(page, M, n);
    const flap = clipHalfPlane(page, M, [-n[0], -n[1]]);
    t.front.style.clipPath = polygon(kept);
    t.cast.style.clipPath = polygon(flap);

    // The flap is the back of the sheet: mirrored left-right (it's the
    // other side), then reflected across the fold.
    const r11 = 1 - 2 * n[0] * n[0];
    const r12 = -2 * n[0] * n[1];
    const r22 = 1 - 2 * n[1] * n[1];
    const md = 2 * (M[0] * n[0] + M[1] * n[1]);
    t.back.style.transform =
      `matrix(${-r11}, ${-r12}, ${r12}, ${r22}, ${r11 * W + md * n[0]}, ${r12 * W + md * n[1]})`;
    t.back.style.clipPath = polygon(flap.map(([x, y]) => [W - x, y]));
    // A lone page's plain back fades out as it lands off the page.
    t.back.style.opacity = t.double ? "" : Math.min(1, (1 - p) * 4);

    // Light: the page bends into the fold, the flap catches light where
    // it curls over, and it shades the page it uncovers.
    const curl = Math.sin(Math.PI * Math.min(1, p * 1.4));
    const dark = a => `rgba(6, 12, 22, ${a.toFixed(3)})`;
    drawBand(t.frontBand, M, n, W * 0.16,
      `linear-gradient(to bottom, ${dark(0.1 * curl)}, ${dark(0)})`);
    drawBand(t.castBand, M, [-n[0], -n[1]], W * 0.3,
      `linear-gradient(to bottom, ${dark(0.28 * curl + 0.04)}, ${dark(0)})`);
    drawBand(t.backBand, [W - M[0], M[1]], [n[0], -n[1]], W * 0.45,
      `linear-gradient(to bottom, rgba(255, 255, 255, ${(0.5 * curl).toFixed(3)}), ${dark(0.1 * curl)} 22%, ${dark(0)} 70%)`);
  }

  // Puts every page back in its spread and shows `index`.
  function endTurn(index) {
    const t = turn;
    turn = null;
    if (t.anim) cancelAnimationFrame(t.anim);
    for (const i of [t.from, t.to]) spreads[i].firstElementChild.append(...spreadPages[i]);
    spreads[t.from].firstElementChild.style.display = "";
    t.stage.remove();
    current = index;
    spreads.forEach((spread, i) => spread.classList.toggle("is-current", i === current));
  }

  function cancelTurn() {
    if (turn) endTurn(turn.from);
  }

  // Animates the held turn to done (1) or back (0), easing out; a
  // finger's height offset eases away with it.
  function settleTurn(target, speed = 1) {
    const t = turn;
    if (!t) return;
    if (t.anim) cancelAnimationFrame(t.anim);
    const start = t.progress;
    const bias = t.yBias;
    const duration = Math.max(90, 300 * Math.abs(target - start)) / speed;
    const t0 = performance.now();
    const step = now => {
      if (turn !== t) return;
      const k = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      t.yBias = bias * (1 - eased);
      drawTurn(start + (target - start) * eased);
      if (k < 1) t.anim = requestAnimationFrame(step);
      else endTurn(target === 1 ? t.to : t.from);
    };
    t.anim = requestAnimationFrame(step);
  }

  // Keys: a whole animated turn. A turn still settling is finished
  // first, so quick presses keep up.
  function turnPage(dir) {
    if (turn) {
      if (turn.dir === dir && turn.anim) endTurn(turn.to);
      else cancelTurn();
    }
    if (!beginTurn(dir)) return;
    const t = turn;
    t.anim = requestAnimationFrame(t0 => {
      const run = now => {
        if (turn !== t) return;
        const k = Math.min(1, (now - t0) / 380);
        drawTurn(k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
        if (k < 1) t.anim = requestAnimationFrame(run);
        else endTurn(t.to);
      };
      run(t0);
    });
  }

  // Screen px of travel for a whole turn. A finger carries the corner
  // itself (two page widths across the spine of a spread; a little over
  // one for a lone page); a trackpad swipe needs about one page width.
  function turnDistance(source) {
    const pages = source !== "touch" ? 0.9 : turn && turn.double ? 2 : 1.2;
    return pages * pageWidth * viewScale;
  }

  // Follows a drag of `delta` screen px (positive: toward the next
  // page). `clientY` (touch): where the finger is, which the corner
  // follows. Returns false when there's no page that way.
  function dragTurn(delta, source, clientY = null) {
    if (turn && turn.anim) endTurn(turn.progress > 0.5 ? turn.to : turn.from);
    const pageY = () => {
      const box = spreads[current].getBoundingClientRect();
      return (clientY - (box.top + (box.height - pageHeight * viewScale) / 2)) / viewScale;
    };
    if (!turn) {
      if (!beginTurn(Math.sign(delta), clientY === null ? null : pageY())) return false;
    }
    const distance = turnDistance(source);
    const next = turn.progress + (delta * turn.dir) / distance;
    if (next < 0) {
      // Dragged back past where it started: turn the other way instead.
      const rest = next * distance * turn.dir;
      cancelTurn();
      return rest === 0 ? true : dragTurn(rest, source, clientY);
    }
    if (clientY !== null) {
      // Hold the corner at the finger's height (relative to the arc).
      const s = Math.sin(Math.PI * (turn.reversed ? 1 - next : next));
      const arc = turn.corner + (turn.corner ? -1 : 1) * pageHeight * 0.1 * s;
      turn.yBias = s > 0.05 ? Math.max(-pageHeight, Math.min(pageHeight, (pageY() - arc) / s)) : 0;
    }
    drawTurn(next);
    return true;
  }

  // A released drag completes if it went past a quarter of the way or
  // was still moving that way (px/ms); otherwise the page falls back.
  function releaseTurn(velocity = 0) {
    if (!turn) return;
    const along = velocity * turn.dir;
    settleTurn(turn.progress > 0.25 || along > 0.35 ? 1 : 0, Math.max(1, Math.abs(velocity)));
  }

  if (tocDialog) {
    tocDialog.querySelectorAll("[data-jump]").forEach(btn => {
      btn.addEventListener("click", () => {
        navigated = true;
        jumpTo(btn.dataset.jump);
        tocDialog.close();
      });
    });
    tocDialog.addEventListener("click", e => {
      const r = tocDialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        tocDialog.close();
      }
    });
  }

  // Pinch-zoomed in (the visual viewport scaled up), a finger pans the
  // zoomed page in any direction instead of turning it: .is-zoomed hands
  // panning back to the browser (see book.css). Pinch-zoom is analog
  // and rarely lands back on exactly 1.0, hence the margin.
  //
  // Desktop Safari reports a trackpad pinch through its own gesture
  // events and doesn't always show it in visualViewport, so the pinch's
  // accumulated scale is tracked too; a visual viewport narrower than
  // the page also counts.
  let gestureZoom = 1;
  let gestureBase = 1;
  window.addEventListener("gesturestart", () => { gestureBase = gestureZoom; });
  window.addEventListener("gesturechange", e => {
    gestureZoom = Math.max(1, gestureBase * (e.scale || 1));
    updateZoom();
  });
  window.addEventListener("gestureend", e => {
    gestureZoom = Math.max(1, gestureBase * (e.scale || 1));
    if (gestureZoom < 1.02) gestureZoom = 1;
    updateZoom();
  });
  function isZoomed() {
    const vv = window.visualViewport;
    if (vv && (vv.scale > 1.02 || vv.width < root.clientWidth - 2)) return true;
    return gestureZoom > 1.02;
  }
  function updateZoom() {
    root.classList.toggle("is-zoomed", isZoomed());
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateZoom);
    window.visualViewport.addEventListener("scroll", updateZoom);
  }

  if (isTouch) {
    // A finger drags the page: right-to-left turns forward, left-to-right
    // back. The direction is only decided once it's clearly horizontal.
    let drag = null;
    const fingers = new Set();
    book.addEventListener("pointerdown", e => {
      if (e.pointerType !== "touch") return;
      fingers.add(e.pointerId);
      // A second finger: this is a pinch, not a page turn.
      if (fingers.size > 1) {
        if (drag && drag.active) settleTurn(0);
        drag = null;
        return;
      }
      if (drag || isZoomed()) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastT: e.timeStamp, v: 0, active: false };
    });
    book.addEventListener("pointermove", e => {
      if (!drag || e.pointerId !== drag.id) return;
      // A second finger joined (pinch) or the page zoomed: let it go.
      if (!drag.active && isZoomed()) {
        drag = null;
        return;
      }
      const dx = e.clientX - drag.x;
      if (!drag.active) {
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(e.clientY - drag.y)) return;
        drag.active = true;
        try { book.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      }
      const step = drag.lastX - e.clientX;
      const dt = Math.max(1, e.timeStamp - drag.lastT);
      drag.v = 0.7 * drag.v + 0.3 * (step / dt);
      drag.lastX = e.clientX;
      drag.lastT = e.timeStamp;
      if (step) dragTurn(step, "touch", e.clientY);
    });
    const release = e => {
      fingers.delete(e.pointerId);
      if (!drag || e.pointerId !== drag.id) return;
      const v = drag.v;
      drag = null;
      releaseTurn(v);
    };
    book.addEventListener("pointerup", release);
    book.addEventListener("pointercancel", release);
  } else {
    // '/' toggles single/double page; backslash toggles the book page and
    // the tablet-style one. 'a'/ArrowLeft/Left Shift go back
    // a page or spread, 'd'/ArrowRight/Right Shift forward. Space opens
    // and closes the TOC popup where there is one (/contents); while
    // it's open only 'w'/'s' (move between items) and Space work, so
    // nothing changes pages behind it.
    document.addEventListener("keydown", e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const active = document.activeElement;
      const activeTag = (active && active.tagName) || "";
      if (activeTag === "INPUT" || activeTag === "TEXTAREA" || active?.isContentEditable) return;

      if (e.code === "Space" || e.key === " ") {
        if (!tocDialog) return;
        e.preventDefault();
        if (tocDialog.open) tocDialog.close();
        else tocDialog.showModal();
        return;
      }

      if (tocDialog && tocDialog.open) {
        // Enter activates the focused item through the button's own
        // keyboard handling.
        const isUp = e.key === "w" || e.key === "W";
        const isDown = e.key === "s" || e.key === "S";
        if (isUp || isDown) {
          e.preventDefault();
          const items = Array.from(tocDialog.querySelectorAll("[data-jump]"));
          if (items.length) {
            const at = items.indexOf(document.activeElement);
            const next = at === -1
              ? (isDown ? 0 : items.length - 1)
              : Math.max(0, Math.min(items.length - 1, at + (isDown ? 1 : -1)));
            items[next].focus();
          }
        }
        return;
      }

      // By key code too: a Chinese input method types 、 on that key.
      if (e.key === "\\" || e.code === "Backslash") {
        e.preventDefault();
        toggleTabletLayout();
        return;
      }

      if (e.key === "/" || e.code === "Slash") {
        e.preventDefault();
        toggleDouble();
        return;
      }

      const isPrev = e.key === "a" || e.key === "A" || e.key === "ArrowLeft" || e.code === "ShiftLeft";
      const isNext = e.key === "d" || e.key === "D" || e.key === "ArrowRight" || e.code === "ShiftRight";
      if (isPrev || isNext) {
        e.preventDefault();
        turnPage(isNext ? 1 : -1);
      }
    });

    // A trackpad two-finger swipe (horizontal wheel deltas) drags the
    // page under the fingers, momentum included; when the events stop,
    // it settles (see releaseTurn). One gesture turns at most one page:
    // once it completes, the rest of that gesture is ignored. Left alone
    // while pinch-zoomed in, so the swipe can pan instead.
    // Once a swipe has carried the page a third of the way (momentum
    // included) the turn finishes on its own, quickly — it doesn't wait
    // for the trackpad's momentum events to die out. The rest of that
    // swipe is ignored, but a new swipe (a clear direction change, or a
    // fresh burst after the momentum has decayed) is taken at once.
    let wheelIdle = null;
    let wheelDone = false;
    let lastAbs = 0;
    let lastDir = 0;
    const GESTURE_IDLE_GAP = 120;
    const COMMIT_AT = 0.33;

    window.addEventListener("wheel", e => {
      if (e.ctrlKey) return;
      if (!turn && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      if (tocDialog && tocDialog.open) return;

      if (isZoomed()) return;

      e.preventDefault();

      clearTimeout(wheelIdle);
      wheelIdle = setTimeout(() => {
        wheelDone = false;
        lastAbs = 0;
        if (turn && !turn.anim) releaseTurn();
      }, GESTURE_IDLE_GAP);

      const delta = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
      const abs = Math.abs(delta);
      const dir = Math.sign(delta);
      if (wheelDone) {
        const reversed = dir && dir !== lastDir && abs > 4;
        const fresh = abs > Math.max(10, lastAbs * 2.5);
        lastAbs = abs;
        if (!reversed && !fresh) return;
        wheelDone = false;
      }
      lastAbs = abs;
      // A swipe's first touch can report a tiny sign-flipped delta.
      if (!turn && abs < 2) return;
      if (dir) lastDir = dir;
      if (!dragTurn(delta, "wheel")) {
        wheelDone = true;
        return;
      }
      if (turn && turn.progress >= COMMIT_AT) {
        settleTurn(1, 1.6);
        wheelDone = true;
      }
    }, { passive: false });
  }

  // =========================================================
  // Start
  // =========================================================

  applyLayout();
  render().then(() => {
    // A face that finishes loading after the first cut (e.g. more of
    // the Chinese font) reflows text — cut the pages again.
    document.fonts.addEventListener("loadingdone", scheduleRender);
  });
})();
