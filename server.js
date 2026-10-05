import express from "express";
import chokidar from "chokidar";
import { createRequire } from "node:module";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { Readable } from "node:stream";
import { createEntrySource } from "./lib/source.js";
import { loadConfig, readSettings, resolveConfig, writeSettings, DEFAULTS } from "./lib/config.js";
import {
  setup, clearCache, forgetNote, HOME_PATH, SEARCH_PATH, imageProxyMap, assetIds, resolveVaultLinks, listEntries,
  renderHomePage, renderContentsPage, renderEntryPage, renderUnavailablePage, searchTextOf, scanVault
} from "./lib/render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT || 3000);
// The notes folder: $MD2BOOK_NOTES (set by bin/md2book.js), the
// command-line argument, or ./notes.
const LOCAL_ENTRIES_DIR = path.resolve(
  process.cwd(),
  process.env.MD2BOOK_NOTES || process.argv[2] || "notes"
);

const entrySource = createEntrySource(LOCAL_ENTRIES_DIR);

// The site's own settings (name, which notes publish, collections,
// layouts...) — see lib/config.js.
// Local notes keep their settings in their own folder; a deployment
// reading GitHub uses the file next to the app.

// Watching notes and reloading pages is for running md2book on your own
// computer; a deployed site (Vercel) serves a fixed copy.
const LIVE = entrySource.liveReload && !process.env.VERCEL;
const config = loadConfig();

// Optional PAT for a private image-hosting repo (may be a different
// GitHub account/repo entirely from GITHUB_TOKEN's content repo — see
// /img/:id below). Unset means unauthenticated fetches, which only
// works for images that are actually public.
const IMAGE_GITHUB_TOKEN = process.env.IMAGE_GITHUB_TOKEN || "";

// Notes become pages in lib/render.js (HOME_PATH and SEARCH_PATH come
// from it, set from config.site.homePath).
setup({
  config,
  source: entrySource,
  hash: text => crypto.createHash("sha256").update(text).digest("hex"),
  live: LIVE,
  imageToken: IMAGE_GITHUB_TOKEN,
  temmlVersion: createRequire(import.meta.url)("temml/package.json").version
});

// This is a low-traffic personal tool where content and styles change
// often; always serve fresh bytes rather than risk a stale cached CSS/JS
// file silently mismatching newly-changed markup.
app.use("/static", express.static(path.join(__dirname, "static"), {
  etag: false,
  lastModified: false,
  setHeaders: res => res.set("Cache-Control", "no-store")
}));

// Justif (https://github.com/lyallcooper/justif, MIT), which sets
// justified text for layout rows with `justify` (see static/reader.js).
const JUSTIF_DIR = path.join(__dirname, "node_modules/justif");
app.use("/vendor/justif", express.static(path.join(JUSTIF_DIR, "dist"), { maxAge: "30d" }));
app.get("/vendor/justif/LICENSE", (req, res) => res.type("text/plain").sendFile(path.join(JUSTIF_DIR, "LICENSE")));

const clients = new Set();

app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.flushHeaders();
  res.write("event: ready\ndata: ok\n\n");

  clients.add(res);
  req.on("close", () => clients.delete(res));
});

function notifyReload() {
  for (const res of clients) {
    res.write("event: reload\ndata: changed\n\n");
  }
}

// Proxies a private-repo image by opaque id — see "Private image
// proxy" further down for how ids get registered. The real GitHub URL
// never reaches the client: this fetches it server-side (with
// IMAGE_GITHUB_TOKEN, if the image repo needs auth) and streams the
// bytes back under this app's own domain instead — streamed as they
// arrive, not buffered whole, so the browser learns an image's size
// from its first bytes (the reader waits on exactly that, see
// waitForImageSizes in static/reader.js).
app.get("/img/:id", async (req, res) => {
  const entry = imageProxyMap.get(req.params.id);
  if (!entry) {
    res.status(404).type("text").send("Not found");
    return;
  }

  try {
    const upstream = await fetch(entry.url, {
      headers: IMAGE_GITHUB_TOKEN ? { Authorization: `token ${IMAGE_GITHUB_TOKEN}` } : {}
    });
    if (!upstream.ok) {
      res.status(upstream.status).type("text").send("Upstream image fetch failed");
      return;
    }

    res.set({
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      // Immutable: the id is a hash of the real URL, so the same id
      // always means the same bytes — safe to cache indefinitely.
      "Cache-Control": "public, max-age=31536000, immutable"
    });
    const length = upstream.headers.get("content-length");
    if (length) res.set("Content-Length", length);
    Readable.fromWeb(upstream.body)
      .on("error", () => res.destroy())
      .pipe(res);
  } catch (error) {
    res.status(502).type("text").send(`Could not fetch image\n\n${error.stack || error}`);
  }
});

