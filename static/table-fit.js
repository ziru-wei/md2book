/* =========================================================
   Table column widths (used by reader.js before pages are cut).

   Two starting points are measured — as the browser lays them out, on
   a hidden copy — the browser's own column widths, and widths shared out
   by how much text each column holds (never more than a column needs to
   set its widest cell on one line); a short local search then moves
   width between columns while that makes the table shorter. All within
   readability rules:

   - no column narrower than its longest word (so no word is split
     mid-word; long URLs are the exception, and may break), nor than a
     few characters;
   - a prose column keeps lines of at least about 20 characters;
   - a column of numbers or dates never wraps them;
   - no cell's content overflows;
   - a header wraps to at most two lines (or no more than it did).

   The result is kept only if it's clearly shorter than the browser's
   own layout (or fixes a readability problem that layout had), and is
   written into a <colgroup>, so every later layout — the page cut, the
   screen, printing — uses the same widths.

   The search itself takes its measurements as a function, so it runs
   (and is tested) without a browser: see test/table-fit.test.js.
   ========================================================= */

(function (root) {
  "use strict";

  const CJK = "⺀-⿟　-〿぀-ヿ㐀-䶿一-鿿豈-﫿︰-﹏＀-￯";
  const HAS_CJK = new RegExp(`[${CJK}]`);
  const CJK_OR_LATIN = new RegExp(`[${CJK}]|[^${CJK}]+`, "g");
  const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+$|^\S{20,}$/i;
  // A number, amount, percentage, date or time — what a numbers
  // column holds.
  const NUMERIC = /^[(+\-−–]?[$€£¥]?\s*\d[\d\s.,:/'’\-–]*(?:%|[a-z]{0,3}|年|月|日|号|个|次)?\)?$/i;

  // The pieces of a cell's text that can't be broken across lines: words
  // between spaces, and each CJK character on its own (CJK text breaks
  // between any two characters). `url`: the piece may break anyway.
  function tokens(text) {
    const out = [];
    for (const word of String(text).split(/\s+/)) {
      if (!word) continue;
      if (HAS_CJK.test(word)) {
        for (const piece of word.match(CJK_OR_LATIN)) out.push({ text: piece, url: false });
      } else {
        out.push({ text: word, url: URL_LIKE.test(word) });
      }
    }
    return out;
  }

  function isNumeric(text) {
    const t = String(text).trim();
    return t !== "" && NUMERIC.test(t);
  }

  // A column of numbers: most of its non-empty body cells are.
  function isNumericColumn(cells) {
    const filled = cells.map(c => String(c).trim()).filter(Boolean);
    return filled.length > 0 && filled.filter(isNumeric).length / filled.length >= 0.7;
  }

  // A prose column — cells averaging this many characters or more, in
  // several words (a URL isn't prose) — gets lines of at least this many
  // characters (see minimumWidths).
  const PROSE_CELL = 40;
  const PROSE_WORDS = 6;
  const PROSE_LINE = 20;

  // What each column holds: `maxContent`, its widest cell set on one line
  // (padding included); `demand`, all its text set end to end; its
  // average character width; whether it's prose. `columns[j]`: { header,
  // cells, padding, fontSize } of column j (header and cells as text);
  // `width(text, isHeader)`: the text's width set on one line.
  function columnStats(columns, width) {
    return columns.map(col => {
      const texts = col.cells.map(c => String(c).trim().replace(/\s+/g, " ")).filter(Boolean);
      const widths = texts.map(t => width(t, false));
      const header = String(col.header).trim();
      const headerWidth = header ? width(header, true) : 0;
      const chars = texts.reduce((n, t) => n + Array.from(t).length, 0);
      const words = texts.reduce((n, t) => n + tokens(t).length, 0);
      const textWidth = widths.reduce((a, b) => a + b, 0);
      return {
        maxContent: Math.ceil(Math.max(headerWidth, ...widths, 0) + col.padding),
        demand: textWidth + headerWidth,
        charWidth: chars ? textWidth / chars : col.fontSize / 2,
        prose: texts.length > 0 && chars / texts.length >= PROSE_CELL && words / texts.length >= PROSE_WORDS
      };
    });
  }

  // Each column's narrowest readable width in a table `total` wide (see
  // columnStats for the arguments).
  function minimumWidths(columns, width, total = Infinity) {
    const stats = columnStats(columns, width);
    return columns.map((col, j) => {
      let min = 3 * col.fontSize;
      // Measured in place when given (bold and italic words are wider).
      const pieces = col.pieces || [...tokens(col.header).map(t => ({ ...t, header: true })), ...col.cells.flatMap(c => tokens(c))];
      for (const piece of pieces) {
        const w = piece.width ?? width(piece.text, !!piece.header);
        // A long URL may break; it only asks for a fair share.
        min = Math.max(min, piece.url ? Math.min(w, 8 * col.fontSize) : w);
      }
      if (isNumericColumn(col.cells)) {
        for (const cell of col.cells) if (isNumeric(cell)) min = Math.max(min, width(String(cell).trim(), false));
      }
      // Prose isn't squeezed to a word or two a line — within reason: no
      // more than 30% of the table, nor wider than its longest cell.
      const s = stats[j];
      if (s.prose) min = Math.max(min, Math.min(PROSE_LINE * s.charWidth, total * 0.3, s.maxContent - col.padding));
      return Math.ceil(min + col.padding);
    });
  }

  // Widths shared out by how much text each column has — but no column
  // wider than it needs to set its widest cell on one line, nor narrower
  // than its minimum. (Roughly how LaTeX's tabulary sets a table.)
  function balancedWidths(stats, mins, total) {
    const n = stats.length;
    const w = new Array(n).fill(null);
    let open = [...Array(n).keys()];
    let room = total;
    while (open.length) {
      const demand = open.reduce((sum, j) => sum + stats[j].demand, 0);
      const share = j => (demand ? room * stats[j].demand / demand : room / open.length);
      // A column its share would overfill or starve takes its limit, and
      // the rest is shared again.
      const settled = open.find(j => share(j) >= stats[j].maxContent || share(j) <= mins[j]);
      if (settled === undefined) {
        for (const j of open) w[j] = share(j);
        break;
      }
      w[settled] = share(settled) >= stats[settled].maxContent ? stats[settled].maxContent : mins[settled];
      room -= w[settled];
      open = open.filter(j => j !== settled);
    }
    // Everything fits on one line with room to spare: spread the rest.
    const used = w.reduce((a, b) => a + b, 0);
    if (used < total) {
      const all = stats.reduce((sum, st) => sum + st.maxContent, 0);
      for (let j = 0; j < n; j++) w[j] += (total - used) * stats[j].maxContent / all;
    }
    return respectMinimums(w, mins, total);
  }

  // `start` moved to respect `mins` (taking from columns with room to
  // spare), or null if the columns can't all fit their minimums.
  function respectMinimums(start, mins, total) {
    if (mins.reduce((a, b) => a + b, 0) > total + 0.5) return null;
    const w = start.slice();
    let deficit = 0;
    for (let j = 0; j < w.length; j++) {
      if (w[j] < mins[j]) {
        deficit += mins[j] - w[j];
        w[j] = mins[j];
      }
    }
    while (deficit > 0.5) {
      const spare = w.map((x, j) => Math.max(0, x - mins[j]));
      const room = spare.reduce((a, b) => a + b, 0);
      if (room <= 0.5) return null;
      const take = Math.min(deficit, room);
      for (let j = 0; j < w.length; j++) w[j] -= take * spare[j] / room;
      deficit -= take;
    }
    return w;
  }

  // Hill-climbs from `start`: moves width from one column to another —
  // `step` pixels, or 2, 4, 8… times that, up to what the column can
  // spare (a single step often changes no line break at all) — while
  // that makes the table shorter, halving the step when no move does. `measure(widths)` is the table's height at those widths,
  // or null if they break a readability rule; it's called at most once
  // per set of widths. Returns { widths, height, measured }.
  function searchWidths({ start, mins, measure, step, minStep = 2, maxMeasures = 60 }) {
    const cache = new Map();
    const heightAt = w => {
      const key = w.map(x => Math.round(x)).join(",");
      if (!cache.has(key)) cache.set(key, cache.size < maxMeasures ? measure(w) : null);
      return cache.get(key);
    };
    let widths = start.slice();
    let height = heightAt(widths);
    if (height === null) return { widths, height: null, measured: cache.size };
    while (step >= minStep && cache.size < maxMeasures) {
      let best = null;
      for (let from = 0; from < widths.length; from++) {
        const spare = widths[from] - mins[from];
        for (let to = 0; to < widths.length; to++) {
          if (to === from) continue;
          for (let amount = step; amount <= spare; amount *= 2) {
            const next = widths.slice();
            next[from] -= amount;
            next[to] += amount;
            const h = heightAt(next);
            if (h !== null && h < (best ? best.height : height) - 0.5) best = { widths: next, height: h };
          }
        }
      }
      if (best) {
        widths = best.widths;
        height = best.height;
      } else {
        step /= 2;
      }
    }
    return { widths, height, measured: cache.size };
  }

  // Whether the searched widths beat the browser's own: shorter by at
  // least a line (and 3%), or — where the browser's own broke a rule —
  // readable at no real cost in height, or at any cost if the browser's
  // own table overflowed its width.
  function isImprovement({ nativeHeight, nativeReadable, nativeOverflows = false, height, lineHeight }) {
    if (height === null) return false;
    if (nativeOverflows) return true;
    if (!nativeReadable) return height <= nativeHeight * 1.05;
    return height <= nativeHeight - Math.max(lineHeight * 0.9, nativeHeight * 0.03);
  }

  // =========================================================
  // In the browser
  // =========================================================

  // Lines of text in `el`, by the tops of its line boxes.
  function lineCount(el) {
    const r = el.ownerDocument.createRange();
    r.selectNodeContents(el);
    const tops = [];
    for (const rect of r.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      if (!tops.some(t => Math.abs(t - rect.top) < rect.height / 2)) tops.push(rect.top);
    }
    return tops.length;
  }

  // Fits `table` to `width` pixels. `host`: an element to lay hidden
  // copies out in, styled like the table's own surroundings (see
  // reader.js). Writes a <colgroup> and returns true if it found better
  // widths; leaves the table as it was otherwise.
  function fitTable(table, width, host) {
    const doc = table.ownerDocument;
    const rows = Array.from(table.rows);
    const head = rows[0];
    if (!head || rows.length < 2) return false;
    const n = head.cells.length;
    if (n < 2 || rows.some(r => r.cells.length !== n || Array.from(r.cells).some(c => c.colSpan > 1))) return false;

    const copy = table.cloneNode(true);
    copy.querySelector(":scope > colgroup")?.remove();
    copy.style.width = width + "px";
    copy.style.tableLayout = "auto";
    host.replaceChildren(copy);
    const copyRows = Array.from(copy.rows);

    // The browser's own layout. (A word it can't break, like a long URL,
    // can make it wider than it's allowed to be.)
    const nativeTotal = copy.getBoundingClientRect().width;
    const nativeOverflows = nativeTotal > width + 1;
    const nativeWidths = Array.from(copyRows[0].cells, c => c.getBoundingClientRect().width * width / nativeTotal);
    const nativeHeight = copy.getBoundingClientRect().height;
    const nativeHeaderLines = Array.from(copyRows[0].cells, lineCount);

    // Word widths, set in the cells' own style.
    const probe = doc.createElement("span");
    probe.style.whiteSpace = "nowrap";
    const widthCache = new Map();
    const textWidth = (text, isHeader) => {
      const key = (isHeader ? "h" : "d") + text;
      if (!widthCache.has(key)) {
        const cell = isHeader ? copyRows[0].cells[0] : copyRows[1].cells[0];
        probe.textContent = text;
        cell.appendChild(probe);
        widthCache.set(key, probe.getBoundingClientRect().width);
        probe.remove();
      }
      return widthCache.get(key);
    };
    // Each column's unbreakable pieces, measured where they stand, in
    // their own style (a bold word is wider): all of one column's at once.
    const piecesOf = j => {
      const pending = [];
      for (const [r, row] of copyRows.entries()) {
        const walker = doc.createTreeWalker(row.cells[j], NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (const t of tokens(node.data)) {
            const span = doc.createElement("span");
            span.style.whiteSpace = "nowrap";
            span.textContent = t.text;
            node.parentNode.insertBefore(span, node);
            pending.push({ ...t, header: r === 0, span });
          }
        }
      }
      const pieces = pending.map(({ span, ...t }) => ({ ...t, width: span.getBoundingClientRect().width }));
      for (const { span } of pending) span.remove();
      return pieces;
    };
    const columns = [];
    for (let j = 0; j < n; j++) {
      const style = getComputedStyle(copyRows[1].cells[j]);
      columns.push({
        header: head.cells[j].textContent,
        cells: rows.slice(1).map(r => r.cells[j].textContent),
        pieces: piecesOf(j),
        padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
        fontSize: parseFloat(style.fontSize)
      });
    }
    const mins = minimumWidths(columns, textWidth, width);
    const stats = columnStats(columns, textWidth);
    const lineHeight = parseFloat(getComputedStyle(copyRows[1].cells[0]).lineHeight) || 14;

    // Fixed widths from here on.
    const colgroup = doc.createElement("colgroup");
    const cols = Array.from({ length: n }, () => colgroup.appendChild(doc.createElement("col")));
    copy.prepend(colgroup);
    copy.style.tableLayout = "fixed";

    const readable = () => {
      for (const row of copyRows) {
        for (const cell of row.cells) if (cell.scrollWidth > cell.clientWidth + 1) return false;
      }
      return Array.from(copyRows[0].cells).every((c, j) => lineCount(c) <= Math.max(2, nativeHeaderLines[j]));
    };
    const measure = w => {
      cols.forEach((col, j) => { col.style.width = w[j] + "px"; });
      return readable() ? copy.getBoundingClientRect().height : null;
    };

    // The browser's own layout, by the same rules (its header lines are
    // the yardstick, so only overflow and the minimums can fail it).
    colgroup.remove();
    copy.style.tableLayout = "auto";
    const nativeReadable = !nativeOverflows && nativeWidths.every((w, j) => w >= mins[j] - 1.5) && readable();
    copy.prepend(colgroup);
    copy.style.tableLayout = "fixed";

    // Two starting points — the browser's widths and balanced ones — and
    // the search goes on from the shorter (the balanced one when they're
    // within half a line: it reads better).
    const fromNative = respectMinimums(nativeWidths, mins, width);
    const balanced = fromNative && balancedWidths(stats, mins, width);
    if (!fromNative) {
      host.replaceChildren();
      return false;
    }
    const nativeStart = measure(fromNative);
    const balancedStart = balanced ? measure(balanced) : null;
    const start = balancedStart !== null && (nativeStart === null || balancedStart <= nativeStart + lineHeight / 2) ? balanced : fromNative;
    const result = searchWidths({ start, mins, measure, step: Math.max(4, Math.round(width * 0.04)) });
    host.replaceChildren();
    if (!isImprovement({ nativeHeight, nativeReadable, nativeOverflows, height: result.height, lineHeight })) return false;

    const total = result.widths.reduce((a, b) => a + b, 0);
    const final = doc.createElement("colgroup");
    for (const w of result.widths) {
      const col = doc.createElement("col");
      col.style.width = (w / total * 100).toFixed(3) + "%";
      final.appendChild(col);
    }
    table.querySelector(":scope > colgroup")?.remove();
    table.prepend(final);
    table.classList.add("table--fitted");
    return true;
  }

  const api = { tokens, isNumeric, isNumericColumn, columnStats, minimumWidths, balancedWidths, respectMinimums, searchWidths, isImprovement, fitTable };
  root.md2bookTableFit = api;
})(typeof window !== "undefined" ? window : globalThis);
