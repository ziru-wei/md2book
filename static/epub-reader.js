/* EPUB only: position is local; personal cloud bookmarks use the server API. */
(async () => {
  const options = JSON.parse(document.getElementById("epub-config").textContent);
  const { url, row, id, library, cloud, inkLib } = options;
  const $ = id => document.getElementById(id);
  const viewer = $("epub-viewer"), status = $("epub-status"), toc = $("epub-toc");
  const menu = $("epub-menu"), progress = $("epub-progress"), percent = $("epub-percent");
  const addBookmark = $("epub-bookmark-add"), syncNote = $("epub-sync-note");
  const stateKey = `md2book.epub:${library}:${id}`;
  const bookmarkKey = stateKey + ":bookmarks";
  const highlightKey = stateKey + ":highlights";
  const bookmarkUrl = `/api/epub-bookmarks/${id}`;
  const inkBar = $("epub-ink-bar");
  // Touch screens select text by our own long press (no native overlay, handles
  // or menu): `pending` is that selection, offsets into a page's text.
  let selecting = false, pending = null, dismissedAt = -Infinity, dismissedStamp = -1;
  const selectionActive = () => Boolean(pending || document.getSelection()?.toString() || rendition?.selection());
  let book, rendition, current, disposed = false, locationsReady = false;
  let bookmarks = [], highlights = [], bookmarksReady = false, bookmarkBusy = false, lastSync = 0;
  // The bookmark note whose name is being written on it (see editTab).
  let naming = null;
  let navigationQueue = Promise.resolve(), queued = 0, lastTouch = -Infinity;
  // Handwriting: the pen always writes; P makes the mouse a pen (see epub-ink.js).
  const ink = window.createEpubInk({ viewer, key: stateKey, url: `/api/epub-ink/${id}`, cloud, lib: inkLib, view: () => rendition, bar: inkBar,
    onActive: () => { inkBar.hidden = false; }, onPenDown: () => palmCancels.forEach(cancel => cancel()) });
  // What a hand on the screen began (a page drag, a long press, a selection)
  // stops when the pen comes down: it was a palm.
  const palmCancels = [];
  const readLocal = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch { return fallback; }
  };
  const saved = readLocal(stateKey, null);
  // Without a cloud library, bookmarks and highlights live in IndexedDB, which
  // browsers clear less readily than localStorage (the old home of both, still
  // read once and moved over). localStorage remains the fallback.
  function notesStore(mode, run) {
    return new Promise(resolve => {
      if (!window.indexedDB) return resolve(null);
      const opening = indexedDB.open("md2book-epub-notes", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("notes");
      opening.onerror = opening.onblocked = () => resolve(null);
      opening.onsuccess = () => {
        const db = opening.result;
        let tx;
        try { tx = db.transaction("notes", mode); } catch { db.close(); return resolve(null); }
        const request = run(tx.objectStore("notes"));
        tx.oncomplete = () => { db.close(); resolve(mode === "readwrite" ? true : (request.result ?? null)); };
        tx.onerror = tx.onabort = () => { db.close(); resolve(null); };
      };
    });
  }
  let localSaving = Promise.resolve();
  function saveLocal(data) {
    localSaving = localSaving.then(async () => {
      if (await notesStore("readwrite", store => store.put(data, stateKey))) {
        navigator.storage?.persist?.().catch(() => {});
        return;
      }
      try {
        localStorage.setItem(bookmarkKey, JSON.stringify(data.bookmarks));
        localStorage.setItem(highlightKey, JSON.stringify(data.highlights));
      } catch { /* No storage available: nothing can be kept. */ }
    });
    return localSaving;
  }
  async function loadLocal() {
    const stored = await notesStore("readonly", store => store.get(stateKey));
    if (stored) return { bookmarks: stored.bookmarks, highlights: stored.highlights };
    const legacy = { bookmarks: readLocal(bookmarkKey, []), highlights: readLocal(highlightKey, []) };
    if (legacy.bookmarks.length || legacy.highlights.length) await saveLocal(legacy);
    return legacy;
  }
  const fail = error => {
    window.md2bookOpening?.failed();
    status.hidden = false;
    document.documentElement.classList.remove("reader-loading");
    status.textContent = `Could not read EPUB: ${error.message || error}`;
  };
  const idle = task => {
    const run = () => { if (!disposed) task(); };
    if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 1200 });
    else setTimeout(run, 150);
  };
  function navigate(action) {
    if (!rendition || queued >= 4) return;
    queued++;
    navigationQueue = navigationQueue.then(async () => {
      if (disposed) return;
      try { await action(); status.hidden = true; }
      catch (error) { fail(error); }
    }).finally(() => { queued--; });
  }
  function turn(forward) {
    if (!current || (forward ? current.atEnd : current.atStart)) return;
    navigate(() => forward ? rendition.next() : rendition.prev());
  }
  function toggleMenu() {
    if (menu.open) return menu.close();
    menu.showModal();
    if (cloud && !bookmarkBusy && Date.now() - lastSync > 30000) loadBookmarks();
  }
  $("epub-menu-toggle").addEventListener("click", toggleMenu);
  menu.addEventListener("click", event => {
    const r = menu.getBoundingClientRect();
    if (event.target === menu && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) menu.close();
  });
  function keydown(event) {
    // Space also closes the menu it opened (unless the cursor is in a text field).
    if (event.key === " " && menu.open && !event.altKey && !event.ctrlKey && !event.metaKey &&
        !(/TEXTAREA/.test(event.target?.tagName) || (event.target?.tagName === "INPUT" && event.target.type !== "range"))) {
      event.preventDefault(); menu.close(); return;
    }
    const typing = /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName) || event.target?.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.code === "KeyZ" && !typing && !inkBar.hidden) {
      event.preventDefault(); ink.undo(); return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || typing || event.target?.tagName === "BUTTON") return;
    // P: the mouse writes (and again: it reads); E: the eraser while writing.
    if (event.code === "KeyP" && !menu.open) {
      event.preventDefault();
      ink.toggle(); return;
    }
    if (event.code === "KeyE" && ink.active) { event.preventDefault(); ink.eraserToggle(); return; }
    if (event.code === "KeyL" && ink.active) { event.preventDefault(); ink.setTool("lasso"); return; }
    if ((event.key === "Backspace" || event.key === "Delete") && ink.selected) { event.preventDefault(); ink.deleteSelection(); return; }
    if (event.key === "Escape" && ink.active) { ink.toggle(); return; }
    if (event.key === " ") { event.preventDefault(); toggleMenu(); return; }
    if (menu.open) return;
    if (event.code === "Slash" || event.key === "/") { event.preventDefault(); navigate(() => rendition.toggleSpread()); return; }
    const back = ["a", "A", "ArrowLeft"].includes(event.key) || event.code === "ShiftLeft";
    const forward = ["d", "D", "ArrowRight"].includes(event.key) || event.code === "ShiftRight";
    if (!back && !forward) return;
    event.preventDefault();
    turn(forward !== (book.package.metadata.direction === "rtl"));
  }

  // The part of the page on screen: all of it, or — zoomed in and moved —
  // the window onto it, so a tap on its left or right edge still turns the page.
  function visibleBox() {
    const b = viewer.getBoundingClientRect();
    const left = Math.max(b.left, 0), top = Math.max(b.top, 0);
    return { left, top, width: Math.min(b.right, innerWidth) - left, height: Math.min(b.bottom, innerHeight) - top };
  }
  // The book's left and right edges are the bookmarks': a double tap (or
  // click) on one bookmarks the page on that side; a single one does nothing,
  // not even turn the page.
  let lastSideTap = { side: null, at: -Infinity }, lastSpineTap = -Infinity;
  // (A double click there isn't the one beside the book that goes back to the
  // shelf, reader-opening.js, nor picks the word nearest.)
  document.addEventListener("dblclick", event => { if (sideStrip(event.clientX, event.clientY)) event.stopPropagation(); }, true);
  document.addEventListener("mousedown", event => { if (event.detail > 1 && sideStrip(event.clientX, event.clientY)) event.preventDefault(); }, true);
  function sideStrip(x, y) {
    const pages = [...viewer.querySelectorAll(".spread.is-current .page.epub-face:not(.page--absent)")];
    if (!pages.length) return null;
    const first = pages[0].getBoundingClientRect(), last = pages[pages.length - 1].getBoundingClientRect();
    if (y < first.top || y > first.bottom) return null;
    const inset = Math.min(24, first.width * .06);
    return x <= first.left + inset ? "left" : x >= last.right - inset ? "right" : null;
  }
  function tapAt(x, y, touch = false) {
    // The tap that dismissed a selection only dismisses it.
    if (performance.now() - dismissedAt < 700) return;
    const side = sideStrip(x, y);
    if (side) {
      if (lastSideTap.side === side && performance.now() - lastSideTap.at < 450) { lastSideTap = { side: null, at: -Infinity }; quickBookmark(side); }
      else lastSideTap = { side, at: performance.now() };
      return;
    }
    const box = visibleBox();
    const fraction = (x - box.left) / box.width;
    // The upper half of the gutter opens the menu, the lower half the pen kit;
    // with pages held up (see epub-view.js, `held`), a double tap on its
    // middle lets go of them, there.
    if (Math.abs(fraction - .5) <= .08) {
      const along = (y - box.top) / box.height;
      if (rendition?.held && along > .4 && along < .6) {
        if (performance.now() - lastSpineTap < 450) { lastSpineTap = -Infinity; rendition.letGo(); }
        else lastSpineTap = performance.now();
        return;
      }
      if (along <= .5) toggleMenu(); else ink.toggleBar();
      return;
    }
    if (!touch) return;
    turn((fraction > .5) !== (book.package.metadata.direction === "rtl"));
  }
  const wheel = window.createReaderWheel({
    get turn() { return rendition?.turn; },
    dragTurn: delta => rendition?.dragTurn(delta),
    releaseTurn: () => rendition?.releaseTurn(),
    settleTurn: target => rendition?.settleTurn(target)
  }, {
    blocked: () => !rendition || menu.open || !$("epub-note-editor").hidden || (window.visualViewport?.scale || 1) > 1.05,
    direction: () => book?.package.metadata.direction === "rtl" ? -1 : 1
  });
  // Zoom on a touch screen is the book's own, not the browser's: two fingers
  // pinch and move the page, one finger turns it. The browser itself never
  // zooms, so what is pinned to the screen (the pen kit) stays put; a page
  // change cannot throw the view back to a corner; and the screen is not
  // drawn again tile by tile (black patches) after every pinch.
  const rootEl = document.documentElement;
  const touchScreen = rootEl.classList.contains("is-touch") || matchMedia("(pointer: coarse)").matches;
  const zoom = { s: 1, x: 0, y: 0 };
  const isZoomed = () => zoom.s > 1.02;
  viewer.style.transformOrigin = "0 0";
  function applyZoom() {
    zoom.s = Math.min(5, Math.max(1, zoom.s));
    if (zoom.s < 1.02) Object.assign(zoom, { s: 1, x: 0, y: 0 });
    const w = viewer.offsetWidth, h = viewer.offsetHeight;
    zoom.x = Math.min(0, Math.max(w - w * zoom.s, zoom.x));
    zoom.y = Math.min(0, Math.max(h - h * zoom.s, zoom.y));
    viewer.style.transform = zoom.s === 1 ? "" : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
    rootEl.classList.toggle("is-zoomed", isZoomed());
  }
  window.addEventListener("resize", () => { if (isZoomed()) applyZoom(); });
  // Safari's own pinch, should one start anyway.
  for (const type of ["gesturestart", "gesturechange"]) document.addEventListener(type, event => event.preventDefault(), { passive: false });
  // A finger drags the page: right-to-left turns forward, left-to-right back.
  // Decided once the move is clearly horizontal; a second finger is a pinch.
  (() => {
    let drag = null;
    const fingers = new Set();
    const rtl = () => book?.package.metadata.direction === "rtl" ? -1 : 1;
    // Two fingers: the point of the page between them stays between them.
    const touches = new Map();
    let pinch = null;
    const between = () => { const [a, b] = [...touches.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; };
    function startPinch() {
      const m = between(), r = viewer.getBoundingClientRect();
      pinch = { m, s: zoom.s, ox: r.left - zoom.x, oy: r.top - zoom.y, cx: (m.x - r.left) / zoom.s, cy: (m.y - r.top) / zoom.s };
      viewer.style.willChange = "transform";
    }
    function endPinch() {
      pinch = null;
      // Drawn sharp again at the new size, once, when the fingers part.
      viewer.style.willChange = "";
    }
    viewer.addEventListener("pointermove", event => {
      if (!touchScreen || !touches.has(event.pointerId)) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!pinch || touches.size < 2) return;
      const m = between();
      zoom.s = pinch.s * m.d / pinch.m.d;
      const s = Math.min(5, Math.max(1, zoom.s));
      zoom.x = m.x - pinch.ox - pinch.cx * s;
      zoom.y = m.y - pinch.oy - pinch.cy * s;
      applyZoom();
    });
    const lift = event => { touches.delete(event.pointerId); if (touches.size < 2 && pinch) endPinch(); };
    viewer.addEventListener("pointerup", lift);
    viewer.addEventListener("pointercancel", lift);
    viewer.addEventListener("pointerdown", event => {
      if (event.pointerType !== "touch") return;
      fingers.add(event.pointerId);
      if (touchScreen) {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (touches.size === 2) startPinch();
      }
      if (fingers.size > 1) { if (drag?.active) rendition?.settleTurn(0); drag = null; return; }
      if (drag || !rendition || selectionActive() || event.timeStamp === dismissedStamp) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastT: event.timeStamp, v: 0, active: false };
    });
    viewer.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.id) return;
      if (selecting) { drag = null; return; }
      if (!drag.active) {
        const dx = event.clientX - drag.x;
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(event.clientY - drag.y)) return;
        drag.active = true;
        try { viewer.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
      }
      const step = (drag.lastX - event.clientX) * rtl();
      const dt = Math.max(1, event.timeStamp - drag.lastT);
      drag.v = .7 * drag.v + .3 * (step / dt);
      drag.lastX = event.clientX; drag.lastT = event.timeStamp;
      // Zoomed in, the finger's travel is shorter on the page itself.
      if (step) rendition.dragTurn(step / zoom.s, "touch", event.clientY);
    });
    const release = event => {
      fingers.delete(event.pointerId);
      if (!drag || event.pointerId !== drag.id) return;
      const wasActive = drag.active, v = drag.v;
      drag = null;
      if (wasActive) rendition?.releaseTurn(v);
    };
    viewer.addEventListener("pointerup", release);
    viewer.addEventListener("pointercancel", release);
    palmCancels.push(() => {
      if (drag?.active) rendition?.settleTurn(0);
      drag = null;
    });
  })();
  function bindInput(documentOrElement) {
    documentOrElement.addEventListener("wheel", wheel, { passive: false });
    let start = null;
    const doc = documentOrElement.ownerDocument || documentOrElement;
    const hasSelection = () => doc === document ? selectionActive() : Boolean(doc.getSelection()?.toString());
    const interactive = target => target.closest?.("a, button, input, select, textarea, audio, video, [contenteditable], span.epub-hl, .epub-ribbon, .epub-tab, .epub-sticky, .epub-held");
    const toViewer = (x, y) => {
      if (doc === document) return [x, y];
      const frame = doc.defaultView.frameElement, rect = frame.getBoundingClientRect();
      return [rect.left + x * rect.width / frame.offsetWidth, rect.top + y * rect.height / frame.offsetHeight];
    };
    documentOrElement.addEventListener("touchstart", event => {
      start = null;
      if (event.touches.length !== 1 || hasSelection() || interactive(event.composedPath()[0])) return;
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, time: performance.now(), id: touch.identifier };
    }, { passive: true });
    documentOrElement.addEventListener("touchmove", event => {
      const touch = event.touches[0];
      if (start && (event.touches.length !== 1 || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10)) start = null;
    }, { passive: true });
    documentOrElement.addEventListener("touchcancel", () => { start = null; }, { passive: true });
    documentOrElement.addEventListener("touchend", event => {
      lastTouch = performance.now();
      const tap = start;
      start = null;
      const touch = event.changedTouches[0];
      if (!tap || event.touches.length || touch.identifier !== tap.id || performance.now() - tap.time > 350 || hasSelection() ||
          Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > 10) return;
      event.preventDefault();
      tapAt(...toViewer(touch.clientX, touch.clientY), true);
    }, { passive: false });
    documentOrElement.addEventListener("click", event => {
      if (performance.now() - lastTouch < 750 || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey ||
          event.altKey || hasSelection() || interactive(event.composedPath()[0])) return;
      tapAt(...toViewer(event.clientX, event.clientY));
    });
  }

  function updateProgress() {
    if (!current || !locationsReady) return;
    const value = current.atEnd ? 1 : book.locations.percentageFromCfi(current.start.cfi);
    if (!Number.isFinite(value) || value < 0) return;
    progress.value = String(Math.round(value * 10000));
    percent.textContent = `${(value * 100).toFixed(1)}%`;
  }
  progress.addEventListener("input", () => { percent.textContent = `${(Number(progress.value) / 100).toFixed(1)}%`; });
  progress.addEventListener("change", () => {
    const target = book.locations.cfiFromPercentage(Number(progress.value) / 10000);
    if (target) { menu.close(); navigate(() => rendition.display(target)); }
  });

  // Cache potentially large progress indexes in IndexedDB, not localStorage.
  async function locationCache(key, value) {
    if (!window.indexedDB) return null;
    return new Promise(resolve => {
      const opening = indexedDB.open("md2book-epub-cache", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("locations");
      opening.onerror = opening.onblocked = () => resolve(null);
      opening.onsuccess = () => {
        const db = opening.result;
        const tx = db.transaction("locations", value === undefined ? "readonly" : "readwrite");
        const store = tx.objectStore("locations");
        const request = value === undefined ? store.get(key) : store.put(value, key);
        let result = null;
        request.onsuccess = () => { result = request.result; };
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onerror = tx.onabort = () => { db.close(); resolve(null); };
      };
    });
  }
  // Laid-out chapters are kept on this device (static/epub-view.js) under a key
  // that changes with the book's file and with the reader's own code and
  // styles, so a kept page is never shown by a reader that would lay it out
  // differently. Not with Adobe's kit: its glyphs come from its servers, so a
  // chapter laid out online would not match the same chapter offline.
  async function keptLayoutKey(bytes) {
    if (document.querySelector('script[src*="typekit.net"],link[href*="typekit.net"]') || !crypto.subtle || !window.indexedDB) return {};
    try {
      const view = new Uint8Array(bytes), part = 262144;
      const code = await Promise.all([...document.querySelectorAll('script[src*="/static/"], script[src*="/vendor/"], link[rel="stylesheet"][href*="/static/"]')]
        .map(el => fetch(el.src || el.href).then(res => { if (!res.ok) throw new Error(res.status); return res.text(); })));
      const fonts = [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => link.href).filter(href => /fonts/.test(href));
      const sample = await new Blob([view.subarray(0, part), view.subarray(Math.max(part, view.length - part)), code.join("\n"), fonts.join("\n")]).arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", sample))].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
      return { bookId: id, bookKey: `${id}:${bytes.byteLength}:${digest}` };
    } catch { return {}; }
  }
  async function prepareLocations(bytes) {
    // Indexing parses the whole book a second time: too much for a tablet's
    // memory on a large file (the slider stays off; contents still work).
    if (bytes.byteLength > (matchMedia("(pointer: coarse)").matches ? 12 : 80) * 1024 * 1024) return;
    try {
      let cacheKey;
      if (crypto.subtle) {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        cacheKey = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("") + ":1600";
      }
      const cached = cacheKey && await locationCache(cacheKey);
      if (disposed) return;
      let cacheLoaded = false;
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length && parsed.every(cfi => typeof cfi === "string" && cfi.startsWith("epubcfi("))) {
            book.locations.load(parsed);
            cacheLoaded = true;
          }
        } catch { /* regenerate damaged cache */ }
      }
      if (!book.locations.length()) {
        // A separate parser prevents location indexing from unloading chapters
        // that the visible/next spread is still rendering.
        const indexBook = ePub();
        try {
          await indexBook.open(bytes.slice(0), "binary");
          await indexBook.locations.generate(1600);
          if (!disposed) book.locations.load(indexBook.locations.save());
        } finally { indexBook.destroy(); }
      }
      if (disposed) return;
      locationsReady = book.locations.length() > 0;
      renderTicks();
      rendition?.refreshBookmarks();   // the tabs on the top edge need the percentages
      progress.disabled = !locationsReady;
      updateProgress();
      if (cacheKey && !cacheLoaded) await locationCache(cacheKey, book.locations.save());
    } catch { /* Contents and bookmarks still work without a progress index. */ }
  }

  // The contents entry a spine position falls under: the last one starting
  // at or before it (several entries may share one file).
  const chapters = [];
  const chapterAt = index => chapters.filter(c => c.index <= index).pop();
  function renderBookmarks() {
    const list = $("epub-bookmarks");
    list.replaceChildren();
    for (const bookmark of bookmarks) {
      const li = document.createElement("li");
      const jump = document.createElement("button");
      jump.className = "epub-bookmark-jump";
      // The name (or, until one is given, page | how the page begins), and how
      // far into the book, apart on the right.
      jump.innerHTML = '<span class="epub-glyph" aria-hidden="true"></span><span class="toc-title"></span><span class="epub-bookmark-pct"></span>';
      jump.querySelector(".toc-title").textContent = nameOf(bookmark);
      jump.querySelector(".toc-title").classList.toggle("is-placeholder", !bookmark.label);
      jump.querySelector(".epub-bookmark-pct").textContent = Number.isFinite(bookmark.percent) ? `${(bookmark.percent * 100).toFixed(1)}%` : "";
      jump.firstChild.classList.toggle("is-starred", starred(bookmark));
      jump.firstChild.classList.toggle("is-latest", !starred(bookmark) && bookmark.cfi === latestCfi());
      if (bookmark.created) jump.title = new Date(bookmark.created).toLocaleString();
      jump.addEventListener("click", () => { menu.close(); navigate(() => rendition.holdTurn(bookmark.cfi)); });
      const remove = document.createElement("button");
      remove.className = "epub-bookmark-remove";
      remove.innerHTML = '<span class="toc-title">×</span>';
      remove.setAttribute("aria-label", `Remove bookmark: ${nameOf(bookmark)}`);
      remove.disabled = bookmarkBusy;
      remove.addEventListener("click", () => changeBookmark({ type: "remove", cfi: bookmark.cfi }));
      li.className = "toc-item"; li.append(jump, remove); list.append(li);
    }
    // (Not while a note's name is being written on it.)
    if (!naming) rendition?.refreshBookmarks();
    renderTicks();
    addBookmark.disabled = !current || !bookmarksReady;
    const marked = bookmarks.some(b => b.cfi === current?.start.cfi);
    addBookmark.textContent = marked ? "Added" : "Add";
    // The pen kit's bookmark: filled when this page has one.
    const kitMark = inkBar.querySelector('[data-act="bookmark"]');
    kitMark.setAttribute("aria-pressed", String(marked)); kitMark.disabled = addBookmark.disabled;
    kitMark.title = kitMark.ariaLabel = marked ? "Remove this page's bookmark" : "Bookmark this page";
  }
  // Small ribbons on the progress line, where the bookmarks are in the book.
  function renderTicks() {
    const line = $("epub-ticks");
    if (!line) return;
    line.replaceChildren();
    for (const bookmark of bookmarks) {
      const at = bookmark.percent;
      if (!Number.isFinite(at) || at < 0) continue;
      const tick = document.createElement("i");
      tick.classList.toggle("is-starred", starred(bookmark));
      tick.classList.toggle("is-latest", !starred(bookmark) && bookmark.cfi === latestCfi());
      tick.style.left = (at * 100) + "%";
      line.append(tick);
    }
  }
  async function cloudRequest(operation) {
    const response = await fetch(bookmarkUrl, operation ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation)
    } : { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Cloud bookmarks are unavailable.");
    // Saved on this device while offline (static/sw.js), not yet sent.
    waiting = Number(response.headers.get("X-Md2book-Pending")) || 0;
    showWaiting();
    return data;
  }
  let waiting = 0;
  // Changes saved offline were just sent (static/sw.js): show what is stored now.
  navigator.serviceWorker?.addEventListener("message", event => {
    if (cloud && event.data?.type === "notes" && event.data.sent && !bookmarkBusy) loadBookmarks();
  });
  function showWaiting() {
    syncNote.textContent = waiting ? `${waiting} change${waiting === 1 ? "" : "s"} saved on this device, not yet synced: sent once the site can be reached.` : "";
    syncNote.hidden = !waiting;
  }
  const arrayOf = value => Array.isArray(value) ? value : [];
  // Notes this browser kept before the book's notes were saved elsewhere (a
  // local server before it used the vault's files): added to them, once.
  async function moveLocalNotes() {
    const movedKey = stateKey + ":moved";
    try { if (localStorage.getItem(movedKey)) return; } catch { return; }
    const local = await loadLocal();
    const operations = [
      ...arrayOf(local.bookmarks).filter(b => b?.cfi && !bookmarks.some(x => x.cfi === b.cfi)).map(b => ({ type: "add", cfi: b.cfi, label: String(b.label || "").slice(0, 300) })),
      ...arrayOf(local.highlights).filter(h => h?.id && !highlights.some(x => x.id === h.id)).map(h => ({ type: "highlight", highlight: h }))
    ];
    let failed = false;
    for (const operation of operations) {
      try { const data = await cloudRequest(operation); bookmarks = arrayOf(data.bookmarks); highlights = arrayOf(data.highlights); }
      catch { failed = true; }   // tried again next time
    }
    if (!failed) try { localStorage.setItem(movedKey, "1"); } catch { /* storage unavailable */ }
  }
  async function loadBookmarks() {
    if (bookmarkBusy) return;
    bookmarkBusy = true;
    try {
      if (cloud) {
        const data = await cloudRequest(); bookmarks = arrayOf(data.bookmarks); highlights = arrayOf(data.highlights);
        await moveLocalNotes();
      }
      else { const data = await loadLocal(); bookmarks = arrayOf(data.bookmarks); highlights = arrayOf(data.highlights); }
      bookmarksReady = true;
      lastSync = Date.now();
      showWaiting();
    } catch (error) {
      // Retried the next time the menu opens; say why nothing is shown.
      syncNote.textContent = error.message || "Could not load notes."; syncNote.hidden = false;
    } finally { bookmarkBusy = false; renderBookmarks(); rendition?.refreshHighlights(); }
  }
  // A bookmark changes on screen at once and is saved behind the scenes, in
  // order: one just made can be named straight away (on a touch screen, while
  // the tap that made it still lets the keyboard come up).
  let bookmarkSaves = Promise.resolve(), bookmarkPending = 0;
  function changeBookmark(operation) {
    if (!bookmarksReady) return bookmarkSaves;
    const result = bookmarks.filter(b => b.cfi !== operation.cfi);
    // Renamed, a bookmark keeps its date (and so whether it is the newest).
    const kept = bookmarks.find(b => b.cfi === operation.cfi);
    const meta = {};
    for (const key of ["excerpt", "page", "percent"]) if ((operation[key] ?? kept?.[key]) !== undefined) meta[key] = operation[key] ?? kept[key];
    if (operation.type === "add") result.push({ cfi: operation.cfi, label: operation.label, ...meta, created: kept?.created || new Date().toISOString() });
    bookmarks = result;
    bookmarkPending++; bookmarkBusy = true;
    renderBookmarks();
    return bookmarkSaves = bookmarkSaves.then(async () => {
      let failed = false;
      try {
        if (cloud) {
          const stored = (await cloudRequest(operation)).bookmarks;
          // (A later change still to be sent: what is shown already has it.)
          if (bookmarkPending === 1) bookmarks = stored;
        } else await saveLocal({ bookmarks, highlights });
        lastSync = Date.now();
      } catch (error) {
        failed = true;
        syncNote.textContent = error.message || "Not saved."; syncNote.hidden = false;
      } finally {
        bookmarkPending--; bookmarkBusy = bookmarkPending > 0;
        renderBookmarks();
        // What is shown was not saved: show what is.
        if (failed && !bookmarkBusy) loadBookmarks();
      }
    });
  }
  // From the pen kit: a bookmark for this page, or off again.
  inkBar.querySelector('[data-act="bookmark"]').addEventListener("click", () => {
    if (!current) return;
    if (bookmarks.some(b => b.cfi === current.start.cfi)) changeBookmark({ type: "remove", cfi: current.start.cfi });
    else quickBookmark("left");
  });
  // A bookmark is made with what stays true of it, as its date does: the page
  // it was on, how far into the book that is, and how the page begins (its
  // name until it is given one).
  // (`mark`: the page, from rendition.pageMark.)
  function bookmarkMeta(mark) {
    const shown = mark.el.querySelector(".epub-page-content");
    const text = (shown?.shadowRoot?.querySelector("body")?.textContent || "").replace(/\s+/g, " ").trim();
    const page = mark.page ?? null, total = current?.pagination?.total ?? null;
    const spine = book.spine.spineItems.filter(s => s.linear), at = spine.findIndex(s => s.index === current.start.index);
    const percent = page && total ? (page - 1) / total
      : locationsReady ? book.locations.percentageFromCfi(mark.cfi)
      : Math.max(0, at) / Math.max(1, spine.length);
    return { ...(text ? { excerpt: text.slice(0, 24) } : {}), ...(page ? { page } : {}), percent: Math.round(Math.min(1, Math.max(0, percent)) * 10000) / 10000 };
  }
  const nameOf = b => b.label || `${b.page ?? "—"} | ${b.excerpt || ""}`.trim();
  // A name beginning with "*": marked out (pale blue, over the newest's orange).
  const starred = b => /^[*＊]/.test(b.label.trim());
  addBookmark.addEventListener("click", () => { menu.close(); quickBookmark("left"); });

  // --- Bookmark notes in the book's edges --------------------------------------
  // The newest bookmark is red, the others pale.
  const latestCfi = () => bookmarks.reduce((a, b) => !a || String(b.created || "") > String(a.created || "") ? b : a, null)?.cfi || null;
  const bookmarkTabs = () => {
    const latest = latestCfi();
    // A name given by hand shows on the note, as much as fits. Where
    // it is down the edge and how deep in it: from the place it was made at.
    return bookmarks.filter(b => Number.isFinite(b.percent) && Number.isInteger(b.page))
      .map(b => ({ cfi: b.cfi, label: nameOf(b), name: b.label.trim(), at: b.percent, page: b.page, latest: b.cfi === latest, starred: starred(b) }));
  };
  // The note open (its name in full, or being named) looks pressed (greyer).
  const markOpen = cfi => viewer.querySelectorAll(".epub-tab").forEach(el => {
    el.classList.toggle("is-open", el.dataset.cfi === cfi);
    if (el.dataset.cfi !== cfi) el.classList.remove("is-expanded");
  });
  const closeTab = () => markOpen(null);
  // `how` (epub-view.js): "jump" (a tap or click), "edit" (a double one),
  // "preview" (the pointer resting on it, a finger held): the note darkens,
  // and opens out if its name is cut short; "unpreview".
  function openTab(cfi, el, how) {
    const b = bookmarks.find(x => x.cfi === cfi);
    if (!b || naming) return;
    if (how === "jump") { closeTab(); navigate(() => rendition.holdTurn(cfi)); return; }
    if (how === "edit") { editTab(cfi); return; }
    if (how === "unpreview") { closeTab(); return; }
    markOpen(cfi);
    // Only a name cut short opens out; one shown whole just darkens.
    const text = el.querySelector(".epub-tab-text");
    el.classList.toggle("is-expanded", text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1);
  }
  document.addEventListener("pointerdown", event => { if (!naming && !event.target.closest?.(".epub-tab")) closeTab(); }, true);
  // A note's name is written on the note itself (drawn out over the page a
  // little, for room): Enter or a press elsewhere keeps it, Escape doesn't; left
  // empty, the bookmark has no name again (in the menu: "page | text").
  function editTab(cfi) {
    closeTab();
    const b = bookmarks.find(x => x.cfi === cfi);
    const el = viewer.querySelector(`.spread.is-current .epub-tab[data-cfi="${CSS.escape(cfi)}"]`);
    const text = el?.querySelector(".epub-tab-text");
    if (!b || !text) return;
    if (naming) endEdit(true);
    el.classList.remove("is-expanded");
    // (Coloured as when it is open.)
    el.classList.add("is-open");
    naming = { cfi, el, text };
    el.classList.add("is-editing");
    text.contentEditable = "true";
    text.textContent = b.label || "";
    text.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); endEdit(true); }
      else if (event.key === "Escape") { event.preventDefault(); endEdit(false); }
    });
    text.addEventListener("paste", event => {
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain").replace(/\s+/g, " "));
    });
    text.addEventListener("blur", () => endEdit(true));
    // Beside it while it is named: delete it (at the press, before the
    // writing loses its focus and the name is kept).
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "epub-tab-delete"; remove.title = remove.ariaLabel = "Delete bookmark";
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
    remove.addEventListener("pointerdown", event => { event.preventDefault(); event.stopPropagation(); endEdit(false); changeBookmark({ type: "remove", cfi }); });
    text.parentElement.append(remove);
    text.focus();
    const range = document.createRange(); range.selectNodeContents(text);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  function endEdit(save) {
    if (!naming) return;
    const { cfi, el, text } = naming;
    naming = null;
    const label = text.textContent.replace(/\s+/g, " ").trim().slice(0, 300), b = bookmarks.find(x => x.cfi === cfi);
    text.contentEditable = "false"; el.classList.remove("is-editing");
    el.querySelector(".epub-tab-delete")?.remove();
    document.getSelection()?.removeAllRanges();
    if (save && b && label !== (b.label || "")) changeBookmark({ type: "add", cfi, label });
    else rendition?.refreshBookmarks();
  }
  // A bookmark for the page on one side (a double tap on that edge, the
  // menu's Add, the pen kit's), its name ready to be written; if the page
  // has one, its name.
  function quickBookmark(side) {
    const mark = rendition?.pageMark(side);
    if (!mark || !bookmarksReady) return;
    const cfi = mark.el.querySelector(":scope > .epub-tab.is-here")?.dataset.cfi
      || (changeBookmark({ type: "add", cfi: mark.cfi, label: "", ...bookmarkMeta(mark) }), mark.cfi);
    editTab(cfi);
  }

  // Highlights and notes. Shown at once, saved in order behind the scenes;
  // a failed save reloads what is actually stored.
  // While a highlight is being stretched, the painted copy follows its saved note and marker.
  const livePending = () => { const saved = pending?.edit && highlights.find(x => x.id === pending.id); return saved ? { ...pending, note: saved.note, marker: saved.marker } : pending; };
  // (And a new note not yet written: its sticky note, empty, by its passage.)
  let draftNote = null;
  const highlightsOf = index => [...highlights.filter(h => h.section === index && h.id !== pending?.id), ...(pending?.section === index ? [livePending()] : []),
    ...(draftNote?.section === index ? [draftNote] : [])];
  let saving = Promise.resolve();
  function changeHighlight(operation) {
    if (!bookmarksReady) return;
    if (operation.type === "highlight") {
      const h = { ...operation.highlight, created: highlights.find(x => x.id === operation.highlight.id)?.created || new Date().toISOString() };
      highlights = highlights.some(x => x.id === h.id) ? highlights.map(x => x.id === h.id ? h : x) : [...highlights, h];
    } else highlights = highlights.filter(h => h.id !== operation.id);
    rendition?.refreshHighlights();
    saving = saving.then(async () => {
      try {
        if (cloud) await cloudRequest(operation);
        else await saveLocal({ bookmarks, highlights });
      } catch { bookmarkBusy = false; await loadBookmarks(); }
    });
  }
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const bar = $("epub-selection-bar"), editor = $("epub-note-editor"), noteText = $("epub-note-text");
  let picked = null, editing = null, barTimer;
  function place(el, rect, below) {
    el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    const top = below ? Math.min(innerHeight - h - 8, rect.bottom + 8) : Math.max(8, rect.top - h - 8);
    el.style.left = left + "px"; el.style.top = top + "px";
  }
  let anchor = null;
  // Closing the note box also lets go of a tapped highlight (its handles).
  // A note started on a fresh selection: kept here until it has text, then saved as a
  // note with its underline only (no highlight).
  let drafting = null;
  function closeEditor() {
    const wasDraft = drafting;
    editing = null; drafting = null; editor.hidden = true;
    if (pending && (pending.edit || wasDraft)) clearPending();
  }
  const coarse = () => matchMedia("(pointer: coarse)").matches;
  // The note box is as tall as its lines, up to its max-height (it scrolls
  // past that), and stays on screen as it grows.
  let editorRect = null;
  function fitNote() {
    noteText.style.height = "auto";
    noteText.style.height = noteText.scrollHeight + "px";
    if (!editor.hidden && editorRect) place(editor, editorRect, true);
  }
  function openEditor(h, rect = anchor, focus = !coarse()) {
    editing = h; bar.hidden = true;
    noteText.value = h.note || "";
    syncMarkerButton(h);
    editorRect = rect;
    place(editor, rect, true);
    fitNote();
    if (focus) noteText.focus({ preventScroll: true });
  }
  async function createHighlight(picked) {
    const info = await rendition.contextFor(picked).catch(() => picked);
    const h = { id: newId(), section: info.section, quote: info.quote.slice(0, 1000), prefix: info.prefix, suffix: info.suffix, note: "" };
    pending = null; handles.forEach(h => { h.hidden = true; });
    changeHighlight({ type: "highlight", highlight: h });
    document.getSelection()?.removeAllRanges();
    bar.hidden = true; picked = null;
    return h;
  }
  const handles = [$("epub-handle-start"), $("epub-handle-end")];
  function clearPending() {
    if (!pending) return;
    pending = null; picked = null; bar.hidden = true; handles.forEach(h => { h.hidden = true; });
    rendition?.refreshHighlights();
  }
  // Show the handles and the bar around the painted selection.
  function showSelection() {
    const m = pending && rendition.measure(pending);
    if (!m) { clearPending(); return; }
    picked = { section: pending.section, quote: m.quote, prefix: m.prefix, suffix: m.suffix, rect: m.rect };
    for (const [handle, point] of [[handles[0], m.startPoint], [handles[1], m.endPoint]]) {
      handle.style.left = point.x + "px"; handle.style.top = point.y + "px"; handle.style.height = point.h + "px"; handle.hidden = false;
    }
    // A new selection offers Highlight and Note; a tapped highlight, Note and Delete.
    anchor = { left: m.rect.left, width: m.rect.width, top: m.rect.top, bottom: m.endPoint.y + m.endPoint.h + 18 };
    // A tapped highlight opens its note box straight away; a new selection, the small bar.
    if (drafting) Object.assign(drafting, { quote: m.quote.slice(0, 1000), prefix: m.prefix, suffix: m.suffix });
    if (pending.edit || drafting) { bar.hidden = true; if (!editor.hidden) place(editor, anchor, true); }
    else place(bar, anchor, true);
  }
  function startSelection(x, y) {
    const found = rendition?.pickWord(x, y);
    if (!found) return false;
    pending = { ...found, id: "pending", pending: true, quote: "", prefix: "", suffix: "" };
    rendition.refreshHighlights();
    showSelection();
    return true;
  }
  // A tap on a highlight selects it: handles to stretch it, and Note / Delete.
  // A tapped highlight: its handles, and (`box`) the box for a note to it.
  function startEdit(mark, box = true) {
    const h = highlights.find(x => x.id === mark.dataset.id), found = h && rendition.editInfo(mark);
    if (!found) return false;
    if (pending?.id === h.id) return true;
    clearPending();
    pending = { ...found, id: h.id, edit: true, base: h, note: h.note, quote: h.quote, prefix: h.prefix, suffix: h.suffix };
    rendition.refreshHighlights();
    showSelection();
    if (pending && box) { openEditor(h); bar.hidden = true; }
    else bar.hidden = true;
    return true;
  }
  // The stretched range of a tapped highlight is saved when the handle is let go.
  async function commitEdit() {
    if (!pending?.edit) return;
    const m = rendition.measure(pending), base = pending.base;
    if (!m || m.quote === base.quote) return;
    const info = await rendition.contextFor({ section: pending.section, quote: m.quote.slice(0, 1000), prefix: m.prefix, suffix: m.suffix }).catch(() => m);
    const next = { ...base, quote: info.quote, prefix: info.prefix, suffix: info.suffix };
    if (pending?.edit) pending.base = next;
    changeHighlight({ type: "highlight", highlight: next });
  }
  // A long press selects the word under the finger; the handles stretch it.
  (() => {
    let press = null;
    const fingers = new Set();
    const cancel = () => { if (press) { clearTimeout(press.timer); press = null; } };
    viewer.addEventListener("pointerdown", event => {
      if (event.pointerType !== "touch") return;
      fingers.add(event.pointerId);
      cancel();
      if (fingers.size > 1 || !rendition || menu.open) return;
      const { clientX: x, clientY: y } = event;
      press = { id: event.pointerId, x, y, timer: setTimeout(() => {
        press = null;
        if (startSelection(x, y)) { selecting = true; dismissedAt = performance.now(); }
      }, 450) };
    });
    viewer.addEventListener("pointermove", event => {
      // A finger already moving sideways, however slowly, is turning the page.
      if (press && event.pointerId === press.id && (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8 || Math.abs(event.clientX - press.x) > 4)) cancel();
    });
    const up = event => {
      fingers.delete(event.pointerId);
      if (press && event.pointerId === press.id) cancel();
      if (selecting) { selecting = false; dismissedAt = performance.now(); }
    };
    viewer.addEventListener("pointerup", up);
    viewer.addEventListener("pointercancel", up);
    palmCancels.push(() => {
      cancel();
      if (selecting) { selecting = false; clearPending(); }
    });
    viewer.addEventListener("contextmenu", event => { if (coarse()) event.preventDefault(); });
  })();
  handles.forEach((handle, which) => {
    let dragging = false;
    let grab = 0;
    handle.addEventListener("pointerdown", event => {
      event.preventDefault(); dragging = true;
      // Keep aiming at the line the handle was taken on, however the finger sits on it.
      const box = handle.getBoundingClientRect();
      grab = box.top + 14 + (box.height - 28) / 2 - event.clientY;
      try { handle.setPointerCapture(event.pointerId); } catch { /* gone */ }
    });
    handle.addEventListener("pointermove", event => {
      if (!dragging || !pending) return;
      const at = rendition.offsetAt(pending.shadow, event.clientX, event.clientY + grab);
      if (at === null) return;
      const [start, end] = pending.offsets;
      const next = which === 0 ? [Math.min(at, end - 1), end] : [start, Math.max(at, start + 1)];
      if (next[0] === start && next[1] === end) return;
      pending.offsets = next;
      rendition.refreshHighlights();
      showSelection();
    });
    const stop = () => { if (dragging) { dragging = false; commitEdit(); } };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });
  document.addEventListener("selectionchange", () => {
    clearTimeout(barTimer);
    // Touch screens never use the native selection (see above).
    if (coarse()) return;
    barTimer = setTimeout(() => {
      if (!rendition || menu.open || !editor.hidden || pending) return;
      picked = rendition.selection();
      if (picked) place(bar, picked.rect, false); else bar.hidden = true;
    }, 250);
  });
  document.addEventListener("pointerdown", event => {
    if (pending && !pending.edit && !bar.contains(event.target) && !editor.contains(event.target) && !event.target.closest?.(".epub-handle, .epub-sticky, .epub-sticky-delete")) { dismissedAt = performance.now(); dismissedStamp = event.timeStamp; clearPending(); }
  }, true);
  // Pressing the bar must not drop a native selection (mouse).
  bar.addEventListener("mousedown", event => event.preventDefault());
  bar.addEventListener("click", async event => {
    const act = event.target.closest("button")?.dataset.act;
    if (!act || !picked) return;
    // Notes could not be loaded (cloud sign-in missing): the menu says why.
    if (!bookmarksReady) { bar.hidden = true; toggleMenu(); return; }
    const rect = picked.rect;
    if (act === "note") {
      // Note, not Highlight: only the underline shows, and a sticky note in the
      // margin to write it on (kept only once written on).
      const info = await rendition.contextFor(picked).catch(() => picked);
      pending = null; picked = null; handles.forEach(h => { h.hidden = true; });
      document.getSelection()?.removeAllRanges();
      bar.hidden = true;
      draftNote = { id: newId(), section: info.section, quote: info.quote.slice(0, 1000), prefix: info.prefix, suffix: info.suffix, note: "", marker: false, draft: true };
      rendition.refreshHighlights();
      editSticky(draftNote.id);
      return;
    }
    await createHighlight(picked);
  });
  viewer.addEventListener("click", event => {
    if (event.target.closest?.(".epub-sticky, .epub-sticky-delete")) return;
    const mark = event.composedPath().find(node => node.matches?.("span.epub-hl"));
    if (!mark || mark.dataset.id === "pending" || mark.dataset.id === stickyEditing?.id || document.getSelection()?.toString()) return;
    // A note's passage: written on on its sticky note; a highlight: its box.
    if (highlights.find(x => x.id === mark.dataset.id)?.note) writeNote(mark.dataset.id);
    else startEdit(mark);
  });

  // --- Notes on sticky notes ----------------------------------------------------
  // A note is written on its sticky note in the margin (epub-view.js,
  // setStickies), there and nowhere else: a double click or tap on it, or a
  // click on its passage, and it is written on, the passage's handles out to
  // stretch what it is about. Enter or a press elsewhere keeps it (Shift+Enter:
  // a new line), Escape doesn't; its delete button floats beside it.
  let stickyEditing = null, lastStickyUp = null;
  const stickyOf = id => viewer.querySelector(`.spread.is-current .epub-sticky[data-id="${CSS.escape(id)}"]`);
  viewer.addEventListener("pointerup", event => {
    const sticky = event.target.closest?.(".epub-sticky");
    if (!sticky || sticky.classList.contains("is-editing")) return;
    const id = sticky.dataset.id, now = performance.now();
    if (lastStickyUp?.id === id && now - lastStickyUp.at < 400) { lastStickyUp = null; writeNote(id); }
    else lastStickyUp = { id, at: now };
  });
  // Where a page's sticky notes were just put: kept with the notes whose place
  // changed (a note added above moves the ones below), for the bits of them in
  // the edge once the page is turned.
  // (After the drawing that told it, not in the middle of it.)
  function notesPlaced(list) {
    queueMicrotask(() => {
      for (const { id, place } of list) {
        const h = highlights.find(x => x.id === id);
        if (!h?.note || (h.place && h.place.page === place.page && Math.abs(h.place.y - place.y) < 1 && Math.abs(h.place.h - place.h) < 1)) continue;
        changeHighlight({ type: "highlight", highlight: { ...h, place } });
      }
    });
  }
  function writeNote(id) {
    const mark = [...viewer.querySelectorAll(".spread.is-current .epub-page-content")]
      .map(host => host.shadowRoot?.querySelector(`span.epub-hl[data-id="${CSS.escape(id)}"]`)).find(Boolean);
    if (mark) startEdit(mark, false);
    editSticky(id);
  }
  function editSticky(id) {
    const el = stickyOf(id);
    if (!el) return;
    if (stickyEditing) endSticky(true);
    const text = el.querySelector(".epub-sticky-text");
    stickyEditing = { id, el, text };
    el.classList.add("is-editing");
    text.contentEditable = "true";
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "epub-sticky-delete"; remove.title = remove.ariaLabel = "Delete note";
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
    remove.style.top = el.offsetTop + "px";
    remove.style.left = (el.classList.contains("epub-sticky--left") ? el.offsetLeft + el.offsetWidth + 6 : el.offsetLeft - 34) + "px";
    remove.addEventListener("pointerdown", event => {
      event.preventDefault(); event.stopPropagation();
      const h = draftNote?.id === id ? null : highlights.find(x => x.id === id);
      endSticky(false);
      // The note goes; a highlight it was written to stays.
      if (h) changeHighlight(h.marker === false ? { type: "unhighlight", id } : { type: "highlight", highlight: { ...h, note: "" } });
    });
    el.parentElement.append(remove);
    stickyEditing.remove = remove;
    text.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); endSticky(true); }
      else if (event.key === "Escape") { event.preventDefault(); endSticky(false); }
    });
    text.addEventListener("paste", event => {
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    });
    text.addEventListener("blur", () => { if (stickyEditing?.el === el) endSticky(true); });
    text.focus();
    const range = document.createRange(); range.selectNodeContents(text); range.collapse(false);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  function endSticky(save) {
    if (!stickyEditing) return;
    const { id, el, text, remove } = stickyEditing;
    stickyEditing = null;
    const note = text.innerText.replace(/\u00a0/g, " ").trim().slice(0, 2000);
    text.contentEditable = "false"; el.classList.remove("is-editing"); remove?.remove();
    document.getSelection()?.removeAllRanges();
    const draft = draftNote?.id === id ? draftNote : null, h = highlights.find(x => x.id === id);
    if (draft) draftNote = null;
    if (pending?.edit) { pending = null; handles.forEach(handle => { handle.hidden = true; }); }
    if (save && draft && note) changeHighlight({ type: "highlight", highlight: { ...draft, draft: undefined, note } });
    // Written off, a note leaves its highlight (or, without one, it comes back).
    else if (save && h && note !== (h.note || "")) changeHighlight({ type: "highlight", highlight: { ...h, note, marker: note ? h.marker : undefined, place: note ? h.place : undefined } });
    else rendition?.refreshHighlights();
  }
  // The highlight as stored now (its range may have been stretched since the box opened).
  const current_ = () => highlights.find(x => x.id === editing.id) || editing;
  // The eraser keeps the note and drops the green: only worth pressing with a note.
  function syncMarkerButton(h = current_()) {
    const button = $("epub-note-marker");
    button.disabled = !noteText.value.trim();
    button.setAttribute("aria-pressed", String(h.marker === false && !button.disabled));
  }
  noteText.addEventListener("input", () => { if (editing) syncMarkerButton(); fitNote(); });
  $("epub-note-marker").addEventListener("click", () => {
    if (!editing) return;
    const cur = current_(), note = noteText.value.trim();
    if (!note) return;
    changeHighlight({ type: "highlight", highlight: { ...cur, note, marker: cur.marker === false ? undefined : false } });
    syncMarkerButton({ ...cur, marker: cur.marker === false ? undefined : false });
  });
  editor.addEventListener("submit", event => {
    event.preventDefault();
    if (editing) {
      const cur = current_(), note = noteText.value.trim();
      if (editing === drafting) {
        // A new note-only mark: nothing to keep without text.
        if (note) changeHighlight({ type: "highlight", highlight: { ...cur, note } });
      } else {
        // Without a note the erased highlight would vanish: it comes back.
        changeHighlight({ type: "highlight", highlight: { ...cur, note, marker: note ? cur.marker : undefined } });
      }
    }
    closeEditor();
  });
  $("epub-note-delete").addEventListener("click", () => {
    if (editing && editing !== drafting) changeHighlight({ type: "unhighlight", id: editing.id });
    closeEditor();
  });
  document.addEventListener("pointerdown", event => {
    if (!editor.hidden && !editor.contains(event.target) && !event.target.closest?.(".epub-handle")) {
      dismissedAt = performance.now(); dismissedStamp = event.timeStamp;
      closeEditor();
    }
  }, true);
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeEditor(); }, true);

  // Paper effects (show-through, letterpress, ink bleed, highlight bleed-through) are
  // heavy for a tablet or phone: off there until this switch turns them on.
  const effectsRow = $("epub-effects-row");
  if (coarse() && (row.showThrough || row.letterpress || row.inkBleed)) {
    effectsRow.hidden = false;
    const box = $("epub-effects");
    try { box.checked = localStorage.getItem("md2book.epub.effects") === "1"; } catch { /* no storage */ }
    box.addEventListener("change", () => {
      try { localStorage.setItem("md2book.epub.effects", box.checked ? "1" : "0"); } catch { /* no storage */ }
      location.reload();   // the reading position is saved on every turn
    });
  }
  // Without a cloud library the notes live in this browser, which can be
  // cleared: a file copy keeps them safe.
  if (!cloud) {
    $("epub-backup").hidden = false;
    $("epub-export").addEventListener("click", () => {
      const file = new Blob([JSON.stringify({ bookmarks, highlights, ink: ink.exportData() }, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(file); link.download = `${document.title || "book"}-notes.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
    $("epub-import").addEventListener("click", () => $("epub-import-file").click());
    $("epub-import-file").addEventListener("change", async event => {
      const file = event.target.files[0]; event.target.value = "";
      if (!file || !bookmarksReady) return;
      try {
        const data = JSON.parse(await file.text());
        const mergedBookmarks = [...bookmarks], mergedHighlights = [...highlights];
        for (const b of arrayOf(data.bookmarks)) if (typeof b?.cfi === "string" && !mergedBookmarks.some(x => x.cfi === b.cfi)) mergedBookmarks.push({ cfi: b.cfi, label: String(b.label || "").slice(0, 300), created: b.created });
        for (const h of arrayOf(data.highlights)) if (typeof h?.id === "string" && typeof h.quote === "string" && Number.isInteger(h.section) && !mergedHighlights.some(x => x.id === h.id)) mergedHighlights.push(h);
        bookmarks = mergedBookmarks; highlights = mergedHighlights;
        await saveLocal({ bookmarks, highlights });
        if (data.ink) ink.importData(data.ink);
        renderBookmarks(); rendition?.refreshHighlights();
      } catch { /* Not a notes file. */ }
    });
  }
  loadBookmarks();

  // The layout report (static/epub-report.js), for comparing where pages
  // begin and end on two devices, and the ink log (static/epub-ink.js), what
  // the pen sent: shown to copy or save.
  function showReport(label, name, make) {
    menu.close();
    const dialog = document.createElement("dialog");
    dialog.className = "epub-report";
    dialog.innerHTML = '<textarea readonly></textarea><div class="acts"><button type="button" data-act="save">Save as file</button><button type="button" class="main" data-act="copy">Copy</button><button type="button" data-act="close">Close</button></div>';
    const area = dialog.querySelector("textarea");
    area.setAttribute("aria-label", label); area.value = "Making the report…";
    document.body.append(dialog);
    dialog.showModal();
    let text = "";
    Promise.resolve().then(make).then(value => { text = value; }, error => { text = `Could not make the report: ${error.message || error}`; })
      .then(() => { area.value = text; });
    dialog.addEventListener("click", async event => {
      const act = event.target.closest("button")?.dataset.act;
      if (act === "close") { dialog.close(); dialog.remove(); }
      else if (act === "copy") {
        try { await navigator.clipboard.writeText(text); event.target.textContent = "Copied"; }
        catch { area.focus(); area.select(); }
      } else if (act === "save") {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
        link.download = `${document.title || "book"} ${name} ${/iPad|iPhone/.test(navigator.userAgent) || navigator.maxTouchPoints > 1 ? "iPad" : "computer"}.txt`;
        link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      }
    });
  }
  let keep = {};
  $("epub-report-open")?.addEventListener("click", () => {
    if (!rendition || !window.md2bookLayoutReport) return;
    showReport("Layout report", "layout", () => window.md2bookLayoutReport({ title: document.title, row, rendition, keep, toc: chapters.map(c => ({ index: c.index, label: c.label })) }));
  });
  $("epub-ink-log-open")?.addEventListener("click", () => showReport("Ink log", "ink log", () => ink.log()));

  try {
    // In ranges where the server honours them: a serverless response is capped.
    const CHUNK = 3 * 1024 * 1024;
    await window.md2bookOpening?.step("download");
    const first = await fetch(url, { headers: { Range: `bytes=0-${CHUNK - 1}` } });
    if (!first.ok) throw new Error(`File request failed (${first.status})`);
    let bytes = await first.arrayBuffer();
    const total = first.status === 206 && Number(/\/(\d+)$/.exec(first.headers.get("content-range") || "")?.[1]);
    if (total && total > bytes.byteLength) {
      const parts = [bytes];
      for (let start = bytes.byteLength; start < total; start += CHUNK) {
        const part = await fetch(url, { headers: { Range: `bytes=${start}-${Math.min(start + CHUNK, total) - 1}` } });
        if (part.status !== 206) throw new Error(`File request failed (${part.status})`);
        parts.push(await part.arrayBuffer());
      }
      const whole = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) { whole.set(new Uint8Array(part), offset); offset += part.byteLength; }
      bytes = whole.buffer;
    }
    // Keep this book for reading offline (or bring the kept copy up to date):
    // static/sw.js, when the site is an app (static/offline.js).
    if (navigator.onLine !== false) navigator.serviceWorker?.ready.then(reg => reg.active?.postMessage({ type: "keep", id })).catch(() => {});
    await window.md2bookOpening?.step("open");
    book = ePub();
    await book.open(bytes, "binary");
    keep = await keptLayoutKey(bytes);
    rendition = window.createEpubView(book, viewer, row, keep);
    rendition.setHighlights(highlightsOf, () => highlights.filter(h => h.note && h.place).map(h => ({ id: h.id, place: h.place })), notesPlaced);
    rendition.setBookmarks(() => bookmarks.map(b => b.cfi), async cfis => { for (const cfi of cfis) await changeBookmark({ type: "remove", cfi }); },
      { tabs: bookmarkTabs, latest: latestCfi, open: openTab });
    rendition.setInk(ink.paint);
    rendition.hooks.content.register(contents => bindInput(contents.document));
    bindInput(viewer);
    const shell = getComputedStyle(document.documentElement);
    rendition.themes.default({
      body: { color: shell.getPropertyValue("--ink").trim(), background: shell.getPropertyValue("--paper").trim() },
      "p, li": { "text-align": row.justify ? "justify !important" : "start !important" },
      img: { "mix-blend-mode": row.multiplyImages ? "multiply !important" : "normal !important" }
    });
    rendition.on("keydown", keydown);
    document.addEventListener("keydown", keydown);
    rendition.on("relocated", location => {
      clearPending();
      current = location;
      // Persist synchronously: a refresh immediately after a turn keeps this CFI.
      try { localStorage.setItem(stateKey, JSON.stringify({ cfi: location.start.cfi, href: location.start.href, updated: Date.now() })); }
      catch { /* Position cannot be saved without browser storage. */ }
      const href = location.start.href.split("#")[0];
      const here = chapterAt(location.start.index);
      for (const item of toc.children) item.classList.toggle("is-current", item === here?.li);
      updateProgress(); renderBookmarks(); ink.turned();
    });
    rendition.on("displayError", fail);
    toc.addEventListener("click", event => {
      const item = event.target.closest(".toc-item");
      if (item) { menu.close(); navigate(() => rendition.display(item.dataset.href)); }
    });
    const navigation = await book.loaded.navigation;
    function addItems(items, depth = 0) {
      for (const item of items) {
        const li = document.createElement("li");
        li.className = "toc-item";
        li.dataset.href = item.href;
        li.style.setProperty("--depth", depth);
        li.innerHTML = '<button type="button"><span class="toc-title"></span></button>';
        li.querySelector(".toc-title").textContent = item.label.trim();
        const spine = book.spine.get(item.href);
        if (spine) chapters.push({ index: spine.index, label: item.label.trim(), li });
        toc.appendChild(li);
        addItems(item.subitems || [], depth + 1);
      }
    }
    addItems(navigation.toc);
    await window.md2bookOpening?.step("layout");
    try { await rendition.display(saved?.cfi || undefined); }
    catch (error) {
      if (!saved?.cfi) throw error;
      // A replaced/edited EPUB may no longer contain the old position.
      try { await rendition.display(saved.href); } catch { await rendition.display(); }
    }
    status.hidden = true;
    window.md2bookOpening?.ready();
    idle(() => prepareLocations(bytes));
  } catch (error) { fail(error); }
  window.addEventListener("pagehide", event => {
    if (event.persisted) return;
    disposed = true;
    wheel.destroy();
    rendition?.destroy();
    book?.destroy();
  }, { once: true });
})();
