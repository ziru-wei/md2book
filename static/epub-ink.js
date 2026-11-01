/* EPUB handwriting: an Apple Pencil (or any pen) always writes; on a computer
   P turns the mouse into a pen. Only in the single-column tablet layout, whose
   pages are the same on a computer and an iPad. Strokes are drawn by
   perfect-freehand.

   Nothing drawn may be lost. A stroke is copied to localStorage the moment
   the pen lifts (synchronously, before anything else can happen), then put in
   an IndexedDB outbox, and only leaves the outbox once the server has said it
   was saved. The outbox is sent a few seconds after writing pauses (at most
   15 s after the first unsent stroke), on a page turn, when the page is
   hidden (iPad Safari may freeze it any moment after: keepalive), when the
   network comes back, and whenever the book is opened again. Every operation
   is safe to send twice. Pure helpers have no DOM dependency (see
   test/epub-ink.test.js). */
(function (root) {
  const opKey = op => op.type + ":" + (op.stroke ? op.stroke.id : op.id);

  // Points ([x, y, pressure], page pixels from the stroke's origin) as
  // integers: quarter pixels and hundredths, each point after the first as a
  // difference from the one before.
  function encodePoints(points) {
    const out = [];
    let px = 0, py = 0, pp = 0;
    for (const [x, y, p] of points) {
      const qx = Math.round(x * 4), qy = Math.round(y * 4), qp = Math.round(Math.max(0, Math.min(1, p ?? .5)) * 100);
      out.push(qx - px, qy - py, qp - pp);
      px = qx; py = qy; pp = qp;
    }
    return out;
  }
  function decodePoints(pts) {
    const out = [];
    let x = 0, y = 0, p = 0;
    for (let i = 0; i + 2 < pts.length; i += 3) {
      x += pts[i]; y += pts[i + 1]; p += pts[i + 2];
      out.push([x / 4, y / 4, p / 100]);
    }
    return out;
  }

  // What a pen sends, made fit to draw. An iPad's Pencil sends many points a
  // few hundredths of a pixel apart, and now and then a pressure of 0 among
  // real ones: drawn as they come, the outline turns back on itself in tiny
  // spikes and its width jumps. Points closer than `gap` to the last one kept
  // are dropped (the final point always stays), a missing pressure takes the
  // one before it, and pressure is eased so the line swells and thins smoothly.
  function cleanPoints(points, gap = .6) {
    const out = [];
    let p = null;
    points.forEach(([x, y, raw], i) => {
      const given = raw > 0 && raw <= 1 ? raw : null;
      p = p === null ? (given ?? .5) : p + ((given ?? p) - p) * .35;
      const last = out[out.length - 1];
      if (last && Math.hypot(x - last[0], y - last[1]) < gap) {
        if (i === points.length - 1 && out.length > 1) out[out.length - 1] = [x, y, p];
        return;
      }
      out.push([x, y, p]);
    });
    // Its coordinates come in whole screen pixels, so a gently sloping line is
    // a staircase: each point is averaged with its neighbours (two each side),
    // the ends kept where they are.
    return out.map(([x, y, p], i) => {
      if (i === 0 || i === out.length - 1) return [x, y, p];
      let sx = 0, sy = 0, n = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(out.length - 1, i + 2); j++) { sx += out[j][0]; sy += out[j][1]; n++; }
      return [sx / n, sy / n, p];
    });
  }

  // The samples of a pointermove not seen yet. iPad Safari can hand the same
  // coalesced samples to two pointermoves: taken twice, the line would run back
  // over each stretch and fold into spikes.
  const freshSamples = (samples, after) => samples.filter(s => s.timeStamp > after);

  // A Pencil writing lightly presses 0.03 to 0.2: spread over the width's range.
  const penPressure = raw => raw > 0 ? Math.min(1, .35 + .65 * Math.sqrt(Math.min(1, raw / .35))) : 0;

  // The same rules as the server (lib/epub-ink.js): strokes are only added
  // or erased, and an erased id stays erased.
  function applyOps(state, ops) {
    for (const op of ops) {
      if (op.type === "erase") { state.strokes.delete(op.id); state.erased.add(op.id); }
      else if (op.type === "stroke" && !state.erased.has(op.stroke.id) && !state.strokes.has(op.stroke.id)) state.strokes.set(op.stroke.id, op.stroke);
    }
    return state;
  }
  const stateOf = data => ({
    strokes: new Map((Array.isArray(data?.strokes) ? data.strokes : []).filter(s => s && s.id).map(s => [s.id, s])),
    erased: new Set(Array.isArray(data?.erased) ? data.erased : [])
  });

  // The first entries of the outbox that fit in `limit` bytes of JSON (at
  // least one, whatever its size, so nothing is stuck behind it).
  function takeBatch(entries, limit, max = 500) {
    const batch = [];
    let size = 12;
    for (const entry of entries) {
      const n = JSON.stringify(entry.op).length + 1;
      if (batch.length && (size + n > limit || batch.length >= max)) break;
      batch.push(entry); size += n;
    }
    return batch;
  }

  // An outline (perfect-freehand's) as an SVG path.
  function pathOf(outline) {
    if (outline.length < 2) return "";
    const r = n => Math.round(n * 100) / 100;
    let d = `M${r(outline[0][0])} ${r(outline[0][1])}Q`;
    for (let i = 0; i < outline.length; i++) {
      const [x0, y0] = outline[i], [x1, y1] = outline[(i + 1) % outline.length];
      d += `${r(x0)} ${r(y0)} ${r((x0 + x1) / 2)} ${r((y0 + y1) / 2)} `;
    }
    return d + "Z";
  }

  const api = { opKey, encodePoints, decodePoints, cleanPoints, freshSamples, penPressure, applyOps, stateOf, takeBatch, pathOf };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
  root.epubInk = api;

  const SVG = "http://www.w3.org/2000/svg";
  // Black, blue and red ink; the last one chosen is kept in this browser.
  const INKS = { black: "#222222", blue: "#1f4fbf", red: "#c62f2f" }, SIZE = 1.4;
  // Only the start of a book's outbox needs to fit a keepalive request (64 KB in all).
  const KEEPALIVE = 56000;

  // `view()`: the reader's rendition (made later than this). `key`: this
  // browser's name for the book (localStorage and IndexedDB).
  root.createEpubInk = function createEpubInk({ viewer, key, url, cloud, lib, view, bar, onActive }) {
    let getStroke = null;
    import(new URL(lib, document.baseURI).href).then(m => { getStroke = m.getStroke; repaintAll(); }).catch(() => {});
    // A mouse has no pressure (always .5): an even line.
    const outline = (points, size, last) => getStroke
      ? getStroke(cleanPoints(points), { size: size * 2.2, thinning: .4, smoothing: .6, streamline: .45, simulatePressure: false, last })
      : points.flatMap(([x, y]) => [[x - size / 2, y - size / 2], [x + size / 2, y + size / 2]]);

    // --- Where the strokes are kept --------------------------------------
    // `base`: what the server has (as last read, plus what it has accepted
    // since); `pending`: the outbox, [{ op, seq }]; `held`: what the server
    // refused as invalid, kept and shown on this device only.
    let base = stateOf(null), held = [], pending = [], bySection = new Map();
    const walKey = key + ":ink-wal";
    const walRead = () => { try { return JSON.parse(localStorage.getItem(walKey)) || []; } catch { return []; } };
    const walWrite = ops => { try { ops.length ? localStorage.setItem(walKey, JSON.stringify(ops)) : localStorage.removeItem(walKey); return true; } catch { return false; } };
    let dbPromise = null;
    function db() {
      dbPromise ??= new Promise(resolve => {
        if (!window.indexedDB) return resolve(null);
        let opening;
        try { opening = indexedDB.open("md2book-epub-ink", 1); } catch { return resolve(null); }
        opening.onupgradeneeded = () => {
          const d = opening.result;
          d.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }).createIndex("book", "book");
          d.createObjectStore("state");
        };
        opening.onerror = opening.onblocked = () => resolve(null);
        opening.onsuccess = () => {
          const d = opening.result;
          d.onversionchange = () => { d.close(); dbPromise = null; };
          resolve(d);
        };
      });
      return dbPromise;
    }
    // One transaction; resolves with run's result once it is committed, or
    // null (no IndexedDB, or it failed).
    async function tx(stores, mode, run) {
      const d = await db();
      if (!d) return null;
      return new Promise(resolve => {
        let t, result;
        try { t = d.transaction(stores, mode); } catch { return resolve(null); }
        try { result = run(t); } catch { try { t.abort(); } catch { /* already over */ } return resolve(null); }
        t.oncomplete = () => resolve(result ?? true);
        t.onerror = t.onabort = () => resolve(null);
      });
    }
    const saveState = () => tx(["state"], "readwrite", t => { t.objectStore("state").put({ strokes: [...base.strokes.values()], erased: [...base.erased], held }, key); });
    function rebuild() {
      const state = stateOf(null);
      state.strokes = new Map(base.strokes); state.erased = new Set(base.erased);
      applyOps(state, held);
      applyOps(state, pending.map(e => e.op));
      bySection = new Map();
      for (const s of state.strokes.values()) {
        if (!bySection.has(s.section)) bySection.set(s.section, []);
        bySection.get(s.section).push(s);
      }
      repaintAll();
      showStatus();
    }

    // Ops drawn here: kept first, shown at once, sent later.
    function commit(ops) {
      if (!ops.length) return;
      walWrite([...walRead(), ...ops]);
      const entries = ops.map(op => ({ op, seq: null }));
      pending.push(...entries);
      rebuild();
      if (!cloud) {
        // This browser is the only store: straight into its state.
        applyOps(base, ops);
        saveState().then(ok => { if (ok) { forget(entries); } });
        return;
      }
      tx(["outbox"], "readwrite", t => {
        const store = t.objectStore("outbox");
        entries.forEach(entry => { store.add({ book: key, op: entry.op }).onsuccess = event => { entry.seq = event.target.result; }; });
      }).then(ok => { if (ok) walDrop(ops); });
      scheduleFlush();
    }
    const walDrop = ops => { const gone = new Set(ops.map(opKey)); walWrite(walRead().filter(op => !gone.has(opKey(op)))); };
    function forget(entries) {
      const gone = new Set(entries);
      pending = pending.filter(e => !gone.has(e));
      walDrop(entries.map(e => e.op));
      showStatus();
    }
    async function load() {
      const [state, stored] = await Promise.all([
        tx(["state"], "readonly", t => t.objectStore("state").get(key)),
        tx(["outbox"], "readonly", t => t.objectStore("outbox").index("book").getAll(key))
      ]);
      const saved = state?.result;
      if (saved) {
        const s = stateOf(saved);
        for (const [id, stroke] of s.strokes) if (!base.strokes.has(id)) base.strokes.set(id, stroke);
        for (const id of s.erased) base.erased.add(id);
        held = Array.isArray(saved.held) ? saved.held : [];
      }
      // Strokes drawn before this finished loading come after the older ones.
      const known = new Set(pending.map(e => opKey(e.op)));
      const older = (stored?.result || []).filter(r => !known.has(opKey(r.op))).map(r => ({ op: r.op, seq: r.seq }));
      older.forEach(e => known.add(opKey(e.op)));
      // Strokes that never reached IndexedDB (the page was closed first, or
      // there is none): from the localStorage copy into the outbox.
      const lost = walRead().filter(op => !known.has(opKey(op)));
      pending = [...older, ...pending];
      if (lost.length) {
        const entries = lost.map(op => ({ op, seq: null }));
        pending.push(...entries);
        if (!cloud) { applyOps(base, lost); if (await saveState()) forget(entries); }
        else if (await tx(["outbox"], "readwrite", t => {
          const store = t.objectStore("outbox");
          entries.forEach(entry => { store.add({ book: key, op: entry.op }).onsuccess = event => { entry.seq = event.target.result; }; });
        })) walDrop(lost);
      }
      rebuild();
    }

    // --- Sending and fetching ---------------------------------------------
    let flushing = null, flushTimer = 0, retryTimer = 0, backoff = 0, firstUnsent = 0, problem = "", ackLog = [];
    function scheduleFlush(delay = 3000) {
      if (!cloud) return;
      clearTimeout(flushTimer);
      firstUnsent ||= Date.now();
      flushTimer = setTimeout(flush, Math.max(0, Math.min(delay, firstUnsent + 15000 - Date.now())));
    }
    async function accepted(batch) {
      const ops = batch.map(e => e.op);
      applyOps(base, ops);
      ackLog.push({ at: performance.now(), ops });
      const seqs = batch.map(e => e.seq).filter(seq => seq !== null);
      forget(batch);
      await tx(["outbox"], "readwrite", t => { const store = t.objectStore("outbox"); seqs.forEach(seq => store.delete(seq)); });
      saveState();
    }
    const post = (ops, keepalive = false) => fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ops }), keepalive, credentials: "same-origin"
    });
    const reason = async response => { try { return (await response.json()).error || ""; } catch { return ""; } };
    function flush() {
      clearTimeout(flushTimer);
      if (!cloud) return Promise.resolve();
      if (flushing) return flushing;
      flushing = (async () => {
        while (pending.length) {
          const batch = takeBatch(pending, 200000);
          let response;
          try { response = await post(batch.map(e => e.op)); }
          catch { return retry("Offline: handwriting is kept on this device and sent when the connection is back."); }
          if (response.status === 400) {
            // Not a passing failure: kept and shown here, never sent again.
            held.push(...batch.map(e => e.op));
            await saveState();
            const seqs = batch.map(e => e.seq).filter(seq => seq !== null);
            forget(batch);
            await tx(["outbox"], "readwrite", t => { const store = t.objectStore("outbox"); seqs.forEach(seq => store.delete(seq)); });
            continue;
          }
          if (!response.ok) return retry((await reason(response)) || `Handwriting not sent yet (${response.status}); kept on this device.`);
          await accepted(batch);
        }
        firstUnsent = 0; backoff = 0; problem = ""; showStatus();
      })().finally(() => { flushing = null; });
      return flushing;
    }
    function retry(message) {
      problem = message; showStatus();
      backoff = Math.min(120000, backoff ? backoff * 2 : 4000);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(flush, backoff);
    }
    // The page is being hidden or closed: what fits goes now, without waiting
    // for an answer. Whatever the answer, the outbox keeps it until a later,
    // answered request (sending it twice changes nothing).
    let lastBeacon = 0;
    function beacon() {
      if (!cloud || !pending.length || performance.now() - lastBeacon < 1000) return;
      lastBeacon = performance.now();
      const batch = takeBatch(pending, KEEPALIVE);
      if (JSON.stringify(batch.map(e => e.op)).length > KEEPALIVE) { flush(); return; }
      try { post(batch.map(e => e.op), true).then(r => r.ok && accepted(batch)).catch(() => {}); } catch { /* not allowed now */ }
    }
    let pulling = null, lastPull = 0;
    function pull() {
      if (!cloud) return Promise.resolve();
      if (pulling) return pulling;
      const started = performance.now();
      pulling = (async () => {
        try {
          const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
          if (!response.ok) throw new Error((await reason(response)) || `Could not load handwriting (${response.status}).`);
          const next = stateOf(await response.json());
          // What the server accepted after this was read is in it already.
          for (const entry of ackLog) if (entry.at >= started) applyOps(next, entry.ops);
          ackLog = ackLog.filter(entry => entry.at >= started);
          base = next; lastPull = Date.now();
          saveState(); rebuild();
        } catch (error) {
          if (!pending.length) { problem = error.message || "Could not load handwriting."; showStatus(); }
        }
      })().finally(() => { pulling = null; });
      return pulling;
    }

    // --- Pages -------------------------------------------------------------
    const pagesShown = () => viewer.querySelectorAll(".spread .page.epub-face[data-section]");
    let repaintTimer = 0;
    function repaintAll() {
      clearTimeout(repaintTimer);
      // Never in the middle of a fold.
      if (view()?.turn) { repaintTimer = setTimeout(repaintAll, 300); return; }
      for (const page of pagesShown()) paint(page);
    }
    // Page pixels: the page may be scaled to fit the window.
    const frameOf = page => { const r = page.getBoundingClientRect(); return { left: r.left, top: r.top, k: r.width / page.offsetWidth || 1 }; };
    // Ink lives on the single-column tablet pages only: 720 × 1000 on a computer
    // and on an iPad alike, with the same pagination, so a stroke is simply at
    // its place on its page (chapter, sheet) and shows nowhere else.
    const tablet = () => /^\["tablet",/.test(view()?.inkLayout || "");
    const onPage = (stroke, page) => /^\["tablet",/.test(stroke.page.key) && stroke.page.sheet === +page.dataset.sheet;
    function layerOf(page) {
      let layer = page.querySelector(":scope > svg.epub-handwriting");
      if (!layer) {
        layer = document.createElementNS(SVG, "svg");
        layer.setAttribute("class", "epub-handwriting"); layer.setAttribute("aria-hidden", "true");
        page.append(layer);
      }
      return layer;
    }
    function strokePath(d, color) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d); path.setAttribute("fill", color);
      return path;
    }
    function paint(page) {
      if (!page.isConnected || page.dataset.section === undefined) return;
      const list = tablet() ? (bySection.get(+page.dataset.section) || []).filter(stroke => onPage(stroke, page)) : [];
      if (!list.length && !page.querySelector(":scope > svg.epub-handwriting")) { page._ink = []; return; }
      const placed = list.map(stroke => {
        const points = decodePoints(stroke.pts).map(([x, y, p]) => [stroke.page.x + x, stroke.page.y + y, p]);
        return { id: stroke.id, stroke, points, path: strokePath(pathOf(outline(points, stroke.size, true)), stroke.color), size: stroke.size };
      });
      const layer = layerOf(page);
      layer.replaceChildren(...placed.map(p => p.path));
      if (drawing?.page === page && drawing.live) layer.append(drawing.live);
      page._ink = placed;
    }

    // --- Writing -------------------------------------------------------------
    let ink = "black";
    try { if (INKS[localStorage.getItem("md2book.epub.ink")]) ink = localStorage.getItem("md2book.epub.ink"); } catch { /* no storage */ }
    let mode = false, tool = "pen", drawing = null, lastPen = -Infinity, undo = [];
    const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
    const pageAt = (x, y) => [...viewer.querySelectorAll(".spread.is-current .page.epub-face[data-section]")].find(page => {
      const r = page.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }) || null;
    const writes = event => event.pointerType === "pen" || (mode && event.pointerType === "mouse" && event.button === 0);
    // A pen's eraser end (or its barrel button held down) erases.
    const erasing = event => tool === "eraser" || event.button === 5 || (event.buttons & 32) === 32;
    const local = (event, frame) => [(event.clientX - frame.left) / frame.k, (event.clientY - frame.top) / frame.k,
      event.pointerType === "pen" ? penPressure(event.pressure) : .5];

    viewer.addEventListener("pointerdown", event => {
      // A palm resting while the pen writes moves nothing.
      if (event.pointerType === "touch" && (drawing || performance.now() - lastPen < 600)) {
        if (drawing?.trace) drawing.trace.palms++;
        event.stopImmediatePropagation(); return;
      }
      if (!writes(event) || drawing) return;
      const page = pageAt(event.clientX, event.clientY);
      if (!page || view()?.turn || !tablet()) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.pointerType === "pen") { lastPen = performance.now(); onActive?.(); }
      const frame = frameOf(page);
      drawing = { id: event.pointerId, page, frame, points: [local(event, frame)], erase: erasing(event), hits: new Set(), live: null, trace: startTrace(event, frame), last: event.timeStamp };
      try { viewer.setPointerCapture(event.pointerId); } catch { /* gone already */ }
      if (drawing.erase) eraseAt(drawing.points[0]);
      else { drawing.live = strokePath("", INKS[ink]); layerOf(page).append(drawing.live); drawLive(); }
    }, true);
    let frameRequest = 0;
    function drawLive() {
      if (frameRequest || !drawing?.live) return;
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0;
        if (drawing?.live) drawing.live.setAttribute("d", pathOf(outline(drawing.points, SIZE, false)));
      });
    }
    viewer.addEventListener("pointermove", event => {
      if (!drawing || event.pointerId !== drawing.id) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.pointerType === "pen") lastPen = performance.now();
      const samples = event.getCoalescedEvents?.() || [];
      const fresh = freshSamples(samples.length ? samples : [event], drawing.last);
      record(drawing.trace, event, samples, fresh.length);
      if (!fresh.length) return;
      drawing.last = fresh[fresh.length - 1].timeStamp;
      for (const sample of fresh) {
        const point = local(sample, drawing.frame);
        if (drawing.erase) eraseAt(point); else drawing.points.push(point);
      }
      drawLive();
    }, true);
    function eraseAt([x, y]) {
      for (const p of drawing.page._ink || []) {
        if (drawing.hits.has(p.id)) continue;
        const reach = 7 + p.size;
        if (p.points.some(([px, py]) => Math.abs(px - x) < reach && Math.abs(py - y) < reach && Math.hypot(px - x, py - y) < reach)) {
          drawing.hits.add(p.id); p.path.style.display = "none";
        }
      }
    }
    // Lifting the pen, or losing it (the page hidden, a system gesture), ends
    // the stroke the same way: it is kept.
    function finish(event) {
      if (!drawing || (event && event.pointerId !== drawing.id)) return;
      event?.preventDefault?.();
      const d = drawing;
      drawing = null;
      try { viewer.releasePointerCapture(d.id); } catch { /* released */ }
      endTrace(d, event);
      if (d.erase) {
        const gone = [...bySection.values()].flat().filter(s => d.hits.has(s.id));
        if (gone.length) { undo.push({ restore: gone }); commit(gone.map(s => ({ type: "erase", id: s.id }))); }
        return;
      }
      d.live?.remove();
      if (!d.points.length) return;
      const stroke = { id: newId(), section: +d.page.dataset.section, color: INKS[ink], size: SIZE,
        page: { key: view()?.inkLayout || "", sheet: +d.page.dataset.sheet, x: 0, y: 0 },
        pts: encodePoints(cleanPoints(d.points).slice(0, 4000)), created: new Date().toISOString() };
      undo.push({ ids: [stroke.id] });
      commit([{ type: "stroke", stroke }]);
    }
    viewer.addEventListener("pointerup", event => { if (drawing && event.pointerId === drawing.id) { event.stopImmediatePropagation(); finish(event); } }, true);
    viewer.addEventListener("pointercancel", event => { if (drawing && event.pointerId === drawing.id) { event.stopImmediatePropagation(); finish(event); } }, true);
    // The touches a pencil also makes, and the clicks after a stroke, are the
    // pen's own: no page turn, no selection, no Scribble (iPadOS turns pencil
    // writing into text unless its touches are taken).
    const pencilTouch = event => [...event.changedTouches].some(t => t.touchType === "stylus");
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      window.addEventListener(type, event => {
        if (!viewer.contains(event.target) && !event.composedPath().includes(viewer)) return;
        if (drawing?.trace) {
          const key = type + (pencilTouch(event) ? " stylus" : " finger") + (event.cancelable ? "" : " (not cancelable)");
          drawing.trace.touches[key] = (drawing.trace.touches[key] || 0) + 1;
        }
        if (pencilTouch(event)) { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); }
        else if (drawing || performance.now() - lastPen < 600) event.stopImmediatePropagation();
      }, { capture: true, passive: false });
    }
    viewer.addEventListener("click", event => {
      if (mode || performance.now() - lastPen < 600) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);

    // --- What the pen sent: the menu's "Ink log", for a stroke that looks wrong --
    // The last few strokes, every event as it came (the coalesced samples
    // inside each pointermove too), in client pixels.
    const traces = [];
    const n2 = v => typeof v === "number" ? Math.round(v * 100) / 100 : "";
    const sampleOf = (e, kind, t0) => [kind, n2(e.timeStamp - t0), n2(e.clientX), n2(e.clientY), n2(e.pressure),
      n2(e.tiltX), n2(e.tiltY), n2(e.altitudeAngle), n2(e.azimuthAngle), e.buttons, n2(e.width), n2(e.height)].join("\t");
    function startTrace(event, frame) {
      const trace = { at: new Date().toISOString(), t0: event.timeStamp, type: event.pointerType, erase: erasing(event), k: frame.k,
        moves: 0, coalesced: 0, empty: 0, repeated: 0, palms: 0, touches: {}, rows: [sampleOf(event, "down", event.timeStamp)] };
      traces.push(trace);
      if (traces.length > 5) traces.shift();
      return trace;
    }
    function record(trace, event, samples, fresh) {
      if (!trace) return;
      trace.moves++; trace.coalesced += samples.length;
      trace.repeated += (samples.length || 1) - fresh;
      if (!samples.length) trace.empty++;
      if (trace.rows.length > 3000) return;
      for (const sample of samples) trace.rows.push(sampleOf(sample, "c", trace.t0));
      trace.rows.push(sampleOf(event, "move", trace.t0));
    }
    function endTrace(d, event) {
      const trace = d.trace;
      if (!trace) return;
      trace.end = event ? event.type : "page hidden";
      if (event) trace.rows.push(sampleOf(event, event.type, trace.t0));
      const clean = cleanPoints(d.points);
      trace.points = d.points.length; trace.clean = clean.length;
      trace.zero = d.points.filter(p => !(p[2] > 0)).length;
      trace.outline = getStroke ? outline(d.points, SIZE, true).length : "perfect-freehand not loaded";
    }
    function log() {
      const vv = window.visualViewport;
      const lines = [
        `md2book ink log · ${new Date().toISOString()}`,
        `browser: ${navigator.userAgent}`,
        `screen: ${innerWidth}×${innerHeight} css px, devicePixelRatio ${devicePixelRatio}, zoom ${vv ? n2(vv.scale) : "?"}, touch points ${navigator.maxTouchPoints}`,
        `layout: ${view()?.inkLayout || "?"} · perfect-freehand ${getStroke ? "loaded" : "NOT loaded"} · getCoalescedEvents ${"getCoalescedEvents" in PointerEvent.prototype ? "yes" : "no"} · getPredictedEvents ${"getPredictedEvents" in PointerEvent.prototype ? "yes" : "no"}`,
        `strokes logged: ${traces.length} (the last 5)`, ""
      ];
      traces.forEach((t, i) => {
        lines.push(`— stroke ${i + 1} · ${t.at} · ${t.type}${t.erase ? " (eraser)" : ""} · page scale ${n2(t.k)} · ended by ${t.end || "(still drawing)"}`,
          `pointermove ${t.moves}, coalesced samples ${t.coalesced}, moves without samples ${t.empty}, samples seen before (skipped) ${t.repeated}, palm touches ignored ${t.palms}`,
          `touch events: ${Object.entries(t.touches).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
          `points ${t.points ?? "?"}, with pressure 0 ${t.zero ?? "?"}, after cleaning ${t.clean ?? "?"}, outline points ${t.outline ?? "?"}`,
          "kind\tms\tx\ty\tpressure\ttiltX\ttiltY\taltitude\tazimuth\tbuttons\twidth\theight", ...t.rows, "");
      });
      if (!traces.length) lines.push("Draw a stroke first, then open this log again.");
      return lines.join("\n");
    }

    function undoLast() {
      const last = undo.pop();
      if (!last) return;
      if (last.ids) commit(last.ids.map(id => ({ type: "erase", id })));
      // An erased stroke stays erased: it comes back as a copy.
      else commit(last.restore.map(s => ({ type: "stroke", stroke: { ...s, id: newId() } })));
    }

    // --- The bar: pen, eraser, undo, and whether everything is saved ------------
    const status = bar.querySelector(".epub-ink-status");
    function showStatus() {
      const waiting = pending.length;
      status.textContent = !cloud ? "" : waiting ? `${waiting} ↑` : problem ? "!" : "✓";
      const title = !cloud ? "Saved in this browser" : waiting ? `${problem || "Sending…"} (${waiting} waiting on this device)` : problem || "Saved";
      status.title = title; status.setAttribute("aria-label", title);
      status.classList.toggle("is-waiting", Boolean(waiting || problem));
    }
    function setTool(next) {
      tool = next;
      for (const button of bar.querySelectorAll("[data-tool]")) button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
    }
    // A colour is picked to write with: the pen again, not the eraser.
    function setInk(next) {
      ink = next;
      try { localStorage.setItem("md2book.epub.ink", ink); } catch { /* no storage */ }
      for (const button of bar.querySelectorAll("[data-ink]")) button.setAttribute("aria-pressed", String(button.dataset.ink === ink));
      setTool("pen");
    }
    setInk(ink);
    bar.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.tool) setTool(button.dataset.tool);
      else if (button.dataset.ink) setInk(button.dataset.ink);
      else if (button.dataset.act === "undo") undoLast();
      else if (button.dataset.act === "close") { setMode(false); bar.hidden = true; }
    });
    bar.addEventListener("pointerdown", event => event.stopPropagation());
    // Its buttons never take the keyboard (P, E and ⌘Z keep working).
    bar.addEventListener("mousedown", event => event.preventDefault());
    function setMode(on) {
      mode = on;
      document.documentElement.classList.toggle("epub-inking", on);
      if (on) bar.hidden = false;
      else if (!matchMedia("(pointer: coarse)").matches) bar.hidden = true;
      if (!on) flush();
    }
    function showBar() { bar.hidden = false; }

    // --- When to send and fetch ----------------------------------------------
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { finish(); beacon(); flush(); return; }
      backoff = 0; flush();
      if (Date.now() - lastPull > 15000) pull();
    });
    window.addEventListener("pagehide", () => { finish(); beacon(); });
    window.addEventListener("pageshow", event => { if (event.persisted) { flush(); pull(); } });
    window.addEventListener("online", () => { backoff = 0; flush(); pull(); });
    setInterval(() => {
      if (document.visibilityState !== "visible" || drawing) return;
      if (pending.length && !flushing) flush();
      if (Date.now() - lastPull > 90000) pull();
    }, 30000);
    showStatus();
    load().then(() => { if (cloud) flush().finally(pull); });

    return {
      paint,
      repaint: repaintAll,
      toggle: () => setMode(!mode),
      get tablet() { return tablet(); },
      get active() { return mode; },
      setTool, undo: undoLast, showBar, log,
      eraserToggle: () => setTool(tool === "eraser" ? "pen" : "eraser"),
      // A page turn is a pause in writing: send what is waiting.
      turned: () => { if (pending.length) scheduleFlush(600); },
      exportData: () => ({ strokes: [...[...bySection.values()].flat()] }),
      importData: data => commit([...stateOf(data).strokes.values()].map(stroke => ({ type: "stroke", stroke })))
    };
  };
})(typeof window !== "undefined" ? window : globalThis);
