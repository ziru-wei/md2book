import express from "express";
import chokidar from "chokidar";
import { createRequire } from "node:module";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { Readable } from "node:stream";
import { createEntrySource } from "./lib/source.js";
import { loadConfig, layerSettings, readSettings, resolveConfig, writeSettings, DEFAULTS } from "./lib/config.js";
import {
  setup, clearCache, forgetNote, HOME_PATH, SEARCH_PATH, imageProxyMap, assetIds, resolveVaultLinks, listEntries,
  listEpubs, renderEpubPage, renderHomePage, renderContentsPage, renderEntryPage, renderUnavailablePage, searchTextOf, scanVault
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
// layouts...) — see lib/config.js: md2book.settings.json in the md2book
// folder, deployed with it — or, for notes in a GitHub repository, the
// repo's own copy (below).

// Watching notes and reloading pages is for running md2book on your own
// computer; a deployed site (Vercel) serves a fixed copy.
const LIVE = entrySource.liveReload && !process.env.VERCEL;
const config = loadConfig();

// Notes from a GitHub repository keep their settings there too (see
// createGitHubSource): md2book.settings.json at the repo's top, when it
// has one, laid over the file deployed with the app — what the repo's
// file leaves out (say, a font kit set only in the deployed file) still
// applies. Saving from /settings writes the two as one to the repo. Every listing of
// the notes says which version of it there is, so a change saved there
// (from /settings on any instance of the site, or pushed) applies on
// the next page served.
const REPO_SETTINGS = typeof entrySource.writeSettings === "function";
const deployedSettings = readSettings();
let repoSettingsVersion;
// What the site runs on: the deployed file's settings, or the repo's.
let savedSettings = deployedSettings.saved;

// Swaps in settings `saved` (everything reads `config`) and re-renders
// notes. The home page stays where it was served from.
function applySettings(saved, file) {
  const next = resolveConfig(saved);
  next.site.homePath = config.site.homePath;
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, next, { file });
  savedSettings = saved;
  clearCache();
}

async function followRepoSettings(version) {
  if (version === repoSettingsVersion) return;
  const saved = version ? layerSettings(deployedSettings.saved, await entrySource.readSettings(version)) : deployedSettings.saved;
  applySettings(saved, version ? entrySource.settingsLabel : deployedSettings.exists ? deployedSettings.file : null);
  repoSettingsVersion = version;
}

if (REPO_SETTINGS) {
  const listAll = entrySource.listAll.bind(entrySource);
  entrySource.listAll = async () => {
    const listing = await listAll();
    await followRepoSettings(listing.settings);
    return listing;
  };
}

// Optional PAT for a private image-hosting repo (may be a different
// GitHub account/repo entirely from GITHUB_TOKEN's content repo — see
// /img/:id below). Unset means unauthenticated fetches, which only
// works for images that are actually public.
const IMAGE_GITHUB_TOKEN = process.env.IMAGE_GITHUB_TOKEN || "";

// The settings page edits the site's settings, in one of two ways:
// - "local": notes in a folder on this computer — /settings, opened from
//   this computer only, saves md2book.settings.json in the md2book
//   folder.
// - "repo": notes in a GitHub repository (a deployed site) — the page
//   lives under the home page's own address (<home path>/settings),
//   which only the site's owner knows, and saves md2book.settings.json
//   to the repo. Only with a home path set: on a site whose home page is
//   the plain "/", anyone could find it.
// Otherwise there is no settings page.
const SETTINGS_MODE = LIVE ? "local" : REPO_SETTINGS && config.site.homePath !== "/" ? "repo" : null;
const SETTINGS_BASE = SETTINGS_MODE === "repo" ? config.site.homePath.replace(/\/$/, "") : "";
const SETTINGS_PATH = SETTINGS_MODE && SETTINGS_BASE + "/settings";

// Notes become pages in lib/render.js (HOME_PATH and SEARCH_PATH come
// from it, set from config.site.homePath).
setup({
  config,
  source: entrySource,
  hash: text => crypto.createHash("sha256").update(text).digest("hex"),
  live: LIVE,
  // Linked from the home page.
  settingsPath: SETTINGS_PATH,
  epubCloud: Boolean(REPO_SETTINGS || process.env.VERCEL),
  imageToken: IMAGE_GITHUB_TOKEN,
  temmlVersion: createRequire(import.meta.url)("temml/package.json").version
});

// This is a low-traffic personal tool where content and styles change
// often; always serve fresh bytes rather than risk a stale cached CSS/JS
// file silently mismatching newly-changed markup.
// Fonts (static/fonts) are the exception: large, and they don't change.
app.use("/static/fonts", express.static(path.join(__dirname, "static", "fonts"), { maxAge: "30d" }));
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

app.use("/vendor/epubjs", express.static(path.join(__dirname, "node_modules/epubjs/dist")));
app.use("/vendor/jszip", express.static(path.join(__dirname, "node_modules/jszip/dist")));

app.get(["/epub/:id", "/epub-file/:id"], async (req, res) => {
  try {
    const book = (await listEpubs()).find(book => book.id === req.params.id);
    if (!book) return res.status(404).type("html").send(renderUnavailablePage());
    if (req.path.startsWith("/epub/")) return res.type("html").send(renderEpubPage(book, undefined, { homePath: SETTINGS_MODE === "repo" && !hasBookmarkSession(req) ? "/" : HOME_PATH }));
    const asset = await entrySource.readAsset(book.path);
    if (!asset) return res.status(404).send("Not found");
    res.type("application/epub+zip").set("Cache-Control", "no-store");
    if (asset.size) res.set("Content-Length", String(asset.size));
    asset.stream.on("error", () => res.destroy()).pipe(res);
  } catch (error) {
    res.status(500).type("text").send(`Could not read EPUB: ${error.message}`);
  }
});

