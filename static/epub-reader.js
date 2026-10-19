/* EPUB only: position is local; personal cloud bookmarks use the server API. */
(async () => {
  const options = JSON.parse(document.getElementById("epub-config").textContent);
  const { url, row, id, library, cloud } = options;
  const $ = id => document.getElementById(id);
  const viewer = $("epub-viewer"), status = $("epub-status"), toc = $("epub-toc");
  const menu = $("epub-menu"), progress = $("epub-progress"), percent = $("epub-percent");
  const addBookmark = $("epub-bookmark-add"), syncNote = $("epub-sync-note");
  const stateKey = `md2book.epub:${library}:${id}`;
  const bookmarkKey = stateKey + ":bookmarks";
  const highlightKey = stateKey + ":highlights";
  const bookmarkUrl = `/api/epub-bookmarks/${id}`;
  // Touch screens: a finished selection becomes our own grey mark (`pending`) and
  // the native one is dropped, with its blue overlay, handles and menu.
  let pending = null, dismissedAt = -Infinity, dismissedStamp = -1;
  const selectionActive = () => Boolean(pending || document.getSelection()?.toString() || rendition?.selection());
  let book, rendition, current, disposed = false, locationsReady = false;
  let bookmarks = [], highlights = [], bookmarksReady = false, bookmarkBusy = false, lastSync = 0;
  let navigationQueue = Promise.resolve(), queued = 0, lastTouch = -Infinity;
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
    if (event.altKey || event.ctrlKey || event.metaKey ||
        /INPUT|TEXTAREA|SELECT|BUTTON/.test(event.target?.tagName) || event.target?.isContentEditable) return;
    if (event.key === " ") { event.preventDefault(); toggleMenu(); return; }
    if (menu.open) return;
    if (event.code === "Backslash" || event.key === "\\") { event.preventDefault(); navigate(() => rendition.toggleColumns()); return; }
    if (event.code === "Slash" || event.key === "/") { event.preventDefault(); navigate(() => rendition.toggleSpread()); return; }
    const back = ["a", "A", "ArrowLeft"].includes(event.key) || event.code === "ShiftLeft";
    const forward = ["d", "D", "ArrowRight"].includes(event.key) || event.code === "ShiftRight";
    if (!back && !forward) return;
    event.preventDefault();
    turn(forward !== (book.package.metadata.direction === "rtl"));
  }

  // The part of the page on screen: all of it, or — pinch-zoomed and panned —
  // the visible window, so a tap on its left or right edge still turns the page.
  function visibleBox() {
    const bounds = viewer.getBoundingClientRect(), vv = window.visualViewport;
    if (!vv || vv.scale <= 1.02) return bounds;
    return { left: Math.max(bounds.left, vv.offsetLeft), top: Math.max(bounds.top, vv.offsetTop),
      width: vv.width, height: vv.height };
  }
  function tapAt(x, y, touch = false) {
    // The tap that dismissed a selection only dismisses it.
    if (performance.now() - dismissedAt < 700) return;
    const box = visibleBox();
    const fraction = (x - box.left) / box.width;
    // The menu opens from the upper half of the gutter only.
    if (Math.abs(fraction - .5) <= .08 && y - box.top <= box.height / 2) { toggleMenu(); return; }
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
  // Pinch-zoom state: while zoomed a finger pans the page and never turns it.
  const rootEl = document.documentElement;
  const isZoomed = () => { const vv = window.visualViewport; return !!vv && (vv.scale > 1.02 || vv.width < rootEl.clientWidth - 2); };
  const updateZoom = () => rootEl.classList.toggle("is-zoomed", isZoomed());
  window.visualViewport?.addEventListener("resize", updateZoom);
  window.visualViewport?.addEventListener("scroll", updateZoom);
  // A finger drags the page: right-to-left turns forward, left-to-right back.
  // Decided once the move is clearly horizontal; a second finger is a pinch.
  (() => {
    let drag = null;
    const fingers = new Set();
    const rtl = () => book?.package.metadata.direction === "rtl" ? -1 : 1;
    viewer.addEventListener("pointerdown", event => {
      if (event.pointerType !== "touch") return;
      fingers.add(event.pointerId);
      if (fingers.size > 1) { if (drag?.active) rendition?.settleTurn(0); drag = null; return; }
      if (drag || isZoomed() || !rendition || selectionActive() || event.timeStamp === dismissedStamp) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastT: event.timeStamp, v: 0, active: false };
    });
    viewer.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.active && isZoomed()) { drag = null; return; }
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
      if (step) rendition.dragTurn(step, "touch", event.clientY);
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
  })();
  function bindInput(documentOrElement) {
    documentOrElement.addEventListener("wheel", wheel, { passive: false });
    let start = null;
    const doc = documentOrElement.ownerDocument || documentOrElement;
    const hasSelection = () => doc === document ? selectionActive() : Boolean(doc.getSelection()?.toString());
    const interactive = target => target.closest?.("a, button, input, select, textarea, audio, video, [contenteditable], span.epub-hl");
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
      jump.innerHTML = '<span class="toc-title"></span>';
      jump.firstChild.textContent = bookmark.label;
      if (bookmark.created) jump.title = new Date(bookmark.created).toLocaleString();
      jump.addEventListener("click", () => { menu.close(); navigate(() => rendition.display(bookmark.cfi)); });
      const remove = document.createElement("button");
      remove.className = "epub-bookmark-remove";
      remove.innerHTML = '<span class="toc-title">×</span>';
      remove.setAttribute("aria-label", `Remove bookmark: ${bookmark.label}`);
      remove.disabled = bookmarkBusy;
      remove.addEventListener("click", () => changeBookmark({ type: "remove", cfi: bookmark.cfi }));
      li.className = "toc-item"; li.append(jump, remove); list.append(li);
    }
    addBookmark.disabled = !current || !bookmarksReady || bookmarkBusy;
    addBookmark.textContent = bookmarks.some(b => b.cfi === current?.start.cfi) ? "Added" : "Add";
  }
  async function cloudRequest(operation) {
    const response = await fetch(bookmarkUrl, operation ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation)
    } : { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Cloud bookmarks are unavailable.");
    return data;
  }
  const arrayOf = value => Array.isArray(value) ? value : [];
  async function loadBookmarks() {
    if (bookmarkBusy) return;
    bookmarkBusy = true;
    try {
      if (cloud) { const data = await cloudRequest(); bookmarks = arrayOf(data.bookmarks); highlights = arrayOf(data.highlights); }
      else { const data = await loadLocal(); bookmarks = arrayOf(data.bookmarks); highlights = arrayOf(data.highlights); }
      bookmarksReady = true;
      lastSync = Date.now();
      syncNote.hidden = true;
    } catch (error) {
      // Retried the next time the menu opens; say why nothing is shown.
      syncNote.textContent = error.message || "Could not load notes."; syncNote.hidden = false;
    } finally { bookmarkBusy = false; renderBookmarks(); rendition?.refreshHighlights(); }
  }
  async function changeBookmark(operation) {
    if (!bookmarksReady || bookmarkBusy) return;
    bookmarkBusy = true;
    renderBookmarks();
    try {
      if (cloud) bookmarks = (await cloudRequest(operation)).bookmarks;
      else {
        const result = bookmarks.filter(b => b.cfi !== operation.cfi);
        if (operation.type === "add") result.push({ cfi: operation.cfi, label: operation.label, created: new Date().toISOString() });
        bookmarks = result;
        await saveLocal({ bookmarks, highlights });
      }
      lastSync = Date.now();
    } catch (error) {
      syncNote.textContent = error.message || "Not saved."; syncNote.hidden = false;
    } finally { bookmarkBusy = false; renderBookmarks(); }
  }
  addBookmark.addEventListener("click", () => {
    if (!current || bookmarks.some(b => b.cfi === current.start.cfi)) return;
    const chapter = chapterAt(current.start.index)?.label || `Chapter ${current.start.index + 1}`;
    changeBookmark({ type: "add", cfi: current.start.cfi, label: `${chapter}${locationsReady ? ` · ${percent.textContent}` : ""}`.slice(0, 300) });
  });

  // Highlights and notes. Shown at once, saved in order behind the scenes;
  // a failed save reloads what is actually stored.
  const highlightsOf = index => [...highlights.filter(h => h.section === index), ...(pending?.section === index ? [pending] : [])];
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
  function closeEditor() { editing = null; editor.hidden = true; }
  const coarse = () => matchMedia("(pointer: coarse)").matches;
  function openEditor(h, rect, focus = true) {
    editing = h; bar.hidden = true;
    $("epub-note-quote").textContent = h.quote.trim();
    noteText.value = h.note || "";
    $("epub-note-clear").hidden = !h.note;
    place(editor, rect, true);
    if (focus) noteText.focus({ preventScroll: true });
  }
  async function createHighlight(picked) {
    const info = await rendition.contextFor(picked).catch(() => picked);
    const h = { id: newId(), section: info.section, quote: info.quote.slice(0, 1000), prefix: info.prefix, suffix: info.suffix, note: "" };
    pending = null;
    changeHighlight({ type: "highlight", highlight: h });
    document.getSelection()?.removeAllRanges();
    bar.hidden = true; picked = null;
    return h;
  }
  function clearPending() {
    if (!pending) return;
    pending = null; picked = null; bar.hidden = true;
    rendition?.refreshHighlights();
  }
  document.addEventListener("selectionchange", () => {
    clearTimeout(barTimer);
    barTimer = setTimeout(() => {
      if (!rendition || menu.open || !editor.hidden) return;
      const found = rendition.selection();
      if (coarse()) {
        if (!found) return;
        // Keep the selection as our own mark: no native overlay, handles or menu.
        pending = { ...found, id: "pending", pending: true }; picked = found;
        document.getSelection()?.removeAllRanges();
        rendition.refreshHighlights();
        place(bar, found.rect, true);
        return;
      }
      picked = found;
      if (picked) place(bar, picked.rect, false); else bar.hidden = true;
    }, coarse() ? 500 : 250);
  });
  document.addEventListener("pointerdown", event => {
    if (pending && !bar.contains(event.target)) { dismissedAt = performance.now(); dismissedStamp = event.timeStamp; clearPending(); }
  }, true);
  // Pressing the bar must not drop the selection (mouse or finger).
  bar.addEventListener("mousedown", event => event.preventDefault());
  bar.addEventListener("touchstart", event => event.preventDefault(), { passive: false });
  bar.addEventListener("click", async event => {
    const act = event.target.closest("button")?.dataset.act;
    if (!act || !picked) return;
    // Notes could not be loaded (cloud sign-in missing): the menu says why.
    if (!bookmarksReady) { bar.hidden = true; toggleMenu(); return; }
    const rect = picked.rect, h = await createHighlight(picked);
    if (act === "note") openEditor(h, rect);
  });
  viewer.addEventListener("click", event => {
    const mark = event.composedPath().find(node => node.matches?.("span.epub-hl"));
    const h = mark && highlights.find(x => x.id === mark.dataset.id);
    if (h && !document.getSelection()?.toString()) openEditor(h, mark.getClientRects()[0] || mark.getBoundingClientRect(), !coarse());
  });
  editor.addEventListener("submit", event => {
    event.preventDefault();
    if (editing) changeHighlight({ type: "highlight", highlight: { ...editing, note: noteText.value.trim() } });
    closeEditor();
  });
  $("epub-note-clear").addEventListener("click", () => {
    if (editing) changeHighlight({ type: "highlight", highlight: { ...editing, note: "" } });
    closeEditor();
  });
  $("epub-note-delete").addEventListener("click", () => {
    if (editing) changeHighlight({ type: "unhighlight", id: editing.id });
    closeEditor();
  });
  document.addEventListener("pointerdown", event => { if (!editor.hidden && !editor.contains(event.target)) closeEditor(); }, true);
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeEditor(); }, true);

  // Without a cloud library the notes live in this browser, which can be
  // cleared: a file copy keeps them safe.
  if (!cloud) {
    $("epub-backup").hidden = false;
    $("epub-export").addEventListener("click", () => {
      const file = new Blob([JSON.stringify({ bookmarks, highlights }, null, 2)], { type: "application/json" });
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
        renderBookmarks(); rendition?.refreshHighlights();
      } catch { /* Not a notes file. */ }
    });
  }
  loadBookmarks();

  try {
    // In ranges where the server honours them: a serverless response is capped.
    const CHUNK = 3 * 1024 * 1024;
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
    book = ePub();
    await book.open(bytes, "binary");
    rendition = window.createEpubView(book, viewer, row);
    rendition.setHighlights(highlightsOf);
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
      current = location;
      // Persist synchronously: a refresh immediately after a turn keeps this CFI.
      try { localStorage.setItem(stateKey, JSON.stringify({ cfi: location.start.cfi, href: location.start.href, updated: Date.now() })); }
      catch { /* Position cannot be saved without browser storage. */ }
      const href = location.start.href.split("#")[0];
      const here = chapterAt(location.start.index);
      for (const item of toc.children) item.classList.toggle("is-current", item === here?.li);
      updateProgress(); renderBookmarks();
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
    const metadata = await book.loaded.metadata;
    if (metadata.title) { $("epub-title").textContent = metadata.title; document.title = metadata.title; }
    try { await rendition.display(saved?.cfi || undefined); }
    catch (error) {
      if (!saved?.cfi) throw error;
      // A replaced/edited EPUB may no longer contain the old position.
      try { await rendition.display(saved.href); } catch { await rendition.display(); }
    }
    status.hidden = true;
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
