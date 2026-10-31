/* md2book offline: the service worker behind the home-screen app (served at
   /sw.js; see static/offline.js for the page side).

   - Pages (the home page, collections, notes, EPUB readers) come from the
     network when it answers within a few seconds, and are kept; offline, the
     copy kept last is shown.
   - The reader's own files, fonts, images and attachments are kept as they
     are fetched; "Download for offline" (a message from the home page) fetches
     all of them at once, with every EPUB file.
   - An EPUB file kept here is read from here, in the ranges the reader asks for.
   - EPUB bookmarks and highlights saved while offline wait in a queue (in
     order) and are sent when the server can be reached again; meanwhile the
     reader sees them applied to the copy of the book's notes kept here.
   PDFs are not kept: they are read online only. */
"use strict";

const CACHE = "md2book-offline-v1";
// Fonts and the math stylesheet come from these hosts.
const FONT_HOSTS = /^(fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|cdn\.jsdelivr\.net)$/;
// Kept the first time and not fetched again (they don't change under the same address).
const KEEP_FIRST = /^\/(static\/fonts|static\/icons|vendor|img|asset|epub-cover)\//;
// What one sync keeps, by path; whatever else of these kinds is left over is removed.
const PRUNED = /^\/(entry|contents|epub|epub-file|api\/epub-bookmarks)\//;
const CHUNK = 3 * 1024 * 1024;   // a Vercel response is capped at about 4.5 MB
const PAGE_WAIT = 4000;          // ms to wait for the network before showing the kept page

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith("md2book-") && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));

const sameOrigin = url => url.origin === self.location.origin;
const keyOf = url => sameOrigin(url) ? url.pathname : url.href;
const match = (cache, key) => cache.match(key, { ignoreVary: true, ignoreSearch: false });
const keepable = res => res && (res.ok || res.type === "opaque");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (!/^https?:$/.test(url.protocol)) return;
  if (sameOrigin(url)) {
    const p = url.pathname;
    if (p.startsWith("/api/epub-bookmarks/")) return event.respondWith(bookmarks(req, url, event));
    if (req.method !== "GET") return;
    // Live reload, the settings, the offline list itself, PDFs: always online.
    if (p === "/events" || p === "/sw.js" || /\/settings$|\/api\/settings$|\/offline\.json$|\/manifest\.webmanifest$/.test(p) || p.startsWith("/pdf")) return;
    if (p.startsWith("/epub-file/")) return event.respondWith(epubFile(req, url));
    if (KEEP_FIRST.test(p)) return event.respondWith(cacheFirst(req, p, event));
    if (p.startsWith("/static/")) return event.respondWith(networkFirst(req, p, event, PAGE_WAIT));
    if (req.mode === "navigate" || req.destination === "document" || req.destination === "iframe") return event.respondWith(page(req, url, event));
    return;   // search and the like: online only
  }
  if (req.method !== "GET") return;
  if (FONT_HOSTS.test(url.hostname)) return event.respondWith(staleWhileRevalidate(req, url.href, event));
  if (req.destination === "image") return event.respondWith(cacheFirst(req, url.href, event));
});

async function cacheFirst(req, key, event) {
  const cache = await caches.open(CACHE);
  const kept = await match(cache, key);
  if (kept) return kept;
  const res = await fetch(req);
  if (keepable(res)) event.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}

async function staleWhileRevalidate(req, key, event) {
  const cache = await caches.open(CACHE);
  const kept = await match(cache, key);
  const fresh = fetch(req).then(res => {
    if (keepable(res)) return cache.put(key, res.clone()).then(() => res, () => res);
    return res;
  });
  if (kept) { event.waitUntil(fresh.catch(() => {})); return kept; }
  return fresh;
}

// The network's answer, kept; the kept copy when the network fails, or is slow
// and there is a copy (the network's answer is still kept when it comes).
async function networkFirst(req, key, event, wait, fallback) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then(async res => {
    if (res.ok && res.type === "basic") await cache.put(key, res.clone()).catch(() => {});
    return res;
  });
  event.waitUntil(network.catch(() => {}));
  const kept = await match(cache, key);
  if (!kept) return network.catch(() => fallback ? fallback() : Response.error());
  return Promise.race([network.catch(() => kept), sleep(wait).then(() => kept)]);
}

function page(req, url, event) {
  return networkFirst(req, url.pathname, event, PAGE_WAIT, () => notKeptPage());
}

