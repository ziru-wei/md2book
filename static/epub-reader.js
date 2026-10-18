/* EPUB only: position is local; personal cloud bookmarks use the server API. */
(async () => {
  const options = JSON.parse(document.getElementById("epub-config").textContent);
  const { url, row, id, library, cloud } = options;
  const $ = id => document.getElementById(id);
  const viewer = $("epub-viewer"), status = $("epub-status"), toc = $("epub-toc");
  const menu = $("epub-menu"), progress = $("epub-progress"), percent = $("epub-percent");
  const addBookmark = $("epub-bookmark-add");
  const stateKey = `md2book.epub:${library}:${id}`;
  const bookmarkKey = stateKey + ":bookmarks";
  const bookmarkUrl = `/api/epub-bookmarks/${id}`;
  let book, rendition, current, disposed = false, locationsReady = false;
  let bookmarks = [], bookmarksReady = false, bookmarkBusy = false, lastSync = 0;
  let navigationQueue = Promise.resolve(), queued = 0, lastTouch = -Infinity;
  const readLocal = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch { return fallback; }
  };
  const saved = readLocal(stateKey, null);
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

  function tapAt(x, y, touch = false) {
    const bounds = viewer.getBoundingClientRect();
    const fraction = (x - bounds.left) / bounds.width;
    // The menu opens from the upper half of the gutter only.
    if (Math.abs(fraction - .5) <= .08 && y - bounds.top <= bounds.height / 2) { toggleMenu(); return; }
    if (!touch) return;
    turn((fraction > .5) !== (book.package.metadata.direction === "rtl"));
  }
  const wheel = window.createReaderWheel({
    get turn() { return rendition?.turn; },
    dragTurn: delta => rendition?.dragTurn(delta),
    releaseTurn: () => rendition?.releaseTurn(),
    settleTurn: target => rendition?.settleTurn(target)
  }, {
    blocked: () => !rendition || menu.open || (window.visualViewport?.scale || 1) > 1.05,
    direction: () => book?.package.metadata.direction === "rtl" ? -1 : 1
  });
  function bindInput(documentOrElement) {
    documentOrElement.addEventListener("wheel", wheel, { passive: false });
    let start = null;
    const doc = documentOrElement.ownerDocument || documentOrElement;
    const hasSelection = () => Boolean(doc.getSelection()?.toString());
    const interactive = target => target.closest?.("a, button, input, select, textarea, audio, video, [contenteditable]");
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
          Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > 10 || (window.visualViewport?.scale || 1) > 1.05) return;
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
    return data.bookmarks;
  }
  async function loadBookmarks() {
    if (bookmarkBusy) return;
    bookmarkBusy = true;
    try {
      bookmarks = cloud ? await cloudRequest() : readLocal(bookmarkKey, []);
      if (!Array.isArray(bookmarks)) bookmarks = [];
      bookmarksReady = true;
      lastSync = Date.now();
    } catch { /* Retried the next time the menu opens. */
    } finally { bookmarkBusy = false; renderBookmarks(); }
  }
  async function changeBookmark(operation) {
    if (!bookmarksReady || bookmarkBusy) return;
    bookmarkBusy = true;
    renderBookmarks();
    try {
      if (cloud) bookmarks = await cloudRequest(operation);
      else {
        const result = readLocal(bookmarkKey, []).filter(b => b.cfi !== operation.cfi);
        if (operation.type === "add") result.push({ cfi: operation.cfi, label: operation.label, created: new Date().toISOString() });
        localStorage.setItem(bookmarkKey, JSON.stringify(result));
        bookmarks = result;
      }
      lastSync = Date.now();
    } catch { /* Not saved; the list still shows what is stored. */
    } finally { bookmarkBusy = false; renderBookmarks(); }
  }
  addBookmark.addEventListener("click", () => {
    if (!current || bookmarks.some(b => b.cfi === current.start.cfi)) return;
    const chapter = chapterAt(current.start.index)?.label || `Chapter ${current.start.index + 1}`;
    changeBookmark({ type: "add", cfi: current.start.cfi, label: `${chapter}${locationsReady ? ` · ${percent.textContent}` : ""}`.slice(0, 300) });
  });
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
