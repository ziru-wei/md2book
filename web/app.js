// md2book in the browser: the same pages as the server (lib/render.js),
// made from a folder on this computer that the browser reads directly —
// nothing is uploaded. Each page is shown in a full-window <iframe>
// (srcdoc), so it runs exactly as served, static/reader.js and all;
// what the server would answer (links between pages, search, the
// settings API, attachments) is answered here instead.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { DEFAULTS, SETTINGS_NAME, resolveConfig } from "../lib/config-core.js";
import * as render from "../lib/render.js";
import { createDirectorySource, createFileListSource } from "./source.js";

// gray-matter keeps a Buffer copy of each note it reads; a string does.
globalThis.Buffer ||= { from: value => value, isBuffer: () => false };

// Where index.html, static/ and vendor/ are served (a GitHub Pages
// project site lives under /<repo>/).
const APP_BASE = new URL("./", location.href).href;

const $ = selector => document.querySelector(selector);
const frame = $("#page");
const landing = $("#landing");

let source = null;
let config = null;

// --- The chosen folder, remembered ------------------------------------
//
// A folder picked with showDirectoryPicker() is kept (its handle, not
// its files) in IndexedDB, so the next visit can open it again — after
// asking, unless the browser was told to allow it on every visit.

function idb(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("md2book", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("folders");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = run(open.result.transaction("folders", mode).objectStore("folders"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
}

const savedFolder = () => idb("readonly", store => store.get("last")).catch(() => null);
const rememberFolder = handle => idb("readwrite", store => store.put(handle, "last")).catch(() => {});

// --- Settings ---------------------------------------------------------
//
// Kept in this browser, per folder (by its name). A folder with no
// settings here yet starts from its own md2book.settings.json, if it
// has one at the top.

const settingsKey = () => `md2book.settings:${source.name}`;

async function loadSaved() {
  try {
    const kept = localStorage.getItem(settingsKey());
    if (kept) return JSON.parse(kept);
  } catch { /* storage unavailable */ }
  try {
    const file = await source.readAsset(SETTINGS_NAME);
    if (file) return JSON.parse(await file.text());
  } catch { /* none, or not JSON */ }
  return {};
}

// Pages here have no addresses of their own to hide: the home page is
// always "/".
function applySettings(saved) {
  const next = resolveConfig(saved);
  next.site.homePath = "/";
  next.file = null;
  if (!config) return (config = next);
  // lib/render.js holds `config`: swap its contents.
  for (const key of Object.keys(config)) delete config[key];
  return Object.assign(config, next);
}

async function useSource(nextSource) {
  source = nextSource;
  config = null;
  applySettings(await loadSaved());
  render.setup({
    config,
    source,
    hash: text => bytesToHex(sha256(utf8ToBytes(text))),
    staticBase: APP_BASE,
    // Remote images load straight from where they are.
    proxyImages: false,
    temmlVersion: TEMML_VERSION
  });
  for (const { url } of blobUrls.values()) URL.revokeObjectURL(url);
  blobUrls.clear();
  landing.hidden = true;
  frame.hidden = false;
  watch();
  await show();
}

// --- Attachments --------------------------------------------------------
//
// The renderer links an attachment as /asset/<id>; here each becomes a
// blob: URL for the file itself, made once per file version.

const blobUrls = new Map();

async function withAttachments(html) {
  const ids = new Set([...html.matchAll(/\/asset\/([0-9a-f]+)/g)].map(m => m[1]));
  const urls = new Map();
  await Promise.all([...ids].map(async id => {
    const p = render.assetIds.get(id);
    const file = p && await source.readAsset(p);
    if (!file) return;
    const key = `${file.lastModified}:${file.size}`;
    let cached = blobUrls.get(p);
    if (!cached || cached.key !== key) {
      if (cached) URL.revokeObjectURL(cached.url);
      cached = { key, url: URL.createObjectURL(file) };
      blobUrls.set(p, cached);
    }
    urls.set(id, cached.url);
  }));
  return html.replace(/\/asset\/([0-9a-f]+)/g, (m, id) => urls.get(id) || m);
}

// --- Pages --------------------------------------------------------------

// The page shown: the part of the address after "#", a server path
// ("/", "/entry/<slug>", "/contents/<name>", "/settings").
const currentPath = () => decodeURI(location.hash.slice(1)) || "/";

async function pageHtml(path) {
  if (path === "/settings") {
    const res = await fetch(new URL("static/settings.html", APP_BASE));
    return res.text();
  }
  const entries = await render.listEntries();
  let match;
  if ((match = /^\/entry\/([^/?#]+)$/.exec(path))) {
    const entry = entries.find(e => e.slug === match[1]);
    return entry ? render.resolveVaultLinks(await render.renderEntryPage(entry)) : render.renderUnavailablePage();
  }
  if ((match = /^\/contents\/([^/?#]+)$/.exec(path))) {
    return render.resolveVaultLinks(await render.renderContentsPage(entries, decodeURIComponent(match[1])));
  }
  if (path === "/") return render.resolveVaultLinks(render.renderHomePage(entries));
  return render.renderUnavailablePage();
}

// Runs first in every page: sends links to other pages, and the page's
// requests to the server, back here.
const BRIDGE = `<script>
(function () {
  var app = parent.md2book;
  function internal(href) { return /^\\/(?!\\/)/.test(href || ""); }
  function follow(e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || !internal(a.getAttribute("href"))) return;
    e.preventDefault();
    var href = a.getAttribute("href");
    if (e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey) window.open(app.addressOf(href), "_blank");
    else app.go(href);
  }
  document.addEventListener("click", follow, true);
  document.addEventListener("auxclick", follow, true);
  var serverFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input.url;
    if (!internal(url)) return serverFetch.apply(this, arguments);
    return app.answer(url, init || {}).then(function (r) {
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    });
  };
  if (app.onHome) {
    document.addEventListener("DOMContentLoaded", function () {
      var header = document.querySelector(".index-header");
      if (!header) return;
      var links = document.createElement("div");
      links.className = "web-folder-links";
      [["/open", app.folderName], ["/settings", "settings"]].forEach(function (item) {
        var link = document.createElement("a");
        link.href = item[0];
        link.textContent = item[1];
        if (item[0] === "/open") link.title = "Open another folder";
        links.appendChild(link);
      });
      header.appendChild(links);
    });
  }
})();
</script>
<style>
  .web-folder-links { display: flex; justify-content: center; gap: 1.2em; margin-top: 0.6em; font-size: 0.8rem; letter-spacing: 0.02em; }
  .web-folder-links a { color: inherit; opacity: 0.55; text-decoration: none; }
  .web-folder-links a:hover { opacity: 1; }
</style>`;

let showing = 0;

async function show() {
  if (!source) return;
  const path = currentPath();
  const n = ++showing;
  let html;
  try {
    html = await withAttachments(await pageHtml(path));
  } catch (error) {
    html = `<pre style="white-space: pre-wrap; padding: 2rem">Could not read ${escapeText(source.label)}\n\n${escapeText(error.stack || error)}</pre>`;
  }
  if (n !== showing) return;
  window.md2book.onHome = path === "/";
  frame.srcdoc = html.replace(/<head>/i, m => m + BRIDGE);
}

function escapeText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

frame.addEventListener("load", () => {
  const doc = frame.contentDocument;
  if (doc && doc.title) document.title = doc.title;
  frame.contentWindow.focus();
});

window.addEventListener("hashchange", show);

// What a page's fetch() to the server gets here: the home page's search,
// and the settings page's API (see server.js).
async function answer(url, { method = "GET", body }) {
  const { pathname, searchParams } = new URL(url, "http://md2book.local");
  if (pathname === render.SEARCH_PATH) {
    const words = String(searchParams.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean);
    const entries = await render.listEntries();
    const hits = words.length ? entries.filter(e => words.every(w => render.searchTextOf(e).includes(w))) : entries;
    return { status: 200, body: hits.map(e => e.slug) };
  }
  if (pathname === "/api/settings") {
    const where = "this browser (per folder)";
    try {
      if (method === "PUT") {
        const saved = JSON.parse(body);
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Settings must be an object");
        applySettings(saved);
        try { localStorage.setItem(settingsKey(), JSON.stringify(saved)); } catch { /* storage unavailable */ }
        render.clearCache();
        return { status: 200, body: { file: where, vault: await render.scanVault() } };
      }
      return {
        status: 200,
        body: { file: where, saved: await loadSaved(), defaults: DEFAULTS, homePath: "/", notesDir: source.name, vault: await render.scanVault() }
      };
    } catch (error) {
      return { status: method === "PUT" ? 400 : 500, body: { error: String(error.message || error) } };
    }
  }
  return { status: 404, body: { error: "Not found" } };
}

window.md2book = {
  onHome: false,
  get folderName() { return source ? source.name : ""; },
  addressOf: path => `${APP_BASE}#${path}`,
  go(path) {
    if (path === "/open") showLanding();
    else if (currentPath() === path) show();
    else location.hash = path;
  },
  answer
};

// --- Following edits ----------------------------------------------------
//
// When a note or attachment changes, the page is made again (as the
// server's live reload does). Chrome's FileSystemObserver reports
// changes as they happen; elsewhere the folder is checked every few
// seconds while the page is in view.

let stopWatching = () => {};

function watch() {
  stopWatching();
  if (!source.signature) return;
  let last = null;
  let timer = null;
  const check = async () => {
    const signature = await source.signature().catch(() => last);
    if (last !== null && signature !== last) show();
    last = signature;
  };
  check();
  const soon = () => { clearTimeout(timer); timer = setTimeout(check, 300); };
  if ("FileSystemObserver" in window) {
    const observer = new FileSystemObserver(soon);
    observer.observe(source.handle, { recursive: true }).catch(() => {});
    stopWatching = () => observer.disconnect();
  } else {
    const poll = setInterval(() => { if (document.visibilityState === "visible") check(); }, 3000);
    stopWatching = () => clearInterval(poll);
  }
}

// --- Choosing a folder --------------------------------------------------

const canPick = "showDirectoryPicker" in window;

async function openHandle(handle) {
  const directory = createDirectorySource(handle);
  directory.handle = handle;
  await rememberFolder(handle);
  await useSource(directory);
}

$("#pick").addEventListener("click", async () => {
  if (!canPick) {
    $("#folder-input").click();
    return;
  }
  try {
    await openHandle(await showDirectoryPicker({ id: "md2book", mode: "read" }));
  } catch (error) {
    if (error.name !== "AbortError") showError(error);
  }
});

$("#folder-input").addEventListener("change", async event => {
  if (event.target.files.length) await useSource(createFileListSource(event.target.files)).catch(showError);
});

function showError(error) {
  $("#error").hidden = false;
  $("#error").textContent = String(error.message || error);
}

// The folder picker; on first load, the last folder opens straight away
// if the browser still allows it.
async function showLanding({ reopen = false } = {}) {
  stopWatching();
  source = null;
  frame.hidden = true;
  frame.srcdoc = "";
  landing.hidden = false;
  document.title = "md2book";
  $("#browser-note").hidden = canPick;

  const handle = canPick && await savedFolder();
  $("#reopen").hidden = !handle;
  $("#pick").classList.toggle("secondary", !!handle);
  if (!handle) return;
  $("#reopen-name").textContent = handle.name;
  // Allowed already (this visit, or on every visit).
  if (reopen && await handle.queryPermission({ mode: "read" }) === "granted") {
    await openHandle(handle).catch(showError);
    return;
  }
  $("#reopen").onclick = async () => {
    if (await handle.requestPermission({ mode: "read" }) === "granted") await openHandle(handle).catch(showError);
  };
}

showLanding({ reopen: true });
