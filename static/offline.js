/* md2book offline, the page side (static/sw.js does the work).

   Every page registers the service worker and, when the network is back,
   asks it to send the EPUB notes changes made offline. The home page adds
   the panel behind its offline button: download every EPUB to this device,
   update it, or remove it. Once downloaded, the home page brings the copy up
   to date by itself when it opens online (at most every 30 minutes).

   On an iPhone or iPad, a site added to the Home Screen keeps its own
   storage, apart from Safari's: download from inside the app. */
(function () {
  "use strict";
  if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;

  const ENABLED = "md2book-offline";
  const REFRESH = 30 * 60 * 1000;
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

  const ready = navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready).catch(() => null);
  const send = message => ready.then(reg => reg?.active?.postMessage(message));
  const flush = () => { if (navigator.onLine !== false) send({ type: "flush" }); };
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) flush(); });
  flush();

  // A new version of the reader deployed since this page's copy was kept: the
  // page carries the version it was served with, the server says which is
  // current. Offered, not forced (the kept copy is what reads offline); a
  // home-screen app has no reload button of its own.
  const ours = document.querySelector('meta[name="md2book-version"]')?.content;
  if (ours && navigator.onLine !== false) {
    fetch("/version", { cache: "no-store" }).then(res => res.ok ? res.json() : null).then(current => {
      if (!current?.version || current.version === ours || document.getElementById("md2book-updated")) return;
      let zh = false;
      try { zh = (localStorage.getItem("md2book-settings-lang") || navigator.language).startsWith("zh"); } catch { /* storage unavailable */ }
      const note = document.createElement("button");
      note.id = "md2book-updated"; note.type = "button";
      note.textContent = zh ? "阅读器已更新，点此刷新" : "A new version is ready: tap to reload";
      note.style.cssText = "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483000;padding:9px 16px;border:0;border-radius:999px;background:#232527;color:#f6f8f9;font:13px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer";
      note.addEventListener("click", async () => {
        note.disabled = true;
        // The kept reader files go first, so the reload fetches the new ones.
        const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
        await reg?.update().catch(() => {});
        const worker = reg?.active;
        if (worker) await new Promise(resolve => {
          const done = event => { if (event.data?.type === "updated-ready") { navigator.serviceWorker.removeEventListener("message", done); resolve(); } };
          navigator.serviceWorker.addEventListener("message", done);
          worker.postMessage({ type: "update" });
          setTimeout(resolve, 4000);
        });
        location.reload();
      });
      document.body.append(note);
    }).catch(() => {});
  }

  const dataEl = document.getElementById("home-data");
  let data = null;
  try { data = dataEl && JSON.parse(dataEl.textContent); } catch { /* not the home page */ }
  const list = data?.offline;
  if (!list) return;

  let lang = "en";
  try { lang = localStorage.getItem("md2book-settings-lang") || (navigator.language.startsWith("zh") ? "zh" : "en"); } catch { /* storage unavailable */ }
  const T = {
    en: {
      title: "Offline reading",
      intro: "Keep every EPUB on this device, with its bookmarks and highlights, to read without a connection. Notes and PDFs are read online only.",
      ios: "On an iPad or iPhone, first add this page to the Home Screen (Share → Add to Home Screen), then download from inside that app: Safari and the app keep separate copies.",
      download: "Download to this device", update: "Update now", remove: "Remove", close: "Close",
      kept: (s, when) => `${s.books} EPUB${s.books === 1 ? "" : "s"} kept on this device, updated ${when}.`,
      failed: n => `${n} item${n === 1 ? "" : "s"} could not be downloaded; they'll be tried again next time.`,
      size: mb => `Space used: about ${mb} MB.`,
      waiting: n => `${n} EPUB note change${n === 1 ? "" : "s"} saved here, to be sent when online.`,
      phase: { list: "Getting the list", pages: "Pages", files: "Fonts and reader files", books: "EPUBs" },
      offlineNow: "You're offline: EPUBs open from this device; notes need a connection.",
      error: m => `Download failed (${m}). Check the connection and try again.`,
      confirmRemove: "Remove the offline copy from this device?",
      auto: "It updates by itself when this page opens online."
    },
    zh: {
      title: "离线阅读",
      intro: "把所有 EPUB 连同书签和批注保存到这台设备，没有网络也能读。笔记和 PDF 只能在线阅读。",
      ios: "在 iPad 或 iPhone 上，请先把本页添加到主屏幕（分享 → 添加到主屏幕），再从主屏幕打开的 app 里下载：Safari 和主屏幕 app 各存各的。",
      download: "下载到这台设备", update: "立即更新", remove: "移除", close: "关闭",
      kept: (s, when) => `已在这台设备保存 ${s.books} 本 EPUB，更新于 ${when}。`,
      failed: n => `有 ${n} 项没能下载，下次更新时会再试。`,
      size: mb => `占用空间约 ${mb} MB。`,
      waiting: n => `有 ${n} 条 EPUB 书签或批注改动存在本机，联网后会自动同步。`,
      phase: { list: "获取清单", pages: "页面", files: "字体和阅读器文件", books: "EPUB" },
      offlineNow: "当前离线：EPUB 从本机打开，笔记需要联网。",
      error: m => `下载失败（${m}）。请检查网络后重试。`,
      confirmRemove: "从这台设备移除离线内容？",
      auto: "之后每次联网打开首页时会自动更新。"
    }
  }[lang === "zh" ? "zh" : "en"];

  const state = { status: null, busy: false, waiting: 0, progress: null, error: null };
  const root = document.documentElement;
  function mark() {
    root.dataset.offlineState = state.busy ? "busy" : state.status ? "kept" : "";
    if (state.waiting) root.dataset.offlineWaiting = ""; else delete root.dataset.offlineWaiting;
  }

  const panel = document.createElement("div");
  panel.className = "h-offline";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", T.title);
  document.body.appendChild(panel);

  const esc = s => String(s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
  const when = at => new Date(at).toLocaleString(lang === "zh" ? "zh-CN" : undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let usage = null;

  function draw() {
    mark();
    if (panel.hidden) return;
    const s = state.status, p = state.progress;
    const parts = [`<h3>${T.title}</h3>`];
    if (navigator.onLine === false) parts.push(`<p class="warn">${T.offlineNow}</p>`);
    if (s) {
      parts.push(`<p>${esc(T.kept(s, when(s.at)))}</p>`);
      if (s.failed?.length) parts.push(`<p class="warn" title="${esc(s.failed.slice(0, 20).join("\n"))}">${esc(T.failed(s.failed.length))}</p>`);
      if (usage) parts.push(`<p class="muted">${esc(T.size(usage))} ${T.auto}</p>`);
    } else {
      parts.push(`<p>${T.intro}</p>`);
      if (apple && !standalone) parts.push(`<p class="muted">${T.ios}</p>`);
    }
    if (state.waiting) parts.push(`<p class="warn">${esc(T.waiting(state.waiting))}</p>`);
    if (state.busy && p) {
      const share = p.total ? Math.min(1, p.done / p.total) : 0;
      parts.push(`<div class="bar"><i style="width:${(share * 100).toFixed(1)}%"></i></div><p class="muted">${esc(T.phase[p.phase] || "")} · ${p.done}/${p.total}</p>`);
    }
    if (state.error) parts.push(`<p class="warn">${esc(T.error(state.error))}</p>`);
    const offline = navigator.onLine === false;
    parts.push(`<div class="acts">
      <button type="button" class="main" data-act="download" ${state.busy || offline ? "disabled" : ""}>${s ? T.update : T.download}</button>
      ${s ? `<button type="button" data-act="remove" ${state.busy ? "disabled" : ""}>${T.remove}</button>` : ""}
      <button type="button" data-act="close">${T.close}</button></div>`);
    panel.innerHTML = parts.join("");
  }

  async function measure() {
    try {
      const estimate = await navigator.storage?.estimate?.();
      usage = estimate?.usage ? Math.max(1, Math.round(estimate.usage / 1048576)) : null;
    } catch { usage = null; }
  }

  function download() {
    state.busy = true; state.error = null; state.progress = { phase: "list", done: 0, total: 1 };
    write(ENABLED, "1");
    // Ask that the browser keep this copy rather than clear it under pressure.
    navigator.storage?.persist?.().catch(() => {});
    send({ type: "download", list });
    draw();
  }

  panel.addEventListener("click", event => {
    const act = event.target.closest("button")?.dataset.act;
    if (act === "download") download();
    else if (act === "close") panel.hidden = true;
    else if (act === "remove" && confirm(T.confirmRemove)) {
      write(ENABLED, null);
      send({ type: "forget" });
      // The books' pages laid out on this device go too (static/epub-view.js).
      try { indexedDB.deleteDatabase("md2book-epub-layout"); } catch { /* none */ }
    }
  });
  document.addEventListener("click", event => {
    // (Its own buttons are redrawn as they are pressed: the path still has the panel.)
    const path = event.composedPath();
    if (!panel.hidden && !path.includes(panel) && !path.some(node => node.dataset?.offline !== undefined)) panel.hidden = true;
  });
  window.addEventListener("online", draw);
  window.addEventListener("offline", draw);

  navigator.serviceWorker.addEventListener("message", event => {
    const m = event.data || {};
    if (m.type === "status") {
      state.status = m.status; state.busy = m.busy; state.waiting = m.waiting;
      // Downloaded before, and online: bring the copy up to date.
      if (read(ENABLED) === "1" && !m.busy && navigator.onLine !== false && (!m.status || Date.now() - m.status.at > REFRESH)) download();
    } else if (m.type === "progress") { state.busy = true; state.progress = m; }
    else if (m.type === "done") { state.busy = false; state.status = m.status; state.progress = null; measure().then(draw); send({ type: "status" }); }
    else if (m.type === "error") { state.busy = false; state.error = m.message; state.progress = null; }
    else if (m.type === "notes") state.waiting = m.left;
    else if (m.type === "forgotten") { state.status = null; usage = null; send({ type: "status" }); }
    draw();
  });

  window.md2bookOffline = {
    open() {
      panel.hidden = !panel.hidden;
      const button = document.querySelector("[data-offline]")?.getBoundingClientRect();
      if (button) { panel.style.top = (button.bottom + 10) + "px"; panel.style.right = Math.max(16, innerWidth - button.right) + "px"; }
      if (!panel.hidden) { measure().then(draw); send({ type: "status" }); }
      draw();
    }
  };
  navigator.serviceWorker.startMessages?.();
  send({ type: "status" });
})();