// The private library URL unlocks personal bookmarks, as it does settings.
// Shared EPUB URLs neither expose that URL nor grant write access.
const BOOKMARK_COOKIE = "md2book-epub-owner";
function bookmarkSignature(value) {
  return crypto.createHmac("sha256", process.env.GITHUB_TOKEN || "").update(HOME_PATH + ":" + value).digest("hex");
}
function grantBookmarkSession(res) {
  const expires = String(Date.now() + 30 * 86400000);
  res.cookie(BOOKMARK_COOKIE, expires + "." + bookmarkSignature(expires), {
    httpOnly: true, sameSite: "strict", secure: Boolean(process.env.VERCEL), maxAge: 30 * 86400000, path: "/"
  });
}
function hasBookmarkSession(req) {
  const cookie = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(BOOKMARK_COOKIE + "="));
  const value = cookie?.slice(BOOKMARK_COOKIE.length + 1) || "";
  const [expires, signature] = value.split(".");
  if (!/^\d+$/.test(expires || "") || Number(expires) < Date.now() || !/^[a-f0-9]{64}$/.test(signature || "")) return false;
  return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(bookmarkSignature(expires), "hex"));
}
function bookmarkGuard(req, res, next) {
  res.set("Cache-Control", "no-store");
  if (SETTINGS_MODE !== "repo" || !entrySource.bookmarks) return res.status(503).json({ error: "Cloud bookmarks need GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN (Contents: Read and write), and a private HOME_PATH." });
  if (!hasBookmarkSession(req)) return res.status(403).json({ error: "Open your private library URL first to enable cloud bookmarks on this device." });
  if (!/^[a-f0-9]{64}$/.test(req.params.id)) return res.status(400).json({ error: "Invalid book id" });
  next();
}
app.get("/api/epub-bookmarks/:id", bookmarkGuard, async (req, res) => {
  try { res.json(await entrySource.bookmarks.read(req.params.id)); }
  catch { res.status(502).json({ error: "Could not load cloud bookmarks. Check GitHub access and try again." }); }
});
app.post("/api/epub-bookmarks/:id", bookmarkGuard, express.json({ limit: "8kb" }), async (req, res) => {
  try { res.json(await entrySource.bookmarks.update(req.params.id, req.body)); }
  catch { res.status(400).json({ error: "Bookmark was not saved. Check GitHub write access and retry." }); }
});

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
  if (SETTINGS_MODE === "repo") grantBookmarkSession(res);
  try {
    const entries = await listEntries();
    res.type("html").send(resolveVaultLinks(renderHomePage(entries, await listEpubs())));
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

let liveWatcher;
if (LIVE) {
  const watchTargets = [
    entrySource.rootDir,
    path.join(__dirname, "static")
  ];

  liveWatcher = chokidar.watch(watchTargets, {
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
// (Where it is and what it saves to: see SETTINGS_MODE above.)

function fromThisComputer(req) {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function settingsGuard(req, res, next) {
  if (SETTINGS_MODE === "repo" || (SETTINGS_MODE === "local" && fromThisComputer(req))) return next();
  res.status(404).type("text").send("Not found");
}

app.get(SETTINGS_BASE + "/settings", settingsGuard, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "static", "settings.html"));
});

app.get(SETTINGS_BASE + "/api/settings", settingsGuard, async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    if (SETTINGS_MODE === "repo") {
      // Lists the notes, which brings in the repo's settings first.
      const vault = await scanVault();
      res.json({ mode: "repo", file: entrySource.settingsLabel, saved: savedSettings, defaults: DEFAULTS, homePath: HOME_PATH, notesDir: entrySource.label, vault });
      return;
    }
    const { file, saved } = readSettings();
    res.json({ file, saved, defaults: DEFAULTS, homePath: HOME_PATH, notesDir: LOCAL_ENTRIES_DIR, vault: await scanVault() });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.put(SETTINGS_BASE + "/api/settings", settingsGuard, express.json({ limit: "200kb" }), async (req, res) => {
  try {
    const saved = req.body;
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Settings must be an object");
    resolveConfig(saved);
    let file;
    if (SETTINGS_MODE === "repo") {
      // What the repo holds now (this instance may not have looked yet).
      await entrySource.listAll();
      // Each save is a commit: none when nothing changed.
      if (JSON.stringify(saved) !== JSON.stringify(savedSettings)) repoSettingsVersion = await entrySource.writeSettings(saved);
      file = entrySource.settingsLabel;
    } else {
      file = readSettings().file;
      writeSettings(file, saved);
    }
    applySettings(saved, file);
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
  return app.listen(port, error => {
    if (error) {
      console.error(error.code === "EADDRINUSE"
        ? `md2book: port ${port} is already in use. Stop the other server or choose --port ${port + 1}.`
        : `md2book: could not start: ${error.message}`);
      process.exitCode = 1;
      // A failed CLI start must not remain alive just watching the vault.
      liveWatcher?.close();
      return;
    }
    const url = `http://localhost:${port}${HOME_PATH}`;
    console.log(`md2book: ${url}`);
    console.log(`Notes:   ${entrySource.label}`);
    console.log(`Settings: ${SETTINGS_MODE ? `http://localhost:${port}${SETTINGS_PATH}` : "(md2book.settings.json)"}`);
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
