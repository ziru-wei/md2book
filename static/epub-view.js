// EPUB owns pagination; the shared reader owns sheets and paper folds.
// Chapters are measured once; ordinary page DOM stays unchanged throughout a fold.
window.createEpubView = function createEpubView(book, mount, row) {
  const root = document.documentElement, geometry = window.createReaderLayout(root, { tabletAspectRatio: .76, fixedTablet: true });
  const fixedLayout = book.package.metadata.layout === "pre-paginated";
  // Paper effects stack extra copies and blended text shadows on every sheet;
  // a touch device (iPad Safari) runs out of memory with them.
  if (geometry.isTouch) {
    row = { ...row, showThrough: false, inkBleed: false, letterpress: false };
    root.classList.remove("show-through", "ink-bleed", "letterpress");
  }
  const content = window.createEpubContent(book, root, row, fixedLayout);
  root.classList.add("reader", "epub-fixed-paper");
  mount.tabIndex = 0;
  let wantsTablet = Number(row.columns) === 1, wantsDouble = true;
  let perSpread, columns, width, height, scale, current, disposed = false;
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
  let layoutKey = "", viewportKey = "", highlightsOf = () => [];
  let indexTimer, indexEpoch = 0, indexing = false, paginationError = false;
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
  function updatePageNumbers() {
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
  engine = window.createPageTurn(turns);
  function configure() {
    clearTimeout(indexTimer); indexEpoch++; indexing = false; paginationError = false;
    geometry.applyLayout(wantsTablet);
    perSpread = geometry.pagesPerSpread(wantsDouble);
    columns = !fixedLayout && root.dataset.layout === "book" ? 2 : 1;
    const probe = element("page"); mount.append(probe);
    width = probe.offsetWidth; height = probe.offsetHeight; probe.remove();
    const nextKey = JSON.stringify([root.dataset.layout, width, height, columns]);
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
    scale = root.dataset.layout !== "phone" ? Math.min(geometry.viewportWidth() / (width * perSpread), geometry.viewportHeight() / height) : 1;
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
    const gap = columns === 2 ? parseFloat(getComputedStyle(root).getPropertyValue("--column-gap")) : 0;
    Object.assign(viewport.style, {left:-gap / 2 + "px", width:area.offsetWidth + gap + "px", height:area.offsetHeight + "px"});
    return {page, area, viewport, number, gap};
  }
  // Laid-out chapters hold a DOM clone of every sheet: keep only the few read
  // lately. Page counting (`transient`) measures every chapter once but must not
  // keep them, or a long book fills the device's memory.
  const CHAPTER_CACHE = geometry.isTouch ? 3 : 6;
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
        const notes = fixedLayout ? [] : await content.notesFor(section);
        const spread = {el:element("spread epub-preparing"), inner:element("spread-inner"), pages:[], renders:[]};
        spread.el.inert = true; spread.el.setAttribute("aria-hidden","true");
        spread.el.append(spread.inner); outerMount.append(spread.el);
        const {page,area,viewport,gap} = pageShell(spread, 0, notes.length > 0);
        let rendition;
        try {
          const r = rendition = new PaperRendition(book, {
            width: area.offsetWidth + gap, height: area.offsetHeight,
            flow: "paginated", spread: columns === 2 ? "both" : "none", minSpreadWidth: 0, gap,
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
  let bookmarkCfis = () => [], onRibbon = null;
  const pageRange = new WeakMap();
  const compareCfi = (a, b) => { try { return new ePub.CFI().compare(a, b); } catch { return 0; } };
  const ribbonHits = page => {
    const range = pageRange.get(page);
    // Within this page's chapter, from its first position up to the next page's.
    return range ? bookmarkCfis().filter(cfi => cfi.startsWith(`epubcfi(${range.base}!`) &&
      compareCfi(cfi, range.start) >= 0 && (!range.end || compareCfi(cfi, range.end) < 0)) : [];
  };
  function setRibbon(page) {
    const hits = ribbonHits(page), ribbon = page.querySelector(":scope > .epub-ribbon");
    if (hits.length && !ribbon) {
      const el = element("epub-ribbon");
      el.setAttribute("role", "button"); el.setAttribute("aria-label", "Remove bookmark");
      el.dataset.side = page.classList.contains("page--right") ? "left" : "right";
      el.addEventListener("click", event => { event.stopPropagation(); onRibbon?.(ribbonHits(page)); });
      page.append(el);
    } else if (!hits.length && ribbon) ribbon.remove();
  }
  // A highlight is pressed hard enough to show on the back of the sheet: the
  // marks of the page behind this one, mirrored, faint, under this page's text.
  async function setBleed(page) {
    page.querySelector(":scope > .epub-bleed")?.remove();
    const section = +page.dataset.section, sheet = +page.dataset.sheet, total = +page.dataset.total;
    if (!(section >= 0) || disposed) return;
    const target = adjacent({ index: section, sheet, total }, perSpread === 1 || page.classList.contains("page--right"));
    const marks = target ? highlightsOf(target.index).filter(h => !h.pending && h.marker !== false) : [];
    if (!marks.length) return;
    const tsection = book.spine.get(target.index);
    if (!tsection) return;
    const tentry = await chapter(tsection);
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
    await readingDocument.fonts.load(`${css.fontSize} ${css.fontFamily}`,body.textContent || "国A");
    await readingDocument.fonts.ready;
    await Promise.all([...host.shadowRoot.querySelectorAll('img')].map(img => img.decode?.().catch(() => {})));
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
    await setBleed(page).catch(() => {});
    if (effects && row.inkBleed) content.addBleed(page);
    return {point,location};
  }
  async function createSpread(target, backwards = false, align = false) {
    const spread = { el: element("spread epub-preparing"), inner: element("spread-inner" + (perSpread === 2 ? " is-double" : "")), pages: [], renders: [] };
    spread.el.inert = true;
    spread.el.append(spread.inner); mount.append(spread.el); spreads.add(spread);
    // Invisible sheets must still be laid out; their contents never flash onscreen.
    // Opacity hides the preparing spread without suspending iframe layout.
    try {
      let first = await paper(spread, target, 0);
      const folio = pagination(first.point).page;
      if (perSpread === 2 && (backwards || (align && folio !== null && folio % 2 === 0))) {
        const previous = adjacent(first.point, false);
        if (previous) {
          destroySpread(spread);
          return createSpread(previous);
        }
      }
      let last = first;
      for (let i = 1; i < perSpread; i++) {
        const next = await paper(spread, adjacent(last.point, true), i);
        if (next) last = next;
      }
      spread.first = first.point; spread.last = last.point;
      spread.location = { start: first.location.start, end: last.location.end,
        atStart: !adjacent(first.point, false), atEnd: !adjacent(last.point, true), pagination: pagination(first.point) };
      if (row.showThrough && root.dataset.layout !== "phone") {
        // Prepare both outward faces before a spread can become visible.
        // This also covers reverse navigation and opening in mid-book.
        for (const page of spread.pages) {
          if (page.dataset.section === undefined) continue;
          const point = { index: +page.dataset.section, sheet: +page.dataset.sheet, total: +page.dataset.total };
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
    current = spread;
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
  async function display(target) {
    await styleReady;
    if (!perSpread) configure();
    target ??= { index: book.spine.first().index, sheet: 0 };
    const section = book.spine.get(target.index ?? target);
    // The global folio, never the navigation entry point, determines the hand.
    // Resolve earlier chapter counts before opening/restoring a spread.
    for (const preceding of chapters) {
      if (preceding.index === section?.index) break;
      if (!chapterPages.has(preceding.index)) await chapter(preceding);
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
    next: () => enqueue(() => move(true)), prev: () => enqueue(() => move(false)),
    toggleColumns: () => enqueue(() => { if (geometry.isTouch || fixedLayout) return; wantsTablet = !wantsTablet; return relayout(); }),
    toggleSpread: () => enqueue(() => { if (geometry.isTouch) return; wantsDouble = !wantsDouble; return relayout(); }),
    dragTurn,
    releaseTurn: velocity => settleGesture("release", velocity),
    settleTurn: target => settleGesture(target),
    get turn() {
      return engine.turn || (gesture ? { target: Math.min(1, Math.abs(gesture.delta) / (.9 * width * scale)), progress: 0, anim: null } : null);
    },
    // Highlights are painted into the page clones; the saved list is the
    // reader's (`fn(sectionIndex)` returns that chapter's).
    setHighlights(fn) { highlightsOf = fn; },
    refreshHighlights() {
      // Every copy of a page: the page itself, its show-through back and its ink layer.
      for (const host of mount.querySelectorAll(".epub-page-content")) {
        const owner = host.closest("[data-section]");
        if (owner) window.epubAnnotations.paint(host.shadowRoot, highlightsOf(+owner.dataset.section));
      }
      for (const entry of spreads) for (const page of entry.pages) setBleed(page).catch(() => {});
    },
    // `cfis()`: the bookmarks' positions; `remove(cfis)`: a tap on a ribbon.
    setBookmarks(cfis, remove) { bookmarkCfis = cfis; onRibbon = remove; },
    refreshBookmarks() { for (const entry of spreads) for (const page of entry.pages) setRibbon(page); },
    // A painted highlight, as a selection to adjust: its page text offsets.
    editInfo(mark) {
      const shadow = mark.getRootNode(), body = shadow.querySelector?.("body"), page = shadow.host?.closest(".page");
      const offsets = body && window.epubAnnotations.spanOffsets(body, mark.dataset.id);
      return offsets && page && page.dataset.section !== undefined ? { section: +page.dataset.section, shadow, offsets } : null;
    },
    // Touch selection (our own): the page text under a finger, as offsets.
    hostAt(x, y) {
      for (const host of mount.querySelectorAll(".spread.is-current .epub-page-content")) {
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
      for (const host of mount.querySelectorAll(".spread.is-current .epub-page-content")) {
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
    get canSwitchColumns() { return !geometry.isTouch && !fixedLayout; },
    get columns() { return columns; }, get perSpread() { return perSpread; },
    getContents: () => [{document:readingDocument}],
    destroy() { disposed = true; chapterCache.clear(); clearTimeout(resizeTimer); clearTimeout(indexTimer); indexEpoch++; window.removeEventListener("resize", onResize); engine.cancelTurn(); turnWaiters.splice(0).forEach(done => done()); for (const entry of spreads) destroySpread(entry); }
  };
};