function notKeptPage() {
  const html = `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Offline</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eceff1;color:#232527;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}a{color:inherit}</style></head>
<body><div><p><b>Offline</b> · 离线</p><p>This page hasn't been downloaded to this device yet.<br />这一页还没有下载到这台设备。</p>
<p><a href="javascript:history.back()">Back · 返回</a></p></div></body></html>`;
  return new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// An EPUB kept here, in the ranges the reader asks for (static/epub-reader.js).
async function epubFile(req, url) {
  const cache = await caches.open(CACHE);
  const kept = await match(cache, url.pathname);
  if (!kept) return fetch(req);
  const blob = await kept.blob();
  const type = "application/epub+zip";
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") || "");
  if (!range) return new Response(blob, { headers: { "Content-Type": type, "Content-Length": String(blob.size) } });
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : blob.size - 1, blob.size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } });
  return new Response(blob.slice(start, end + 1), { status: 206, headers: {
    "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${blob.size}`
  } });
}

// --- A little IndexedDB: the queue of EPUB notes changes, and the sync status --

function db() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("md2book-offline", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("queue", { keyPath: "seq", autoIncrement: true });
      open.result.createObjectStore("meta");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function store(name, mode, run) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(name, mode);
    const request = run(tx.objectStore(name));
    tx.oncomplete = () => { conn.close(); resolve(request?.result); };
    tx.onerror = tx.onabort = () => { conn.close(); reject(tx.error); };
  });
}
const queued = () => store("queue", "readonly", s => s.getAll());
const enqueue = item => store("queue", "readwrite", s => s.add(item));
const dequeue = seq => store("queue", "readwrite", s => s.delete(seq));
const readMeta = key => store("meta", "readonly", s => s.get(key)).catch(() => undefined);
const writeMeta = (key, value) => store("meta", "readwrite", s => s.put(value, key)).catch(() => {});

// --- EPUB bookmarks and highlights -------------------------------------------

// The same rules as the server's (lib/epub-bookmarks.js), for the copy here.
function applyOperation(state, op) {
  const bookmarks = Array.isArray(state.bookmarks) ? state.bookmarks : [];
  const highlights = Array.isArray(state.highlights) ? state.highlights : [];
  const now = new Date().toISOString();
  if (op?.type === "highlight" && op.highlight?.id) {
    const existing = highlights.find(h => h.id === op.highlight.id);
    const next = { ...op.highlight, created: existing?.created || now };
    return { bookmarks, highlights: existing ? highlights.map(h => h.id === next.id ? next : h) : [...highlights, next] };
  }
  if (op?.type === "unhighlight") return { bookmarks, highlights: highlights.filter(h => h.id !== op.id) };
  if (op?.type === "add" || op?.type === "remove") {
    const rest = bookmarks.filter(b => b.cfi !== op.cfi);
    if (op.type === "remove") return { bookmarks: rest, highlights };
    const existing = bookmarks.find(b => b.cfi === op.cfi);
    return { bookmarks: [...rest, { cfi: op.cfi, label: op.label, created: existing?.created || now }], highlights };
  }
  return { bookmarks, highlights };
}

async function keepNotes(key, data) {
  const cache = await caches.open(CACHE);
  await cache.put(key, new Response(JSON.stringify({ bookmarks: data.bookmarks || [], highlights: data.highlights || [] }), { headers: { "Content-Type": "application/json" } }));
}

// The book's notes as kept here, with the changes not yet sent applied; the
// reader shows how many are waiting (X-Md2book-Pending).
async function notesHere(key) {
  const cache = await caches.open(CACHE);
  const kept = await match(cache, key);
  let state = kept ? await kept.json().catch(() => ({})) : { bookmarks: [], highlights: [] };
  const waiting = (await queued().catch(() => [])).filter(item => item.url === key);
  for (const item of waiting) state = applyOperation(state, item.op);
  return new Response(JSON.stringify({ bookmarks: state.bookmarks || [], highlights: state.highlights || [] }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Md2book-Pending": String(waiting.length), "X-Md2book-Offline": "1" }
  });
}