// An attachment referenced by a published note (see resolveVaultLinks).
// Ids are registered as pages are served; one this instance hasn't seen
// yet (a fresh server) is looked up by resolving every published note.
app.get("/asset/:id", async (req, res) => {
  try {
    if (!assetIds.has(req.params.id)) {
      for (const entry of await listEntries()) {
        resolveVaultLinks(entry.bodyHtml + entry.teaserHtml);
      }
    }
    const p = assetIds.get(req.params.id);
    const asset = p && await entrySource.readAsset(p);
    if (!asset) {
      res.status(404).type("text").send("Not found");
      return;
    }
    res.type(path.extname(p));
    res.set("Cache-Control", "public, max-age=300");
    if (asset.size) res.set("Content-Length", String(asset.size));
    asset.stream.on("error", () => res.destroy()).pipe(res);
  } catch (error) {
    res.status(500).type("text").send(`Could not read attachment\n\n${error.stack || error}`);
  }
});

app.get(SEARCH_PATH, async (req, res) => {
  try {
    const words = String(req.query.q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const entries = await listEntries();
    const hits = words.length ? entries.filter(e => words.every(w => searchTextOf(e).includes(w))) : entries;
    res.json(hits.map(e => e.slug));
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get(HOME_PATH, async (_req, res) => {
  try {
    const entries = await listEntries();
    res.type("html").send(resolveVaultLinks(renderHomePage(entries)));
  } catch (error) {
    res.status(500).type("text").send(`Could not list notes from ${entrySource.label}\n\n${error.stack || error}`);
  }
});

// One collection as a book.
app.get("/contents/:tag", async (req, res) => {
  try {
    const tag = req.params.tag;
    const entries = await listEntries();
    res.type("html").send(resolveVaultLinks(await renderContentsPage(entries, tag)));
  } catch (error) {
    res.status(500).type("text").send(`Could not list notes from ${entrySource.label}\n\n${error.stack || error}`);
  }
});

app.get("/unavailable", (_req, res) => {
  res.status(404).type("html").send(renderUnavailablePage());
});

app.get("/entry/:slug", async (req, res) => {
  try {
    const entries = await listEntries();
    const entry = entries.find(e => e.slug === req.params.slug);
    if (!entry) {
      res.status(404).type("html").send(renderUnavailablePage());
      return;
    }
    res.type("html").send(resolveVaultLinks(await renderEntryPage(entry)));
  } catch (error) {
    res.status(500).type("text").send(`Could not render entry\n\n${error.stack || error}`);
  }
});

if (LIVE) {
  const watchTargets = [
    entrySource.rootDir,
    path.join(__dirname, "static")
  ];

  chokidar.watch(watchTargets, {
    ignoreInitial: true,
    usePolling: process.env.WATCH_POLLING === "1",
    interval: 1000
  }).on("all", (_event, filePath) => {
    if (filePath && filePath.endsWith(".md")) {
      forgetNote(path.relative(entrySource.rootDir, filePath));
    }
    notifyReload();
  });
}

// --- Settings page ------------------------------------------------------
//
// /settings edits md2book.settings.json (see lib/config.js). Only when
// the notes are a local folder, and only from this computer: a public
// deployment never offers it.
function settingsAvailable() {
  return LIVE;
}

function fromThisComputer(req) {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function settingsGuard(req, res, next) {
  if (settingsAvailable() && fromThisComputer(req)) return next();
  res.status(404).type("text").send("Not found");
}

app.get("/settings", settingsGuard, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "static", "settings.html"));
});

app.get("/api/settings", settingsGuard, async (_req, res) => {
  try {
    const { file, saved } = readSettings();
    res.json({ file, saved, defaults: DEFAULTS, homePath: HOME_PATH, notesDir: LOCAL_ENTRIES_DIR, vault: await scanVault() });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.put("/api/settings", settingsGuard, express.json({ limit: "200kb" }), async (req, res) => {
  try {
    const saved = req.body;
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Settings must be an object");
    const next = resolveConfig(saved);
    const { file } = readSettings();
    writeSettings(file, saved);
    // Everything reads `config`: swap its contents, re-render notes.
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, next, { file });
    clearCache();
    notifyReload();
    res.json({ file, vault: await scanVault() });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

// Starts the local server (`npm run dev`, or the md2book command in
// bin/). Deployed on Vercel, `api/index.js` imports `app` instead and
// Vercel handles listening.
export function start({ port = PORT, open = process.env.NO_OPEN !== "1", openPath = HOME_PATH } = {}) {
  return app.listen(port, () => {
    const url = `http://localhost:${port}${HOME_PATH}`;
    console.log(`md2book: ${url}`);
    console.log(`Notes:   ${entrySource.label}`);
    console.log(`Settings: ${settingsAvailable() ? `http://localhost:${port}/settings` : "(md2book.settings.json)"}`);
    if (HOME_PATH !== "/") console.log(`(home path set — plain "/" won't list the notes)`);

    if (open) {
      const opener = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "start \"\""
        : "xdg-open";
      exec(`${opener} http://localhost:${port}${openPath}`);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();

export default app;
