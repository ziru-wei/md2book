// The /img/<id> proxy: fetches a remote image once, keeps it on disk, and never
// downloads more than a few at a time. A page can hold dozens of multi-megabyte
// images; fetched all at once they share one slow link, so every one of them
// arrives last. Queued in order, the first ones on the page arrive first.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const IMMUTABLE = "public, max-age=31536000, immutable";

export function createImageProxy({ lookup, token = "", dir, concurrency = 6 }) {
  // Where bodies are kept: next to the user's other caches, or the OS temp dir
  // (the only writable place on Vercel). If neither works, images still stream
  // through, just uncached.
  let cacheDir = null;
  for (const candidate of [dir, path.join(os.homedir(), ".cache", "md2book", "img"), path.join(os.tmpdir(), "md2book-img")]) {
    if (!candidate) continue;
    try { fs.mkdirSync(candidate, { recursive: true }); cacheDir = candidate; break; } catch { /* try the next */ }
  }

  // A fixed number of downloads at once. A visitor's request goes before any
  // warm-up download, and warm-ups never take more than half the slots, so
  // opening an image is never stuck behind images nobody asked for yet.
  let running = 0, warming = 0;
  const waiting = [], idle = [];
  const maxWarming = Math.max(1, Math.floor(concurrency / 2));
  const start = job => { running++; if (job.background) warming++; job.resolve(); };
  const acquire = (id, background) => new Promise(resolve => {
    const job = { id, background };
    job.resolve = () => resolve(job);
    if (running < concurrency && !waiting.length && (!background || warming < maxWarming)) start(job);
    else (background ? idle : waiting).push(job);
  });
  const release = job => {
    running--; if (job.background) warming--;
    if (waiting.length && running < concurrency) start(waiting.shift());
    else if (idle.length && running < concurrency && warming < maxWarming) start(idle.shift());
  };
  // A visitor asks for an image that is only waiting as a warm-up: it moves up.
  function promote(id) {
    const at = idle.findIndex(job => job.id === id);
    if (at < 0) return;
    const [job] = idle.splice(at, 1);
    job.background = false;
    if (running < concurrency) start(job); else waiting.push(job);
  }

  // id -> the download in progress, so concurrent requests for one image share it.
  const downloads = new Map();

  async function download(id, entry, background = false) {
    const job = await acquire(id, background);
    try {
      const upstream = await fetch(entry.url, { headers: token ? { Authorization: `token ${token}` } : {} });
      if (!upstream.ok) { await upstream.body?.cancel?.().catch(() => {}); return { status: upstream.status }; }
      const type = upstream.headers.get("content-type") || "application/octet-stream";
      if (!cacheDir) return { type, stream: Readable.fromWeb(upstream.body) };
      const file = path.join(cacheDir, id), part = `${file}.${process.pid}.part`;
      try {
        await pipeline(Readable.fromWeb(upstream.body), fs.createWriteStream(part));
        fs.writeFileSync(`${file}.type`, type);
        fs.renameSync(part, file);
      } catch (error) {
        fs.rm(part, { force: true }, () => {});
        throw error;
      }
      return { type };
    } finally { release(job); }
  }

  // Fetches an image nobody has asked for yet (one just found on a page), at low
  // priority, so it is already on disk when its page is opened.
  function prefetch(id) {
    const entry = lookup(id);
    if (!entry || !cacheDir || downloads.has(id) || cached(id)) return;
    downloads.set(id, download(id, entry, true).finally(() => downloads.delete(id)));
    downloads.get(id).catch(() => {});
  }

  function cached(id) {
    if (!cacheDir) return null;
    try {
      const file = path.join(cacheDir, id);
      return { file, size: fs.statSync(file).size, type: fs.readFileSync(`${file}.type`, "utf8") };
    } catch { return null; }
  }

  async function handler(req, res) {
    const id = req.params.id, entry = lookup(id);
    if (!entry) { res.status(404).type("text").send("Not found"); return; }
    try {
      let hit = cached(id);
      if (!hit) {
        if (downloads.has(id)) promote(id);
        else downloads.set(id, download(id, entry).finally(() => downloads.delete(id)));
        const result = await downloads.get(id);
        if (result.status) { res.status(result.status).type("text").send("Upstream image fetch failed"); return; }
        if (result.stream) {
          res.set({ "Content-Type": result.type, "Cache-Control": IMMUTABLE });
          result.stream.on("error", () => res.destroy()).pipe(res);
          return;
        }
        hit = cached(id);
        if (!hit) { res.status(502).type("text").send("Could not fetch image"); return; }
      }
      // Immutable: the id is a hash of the real URL, so the same id always means
      // the same bytes.
      res.set({ "Content-Type": hit.type, "Content-Length": String(hit.size), "Cache-Control": IMMUTABLE });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(hit.file).on("error", () => res.destroy()).pipe(res);
    } catch (error) {
      if (!res.headersSent) res.status(502).type("text").send(`Could not fetch image\n\n${error.stack || error}`);
      else res.destroy();
    }
  }

  handler.prefetch = prefetch;
  return handler;
}