async function bookmarks(req, url, event) {
  const key = url.pathname;
  if (req.method === "GET") {
    await flush();
    try {
      const res = await fetch(req);
      if (res.ok) {
        await res.clone().json().then(data => keepNotes(key, data)).catch(() => {});
        if (!(await queued().catch(() => [])).some(item => item.url === key)) return res;
      }
      // Not signed in (yet) here, or changes still waiting: what is kept here.
      const cache = await caches.open(CACHE);
      if (res.ok || await match(cache, key)) return notesHere(key);
      return res;
    } catch {
      return notesHere(key);
    }
  }
  if (req.method === "POST") {
    const op = await req.clone().json().catch(() => null);
    await flush();
    // Nothing waiting before it: straight to the server.
    if (!(await queued().catch(() => [])).length) {
      try {
        const res = await fetch(req);
        if (res.ok) event.waitUntil(res.clone().json().then(data => keepNotes(key, data)).catch(() => {}));
        return res;
      } catch { /* offline: queued below */ }
    }
    await enqueue({ url: key, op, at: Date.now() });
    return notesHere(key);
  }
  return fetch(req);
}

// Sends the waiting changes, oldest first; stops at the first that can't go
// (offline, or not signed in) and keeps it for next time.
let flushing = null;
function flush() {
  flushing ||= (async () => {
    try {
      let sent = 0;
      for (const item of await queued()) {
        let res;
        try {
          res = await fetch(item.url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.op) });
        } catch { break; }
        if (res.ok) { await keepNotes(item.url, await res.json().catch(() => ({}))); await dequeue(item.seq); sent++; }
        else if (res.status === 400 || res.status === 404) await dequeue(item.seq);   // a change the server will never take
        else break;
      }
      const left = (await queued()).length;
      if (sent || left) broadcast({ type: "notes", sent, left });
    } catch { /* tried again next time */ }
    finally { flushing = null; }
  })();
  return flushing;
}

// --- Download for offline ------------------------------------------------------

async function broadcast(message) {
  for (const client of await self.clients.matchAll({ includeUncontrolled: true })) client.postMessage(message);
}

async function pool(items, size, run) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  }));
}

