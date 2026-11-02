// EPUB owns pagination; the shared reader owns sheets and paper folds.
// Chapters are measured once; ordinary page DOM stays unchanged throughout a fold.
window.createEpubView = function createEpubView(book, mount, row, options = {}) {
  const root = document.documentElement, geometry = window.createReaderLayout(root, { tabletAspectRatio: .72, fixedTablet: true });
  const fixedLayout = book.package.metadata.layout === "pre-paginated";
  // Paper effects stack extra copies and blended text shadows on every sheet;
  // a touch device (iPad Safari) runs out of memory with them.
  // Highlights show through to the back only where "show-through" is on and there
  // is a back to the sheet (never on a phone): same switch, same strength.
  // On a touch device they are off unless the menu's "Paper effects" switch is on.
  let effectsPref = false;
  try { effectsPref = localStorage.getItem("md2book.epub.effects") === "1"; } catch { /* no storage */ }
  const bleedAllowed = !!row.showThrough && (!geometry.isTouch || effectsPref);
  if (geometry.isTouch && !effectsPref) {
    row = { ...row, showThrough: false, inkBleed: false, letterpress: false };
    root.classList.remove("show-through", "ink-bleed", "letterpress");
  }
  const content = window.createEpubContent(book, root, row, fixedLayout);
  root.classList.add("reader", "epub-fixed-paper");
  mount.tabIndex = 0;
  // One column a page always (the iPad's pages, on every screen): the pages,
  // their numbers and the handwriting on them are the same everywhere.
  let wantsDouble = null;
  let perSpread, width, height, scale, current, disposed = false;
  let serial = Promise.resolve(), background = Promise.resolve(), foregroundBusy = false, resizeTimer, engine, gesture, lastTheme = {};
  const listeners = new Map(), hooks = [], spreads = new Set(), turnWaiters = [];
  const waitForPaper = () => engine?.turn ? new Promise(resolve => turnWaiters.push(resolve)) : Promise.resolve();
  const outerMount = mount;
  // Measurement is temporary; every visible leaf lives in the same document
  // as Markdown. Shadow roots isolate publisher selectors, not rendering.
  const readingDocument = document;
  const styleReady = document.fonts.ready;
  const chapterCache = new Map();
  let measurement = Promise.resolve();
  const chapters = book.spine.spineItems.filter(section => section.linear);
  let chapterPages = new Map();
  const pageIndexes = new Map();
  let layoutKey = "", viewportKey = "", highlightsOf = () => [], placedNotes = () => [], onNotesPlaced = null, lastActivity = 0;
  let indexTimer, indexEpoch = 0, indexing = false, paginationError = false;
  // Whether the first page is the book's cover (only a picture): in a printed
  // book the blank inside of the cover comes next, so every later page sits one
  // place further on, and page 2 is on the right.
  let hasCover = false;
  const slot = folio => folio + (hasCover && folio > 1 ? 1 : 0);
  function pagination(point) {
    let offset = 0;
    for (const section of chapters) {
      if (section.index === point.index) break;
      if (!chapterPages.has(section.index)) { offset = null; break; }
      offset += chapterPages.get(section.index);
    }
    const total = chapters.every(section => chapterPages.has(section.index))
      ? chapters.reduce((sum, section) => sum + chapterPages.get(section.index), 0) : null;
    return { page: offset === null ? null : offset + point.sheet + 1, total, error: paginationError, counted: chapters.filter(section => chapterPages.has(section.index)).length, chapters: chapters.length };
  }
  // The book's thickness, as a printed book shows it open: beside the left
  // page the edges of the pages read, beside the right one those still to
  // read, each as thick as its share of the book (a long book is thicker).
  // Only with two single-column sheets side by side, once the book is counted.
  // Every page is as thick as every other (page px): a book of a thousand
  // pages is a thick book. Past EDGE_MAX it would crowd the pages out.
  const EDGE_MAX = 64, EDGE_PER_PAGE = .055, NOTE_OUT = 24, NOTE_OUT_MAX = 84;
  // A note's height: two lines of its name, or with none a sliver.
  const FLAG = 28, SLIVER = 10, GAP = 1;
  const bookEdges = () => !fixedLayout && root.dataset.layout === "tablet" && perSpread === 2;
  const bookTotal = () => chapters.length ? pagination({ index: chapters[0].index, sheet: 0 }).total : null;
  const thickness = total => total ? Math.min(EDGE_MAX, total * EDGE_PER_PAGE) : 0;
  // The spread's scale, with room for the edges as thick as this book's.
  let edgeRoom = 0;
  // Either side of the pages: the edges, and the bookmark notes out of them.
  const roomBeside = () => 2 * ((bookEdges() ? thickness(bookTotal()) : 0) + NOTE_OUT + 4);
  function fitScale() {
    edgeRoom = roomBeside();
    const fit = root.dataset.layout !== "phone" ? Math.min(geometry.viewportWidth() / (width * perSpread + edgeRoom), geometry.viewportHeight() / height) : 1;
    // How far a bookmark or sticky note sticks out past its own sheet's edge,
    // the same for all of them (and so out of the edge, each as far beyond the
    // others as its sheet is deeper): past the whole thickness of the book's
    // edge, and further as the screen leaves room for the top sheet's, within
    // reason (the deepest sheets' may run off the screen a little).
    const beside = (geometry.viewportWidth() / fit - width * perSpread) / 2, edge = bookEdges() ? thickness(bookTotal()) : 0;
    mount.style.setProperty("--flag-len", Math.min(edge + NOTE_OUT_MAX, Math.max(edge + NOTE_OUT, beside - 6)).toFixed(2) + "px");
    return fit;
  }
  // A bookmark gone to as in a printed book: the pages between are turned over
  // together and held up, 8/9 of the way over, a finger left in the page read
  // (`held`: that spread's first and last page numbers, and where it begins).
  // On each spread past it the held-up pages' top sheet (the page shown) stops
  // short of the book's outer edge: a strip of the page held under them shows
  // beyond, in their shadow, their edges standing there (setHeld), and the
  // stack beyond is only the pages under the finger. A tap on the strip lets
  // them fall back, to the page read; a double tap on the spine (epub-reader.js)
  // lets go, here; turning back to the page read, the finger is out.
  let held = null;
  function heldSide(spread) {
    if (!held || !spread.first || perSpread !== 2) return null;
    const first = pagination(spread.first).page, last = pagination(spread.last || spread.first).page;
    if (first === null || last === null) return null;
    return first > held.last ? "left" : last < held.first ? "right" : null;
  }
  function setEdges(spread) {
    if (!spread.first || !spread.inner.isConnected) return;
    const first = pagination(spread.first), last = pagination(spread.last || spread.first);
    const show = bookEdges() && first.total && first.page !== null && last.page !== null;
    for (const side of ["left", "right"]) {
      let edge = spread.inner.querySelector(`:scope > .book-edge--${side}`);
      if (!show) { edge?.remove(); continue; }
      const under = heldSide(spread) === side;
      const pages = side === "left" ? (under ? held.first - 1 : first.page - 1) : (under ? first.total - held.last : first.total - last.page);
      const w = Math.round(thickness(first.total) * pages / first.total * 4) / 4;
      if (!edge) { edge = element(`book-edge book-edge--${side}`); edge.setAttribute("aria-hidden", "true"); spread.inner.append(edge); }
      edge.style.width = w + "px";
      // The stack is seen a little from the side: lower toward its outer edge.
      edge.style.setProperty("--slope", (w * .3).toFixed(2) + "px");
      edge.hidden = w < .5;
    }
  }

  // A spread's edges and the notes in them follow from where it lies in
  // the book: made with it, and again only when that changes (the book
  // counted further), not on every turn.
  function setStack(spread) {
    if (!spread.first) return;
    const first = pagination(spread.first), last = pagination(spread.last || spread.first);
    const key = `${first.page}|${last.page}|${first.total}|${held?.first ?? ""}`;
    if (spread.stackKey === key) return;
    spread.stackKey = key;
    setEdges(spread); setHeld(spread); setTabs(spread);
  }
  // Held up on `side`: the strip's width (`w`: the top sheet's edge, that far
  // in), how thick the pages held up are (`block`) and the stack under the
  // finger beyond (`outer`), in page px; and how deep a page's edge is, by its
  // number (`depth`: in the stack under the finger, or for one of the pages
  // held up, negative: in from the outer edge, at their edges in the strip).
  function heldGeometry(spread) {
    const side = heldSide(spread), total = side && pagination(spread.first).total;
    if (!total || !bookEdges()) return null;
    const first = pagination(spread.first).page, last = pagination(spread.last || spread.first).page, stack = thickness(total);
    const block = stack * (side === "left" ? first - held.first : held.last - last) / total;
    const outer = stack * (side === "left" ? held.first - 1 : total - held.last) / total, w = Math.max(44, block + 24);
    const depth = at => {
      const inBlock = side === "left" ? at >= held.last : at <= held.first;
      if (inBlock) return -(w - Math.min(Math.max(.5, stack * (side === "left" ? first - at : at - last) / total), Math.max(.5, block - .5)));
      return Math.min(Math.max(outer - .5, 0), Math.max(.5, stack * (side === "left" ? held.first - at : at - held.last) / total));
    };
    return { side, w, block, outer, depth };
  }
  function setHeld(spread) {
    for (const page of spread.pages) page.querySelector(":scope > .epub-held")?.remove();
    const g = heldGeometry(spread);
    if (!g) return;
    const side = g.side, page = spread.pages[side === "left" ? 0 : spread.pages.length - 1];
    const strip = element(`epub-held epub-held--${side}`);
    strip.setAttribute("role", "button"); strip.setAttribute("aria-label", "Back to the page held");
    strip.style.setProperty("--block", g.block.toFixed(2) + "px"); strip.style.width = g.w + "px";
    strip.addEventListener("click", event => { event.stopPropagation(); returnHeld(); });
    page.append(strip);
  }
  const restack = () => { for (const spread of spreads) setStack(spread); };
  // A turn straight to `target` (not the next or previous spread), as one.
  async function turnTo(target) {
    await waitForPaper();
    const from = current, section = book.spine.get(target.index ?? target);
    for (const preceding of chapters) {
      if (preceding.index === section?.index) break;
      if (!chapterPages.has(preceding.index)) await chapter(preceding, Boolean(options.bookKey));
    }
    const next = await createSpread(target, false, true);
    if (!from || matchMedia("(prefers-reduced-motion: reduce)").matches) { activate(next); trim(); prefetch(); return; }
    const forward = compareCfi(next.location.start.cfi, from.location.start.cfi) > 0;
    next.el.classList.add("is-near");
    turns.current = forward ? 0 : 1;
    turns.spreads = forward ? [from.el, next.el] : [next.el, from.el];
    turns.spreadPages = forward ? [from.pages, next.pages] : [next.pages, from.pages];
    await new Promise(resolve => { finishTurn({ from, next }, resolve); engine.turnPage(forward ? 1 : -1); });
    trim(); prefetch();
  }
  function returnHeld() {
    return enqueue(async () => {
      if (!held) return;
      await turnTo(held.cfi);
    }).catch(error => emit("displayError", error));
  }
  function updatePageNumbers() {
    // The book counted (or its count changed): room for its edges.
    if (perSpread && roomBeside() !== edgeRoom) {
      scale = fitScale();
      turns.viewScale = scale;
      for (const spread of spreads) spread.inner.style.transform = `scale(${scale})`;
    }
    // The edges grow once the book is counted: the notes in them move with them.
    for (const spread of spreads) setStack(spread);
    for (const spread of spreads) {
      for (const page of spread.pages.flatMap(page => [page, ...page.querySelectorAll(':scope > .page-back')])) {
        if (!page.dataset.section) continue;
        const count = pagination({ index: Number(page.dataset.section), sheet: Number(page.dataset.sheet) });
        const label = count.page === null ? "" : count.total === null ? String(count.page) : `${count.page}/${count.total}`;
        for (const number of page.querySelectorAll(":scope > .page-number, :scope > .page-bleed > .page-number")) number.textContent = label;
      }
      if (spread.first) spread.location.pagination = pagination(spread.first);
    }
    if (current) emit("pagination", current.location.pagination);
    keepCounts();
  }
  const emit = (name, ...args) => (listeners.get(name) || []).forEach(fn => fn(...args));
  const enqueue = fn => {
    const result = serial.then(async () => {
      if (disposed) return;
      foregroundBusy = true;
      try { return await fn(); }
      finally { foregroundBusy = false; }
    });
    serial = result.catch(() => {});
    return result;
  };
  // Speculative rendering must not hold the foreground navigation queue.
  // A turn only waits for its own destination, never the opposite neighbor
  // or a chapter being measured for the global page count.
  const enqueueBackground = fn => {
    const result = background.then(async () => {
      await waitForPaper();
      return disposed ? undefined : fn();
    });
    background = result.catch(() => {});
    return result;
  };
  const paint = () => new Promise(resolve => requestAnimationFrame(resolve));
  const element = window.createPageTurn.element;
  const turns = { pageWidth: 0, pageHeight: 0, viewScale: 1, perSpread: 1, current: 0, spreads: [], spreadPages: [] };
  // A turning sheet carries its bookmark notes on both faces (a note sticks out
  // of the sheet's edge, seen from either side): each face's note is copied,
  // mirrored, onto the other for the turn; and the spread on top, whose notes
  // show while a page turns, keeps those between its pages, not the turning
  // sheet's (that is still turning, not yet in a stack).
  turns.onTurnStart = ({ frontPage, backPage, top }) => {
    const cfis = new Set();
    for (const [from, to] of [[frontPage, backPage], [backPage, frontPage]]) {
      if (!from) continue;
      for (const note of from.querySelectorAll(":scope > .epub-tab.is-here:not(.is-twin)")) {
        cfis.add(note.dataset.cfi);
        if (!to) continue;
        const twin = note.cloneNode(true);
        twin.classList.add("is-twin");
        twin.classList.toggle("epub-tab--left", note.classList.contains("epub-tab--right"));
        twin.classList.toggle("epub-tab--right", note.classList.contains("epub-tab--left"));
        to.append(twin);
      }
    }
    for (const note of top.querySelectorAll(".epub-tabs--behind > .epub-tab")) note.classList.toggle("is-turning", cfis.has(note.dataset.cfi));
    // So with its sticky notes: each face's is copied, mirrored, onto the other
    // (tracing paper: seen from behind, its writing backwards and faint), so
    // the bit sticking out past the sheet goes over with it.
    for (const [from, to] of [[frontPage, backPage], [backPage, frontPage]]) {
      const notes = from && to ? from.querySelectorAll(":scope > .epub-stickies:not(.epub-sticky-twins) > .epub-sticky") : [];
      if (!notes.length) continue;
      const layer = element("epub-stickies epub-sticky-twins");
      for (const note of notes) {
        const twin = note.cloneNode(true), left = note.classList.contains("epub-sticky--right");
        twin.classList.add("is-twin"); twin.classList.remove("is-editing");
        twin.classList.toggle("epub-sticky--left", left); twin.classList.toggle("epub-sticky--right", !left);
        layer.append(twin);
      }
      to.append(layer);
    }
    // (And the bits of its sticky notes in the stack: they turn on it.)
    const turning = new Set([frontPage, backPage].filter(page => page?.dataset.section !== undefined)
      .map(page => String(pagination({ index: +page.dataset.section, sheet: +page.dataset.sheet }).page)));
    for (const edge of top.querySelectorAll(".epub-sticky-edge")) edge.classList.toggle("is-turning", turning.has(edge.dataset.page));
  };
  turns.onTurnEnd = () => {
    for (const el of mount.querySelectorAll(".epub-tab.is-twin")) el.remove();
    for (const el of mount.querySelectorAll(".is-turning")) el.classList.remove("is-turning");
    for (const el of mount.querySelectorAll(".epub-sticky-twins")) el.remove();
  };
  engine = window.createPageTurn(turns);
  function configure() {
    clearTimeout(indexTimer); indexEpoch++; indexing = false; paginationError = false;
    geometry.applyLayout(true);
    perSpread = geometry.pagesPerSpread(wantsDouble);
    const probe = element("page"); mount.append(probe);
    width = probe.offsetWidth; height = probe.offsetHeight; probe.remove();
    // (Its last place, the columns, is always 1: kept so counts and handwriting saved under it still match.)
    const nextKey = JSON.stringify([root.dataset.layout, width, height, 1]);
    if (nextKey !== layoutKey) {
      layoutKey = nextKey;
      if (!pageIndexes.has(layoutKey)) pageIndexes.set(layoutKey, new Map());
      chapterPages = pageIndexes.get(layoutKey);
      // Keep recent geometries for column/spread toggles without retaining
      // every intermediate window size for the lifetime of a long reading.
      pageIndexes.delete(layoutKey); pageIndexes.set(layoutKey, chapterPages);
      if (pageIndexes.size > 4) pageIndexes.delete(pageIndexes.keys().next().value);
    }
    viewportKey = `${geometry.viewportWidth()}x${geometry.viewportHeight()}`;
    // Two sheets side by side on the tablet page: room on either side for the
    // edges of the pages read and still to read (see setEdges).
    scale = fitScale();
    Object.assign(turns, { pageWidth: width, pageHeight: height, viewScale: scale, perSpread });
    mount.style.setProperty("--plane", engine.planeSize() + "px");
  }
  class PaperRendition extends ePub.Rendition {
    constructor(book, options) {
      const existing = new Set(book.spine.hooks.content.list());
      super(book, options);
      this.spineHooks = book.spine.hooks.content.list().filter(hook => !existing.has(hook));
    }
    destroy() {
      for (const hook of this.spineHooks) this.book.spine.hooks.content.deregister(hook);
      this.q.stop();
      super.destroy();
    }
    handleLinks(contents) {
      contents.on("linkClicked", href => enqueue(() => display(book.path.relative(href))).catch(error => emit("displayError", error)));
    }
  }
  function destroySpread(spread) {
    spread.renders.forEach(r => r.destroy());
    spread.el.remove(); spreads.delete(spread);
  }
  function adjacent(point, forward) {
    if (forward && point.sheet + 1 < point.total) return { index: point.index, sheet: point.sheet + 1 };
    if (!forward && point.sheet > 0) return { index: point.index, sheet: point.sheet - 1 };
    const section = book.spine.get(point.index);
    const next = forward ? section.next() : section.prev();
    return next ? { index: next.index, sheet: forward ? 0 : -1 } : null;
  }
  function pageShell(spread, side, hasNotes) {
    const page = element(`page epub-face page--${side ? "right" : "left"}`);
    page.classList.toggle("page--notes", hasNotes);
    const area = element("page-area"), viewport = element("epub-viewport"), number = element("page-number");
    area.append(viewport); page.append(area, number);
    spread.inner.append(engine.leaf("", [page])); spread.pages.push(page);
    Object.assign(viewport.style, {width:area.offsetWidth + "px", height:area.offsetHeight + "px"});
    return {page, area, viewport, number};
  }
  // Laid-out chapters hold a DOM clone of every sheet: keep only the few read
  // lately. Page counting (`transient`) measures every chapter once but must not
  // keep them, or a long book fills the device's memory.
  const CHAPTER_CACHE = geometry.isTouch ? 3 : 6;

  // --- Chapters kept on this device ---------------------------------------
  // A chapter laid out once is kept (IndexedDB) as plain data: its pages as
  // frozen HTML, its positions, anchors and notes. Opening the book, turning
  // into a chapter, jumping to a bookmark in it or showing it through the
  // paper then reads it back instead of laying it out again, offline too.
  // Kept per book and reader code (options.bookKey) and per layout: screen
  // geometry, settings, theme and fonts; anything else is laid out afresh.
  // The background page count lays out (and so keeps) every chapter.
  const KEEP_DB = "md2book-epub-layout";
  let keepDb = null;
  function keepStore(mode, name, run) {
    if (!options.bookKey || !window.indexedDB) return Promise.resolve(null);
    keepDb ||= new Promise(resolve => {
      const opening = indexedDB.open(KEEP_DB, 1);
      opening.onupgradeneeded = () => { opening.result.createObjectStore("chapters"); opening.result.createObjectStore("totals"); };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = opening.onblocked = () => resolve(null);
    });
    return keepDb.then(db => db && new Promise(resolve => {
      let tx;
      try { tx = db.transaction(name, mode); } catch { return resolve(null); }
      const request = run(tx.objectStore(name));
      tx.oncomplete = () => resolve(request?.result ?? null);
      tx.onerror = tx.onabort = () => resolve(null);
    })).catch(() => null);
  }
  const hashText = text => {
    let a = 0x811c9dc5, b = 0x01000193;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 2246822519); }
    return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
  };
  function keepKey(part) {
    const css = getComputedStyle(root);
    const fonts = [css.getPropertyValue("--serif"), css.getPropertyValue("--title-serif"), css.getPropertyValue("--body-size"), css.getPropertyValue("--body-leading")];
    return `${options.bookKey}|${hashText(JSON.stringify([layoutKey, row, lastTheme, devicePixelRatio, fonts]))}|${part}`;
  }
  // The whole book's count, every chapter's pages, kept as one record once
  // counted: read before the first page is shown, so its edges (and the
  // bookmarks in them) come with it, not chapter by chapter afterwards.
  const keptCounts = new Set();
  async function readCounts() {
    if (!options.bookKey || chapters.every(section => chapterPages.has(section.index))) return;
    const counts = await keepStore("readonly", "totals", store => store.get(keepKey("book")));
    if (!counts || !chapters.every(section => counts[section.index] > 0)) return;
    for (const section of chapters) chapterPages.set(section.index, counts[section.index]);
    keptCounts.add(layoutKey);
  }
  function keepCounts() {
    if (!options.bookKey || keptCounts.has(layoutKey) || !chapters.every(section => chapterPages.has(section.index))) return;
    keptCounts.add(layoutKey);
    const counts = Object.fromEntries(chapters.map(section => [section.index, chapterPages.get(section.index)]));
    keepStore("readwrite", "totals", store => store.put(counts, keepKey("book")));
  }
  // Pictures and fonts inside a book are blob: addresses made afresh each time
  // it opens: kept as their paths in the book, made current again when read.
  function bookResources() {
    const urls = book.resources?.urls || [], blobs = book.resources?.replacementUrls || [];
    if (!urls.length || urls.length !== blobs.length) return { toPaths: text => /blob:/.test(text) ? null : text, fromPaths: text => text };
    const toPath = new Map(blobs.map((blob, i) => [blob, urls[i]])), toBlob = new Map(urls.map((url, i) => [url, blobs[i]]));
    return {
      toPaths: text => {
        let missing = false;
        const out = text.replace(/blob:[^"')\s]+/g, blob => toPath.has(blob) ? "md2book-res:" + encodeURIComponent(toPath.get(blob)) : (missing = true, blob));
        return missing ? null : out;
      },
      fromPaths: text => text.replace(/md2book-res:([\w.~!*'()%-]+)/g, (token, path) => toBlob.get(decodeURIComponent(path)) || token)
    };
  }
  let pruned = false;
  async function keepChapter(section, entry) {
    if (!options.bookKey) return;
    const { toPaths } = bookResources();
    const styles = [], fonts = [];
    const index = (list, value) => { const at = list.indexOf(value); return at < 0 ? list.push(value) - 1 : at; };
    const sheets = [];
    for (const host of entry.pages) {
      const data = content.serializePage(host);
      const css = data && toPaths(data.css), fontText = data && toPaths(JSON.stringify(data.fonts));
      const parts = data?.parts.map(part => ({ ...part, html: toPaths(part.html) }));
      // A page whose pictures can't be found again later isn't kept.
      if (!data || css === null || fontText === null || parts.some(part => part.html === null)) return;
      sheets.push({ host: data.host, attrs: data.attrs, parts, css: index(styles, css), fonts: index(fonts, fontText) });
    }
    const key = keepKey(section.index);
    await keepStore("readwrite", "chapters", store => store.put({ total: entry.total, locations: entry.locations, anchors: [...entry.anchors], notes: entry.notes, styles, fonts, sheets }, key));
    await keepStore("readwrite", "totals", store => store.put(entry.total, key));
    // This book as it was before (another file, or older reader code): gone.
    if (!pruned && options.bookId) {
      pruned = true;
      const range = IDBKeyRange.bound(options.bookId + ":", options.bookId + ":\uffff");
      for (const name of ["chapters", "totals"]) keepStore("readwrite", name, store => {
        const cursor = store.openKeyCursor(range);
        cursor.onsuccess = () => { const at = cursor.result; if (!at) return; if (!String(at.key).startsWith(options.bookKey + "|")) store.delete(at.key); at.continue(); };
        return null;
      });
    }
  }
  async function keptChapter(section, transient) {
    if (!options.bookKey) return null;
    const key = keepKey(section.index);
    if (transient) {
      const total = await keepStore("readonly", "totals", store => store.get(key));
      return total ? { pages: [], locations: [], total, notes: [], anchors: new Map() } : null;
    }
    const kept = await keepStore("readonly", "chapters", store => store.get(key));
    if (!kept) return null;
    try {
      const { fromPaths } = bookResources();
      const styles = kept.styles.map(fromPaths), fonts = kept.fonts.map(text => JSON.parse(fromPaths(text)));
      const pages = kept.sheets.map(sheet => content.thawPage({ host: sheet.host, attrs: sheet.attrs, css: styles[sheet.css], fonts: fonts[sheet.fonts],
        parts: sheet.parts.map(part => ({ ...part, html: fromPaths(part.html) })) }, readingDocument));
      return { pages, locations: kept.locations, total: kept.total, notes: kept.notes, anchors: new Map(kept.anchors) };
    } catch { return null; }
  }

  function chapter(section, transient = false) {
    const key = `${layoutKey}:${section.index}`;
    if (chapterCache.has(key)) {
      const hit = chapterCache.get(key);
      chapterCache.delete(key); chapterCache.set(key, hit);
      return hit;
    }
    {
      const pending = measurement.then(async () => {
        await waitForPaper();
        const kept = await keptChapter(section, transient);
        if (kept) {
          chapterPages.set(section.index, kept.total); updatePageNumbers();
          return kept;
        }
        const notes = fixedLayout ? [] : await content.notesFor(section);
        const spread = {el:element("spread epub-preparing"), inner:element("spread-inner"), pages:[], renders:[]};
        spread.el.inert = true; spread.el.setAttribute("aria-hidden","true");
        spread.el.append(spread.inner); outerMount.append(spread.el);
        const {page,area,viewport} = pageShell(spread, 0, notes.length > 0);
        let rendition;
        try {
          const r = rendition = new PaperRendition(book, {
            width: area.offsetWidth, height: area.offsetHeight,
            flow: "paginated", spread: "none", minSpreadWidth: 0, gap: 0,
            allowScriptedContent: false, allowPopups: false, resizeOnOrientationChange: false
          });

          let prepared, prepareError;
          const ready = new Promise(resolve => { prepared = resolve; });
          r.hooks.content.register(async contents => {
            try {
              await waitForPaper();
              await content.prepare(contents, notes);

            } catch (error) { prepareError = error; }
            finally { prepared(); }
          });
          r.themes.default(lastTheme);

          r.attachTo(viewport);
          // Measurement and CFI navigation always happen at scale 1, while hidden.
          await r.display(section.href);
          await ready;
          if (prepareError) throw prepareError;
          await waitForPaper();
          await paint();
          r.manager.views.forEach(view => view.expand());
          const manager = r.manager, view = manager.views.first();
          let total = fixedLayout ? 1 : Math.max(1, Math.round(view.width() / manager.layout.delta));
          // EPUB.js rounds a whole-range bounding width up to a column. A float
          // overhanging the first column can therefore add an empty final sheet.
          if (!fixedLayout && manager.settings.direction !== "rtl") {
            while (total > 1 && !content.hasPage(view.contents, (total - 1) * manager.layout.delta, manager.layout.delta)) total--;
          }

          // Counting pages for the whole-book total needs only the number: no
          // frozen sheets, no positions (they are for reading this chapter).
          // (Unless chapters are kept on this device: then counting lays the
          // chapter out in full, keeps it, and lets it go.)
          if (transient && !options.bookKey) {
            chapterPages.set(section.index,total); updatePageNumbers();
            return {pages:[],locations:[],total,notes,anchors:new Map()};
          }
          const pages = [], locations = [], anchors = new Map();
          for (const el of view.contents.document.querySelectorAll('[id]')) {
            const rect = el.getClientRects()[0];
            if (rect) anchors.set(el.id, Math.max(0,Math.min(total-1,Math.floor(rect.left / manager.layout.delta))));
          }
          for (let sheet = 0; sheet < total; sheet++) {
            await waitForPaper();
            let offset = sheet * manager.layout.delta;
            if (manager.settings.direction === "rtl") offset = manager.settings.rtlScrollType === "default" ? view.width() - manager.layout.delta - offset : -offset;
            manager.scrollTo(offset, 0, true);
            const raw = r.currentLocation();
            const cfi = !fixedLayout && manager.settings.direction !== "rtl" ? content.startCfi(view.contents, sheet * manager.layout.delta, manager.layout.delta) : null;
            const displayed = {page:sheet + 1,total};
            locations.push({start:{...raw.start,cfi:cfi || raw.start.cfi,displayed},end:{...raw.end,displayed}});
            pages.push(content.freezePage(page,view.contents,readingDocument));
            // Yield between fragments, never carry chapter measurement into a fold.
            await new Promise(resolve => setTimeout(resolve,0));
          }
          chapterPages.set(section.index,total); updatePageNumbers();
          await keepChapter(section, {pages,locations,total,notes,anchors}).catch(() => {});
          if (transient) return {pages:[],locations:[],total,notes,anchors:new Map()};
          return {pages,locations,total,notes,anchors};
        } finally { rendition?.destroy(); spread.el.remove(); }
      });
      if (!transient) {
        chapterCache.set(key,pending);
        while (chapterCache.size > CHAPTER_CACHE) chapterCache.delete(chapterCache.keys().next().value);
      }
      measurement = pending.catch(() => {});
      pending.catch(() => chapterCache.delete(key));
      return pending;
    }
  }
  // --- Bookmarks (a ribbon on the sheet) and highlight bleed-through -------
  let bookmarkCfis = () => [], onRibbon = null, inkPaint = null;
  // Every bookmark as a tab on the spread's top edge (`tabs()`: [{ cfi, at,
  // latest }], `at` 0–1 through the book); `latest()`: the newest one's cfi.
  let bookmarkTabs = () => [], latestBookmark = () => null, onTab = null;
  const pageRange = new WeakMap();
  const compareCfi = (a, b) => { try { return new ePub.CFI().compare(a, b); } catch { return 0; } };
  const ribbonHits = page => {
    const range = pageRange.get(page);
    // Within this page's chapter, from its first position up to the next page's.
    return range ? bookmarkCfis().filter(cfi => cfi.startsWith(`epubcfi(${range.base}!`) &&
      compareCfi(cfi, range.start) >= 0 && (!range.end || compareCfi(cfi, range.end) < 0)) : [];
  };
  // Bookmarks are sticky notes now (setTabs): no ribbon on the page.
  function setRibbon(page) { page.querySelector(":scope > .epub-ribbon")?.remove(); }
  // Bookmarks are sticky notes stuck in the book, sticking out of its fore-edge
  // as in a printed book: a note between pages already read out of the left
  // edge, between pages still to read out of the right one, as deep in the
  // stack as its page is (EDGE_PER_PAGE a page) and as far down the edge as its
  // place in the book (top 0 %, bottom 100 %). The note of a page shown is on
  // that very sheet, sticking out of its outer edge, and turns with it. A note
  // given a name shows its first two characters.
  const pageOf = (spread, cfi) => spread.pages.find(page => {
    const range = pageRange.get(page);
    return range && cfi.startsWith(`epubcfi(${range.base}!`) && compareCfi(cfi, range.start) >= 0 && (!range.end || compareCfi(cfi, range.end) < 0);
  });
  function noteFor(tab, side) {
    // A note with no name given is a mere sliver.
    const el = element(`epub-tab epub-tab--${side}` + (tab.starred ? " is-starred" : tab.latest ? " is-latest" : "") + (tab.name ? "" : " is-unnamed"));
    el.dataset.cfi = tab.cfi;
    el.style.setProperty("--at", tab.at.toFixed(4));
    const name = element("epub-tab-name-short"), text = element("epub-tab-text");
    text.textContent = tab.name; name.append(text); el.append(name);
    el.setAttribute("role", "button"); el.setAttribute("aria-label", tab.label || "Bookmark");
    // A tap or click goes there, a double one names it; the pointer resting
    // on it (or a finger held on it) shows its whole name. (Not while its
    // name is being written: then a press is in the writing.)
    let held = null, lastUp = null;
    const naming = () => el.classList.contains("is-editing");
    el.addEventListener("click", event => event.stopPropagation());
    el.addEventListener("mouseenter", () => onTab?.(tab.cfi, el, "preview"));
    el.addEventListener("mouseleave", () => onTab?.(tab.cfi, el, "unpreview"));
    el.addEventListener("pointerdown", event => {
      clearTimeout(held?.timer); held = null;
      if (naming() || event.button > 0) return;
      held = { x: event.clientX, y: event.clientY, timer: event.pointerType === "mouse" ? 0
        : setTimeout(() => { held = null; onTab?.(tab.cfi, el, "preview"); }, 500) };
    });
    el.addEventListener("pointermove", event => { if (held && Math.hypot(event.clientX - held.x, event.clientY - held.y) > 8) { clearTimeout(held.timer); held = null; } });
    el.addEventListener("pointercancel", () => { clearTimeout(held?.timer); held = null; });
    el.addEventListener("pointerup", () => {
      if (!held || naming()) return;   // held long, moved away, or in the writing
      clearTimeout(held.timer); held = null;
      if (lastUp) { clearTimeout(lastUp); lastUp = null; onTab?.(tab.cfi, el, "edit"); return; }
      lastUp = setTimeout(() => { lastUp = null; onTab?.(tab.cfi, el, "jump"); }, 300);
    });
    return el;
  }
  function setTabs(spread) {
    if (!spread.inner.isConnected) return;
    const tabs = bookmarkTabs();
    for (const page of spread.pages) page.querySelectorAll(":scope > .epub-tab, :scope > .epub-held > .epub-tab").forEach(el => el.remove());
    let behind = spread.inner.querySelector(":scope > .epub-tabs--behind");
    if (!spread.first || !spread.location) { behind?.remove(); return; }
    const first = pagination(spread.first), last = pagination(spread.last || spread.first), total = first.total;
    const stack = bookEdges() ? thickness(total) : 0;
    // How thick the stack is on either side of this spread.
    const sides = { left: total ? stack * ((first.page ?? 1) - 1) / total : 0, right: total ? stack * (total - (last.page ?? total)) / total : 0 };
    // (Pages held up on one side: that stack is only those under the finger,
    // and the top sheet's edge is in from the outer edge, see heldGeometry.)
    const hg = heldGeometry(spread);
    if (hg) sides[hg.side] = hg.outer;
    const depthOf = (sideName, at) => hg?.side === sideName ? hg.depth(at)
      : Math.min(Math.max(sides[sideName] - .5, 0), Math.max(.5, stack * (sideName === "right" ? at - (last.page ?? first.page) : (first.page ?? 1) - at) / total));
    // The sticky notes of pages turned (or still to turn): only the bit of each
    // that sticks out of the edge, from its page's depth there, where it was on
    // its page; under the bookmarks, and not to be pressed.
    const slivers = [], heldSlivers = [];
    if (stack && total && first.page !== null && last.page !== null) for (const { id, place } of placedNotes()) {
      const right = place.page > last.page;
      if (!right && place.page >= first.page) continue;
      const depth = depthOf(right ? "right" : "left", place.page);
      const el = element(`epub-sticky-edge epub-sticky-edge--${right ? "right" : "left"}`);
      el.dataset.id = id; el.dataset.page = place.page;
      el.style.top = place.y + "px"; el.style.height = place.h + "px";
      el.style.setProperty("--depth", depth.toFixed(2) + "px"); el.style.setProperty("--sticky-out", stickyOut(id) + "px");
      // (One of the pages held up: over the strip, so with the bookmarks.)
      (depth < 0 ? heldSlivers : slivers).push(el);
    }
    // (Under the pages, so under a page shown's own sticky notes too.)
    let edges = spread.inner.querySelector(":scope > .epub-sticky-edges");
    if (slivers.length) {
      if (!edges) { edges = element("epub-sticky-edges"); spread.inner.prepend(edges); }
      edges.replaceChildren(...slivers);
    } else edges?.remove();
    if (!tabs.length && !heldSlivers.length) { behind?.remove(); return; }
    if (!behind) { behind = element("epub-tabs epub-tabs--behind"); spread.inner.prepend(behind); }
    const elsewhere = [...heldSlivers], placed = [];
    // The page under the finger shows in the strip past the pages held up: its
    // notes are on it there, as on a page shown, under the pages held up.
    const strip = hg && spread.inner.querySelector(`.epub-held--${hg.side}`);
    const underPage = hg && (hg.side === "left" ? held.first : held.last);
    for (const tab of tabs) {
      if (strip && tab.page === underPage) {
        const note = noteFor(tab, hg.side);
        note.classList.add("is-here");
        strip.append(note);
        placed.push({ el: note, side: hg.side, at: tab.at, h: tab.name ? FLAG : SLIVER });
        continue;
      }
      const page = pageOf(spread, tab.cfi);
      if (page) {
        // On its sheet, out of the sheet's outer edge (a lone page: by its place in the book).
        const right = perSpread === 2 ? page.classList.contains("page--right") : tab.at >= .5;
        const note = noteFor(tab, right ? "right" : "left");
        note.classList.add("is-here");
        // (Pages held up: the top sheet's edge is in from the outer edge.)
        if (hg?.side === (right ? "right" : "left")) note.style.setProperty("--held-w", hg.w + "px");
        page.append(note);
        placed.push({ el: note, side: right ? "right" : "left", at: tab.at, h: tab.name ? FLAG : SLIVER });
        continue;
      }
      // Between other pages: before this spread on the left, after it on the
      // right, by its exact place (the page a percentage suggests can be off
      // by a few). How deep it lies: from that page, within its side's stack.
      const right = compareCfi(tab.cfi, spread.location.start.cfi) > 0;
      const depth = !total || !stack ? 0 : depthOf(right ? "right" : "left", tab.page);
      const note = noteFor(tab, right ? "right" : "left");
      note.style.setProperty("--depth", depth.toFixed(2) + "px");
      elsewhere.push(note);
      placed.push({ el: note, side: right ? "right" : "left", at: tab.at, h: tab.name ? FLAG : SLIVER });
    }
    behind.replaceChildren(...elsewhere);
    // Down each side as far as its place in the book, but never on top of
    // another (a name must stay readable): from the top down, each at least a
    // flag below the one above; what runs off the bottom goes back up.
    for (const side of ["left", "right"]) {
      const list = placed.filter(p => p.side === side).sort((a, b) => a.at - b.at);
      let below = -Infinity;
      for (const p of list) { p.y = Math.max(p.at * (height - p.h), below + GAP); below = p.y + p.h; }
      let above = Infinity;
      for (const p of list.slice().reverse()) { p.y = Math.max(0, Math.min(p.y, height - p.h, above - p.h - GAP)); above = p.y; }
      for (const p of list) p.el.style.top = p.y.toFixed(2) + "px";
    }
  }

  // A highlight's note is written on a sticky note in the page's outer margin
  // (sticking out a little past the book's edge), level with where the passage
  // begins, or just below the footnote or note above it there. The text keeps
  // the note's underline, where it belongs. A note being written on stays as
  // it is (only moved), and so does its delete button (epub-reader.js).
  // How far a sticky note sticks out past its sheet: a little, each its own
  // little bit more or less (by its note, so always the same).
  const stickyOut = id => { let h = 2166136261; for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619); return 8 + (h >>> 0) % 5; };
  function setStickies(page) {
    let layer = page.querySelector(":scope > .epub-stickies");
    const keep = layer?.querySelector(".epub-sticky.is-editing");
    if (layer) for (const child of [...layer.children]) if (child !== keep && !child.classList.contains("epub-sticky-delete")) child.remove();
    const area = page.querySelector(":scope > .page-area");
    const marks = area?.querySelector(".epub-page-content")?.shadowRoot?.querySelectorAll("span.epub-hl[data-note]") || [];
    const notes = new Map(highlightsOf(+page.dataset.section).filter(h => h.note || h.draft).map(h => [h.id, h.note || ""]));
    const box = page.getBoundingClientRect(), k = page.offsetHeight / (box.height || 1);   // screen px → page px
    const side = perSpread === 2 && page.classList.contains("page--left") ? "left" : "right";
    const a = area?.getBoundingClientRect(), margin = a ? (side === "left" ? a.left - box.left : box.right - a.right) * k : 0;
    const items = [], seen = new Set();
    for (const mark of marks) {
      const id = mark.dataset.id, r = mark.getClientRects()[0];
      if (seen.has(id) || !notes.has(id) || !r) continue;
      seen.add(id);
      const el = keep?.dataset.id === id ? keep : element(`epub-sticky epub-sticky--${side}`);
      if (el !== keep) {
        const text = element("epub-sticky-text"); text.textContent = notes.get(id);
        el.dataset.id = id; el.append(text); el.style.setProperty("--sticky-w", Math.max(62, margin - 8) + "px");
        el.style.setProperty("--sticky-out", stickyOut(id) + "px");
      }
      items.push({ el, top: (r.top - box.top) * k });
    }
    if (!items.length && !keep) { layer?.remove(); return; }
    if (!layer) { layer = element("epub-stickies"); page.append(layer); }
    for (const item of items) if (item.el !== keep) layer.append(item.el);
    for (const { el } of items) { const text = el.firstChild; el.classList.toggle("is-cut", text.scrollHeight > text.clientHeight + 1); }
    // The footnotes in that margin stay where they are; the notes go round them.
    const taken = [...page.querySelectorAll(`:scope > .page-comments > .comment-margin-marker--${side}`)]
      .map(note => [note.offsetTop, note.offsetTop + note.offsetHeight]);
    const GAP = 6;
    let cursor = 0;
    for (const item of items.sort((x, y) => x.top - y.top)) {
      const h = item.el.offsetHeight;
      let y = Math.max(item.top, cursor);
      for (let moved = true; moved;) {
        moved = false;
        for (const [t, b] of taken) if (y < b + GAP && y + h + GAP > t) { y = b + GAP; moved = true; }
      }
      item.el.style.top = y + "px";
      cursor = y + h + GAP;
    }
    // Where each is now, for the bit of it in the edge once its page is turned.
    const number = pagination({ index: +page.dataset.section, sheet: +page.dataset.sheet }).page;
    if (number !== null) onNotesPlaced?.(items.filter(item => item.el !== keep && !item.el.classList.contains("is-twin"))
      .map(item => ({ id: item.el.dataset.id, place: { page: number, y: parseFloat(item.el.style.top), h: item.el.offsetHeight } })));
  }
  // A highlight is pressed hard enough to show on the back of the sheet: the
  // marks of the page behind this one, mirrored, faint, under this page's text.
  async function setBleed(page) {
    page.querySelector(":scope > .epub-bleed")?.remove();
    const section = +page.dataset.section, sheet = +page.dataset.sheet, total = +page.dataset.total;
    if (!(section >= 0) || disposed || !bleedAllowed || root.dataset.layout === "phone") return;
    // The back of the cover is its blank inside.
    if (hasCover && pagination({ index: section, sheet }).page === 1) return;
    const target = adjacent({ index: section, sheet, total }, perSpread === 1 || page.classList.contains("page--right"));
    const marks = target ? highlightsOf(target.index).filter(h => !h.pending && h.marker !== false) : [];
    if (!marks.length) return;
    // Only from a chapter already laid out: never start measuring one just for this.
    const cached = chapterCache.get(`${layoutKey}:${target.index}`);
    if (!cached) return;
    const tentry = await cached;
    const tsheet = target.sheet < 0 ? tentry.total - 1 : Math.min(target.sheet, tentry.total - 1);
    const probe = { el: element("spread epub-preparing"), inner: element("spread-inner"), pages: [], renders: [] };
    probe.el.inert = true; probe.el.append(probe.inner); mount.append(probe.el);
    try {
      const { page: tp, viewport } = pageShell(probe, page.classList.contains("page--right") ? 0 : 1, tentry.notes.length > 0);
      const host = tentry.pages[tsheet].cloneNode();
      const shadow = host.attachShadow({ mode: "open" });
      shadow.adoptedStyleSheets = tentry.pages[tsheet].shadowRoot.adoptedStyleSheets;
      shadow.append(...[...tentry.pages[tsheet].shadowRoot.childNodes].map(node => node.cloneNode(true)));
      viewport.append(host);
      window.epubAnnotations.paint(shadow, marks);
      const box = tp.getBoundingClientRect(), layer = element("epub-bleed");
      for (const span of shadow.querySelectorAll("span.epub-hl")) for (const r of span.getClientRects()) {
        const bar = document.createElement("i");
        bar.style.cssText = `left:${box.width - (r.left - box.left) - r.width}px;top:${r.top - box.top}px;width:${r.width}px;height:${r.height}px`;
        layer.append(bar);
      }
      if (layer.childElementCount && page.isConnected && !page.querySelector(":scope > .epub-bleed")) page.append(layer);
    } finally { destroySpread(probe); }
  }
  // The bleed-through is a finishing touch: made when the reader is idle and no page
  // is turning, never in the way of showing the next sheet.
  function laterBleed(page) {
    const run = () => {
      if (disposed || !page.isConnected) return;
      if (engine.turn || gesture || foregroundBusy) { setTimeout(run, 600); return; }
      setBleed(page).catch(() => {});
    };
    setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(run, { timeout: 2500 }) : run()), 400);
  }
  // The picture on a page that holds nothing else: its address, or null.
  function coverPicture(shadow) {
    const body = shadow.querySelector("body"), pictures = body ? body.querySelectorAll("img, image") : [];
    if (pictures.length !== 1 || body.textContent.trim().length > 40) return null;
    const p = pictures[0];
    return p.localName === "img" ? p.currentSrc || p.src : p.getAttribute("href") || p.getAttributeNS("http://www.w3.org/1999/xlink", "href");
  }
  async function paper(spread, target, side, measuring = false, effects = true) {
    if (!target) { const {number} = pageShell(spread,side,false); number.hidden = true; return null; }
    const section = book.spine.get(target.index ?? target);
    if (!section) throw new Error(`Chapter not found: ${target}`);
    const entry = await chapter(section, measuring);
    if (measuring) return;
    let sheet = 0;
    if (typeof target === "object") sheet = target.sheet < 0 ? entry.total - 1 : Math.min(target.sheet,entry.total - 1);
    else if (target.startsWith("epubcfi(")) {
      const compare = new ePub.CFI().compare;
      for (let i = 1; i < entry.locations.length; i++) {
        if (compare(entry.locations[i].start.cfi,target) > 0) break;
        sheet = i;
      }
    } else if (target.includes('#')) sheet = entry.anchors.get(decodeURIComponent(target.split('#')[1])) || 0;
    await waitForPaper();
    const folio = pagination({index:section.index,sheet}).page;
    if (perSpread === 1 && folio !== null) side = (folio - 1) % 2;
    const {page,viewport,number} = pageShell(spread,side,entry.notes.length > 0);
    const host = entry.pages[sheet].cloneNode();
    const shadow = host.attachShadow({mode:"open"});
    shadow.adoptedStyleSheets = entry.pages[sheet].shadowRoot.adoptedStyleSheets;
    shadow.append(...[...entry.pages[sheet].shadowRoot.childNodes].map(node => node.cloneNode(true)));
    viewport.append(host);
    window.epubAnnotations.paint(host.shadowRoot, highlightsOf(section.index));
    // Fonts are settled once in this document before the first visible page.
    const body = host.shadowRoot.querySelector('body');
    const css = readingDocument.defaultView.getComputedStyle(body);
    await readingDocument.fonts.load(`${css.fontSize} ${css.fontFamily}`,body.textContent || "国A").catch(() => {});
    await readingDocument.fonts.ready;
    await Promise.all([...host.shadowRoot.querySelectorAll('img')].map(img => img.decode?.().catch(() => {})));
    // The book's first page, when it is only a picture (its cover): the picture
    // fills the sheet edge to edge, as on a printed book.
    const picture = !fixedLayout && folio === 1 && coverPicture(host.shadowRoot);
    if (picture) {
      const art = element("epub-cover-art");
      art.style.backgroundImage = `url(${JSON.stringify(picture)})`;
      page.classList.add("epub-cover"); page.append(art);
    }
    host.shadowRoot.addEventListener('click',event => {
      const a = event.target.closest?.('a[href]');
      if (!a || a.hasAttribute('data-epub-noteref')) return;
      event.preventDefault(); event.stopPropagation();
      const href = a.getAttribute('href');
      if (/^(https?:|mailto:)/i.test(href)) { window.open(href,'_blank','noopener'); return; }
      const resolved = new URL(href,new URL(section.url,'https://epub.invalid/'));
      enqueue(() => display(book.path.relative(resolved.pathname) + resolved.hash)).catch(error => emit('displayError',error));
    });
    const point = {index:section.index,sheet,total:entry.total};
    const location = entry.locations[sheet];
    const count = pagination(point);
    number.textContent = count.page === null ? "" : count.total === null ? String(count.page) : `${count.page}/${count.total}`;
    number.hidden = !row.pageNumbers;
    page.dataset.section = section.index; page.dataset.sheet = sheet; page.dataset.total = entry.total;
    await waitForPaper();
    content.placeNotes(page,[{document:host.shadowRoot}],entry.notes);
    pageRange.set(page, { start: entry.locations[sheet].start.cfi, end: entry.locations[sheet + 1]?.start.cfi, base: section.cfiBase });
    setRibbon(page);
    inkPaint?.(page);
    laterBleed(page);
    if (effects && row.inkBleed) content.addBleed(page);
    return {point,location};
  }
  // In a two-page spread odd places (see slot) are on the right, as in a printed
  // book. A page there starts a spread only after a `lead`: "absent", nothing at
  // all (facing the first page), or "blank", the inside of the cover.
  async function createSpread(target, backwards = false, align = false, lead = null) {
    const spread = { el: element("spread epub-preparing"), inner: element("spread-inner" + (perSpread === 2 ? " is-double" : "")), pages: [], renders: [] };
    spread.el.inert = true;
    spread.el.append(spread.inner); mount.append(spread.el); spreads.add(spread);
    // Invisible sheets must still be laid out; their contents never flash onscreen.
    // Opacity hides the preparing spread without suspending iframe layout.
    try {
      if (lead) { await paper(spread, null, 0); if (lead === "absent") spread.pages[0].classList.add("page--absent"); }
      let first = await paper(spread, target, lead ? 1 : 0);
      const folio = pagination(first.point).page;
      if (perSpread === 2 && !lead && (folio === null ? backwards : slot(folio) % 2 === 1)) {
        const previous = adjacent(first.point, false);
        destroySpread(spread);
        if (!previous) return createSpread(first.point, false, false, "absent");
        if (hasCover && folio === 2) return createSpread(first.point, false, false, "blank");
        return createSpread(previous);
      }
      let last = first;
      for (let i = lead ? 2 : 1; i < perSpread; i++) {
        const next = await paper(spread, adjacent(last.point, true), i);
        if (next) last = next;
      }
      spread.first = first.point; spread.last = last.point;
      spread.location = { start: first.location.start, end: last.location.end,
        atStart: !adjacent(first.point, false), atEnd: !adjacent(last.point, true), pagination: pagination(first.point) };
      setStack(spread);
      if (row.showThrough && root.dataset.layout !== "phone") {
        // Prepare both outward faces before a spread can become visible.
        // This also covers reverse navigation and opening in mid-book.
        for (const page of spread.pages) {
          if (page.dataset.section === undefined) continue;
          const point = { index: +page.dataset.section, sheet: +page.dataset.sheet, total: +page.dataset.total };
          if (hasCover && pagination(point).page === 1) continue;
          const target = adjacent(point, perSpread === 1 || page.classList.contains("page--right"));
          if (!target) continue;
          const probe = { el: element("spread epub-preparing"), inner: element("spread-inner"), pages: [], renders: [] };
          probe.el.inert = true; probe.el.append(probe.inner); mount.append(probe.el);
          try {
            await paper(probe, target, page.classList.contains("page--right") ? 0 : 1, false, false);
            await content.showThrough(page, probe.pages[0]);
          } finally { destroySpread(probe); }
        }
      }
      await waitForPaper();
      spread.inner.style.transform = `scale(${scale})`;
      spread.el.style.visibility = "";
      spread.ready = true; spread.el.classList.remove("epub-preparing");
      // (Placed by where their passages are, now laid out.)
      for (const page of spread.pages) setStickies(page);
      return spread;
    } catch (error) { destroySpread(spread); throw error; }
  }
  function activate(spread) {
    for (const entry of spreads) {
      entry.el.classList.toggle("is-current", entry === spread);
      entry.el.classList.toggle("epub-live", entry === spread);
      entry.el.classList.toggle("is-near", entry !== spread && !!entry.ready);
      entry.el.inert = entry !== spread;
    }
    current = spread; lastActivity = performance.now();
    // Back at the page held (or before it): the finger is out.
    if (held && !heldSide(spread)) { held = null; restack(); }
    // Inert/destroyed chapter frames can otherwise leave keyboard focus in a
    // detached document after a turn or a Contents jump.
    if (!document.querySelector("dialog[open]")) mount.focus({ preventScroll: true });
    root.classList.remove("reader-loading");
    updatePageNumbers();
    emit("relocated", spread.location);
    schedulePageIndex();
  }
  function trim() {
    const keep = new Set([current, current?.prev, current?.next, current?.next?.next, current?.next?.next?.next]);
    for (const entry of spreads) if (entry.ready && !keep.has(entry)) destroySpread(entry);
    if (current?.prev) current.prev.prev = null;
    if (current?.next?.next?.next) current.next.next.next.next = null;
  }
  // Measure one chapter per queued task, with the same geometry and styles as
  // the reader. Navigation can run between chapters; no estimated page totals.
  function schedulePageIndex() {
    if (disposed || indexing || paginationError) return;
    const section = chapters.find(section => !chapterPages.has(section.index));
    if (!section) return;
    indexing = true;
    const epoch = indexEpoch;
    indexTimer = setTimeout(() => {
      // Counting the rest of the book waits for a pause in reading.
      if (performance.now() - lastActivity < 2500 || gesture || engine.turn) { indexing = false; indexTimer = setTimeout(schedulePageIndex, 900); return; }
      enqueueBackground(async () => {
        if (epoch !== indexEpoch || gesture) return;
        const probe = { el: element("spread epub-preparing"), inner: element("spread-inner"), pages: [], renders: [] };
        probe.el.inert = true; probe.el.append(probe.inner); mount.append(probe.el);
        try { await paper(probe, { index: section.index, sheet: 0 }, 0, true); }
        finally { destroySpread(probe); }
      }).catch(() => {
        if (epoch === indexEpoch) { paginationError = true; updatePageNumbers(); }
      }).finally(() => {
        if (epoch === indexEpoch) { indexing = false; schedulePageIndex(); }
      });
    }, 40);
  }
  function neighbor(from, forward) {
    const key = forward ? "next" : "prev", pendingKey = key + "Pending";
    if (from[key]) return Promise.resolve(from[key]);
    if (!from[pendingKey]) {
      from[pendingKey] = createSpread(adjacent(forward ? from.last : from.first, forward), !forward).then(next => {
        if (disposed || !spreads.has(from)) { destroySpread(next); return null; }
        from[key] = next; next[forward ? "prev" : "next"] = from;
        next.el.inert = true; next.el.classList.add("is-near");
        return next;
      }).finally(() => { from[pendingKey] = null; });
    }
    return from[pendingKey];
  }
  function prefetch() {
    const from = current;
    // Prepare adjacent ordinary leaves; a cached turn only updates transforms.
    for (const forward of [true, false]) enqueueBackground(async () => {
      let entry = from;
      // Keep several forward leaves ready for a burst of trackpad/key input.
      // Preparation is outside the fold and uses cached chapter fragments.
      for (let i = 0; i < (forward && !geometry.isTouch ? 3 : 1); i++) {
        if (current !== from || (forward ? entry.location.atEnd : entry.location.atStart)) break;
        entry = await neighbor(entry, forward);
        if (!entry) break;
      }
      if (!foregroundBusy && !engine.turn && !gesture) trim();
    }).catch(() => { /* A foreground turn retries and reports loading errors. */ });
  }
  // Whether the book opens on a cover is read from its first chapter itself,
  // once. It used to be noticed only when that chapter was laid out, which a
  // reader opened mid-book with kept page counts never does: then every page
  // sat one place off, and changed hands with any setting that changed what
  // was kept (Paper effects).
  let coverChecked = null;
  const checkCover = () => coverChecked ??= (async () => {
    if (fixedLayout || !chapters[0]) return;
    try { hasCover = Boolean(coverPicture(await content.load(chapters[0].url))); } catch { /* no cover then */ }
  })();
  async function display(target) {
    await styleReady;
    await checkCover();
    if (!perSpread) configure();
    await readCounts();
    target ??= { index: book.spine.first().index, sheet: 0 };
    const section = book.spine.get(target.index ?? target);
    // The global folio, never the navigation entry point, determines the hand.
    // Resolve earlier chapter counts before opening/restoring a spread.
    for (const preceding of chapters) {
      if (preceding.index === section?.index) break;
      // (Only its page count: kept chapters give it without being rebuilt.)
      if (!chapterPages.has(preceding.index)) await chapter(preceding, Boolean(options.bookKey));
    }
    const next = await createSpread(target, false, true);
    activate(next); trim(); prefetch();
  }
  async function prepareTurn(forward) {
    if (!current || (forward ? current.location.atEnd : current.location.atStart)) return null;
    const from = current, key = forward ? "next" : "prev";
    const next = await neighbor(from, forward);
    if (!next) return null;
    next.el.classList.add("is-near");
    turns.current = forward ? 0 : 1;
    turns.spreads = forward ? [from.el, next.el] : [next.el, from.el];
    turns.spreadPages = forward ? [from.pages, next.pages] : [next.pages, from.pages];
    return { from, next };
  }
  function finishTurn(pair, resolve) {
    turns.markSpreads = () => {
      activate(turns.spreads[turns.current] === pair.next.el ? pair.next : pair.from);
      gesture = null;
      turnWaiters.splice(0).forEach(done => done());
      resolve();
    };
  }
  async function move(forward) {
    lastActivity = performance.now();
    const pair = await prepareTurn(forward);
    if (!pair) return;
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      await new Promise(resolve => {
        finishTurn(pair, resolve);
        engine.turnPage(forward ? 1 : -1);
      });
    } else {
      activate(pair.next);
    }
    trim(); prefetch();
  }
  // The wheel callback is synchronous, while a cache miss may need to load a
  // chapter. Accumulate that gesture until ready; keep navigation serialized
  // until its fold commits or returns to the original sheet.
  // `source` "touch": a finger drags the page by its corner at `clientY`.
  function dragTurn(delta, source = "wheel", clientY = null) {
    if (!delta || disposed || !current) return false;
    lastActivity = performance.now();
    if (engine.turn?.anim) engine.endTurn(engine.turn.progress > .5 ? engine.turn.to : engine.turn.from);
    if (gesture?.started) return engine.dragTurn(delta, source, clientY);
    if (gesture) { gesture.delta += delta; gesture.y = clientY; return true; }
    if (delta > 0 ? current.location.atEnd : current.location.atStart) return false;
    const pending = { delta, started: false, action: null, velocity: 0, source, y: clientY };
    gesture = pending;
    enqueue(async () => {
      if (!pending.delta) { if (gesture === pending) gesture = null; return; }
      const pair = await prepareTurn(pending.delta > 0);
      if (!pair) { if (gesture === pending) gesture = null; return; }
      await new Promise(resolve => {
        finishTurn(pair, resolve);
        pending.started = true;
        engine.dragTurn(pending.delta, pending.source, pending.y);
        if (pending.action === "release") engine.releaseTurn(pending.velocity);
        else if (pending.action !== null) engine.settleTurn(pending.action);
      });
      trim(); prefetch();
    }).catch(error => { gesture = null; emit("displayError", error); });
    return true;
  }
  function settleGesture(action, velocity = 0) {
    if (gesture && !gesture.started) { gesture.action = action; gesture.velocity = velocity; return; }
    if (action === "release") engine.releaseTurn(velocity); else engine.settleTurn(action);
  }
  async function relayout() {
    clearTimeout(indexTimer); indexEpoch++;
    await background;
    const target = current?.location.start.cfi;
    const previousKey = layoutKey, previousSpread = perSpread;
    configure();
    if (current && previousKey === layoutKey && previousSpread === perSpread) {
      for (const entry of spreads) entry.inner.style.transform = `scale(${scale})`;
      schedulePageIndex();
      return;
    }
    for (const entry of spreads) destroySpread(entry);
    current = null; await display(target);
  }
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (viewportKey === `${geometry.viewportWidth()}x${geometry.viewportHeight()}`) return;
      enqueue(relayout).catch(error => emit("displayError", error));
    }, 150);
  };
  window.addEventListener("resize", onResize);
  return {
    hooks: { content: { register(fn) { hooks.push(fn); } } },
    themes: { default(rules) { lastTheme = rules; } },
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    display: target => enqueue(() => display(target)),
    // To a bookmark, the pages between held up (see `held`); again to another,
    // the same page still held.
    holdTurn: target => enqueue(async () => {
      if (!held && current && perSpread === 2) {
        const first = pagination(current.first).page, last = pagination(current.last || current.first).page;
        if (first !== null && last !== null) { held = { first, last, cfi: current.location.start.cfi }; restack(); }
      }
      await turnTo(target);
      restack();
    }),
    returnHeld,
    get held() { return !!held; },
    // The held-up pages laid down where they are: the finger out, here.
    letGo() {
      if (!held) return;
      for (const strip of mount.querySelectorAll(".epub-held")) strip.classList.add("is-letting-go");
      setTimeout(() => { held = null; restack(); }, 260);
    },
    next: () => enqueue(() => move(true)), prev: () => enqueue(() => move(false)),
    toggleSpread: () => enqueue(() => { if (geometry.isTouch) return; wantsDouble = perSpread !== 2; return relayout(); }),
    dragTurn,
    releaseTurn: velocity => settleGesture("release", velocity),
    settleTurn: target => settleGesture(target),
    get turn() {
      return engine.turn || (gesture ? { target: Math.min(1, Math.abs(gesture.delta) / (.9 * width * scale)), progress: 0, anim: null } : null);
    },
    // Highlights are painted into the page clones; the saved list is the
    // reader's (`fn(sectionIndex)` returns that chapter's).
    // (`notes()`: every note with where its sticky note is: [{ id, place }];
    // `placed(list)`: where a page's sticky notes have been put, each time.)
    setHighlights(fn, notes, placed) { highlightsOf = fn; if (notes) placedNotes = notes; if (placed) onNotesPlaced = placed; },
    // A page's number in the book (`page`: one of the pages shown).
    pageNumber(page) { return pagination({ index: +page.dataset.section, sheet: +page.dataset.sheet }).page; },
    refreshHighlights() {
      // Every copy of a page: the page itself, its show-through back and its ink layer.
      for (const host of mount.querySelectorAll(".epub-page-content")) {
        const owner = host.closest("[data-section]");
        if (owner) window.epubAnnotations.paint(host.shadowRoot, highlightsOf(+owner.dataset.section));
      }
      for (const entry of spreads) { for (const page of entry.pages) { setStickies(page); laterBleed(page); } setTabs(entry); }
    },
    // `cfis()`: the bookmarks' positions; `remove(cfis)`: a tap on a ribbon.
    setBookmarks(cfis, remove, { tabs, latest, open } = {}) {
      bookmarkCfis = cfis; onRibbon = remove;
      if (tabs) bookmarkTabs = tabs;
      if (latest) latestBookmark = latest;
      if (open) onTab = open;
    },
    // Handwriting is drawn onto each page as it is made (`paint(page)`).
    setInk(paint) { inkPaint = paint; },
    // The page geometry a stroke was drawn in: where a page without text keeps it.
    get inkLayout() { return layoutKey; },
    // The page on one side of the spread shown (a lone page: that one): where it
    // starts, its page number, and the page itself.
    pageMark(side) {
      const page = current?.pages.filter(p => !p.classList.contains("page--absent") && p.dataset.section !== undefined)
        .find((p, i, list) => list.length === 1 || p.classList.contains(`page--${side}`));
      const range = page && pageRange.get(page);
      return range ? { cfi: range.start, page: pagination({ index: +page.dataset.section, sheet: +page.dataset.sheet }).page, el: page } : null;
    },
    refreshBookmarks() { for (const entry of spreads) { for (const page of entry.pages) setRibbon(page); setTabs(entry); } },
    // A painted highlight, as a selection to adjust: its page text offsets.
    editInfo(mark) {
      const shadow = mark.getRootNode(), body = shadow.querySelector?.("body"), page = shadow.host?.closest(".page");
      const offsets = body && window.epubAnnotations.spanOffsets(body, mark.dataset.id);
      return offsets && page && page.dataset.section !== undefined ? { section: +page.dataset.section, shadow, offsets } : null;
    },
    // Touch selection (our own): the page text under a finger, as offsets.
    hostAt(x, y) {
      for (const host of mount.querySelectorAll(".spread.is-current .page > .page-area .epub-page-content, .spread.is-current .page > .epub-viewport .epub-page-content")) {
        const r = host.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return host;
      }
      return null;
    },
    pickWord(x, y) {
      const host = this.hostAt(x, y);
      if (!host) return null;
      const shadow = host.shadowRoot, body = shadow.querySelector("body"), page = host.closest(".page");
      const hit = body && page && window.epubAnnotations.pointToOffset(shadow, x, y);
      if (!hit || page.dataset.section === undefined) return null;
      const [start, end] = window.epubAnnotations.wordAt(window.epubAnnotations.index(body).text, hit.char);
      return { section: +page.dataset.section, shadow, offsets: [start, end] };
    },
    offsetAt(shadow, x, y) { return window.epubAnnotations.pointToOffset(shadow, x, y)?.offset ?? null; },
    measure(sel) {
      const body = sel.shadow.querySelector("body");
      return body ? window.epubAnnotations.measure(body, sel.offsets[0], sel.offsets[1]) : null;
    },
    // The visible page text the viewer has selected, if any.
    selection() {
      const notes = window.epubAnnotations, selection = document.getSelection();
      for (const host of mount.querySelectorAll(".spread.is-current .page > .page-area .epub-page-content, .spread.is-current .page > .epub-viewport .epub-page-content")) {
        const shadow = host.shadowRoot;
        let range = null;
        try {
          if (selection.getComposedRanges) {
            const found = selection.getComposedRanges({ shadowRoots: [shadow] })[0];
            if (found && !found.collapsed) { range = document.createRange(); range.setStart(found.startContainer, found.startOffset); range.setEnd(found.endContainer, found.endOffset); }
          } else if (shadow.getSelection) {
            const inner = shadow.getSelection();
            if (inner?.rangeCount && !inner.isCollapsed) range = inner.getRangeAt(0);
          }
        } catch { range = null; }
        const body = shadow.querySelector("body");
        if (!range || !body || !body.contains(range.commonAncestorContainer) || !range.toString().trim()) continue;
        const page = host.closest(".page");
        if (!page || page.dataset.section === undefined) continue;
        return { section: +page.dataset.section, rect: range.getBoundingClientRect(), ...notes.describe(body, range) };
      }
      return null;
    },
    // The 32 characters of the chapter before and after a selection, which
    // the page alone may cut short at its edge.
    async contextFor(info) {
      const section = book.spine.get(info.section);
      if (!section) return info;
      const doc = await content.load(section.url), text = window.epubAnnotations.index(doc.body || doc.documentElement).text;
      const hit = window.epubAnnotations.find(text, info);
      return hit ? { ...info, prefix: text.slice(Math.max(0, hit.start - 32), hit.start), suffix: text.slice(hit.end, hit.end + 32) } : info;
    },
    // Where a highlight starts in the book, for jumping to it.
    async cfiFor(h) {
      const section = book.spine.get(h.section);
      if (!section) return null;
      const doc = await content.load(section.url), body = doc.body || doc.documentElement;
      const idx = window.epubAnnotations.index(body), hit = window.epubAnnotations.find(idx.text, h);
      const piece = hit && window.epubAnnotations.segments(idx, hit.start, hit.end)[0];
      if (!piece) return null;
      const range = doc.createRange(); range.setStart(piece.node, piece.from); range.setEnd(piece.node, piece.to);
      return new ePub.CFI(range, section.cfiBase).toString();
    },
    currentLocation: () => current?.location,
    get canSwitchSpread() { return !geometry.isTouch; },
    get perSpread() { return perSpread; },
    getContents: () => [{document:readingDocument}],
    destroy() { disposed = true; chapterCache.clear(); clearTimeout(resizeTimer); clearTimeout(indexTimer); indexEpoch++; window.removeEventListener("resize", onResize); engine.cancelTurn(); turnWaiters.splice(0).forEach(done => done()); for (const entry of spreads) destroySpread(entry); }
  };
};