// Same-origin files and font hosts a page or stylesheet refers to.
function refsIn(text, base, out) {
  const add = raw => {
    let url;
    try { url = new URL(raw.replace(/&amp;/g, "&"), base); } catch { return; }
    if (!/^https?:$/.test(url.protocol)) return;
    url.hash = "";
    if (sameOrigin(url) ? /^\/(static|vendor|img|asset|epub-cover)\//.test(url.pathname) : FONT_HOSTS.test(url.hostname) && url.hostname !== "p.typekit.net") out.add(url.href);
  };
  for (const m of text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) add(m[1]);
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) if (!m[1].startsWith("data:")) add(m[1]);
  // Paths inside the pages' own data (the home page's covers, a note's images).
  for (const m of text.matchAll(/["'(](\/(?:img|asset|epub-cover)\/[\w.-]+)/g)) add(m[1]);
  for (const m of text.matchAll(/<img\b[^>]*\bsrc\s*=\s*["'](https?:[^"']+)["']/g)) {
    try { const url = new URL(m[1]); if (!sameOrigin(url)) out.add(url.href); } catch { /* not a URL */ }
  }
}

// The whole EPUB, in ranges, as one kept response that remembers its version.
async function keepEpub(cache, book) {
  const key = `/epub-file/${book.id}`;
  const kept = await match(cache, key);
  if (kept && book.version && kept.headers.get("X-Md2book-Version") === book.version) return false;
  const first = await fetch(key, { headers: { Range: `bytes=0-${CHUNK - 1}` }, cache: "no-store" });
  if (!first.ok) throw new Error(`${book.title}: ${first.status}`);
  const total = first.status === 206 ? Number(/\/(\d+)$/.exec(first.headers.get("content-range") || "")?.[1]) : 0;
  // Without a version to go by: the same size is taken as the same book.
  if (kept && !book.version && total && Number(kept.headers.get("Content-Length")) === total) return false;
  const parts = [await first.arrayBuffer()];
  let have = parts[0].byteLength;
  while (total && have < total) {
    const part = await fetch(key, { headers: { Range: `bytes=${have}-${Math.min(have + CHUNK, total) - 1}` }, cache: "no-store" });
    if (part.status !== 206) throw new Error(`${book.title}: ${part.status}`);
    const bytes = await part.arrayBuffer();
    if (!bytes.byteLength) throw new Error(`${book.title}: empty range`);
    parts.push(bytes);
    have += bytes.byteLength;
  }
  const blob = new Blob(parts, { type: "application/epub+zip" });
  await cache.put(key, new Response(blob, { headers: {
    "Content-Type": "application/epub+zip", "Content-Length": String(blob.size), "X-Md2book-Version": book.version || ""
  } }));
  return true;
}

let downloading = null;
function download(listUrl) {
  downloading ||= runDownload(listUrl).finally(() => { downloading = null; });
  return downloading;
}

async function runDownload(listUrl) {
  const failed = [];
  const progress = (phase, done, total) => broadcast({ type: "progress", phase, done, total });
  try {
    progress("list", 0, 1);
    await flush();
    const res = await fetch(listUrl, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw new Error(`${res.status}`);
    const list = await res.json();
    const cache = await caches.open(CACHE);
    const wanted = new Set();
    const refs = new Set(list.files.map(p => new URL(p, self.location.origin).href));

    // 1. Pages, fetched afresh: what they refer to is gathered as they come.
    let done = 0;
    await pool(list.pages, 4, async p => {
      const url = new URL(p, self.location.origin);
      wanted.add(url.pathname);
      try {
        const page = await fetch(url, { cache: "no-store", credentials: "same-origin" });
        if (!page.ok) throw new Error(String(page.status));
        refsIn(await page.clone().text(), url, refs);
        await cache.put(url.pathname, page);
      } catch (error) { failed.push(`${url.pathname} (${error.message})`); }
      progress("pages", ++done, list.pages.length);
    });

    // 2. Files: the reader's own (fetched afresh) and the rest once; the
    // stylesheets among them bring their fonts.
    const seen = new Set();
    const fetchFile = async href => {
      if (seen.has(href)) return;
      seen.add(href);
      const url = new URL(href);
      const key = keyOf(url);
      if (sameOrigin(url)) wanted.add(url.pathname);
      const once = sameOrigin(url) ? KEEP_FIRST.test(url.pathname) : true;
      if (once && await match(cache, key)) return;
      let file;
      try { file = await fetch(url, sameOrigin(url) ? { cache: "no-store" } : { mode: "cors", credentials: "omit" }); }
      catch { try { file = await fetch(url, { mode: "no-cors" }); } catch { file = null; } }
      if (!keepable(file)) { if (sameOrigin(url)) failed.push(url.pathname); return; }
      if (file.type !== "opaque" && /css/.test(file.headers.get("content-type") || "")) {
        const more = new Set();
        refsIn(await file.clone().text(), url, more);
        for (const ref of more) if (!seen.has(ref)) queue.push(ref);
      }
      await cache.put(key, file).catch(() => failed.push(key));
    };
    const queue = [...refs];
    done = 0;
    while (queue.length) {
      const batch = queue.splice(0);
      await pool(batch, 6, async href => { await fetchFile(href); progress("files", ++done, done + queue.length); });
    }

    // 3. EPUBs, one at a time (they are large), and each one's notes.
    done = 0;
    for (const book of list.epubs) {
      wanted.add(`/epub-file/${book.id}`);
      wanted.add(`/api/epub-bookmarks/${book.id}`);
      progress("books", done, list.epubs.length);
      try { await keepEpub(cache, book); }
      catch (error) { failed.push(error.message); }
      if (list.cloud) {
        try {
          const notes = await fetch(`/api/epub-bookmarks/${book.id}`, { cache: "no-store", credentials: "same-origin" });
          if (notes.ok) await keepNotes(`/api/epub-bookmarks/${book.id}`, await notes.json());
        } catch { /* kept as it was */ }
      }
      progress("books", ++done, list.epubs.length);
    }

    // 4. Whatever is no longer published (a note, a book) goes.
    const waiting = new Set((await queued().catch(() => [])).map(item => item.url));
    for (const req of await cache.keys()) {
      const p = new URL(req.url).pathname;
      if (sameOrigin(new URL(req.url)) && PRUNED.test(p) && !wanted.has(p) && !waiting.has(p)) await cache.delete(req);
    }

    const status = { at: Date.now(), pages: list.pages.length, books: list.epubs.length, failed };
    await writeMeta("status", status);
    broadcast({ type: "done", status });
  } catch (error) {
    broadcast({ type: "error", message: String(error.message || error) });
  }
}

async function forget() {
  await caches.delete(CACHE);
  await writeMeta("status", null);
}

self.addEventListener("message", event => {
  const data = event.data || {};
  const reply = message => event.source?.postMessage(message);
  if (data.type === "download") event.waitUntil(download(data.list));
  else if (data.type === "flush") event.waitUntil(flush());
  else if (data.type === "forget") event.waitUntil(forget().then(() => reply({ type: "forgotten" })));
  else if (data.type === "status") {
    event.waitUntil((async () => reply({
      type: "status", status: await readMeta("status") || null, busy: Boolean(downloading),
      waiting: (await queued().catch(() => [])).length
    }))());
  }
});
