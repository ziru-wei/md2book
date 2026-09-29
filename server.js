import express from "express";
import chokidar from "chokidar";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import markdownItMark from "markdown-it-mark";
import markdownItKatex from "@vscode/markdown-it-katex";
import temml from "temml";
import { createRequire } from "node:module";
import * as cheerio from "cheerio";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { Readable } from "node:stream";
import { createEntrySource } from "./lib/source.js";
import { loadConfig, layoutOf } from "./lib/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT || 3000);
// The notes folder: the command-line argument, $JOURNAL_DIR, or ./entries.
const LOCAL_ENTRIES_DIR = path.resolve(
  process.cwd(),
  process.env.JOURNAL_DIR || process.argv[2] || "entries"
);

const entrySource = createEntrySource(LOCAL_ENTRIES_DIR);

// The site's own settings (name, which notes publish, collections,
// layouts...) — see lib/config.js.
const config = await loadConfig(LOCAL_ENTRIES_DIR);

// Where the home page (the list of every note) lives — see
// config.site.homePath. Nothing meant to be shared out (a note's
// /entry/<hash> link, a collection's /contents/<name> link) depends on
// it: CONTENTS_PATH is always the plain top-level "/contents", so
// pasting one of those URLs elsewhere can't leak a secret home path.
const HOME_PATH = config.site.homePath;
const CONTENTS_PATH = "/contents";

// Optional PAT for a private image-hosting repo (may be a different
// GitHub account/repo entirely from GITHUB_TOKEN's content repo — see
// /img/:id below). Unset means unauthenticated fetches, which only
// works for images that are actually public.
const IMAGE_GITHUB_TOKEN = process.env.IMAGE_GITHUB_TOKEN || "";

const md = new MarkdownIt({
  html: true,
  linkify: false,
  typographer: true
}).use(markdownItMark)
  // Obsidian-style math: $$...$$ as a display block — on its own lines
  // or inside a paragraph — and $...$ inline. The plugin only parses
  // here; rendering is Temml's (below).
  .use(markdownItKatex.default || markdownItKatex);
md.inline.ruler.at("math_inline", obsidianInlineMath);

// Math renders on the server to native MathML (Temml), so the browser
// lays equations out as ordinary text and pages are cut with them in
// place. (KaTeX's HTML output was tried first: its positioned boxes get
// placed in the wrong column by Safari's multi-column layout.) The TeX
// source rides along as an annotation.
// Math that doesn't parse shows its source in red, the error on hover.
function renderMath(tex, displayMode) {
  try {
    return temml.renderToString(tex, { displayMode, annotate: true, throwOnError: true, trust: false });
  } catch (error) {
    return `<code class="math-error" title="${escapeHtml(String(error.message || error))}">${escapeHtml(tex)}</code>`;
  }
}
md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);
md.renderer.rules.math_block = md.renderer.rules.math_inline_block =
  (tokens, idx) => `<span class="math-block">${renderMath(tokens[idx].content, true)}</span>\n`;

// Temml's stylesheet for pages with math: the system math font (STIX Two
// Math on Apple devices, Cambria Math on Windows), from the CDN at
// exactly the version the server renders with.
const TEMML_VERSION = createRequire(import.meta.url)("temml/package.json").version;
const MATH_CSS = `https://cdn.jsdelivr.net/npm/temml@${TEMML_VERSION}/dist/Temml-Local.css`;

// Inline math the way Obsidian reads it: $x$ opens on a "$" not
// followed by a space, and the next (unescaped) "$" must close it — not
// preceded by a space, not followed by a digit — or it isn't math at
// all, so "costs $5 and $10" and "$ x $" stay text. "\$" is a literal
// dollar sign (markdown-it's escape rule).
function obsidianInlineMath(state, silent) {
  const src = state.src;
  const start = state.pos;
  if (src[start] !== "$" || src[start + 1] === "$") return false;
  const first = src[start + 1];
  if (first === undefined || /\s/.test(first)) return false;

  let end = start + 1;
  while ((end = src.indexOf("$", end)) !== -1 && src[end - 1] === "\\") end += 1;
  if (end === -1 || end === start + 1) return false;
  if (/\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || "")) return false;
  const content = src.slice(start + 1, end);
  if (/\n\s*\n/.test(content)) return false;

  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.markup = "$";
    token.content = content;
  }
  state.pos = end + 1;
  return true;
}

// Text of an element with its math read back as "$TeX$" (from each
// equation's TeX annotation) rather than as run-together symbols.
function plainText($, $el) {
  const $copy = $el.clone();
  $copy.find("math").each((_, math) => {
    const tex = $(math).find('annotation[encoding="application/x-tex"]').first().text();
    $(math).replaceWith(`$${tex}$`);
  });
  return $copy.text();
}

// This is a low-traffic personal tool where content and styles change
// often; always serve fresh bytes rather than risk a stale cached CSS/JS
// file silently mismatching newly-changed markup.
app.use("/static", express.static(path.join(__dirname, "static"), {
  etag: false,
  lastModified: false,
  setHeaders: res => res.set("Cache-Control", "no-store")
}));

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

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Title Case for headings: capitalizes the first letter of every word
// except a fixed list of short prepositions/articles/conjunctions
// (lowercased instead) — unless that word is the first or last one,
// which is always capitalized regardless. Only the first letter of a
// word is touched (the rest is left exactly as typed), so existing
// internal capitalization — acronyms like "AI", "URL" — survives.
const TITLE_CASE_SMALL_WORDS = new Set([
  "a", "an", "the",
  "and", "but", "or", "nor", "so", "yet",
  "as", "at", "by", "for", "from", "in", "into", "of", "off", "on",
  "onto", "out", "over", "per", "to", "up", "via", "with"
]);

// "$...$" math in plain text (titles).
const MATH_SEGMENT_RE = /\$[^$\n]+\$/g;

// `first`/`last`: whether this text starts/ends the whole title — not
// for a piece of a heading with math before/after it.
function toTitleCase(text, { first = true, last = true } = {}) {
  if (!config.typography.titleCase) return text;
  // Math stays exactly as written, as one "word".
  const math = [];
  text = text.replace(MATH_SEGMENT_RE, m => `${math.push(m) - 1}`);
  const restore = str => str.replace(/(\d+)/g, (_, i) => math[i]);
  const tokens = text.split(/(\s+)/);
  const wordIndices = [];
  tokens.forEach((token, i) => {
    if (token && !/^\s+$/.test(token)) wordIndices.push(i);
  });
  if (!wordIndices.length) return restore(text);
  const firstWordIndex = wordIndices[0];
  const lastWordIndex = wordIndices[wordIndices.length - 1];

  return restore(tokens.map((token, i) => {
    if (!token || /^\s+$/.test(token) || token.startsWith("")) return token;
    const lower = token.toLowerCase();
    const isEdge = (first && i === firstWordIndex) || (last && i === lastWordIndex);
    if (TITLE_CASE_SMALL_WORDS.has(lower) && !isEdge) return lower;
    return token.charAt(0).toUpperCase() + token.slice(1);
  }).join(""));
}

// Title text as HTML: plain text escaped, "$...$" math rendered.
function renderTitleText(text) {
  let html = "";
  let last = 0;
  for (const m of text.matchAll(MATH_SEGMENT_RE)) {
    html += escapeHtml(text.slice(last, m.index));
    html += renderMath(m[0].slice(1, -1), false);
    last = m.index + m[0].length;
  }
  return html + escapeHtml(text.slice(last));
}

function normalizeDate(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  return String(value);
}

// Opaque per-file identifier, not a readable slug: a note's URL
// shouldn't hint at its title or filename (e.g. for a link shared on
// its own, out of the journal's context). Stable across requests/
// restarts since it's derived only from the file's own path.
function slugify(id) {
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 12);
}

// A frontmatter value usable as an id: a non-empty string or a number.
function getPublishId(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

// --- Private image proxy ----------------------------------------------
//
// Every raw.githubusercontent.com <img src> is swapped, in
// postProcessMarkdown below, for an opaque same-origin URL
// (/img/<id>) — the point being that a visitor should never see
// "github.com", an owner name, or a repo name anywhere: not in page
// source, not in the Network tab, not after the browser actually
// fetches the image. imageProxyMap remembers id -> the real URL (and
// whether it's a PNG, for addManagedImageSizes below) for the
// lifetime of the process; the /img/:id route fetches the real
// bytes server-side — authenticated with IMAGE_GITHUB_TOKEN, which may
// be a completely different GitHub account/repo than GITHUB_TOKEN's
// content repo — and streams them back under this app's own domain.
const imageProxyMap = new Map();

function isGithubRawUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname === "raw.githubusercontent.com";
  } catch {
    return false;
  }
}

function registerImageProxy(realUrl) {
  const id = crypto.createHash("sha256").update(realUrl).digest("hex").slice(0, 20);
  if (!imageProxyMap.has(id)) {
    imageProxyMap.set(id, {
      url: realUrl,
      isPng: /\.png$/i.test(new URL(realUrl).pathname)
    });
  }
  return `/img/${id}`;
}

const IMAGE_PROXY_PATH_RE = /^\/img\/([0-9a-f]+)$/;

// --- Managed remote PNG sizes ------------------------------------------
//
// The reader needs every image's height before it can cut pages (see
// static/reader.js). A raw-GitHub PNG can take a while to arrive, but
// its first 24 bytes (signature + IHDR) already hold its pixel size —
// so the server reads just those and writes width/height onto the
// <img>, and the browser reserves the right-sized box before a single
// image byte arrives. Only the HTML handed to the reader gets this,
// never the home page's waterfall thumbnails.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// `src` here is always one of OUR OWN /img/<id> proxy URLs by this
// point (postProcessMarkdown already swapped every raw-GitHub <img>)
// — never a real raw.githubusercontent.com one.
function isManagedPngUrl(src) {
  const match = IMAGE_PROXY_PATH_RE.exec(src || "");
  const entry = match && imageProxyMap.get(match[1]);
  return !!entry && entry.isPng;
}

function parsePngHeader(buf) {
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

// Cached by proxy URL — both in-flight promises (so concurrent
// requests for the same image share one fetch) and resolved results,
// for the lifetime of the process. Only the PNG header is ever
// requested (Range: bytes=0-23, exactly the signature + IHDR's width/
// height); if the remote server doesn't honor Range and answers with a
// full 200 instead, the body is cancelled unread rather than
// downloaded.
const pngDimensionCache = new Map();

async function resolvePngDimensions(proxySrc) {
  if (pngDimensionCache.has(proxySrc)) return pngDimensionCache.get(proxySrc);

  const match = IMAGE_PROXY_PATH_RE.exec(proxySrc || "");
  const entry = match && imageProxyMap.get(match[1]);
  if (!entry) return null;
  const rawUrl = entry.url;

  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(rawUrl, {
        headers: {
          Range: "bytes=0-23",
          ...(IMAGE_GITHUB_TOKEN ? { Authorization: `token ${IMAGE_GITHUB_TOKEN}` } : {})
        },
        signal: controller.signal
      });
      if (res.status !== 206) {
        // Range wasn't honored — don't read a potentially huge body.
        await res.body?.cancel?.().catch(() => {});
        return null;
      }
      return parsePngHeader(Buffer.from(await res.arrayBuffer()));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();

  pngDimensionCache.set(proxySrc, promise);
  return promise;
}

// Adds width/height to every managed PNG <img> in `html` whose size
// can be resolved; anything else (non-PNG, unmanaged, network failure)
// is left for the reader to measure once the browser has it.
async function addManagedImageSizes(html) {
  const $ = cheerio.load(`<div id="__wrap">${html}</div>`, null, false);
  const wrap = $("#__wrap");

  await Promise.all(wrap.find("img[src]").toArray().map(async img => {
    const $img = $(img);
    const src = $img.attr("src");
    if (!src || !isManagedPngUrl(src)) return;

    const dims = await resolvePngDimensions(src);
    if (!dims) return;

    $img.attr("width", String(dims.width));
    $img.attr("height", String(dims.height));
  }));

  return wrap.html() || "";
}

// Inline citation tokens: %%REF{>>{"author":"...","time":...}@@URL<<}%%
// The JSON blob is metadata only (author/time) and is discarded here —
// only the URL after "@@" feeds the reference system. Turned into a
// bare, label-less <a> before Markdown parsing so it flows through the
// same [label](url) -> reference machinery in postProcessMarkdown,
// which also groups adjacent ones like "(%%REF..%%, %%REF..%%)" into
// a single [1, 2] instead of [1][2].
const REF_TOKEN_RE = /%%REF\{>>(\{[^{}]*\})@@(.*?)<<\}%%/g;

function expandInlineRefTokens(markdown) {
  return markdown.replace(REF_TOKEN_RE, (_match, _meta, url) => citationRef(url));
}

function citationRef(source) {
  const trimmed = source.trim();
  return trimmed ? `<a class="citation-ref" href="${escapeHtml(trimmed)}"></a>` : "";
}

// CriticMarkup (as written by Obsidian's CriticMarkup plugin), shown as
// the finished text:
//   {--deleted--}          not shown
//   {++added++}            shown ("added")
//   {~~old~>new~~}         only the replacement shown ("new")
//   {==highlighted==}      shown as plain text
//   {==REF==}{>>source<<}  a citation: a numbered reference to the
//                          source (a URL or a [title](url) link), same as
//                          %%REF...%% (see expandInlineRefTokens)
// A {>>comment<<} right after a deletion or an addition is about the
// edit itself and is dropped; after a replacement or a highlight it
// becomes a side note on that text, numbered and set in the page's
// margin (see placeMarginNotes in static/reader.js). A comment on its
// own is dropped too. The plugin's metadata prefix ({"author":...}@@)
// is dropped from every mark. Code spans and fenced code are left as
// written.
const CRITIC_METADATA_RE = /^\s*\{[^{}]*\}@@/;
// Mark content: anything but a blank line (marks stay within a
// paragraph).
const CRITIC_TEXT = String.raw`((?:(?!\n[ \t]*\n)[\s\S])*?)`;
const CRITIC_COMMENT = String.raw`(?:\{>>${CRITIC_TEXT}<<\})?`;
const CRITIC_RULES = [
  [new RegExp(String.raw`\{==\s*(?:\{[^{}]*\}@@)?\s*REF\s*==\}\{>>${CRITIC_TEXT}<<\}`, "g"),
    (_m, source) => citationRef(criticText(source))],
  [new RegExp(String.raw`\{--${CRITIC_TEXT}--\}${CRITIC_COMMENT}`, "g"), () => ""],
  [new RegExp(String.raw`\{\+\+${CRITIC_TEXT}\+\+\}${CRITIC_COMMENT}`, "g"), (_m, text) => criticText(text)],
  [new RegExp(String.raw`\{~~${CRITIC_TEXT}~>${CRITIC_TEXT}~~\}${CRITIC_COMMENT}`, "g"),
    (_m, _old, text, comment) => criticText(text) + sideNote(comment)],
  [new RegExp(String.raw`\{==${CRITIC_TEXT}==\}${CRITIC_COMMENT}`, "g"),
    (_m, text, comment) => criticText(text) + sideNote(comment)],
  [new RegExp(String.raw`\{>>${CRITIC_TEXT}<<\}`, "g"), () => ""]
];

function criticText(text = "") {
  return text.replace(CRITIC_METADATA_RE, "");
}

// Numbered in postProcessMarkdown; the note's own text is rendered as
// inline Markdown there.
function sideNote(comment) {
  const text = criticText(comment).trim();
  if (!text) return "";
  return `<sup class="comment-marker"><span class="comment-number"></span><span class="comment-margin-marker" data-comment="${escapeHtml(text)}"></span></sup>`;
}

// Fenced code blocks and inline code spans, which stay as written.
const CODE_RE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$|(`+)[^`\n][\s\S]*?\2/gm;

function expandCriticMarkup(markdown) {
  const code = [];
  let text = markdown.replace(CODE_RE, m => `${code.push(m) - 1}`);
  for (const [re, replace] of CRITIC_RULES) text = text.replace(re, replace);
  return text.replace(/(\d+)/g, (_, i) => code[i]);
}

// --- Vault links: Obsidian embeds, wikilinks, attachments ---------------
//
// ![[image.png]] (and ![[image.png|300]], ![[image.png|caption]]) embeds
// an attachment from anywhere in the vault; [[Note]], [[Note|text]],
// [[Note#Heading]] link to another note (![[Note]] too). Found by name
// the way Obsidian does — exact path first, else by file name — but only
// when a page is served (resolveVaultLinks), so links follow notes that
// are renamed, added or unpublished. A link to a note that isn't
// published stays plain text. Code stays as written.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|tiff?)$/i;

function expandVaultLinks(markdown) {
  const code = [];
  let text = markdown.replace(CODE_RE, m => `${code.push(m) - 1}`);
  text = text.replace(/(!?)\[\[([^\[\]\n]+?)\]\]/g, (_m, bang, inner) => {
    const [target, option = ""] = inner.split("|").map(part => part.trim());
    if (!target) return _m;
    if (bang && IMAGE_EXT_RE.test(target)) {
      // "|300" or "|300x200" is a size; anything else is alt text.
      const alt = option && !/^\d+(x\d+)?$/.test(option) ? option : path.posix.basename(target);
      // As a Markdown image, so it becomes a figure (with a caption)
      // like any other; its vault-asset: address is resolved below.
      return `![${alt.replace(/[\[\]\\]/g, "\\$&")}](vault-asset:${encodeURIComponent(`name:${target}`)})`;
    }
    const note = target.replace(/[#^].*$/, "").trim();
    const label = option || target.replace(/\.md$/i, "").replace(/#\^?/, " › ");
    return `<a data-wikilink="${encodeURIComponent(`name:${note}`)}" class="wikilink">${escapeHtml(label)}</a>`;
  });
  return text.replace(/(\d+)/g, (_, i) => code[i]);
}

// A relative link/src in note `noteId` as a vault path, or null for
// anything else (a URL, an absolute path, an anchor, data:).
function vaultPath(noteId, ref) {
  if (!ref || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(ref)) return null;
  let decoded = ref;
  try { decoded = decodeURIComponent(ref); } catch { /* keep as written */ }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(noteId || "."), decoded));
  return joined.startsWith("../") ? null : joined.replace(/^\.\//, "");
}

// Published notes and every attachment, refreshed on each listing.
const vault = {
  notesByPath: new Map(),
  notesByName: new Map(),
  assetsByPath: new Map(),
  assetsByName: new Map()
};

function updateVaultIndex(entries, assets) {
  vault.notesByPath = new Map(entries.map(e => [e.id.toLowerCase(), e]));
  vault.notesByName = new Map();
  for (const e of [...entries].sort((a, b) => a.id.length - b.id.length)) {
    const name = path.posix.basename(e.id).replace(/\.md$/i, "").toLowerCase();
    if (!vault.notesByName.has(name)) vault.notesByName.set(name, e);
  }
  vault.assetsByPath = new Map(assets.map(p => [p.toLowerCase(), p]));
  vault.assetsByName = new Map();
  for (const p of [...assets].sort((a, b) => a.length - b.length)) {
    const name = path.posix.basename(p).toLowerCase();
    if (!vault.assetsByName.has(name)) vault.assetsByName.set(name, p);
  }
}

// "name:x" (from ![[x]]/[[x]]) or "path:x" (a relative link) -> a match.
function lookUp(key, byPath, byName, ext = "") {
  const [kind, ...rest] = key.split(":");
  const ref = rest.join(":").replace(/^\/+/, "").toLowerCase();
  if (!ref) return null;
  const withExt = ext && !ref.endsWith(ext) ? ref + ext : ref;
  if (byPath.has(withExt)) return byPath.get(withExt);
  if (kind === "path") return null;
  return byName.get(path.posix.basename(withExt).replace(ext ? new RegExp(`\\${ext}$`) : /$^/, "")) || null;
}

// Attachments a served page refers to, by opaque id -> vault path (the
// /asset/:id route only ever serves these).
const assetIds = new Map();

function assetUrl(p) {
  const id = crypto.createHash("sha256").update(p).digest("hex").slice(0, 20);
  assetIds.set(id, p);
  return `/asset/${id}`;
}

function resolveVaultLinks(html) {
  return html
    .replace(/<img ([^>]*?)data-asset="([^"]*)"([^>]*)>/g, (match, before, key, after) => {
      const p = lookUp(decodeURIComponent(key), vault.assetsByPath, vault.assetsByName);
      return p ? `<img src="${assetUrl(p)}" ${before}${after}>` : match;
    })
    .replace(/<a ([^>]*?)data-wikilink="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (_match, _b, key, _a, inner) => {
      const entry = lookUp(decodeURIComponent(key), vault.notesByPath, vault.notesByName, ".md");
      return entry
        ? `<a class="wikilink" href="/entry/${entry.slug}">${inner}</a>`
        : `<span class="wikilink wikilink--missing">${inner}</span>`;
    });
}

// A reference's stored URL sometimes turns out to be a whole markdown
// link itself (e.g. a browser "copy as markdown link" pasted in whole
// as the URL half of a %%REF...%% token or [label](url)) — split that
// back into its title and real URL so the References list can show
// "Title, https://..." instead of literal brackets/parens.
const MARKDOWN_LINK_RE = /^\[(.+)\]\((\S+)\)$/s;

function splitEmbeddedMarkdownLink(href) {
  const match = MARKDOWN_LINK_RE.exec(href.trim());
  if (!match) return { label: null, url: href };
  return { label: match[1].trim(), url: match[2].trim() };
}

function postProcessMarkdown(renderedHtml, noteId = "") {
  // Wrap rendered fragment so Cheerio can safely transform it.
  const $ = cheerio.load(`<main id="root">${renderedHtml}</main>`, null, false);
  const root = $("#root");

  // First H1 becomes the publication title and is removed from body flow.
  const firstH1 = root.find("h1").first();
  const title = firstH1.length ? toTitleCase(plainText($, firstH1).trim()) : "Untitled";
  if (firstH1.length) firstH1.remove();

  // The private heading (config.privateHeading, any letter case) marks
  // an end-of-note scratchpad — it and everything after it are dropped
  // here, before figures/references/excerpt are computed, so none of it
  // is ever rendered, numbered, or previewed.
  const privateHeading = (config.privateHeading || "").trim().toLowerCase();
  const noteHeading = privateHeading
    ? root.find("h2").filter((_, h) => $(h).text().trim().toLowerCase() === privateHeading).first()
    : $();
  if (noteHeading.length) {
    noteHeading.nextAll().remove();
    noteHeading.remove();
  }

  // Every remaining heading in the body (h2–h6 — h1 was already pulled
  // out above) gets the same Title Case treatment.
  root.find("h2, h3, h4, h5, h6").each((_, h) => {
    const $h = $(h);
    if (!$h.children().length) {
      $h.text(toTitleCase($h.text()));
      return;
    }
    // With markup in it (math, a side note, emphasis): only its words —
    // an equation counts as a word, so "with" before one stays
    // lowercase; a side note is left alone.
    const pieces = [];
    const walk = node => {
      for (const child of node.children || []) {
        if (child.type === "text") pieces.push(child);
        else if (child.type === "tag" && child.name === "math") pieces.push(null);
        else if (child.type === "tag" && !$(child).hasClass("comment-marker")) walk(child);
      }
    };
    walk(h);
    const hasWords = piece => piece === null || /\S/.test(piece.data);
    pieces.forEach((piece, i) => {
      if (!piece) return;
      piece.data = toTitleCase(piece.data, {
        first: !pieces.slice(0, i).some(hasWords),
        last: !pieces.slice(i + 1).some(hasWords)
      });
    });
  });

  // Section numbers: 1, 1.1, 1.1.1 ..., the top level being the
  // largest heading level the entry uses. An "Abstract" heading that
  // opens the entry isn't a numbered section.
  const $sections = root.find("h2, h3, h4, h5, h6").filter((i, h) =>
    !(i === 0 && $(h).clone().find(".comment-marker").remove().end().text().trim().toLowerCase() === "abstract"));
  const levelOf = h => Number(h.name.slice(1));
  const topLevel = Math.min(...$sections.toArray().map(levelOf));
  const counters = [];
  $sections.each((_, h) => {
    const depth = levelOf(h) - topLevel;
    counters[depth] = (counters[depth] || 0) + 1;
    counters.length = depth + 1;
    const number = Array.from(counters, n => n || 0).join(".").replace(/^(0\.)+/, "");
    $(h).prepend(`<span class="heading-number">${number}</span>`);
  });

  // Every raw-GitHub <img src> becomes an opaque /img/<id> proxy URL
  // here, before anything else touches images (figure-wrapping, teaser
  // promotion, addManagedImageSizes) — so every downstream use
  // (body, teaser, waterfall thumbnails) only ever sees the proxy path,
  // never the real GitHub URL. See "Private image proxy" above.
  root.find("img[src]").each((_, img) => {
    const $img = $(img);
    const src = $img.attr("src");
    if (src && isGithubRawUrl(src)) {
      $img.attr("src", registerImageProxy(src));
    }
  });

  // Images and note links by relative path (![](attachments/a.png),
  // [text](other%20note.md)) point into the vault: marked here, resolved
  // when the page is served (see resolveVaultLinks).
  root.find("img[src]").each((_, img) => {
    const $img = $(img);
    const src = $img.attr("src");
    if (src.startsWith("vault-asset:")) {
      $img.removeAttr("src").attr("data-asset", src.slice("vault-asset:".length));
      return;
    }
    const target = vaultPath(noteId, src);
    if (target) $img.removeAttr("src").attr("data-asset", encodeURIComponent(`path:${target}`));
  });
  root.find("a[href]").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    const target = vaultPath(noteId, href.replace(/#.*$/, ""));
    if (target && /\.md$/i.test(target)) {
      $a.removeAttr("href").attr("data-wikilink", encodeURIComponent(`path:${target}`)).addClass("wikilink");
    }
  });

  // Turn standalone Markdown images into figures. A "//teaser" marker
  // promotes one image under the metadata; a "//span" marker makes the
  // figure span the columns at the top of whichever page it lands on
  // (see placeSpanFigures in static/reader.js). Either form (marker,
  // and/or a "(caption)") can be soft-wrapped into the image's own
  // paragraph, or written as its own separate paragraph(s) (blank line
  // before):
  //
  // ![alt](https://...)      ![alt](https://...)
  // //teaser
  // (some caption)     or    //teaser
  //
  //                          (some caption)
  const FIGURE_MARKER_RE = /^\/\/\s*(teaser|span)\s*(?:\((.+)\))?$/is;

  function parseFigureMarker(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const markerMatch = FIGURE_MARKER_RE.exec(trimmed);
    if (markerMatch) {
      const kind = markerMatch[1].toLowerCase();
      return {
        isTeaser: kind === "teaser",
        isSpan: kind === "span",
        caption: markerMatch[2] ? markerMatch[2].trim() : null
      };
    }
    const captionMatch = /^\((.+)\)$/s.exec(trimmed);
    if (captionMatch) {
      return { isTeaser: false, isSpan: false, caption: captionMatch[1].trim() };
    }
    return null;
  }

  // parseFigureMarker above matches against a node's plain .text(),
  // which flattens any inline formatting markdown-it already rendered
  // inside the caption (e.g. "**bold**" is <strong>bold</strong> in the
  // HTML by this point) down to plain text — so a bold marker in a
  // caption would otherwise just vanish. The "//teaser"/"//span" marker and the
  // wrapping parentheses are always plain literal characters even when
  // the caption itself has inline HTML in it, so the exact same two
  // regexes apply just as safely to the node's raw .html() — this
  // extracts the caption as HTML instead, preserving that formatting.
  function captionHtmlFromMarker(html, marker) {
    const trimmed = (html || "").trim();
    if (marker.isTeaser || marker.isSpan) {
      const m = FIGURE_MARKER_RE.exec(trimmed);
      return m && m[2] ? m[2].trim() : escapeHtml(marker.caption || "");
    }
    const m = /^\((.+)\)$/s.exec(trimmed);
    return m ? m[1].trim() : escapeHtml(marker.caption || "");
  }

  // Pass 1: wrap every standalone image into a figure, picking up any
  // marker/caption soft-wrapped into its own paragraph. Teaser
  // promotion itself happens in pass 2, so a bare "//teaser" here can
  // still pick up a caption from a separate following paragraph.
  root.find("p").each((_, p) => {
    const $p = $(p);
    const contents = $p.contents().toArray();
    const imgNodes = contents.filter(node => node.type === "tag" && node.name === "img");

    if (imgNodes.length !== 1) return;

    const img = $(imgNodes[0]);
    const trailingNodes = contents.filter(node => node !== imgNodes[0]);
    const trailingText = trailingNodes.map(node => $(node).text()).join(" ").trim();

    let marker = { isTeaser: false, isSpan: false, caption: null };
    if (trailingText) {
      const parsed = parseFigureMarker(trailingText);
      if (!parsed) return;
      marker = parsed;
    }

    img.attr("loading", "lazy");
    img.attr("decoding", "async");

    const figure = $("<figure class='md-figure'></figure>");
    figure.append(img.clone());
    if (marker.isTeaser) figure.attr("data-teaser-pending", "1");
    if (marker.isSpan) figure.attr("data-span-pending", "1");
    if (marker.caption) {
      const trailingHtml = trailingNodes.map(node => $.html(node)).join(" ").trim();
      const captionHtml = captionHtmlFromMarker(trailingHtml, marker);
      figure.append(`<figcaption data-figcaption="1">${captionHtml}</figcaption>`);
    }

    $p.replaceWith(figure);
  });

  // Pass 2: pick up a marker/caption from following sibling
  // paragraph(s) written on their own line, then finalize teaser
  // promotion (first "//teaser" found wins). Left in place in `root`
  // for now — pulled out after captions are numbered, below.
  root.find("figure.md-figure").each((_, figure) => {
    const $figure = $(figure);
    let isTeaser = $figure.attr("data-teaser-pending") === "1";
    let isSpan = $figure.attr("data-span-pending") === "1";

    if (!isTeaser && !isSpan && !$figure.find("figcaption").length) {
      const next = $figure.next();
      if (next.length && next.is("p")) {
        const parsed = parseFigureMarker(next.text());
        if (parsed) {
          const nextHtml = next.html();
          next.remove();
          isTeaser = parsed.isTeaser;
          isSpan = parsed.isSpan;
          if (parsed.caption) {
            const captionHtml = captionHtmlFromMarker(nextHtml, parsed);
            $figure.append(`<figcaption data-figcaption="1">${captionHtml}</figcaption>`);
          }
        }
      }
    }

    // A bare "//teaser" or "//span" (no caption yet) may still have its
    // caption on the very next paragraph after it.
    if ((isTeaser || isSpan) && !$figure.find("figcaption").length) {
      const next = $figure.next();
      if (next.length && next.is("p")) {
        const capMatch = /^\((.+)\)$/s.exec(next.text().trim());
        if (capMatch) {
          const htmlMatch = /^\((.+)\)$/s.exec((next.html() || "").trim());
          const captionHtml = htmlMatch ? htmlMatch[1].trim() : escapeHtml(capMatch[1].trim());
          next.remove();
          $figure.append(`<figcaption data-figcaption="1">${captionHtml}</figcaption>`);
        }
      }
    }

    $figure.removeAttr("data-teaser-pending data-span-pending");
    if (isTeaser) $figure.addClass("is-teaser-candidate");
    if (isSpan) $figure.addClass("span-figure");
    // Every figure is numbered, caption or not.
    if (!$figure.find("figcaption").length) $figure.append(`<figcaption data-figcaption="1"></figcaption>`);
  });

  // Tables take a caption and a "//span" marker the same ways figures
  // do: "(caption)", "//span" or "//span (caption)" as the next
  // paragraph, or written right under the table — where Markdown parses
  // the line as one more row of its own (first cell only). Every table
  // is wrapped in a figure and numbered, caption or not; a "//span" one
  // goes to the top of the page it lands on (see liftSpanFigure in
  // static/reader.js).
  root.find("table").each((_, table) => {
    const $table = $(table);
    let marker = null;
    let markerHtml = "";
    const $lastRow = $table.find("tbody tr").last();
    if ($lastRow.length && $lastRow.siblings().length) {
      const $cells = $lastRow.children("td");
      const parsed = parseFigureMarker($cells.first().text());
      const restEmpty = $cells.slice(1).toArray().every(cell => !$(cell).text().trim());
      if (parsed && !parsed.isTeaser && restEmpty) {
        marker = parsed;
        markerHtml = $cells.first().html();
        $lastRow.remove();
      }
    }
    if (!marker) {
      const $next = $table.next();
      const parsed = $next.is("p") ? parseFigureMarker($next.text()) : null;
      if (parsed && !parsed.isTeaser) {
        marker = parsed;
        markerHtml = $next.html();
        $next.remove();
      }
    }

    const $figure = $(`<figure class="md-table${marker && marker.isSpan ? " span-figure span-table" : ""}"></figure>`);
    $table.before($figure);
    $figure.append($table);
    const captionHtml = marker && marker.caption ? captionHtmlFromMarker(markerHtml, marker) : "";
    $figure.append(`<figcaption data-tablecaption="1">${captionHtml}</figcaption>`);
  });

  let tableNumber = 0;
  root.find("figcaption[data-tablecaption]").each((_, caption) => {
    tableNumber += 1;
    const $caption = $(caption);
    const inner = ($caption.html() || "").trim();
    $caption.html(inner ? `Table ${tableNumber}. ${inner}` : `Table ${tableNumber}.`);
    $caption.removeAttr("data-tablecaption");
  });

  // Number every figure caption in final document order — done before
  // the teaser is pulled out below, so its caption (if any) is
  // numbered like any other.
  let figureNumber = 0;
  root.find("figcaption[data-figcaption]").each((_, caption) => {
    figureNumber += 1;
    const $caption = $(caption);
    // Prepended as a string, not re-set via .text() — the caption's
    // own inline HTML (its <strong>/<em> etc., already inside
    // $caption from captionHtmlFromMarker above) must stay exactly as
    // parsed, not get flattened back to plain text here. "Figure N. "
    // itself has no special characters, so parsing it as HTML is safe.
    const inner = ($caption.html() || "").trim();
    $caption.html(inner ? `Figure ${figureNumber}. ${inner}` : `Figure ${figureNumber}.`);
    $caption.removeAttr("data-figcaption");
  });

  // First "//teaser" candidate (in document order) is promoted under
  // the metadata; the rest just stay regular in-article figures.
  let teaserHtml = "";
  const $teaser = root.find("figure.is-teaser-candidate").first();
  if ($teaser.length) {
    $teaser.removeClass("md-figure is-teaser-candidate").addClass("teaser-figure");
    $teaser.find("img").removeAttr("loading");
    teaserHtml = $.html($teaser);
    $teaser.remove();
  }
  root.find(".is-teaser-candidate").removeClass("is-teaser-candidate");

  // Publication-style references:
  // [label](url) -> label [N]
  // %%REF{...}@@url<<}%% -> bare [N] (no label), sharing the same
  // numbering/dedup-by-URL as ordinary links.
  // The References list itself is returned separately — where it sits
  // in the page flow depends on the view (see renderEntryBody).
  const refs = [];
  const byUrl = new Map();

  root.find("a[href]").each((_, anchor) => {
    const $a = $(anchor);
    const href = $a.attr("href");

    if (!href || href.startsWith("#")) return;

    let ref = byUrl.get(href);
    if (!ref) {
      ref = { number: refs.length + 1, href };
      refs.push(ref);
      byUrl.set(href, ref);
    }

    if ($a.hasClass("citation-ref")) {
      $a.replaceWith(
        `<a class="citation-marker" href="#ref-${ref.number}" aria-label="Reference ${ref.number}">${ref.number}</a>`
      );
      return;
    }

    const labelHtml = $a.html() || escapeHtml(href);
    $a.replaceWith(
      `<span class="link-label">${labelHtml}</span>` +
      `<a class="reference-marker" href="#ref-${ref.number}" aria-label="Reference ${ref.number}">[${ref.number}]</a>`
    );
  });

  // Bare citation markers written back-to-back — e.g.
  // "(%%REF..%%, %%REF..%%)" — collapse into one bracketed,
  // comma-separated group: [1, 2] instead of [1][2]. A lone marker
  // still gets its own brackets, just like an ordinary link reference.
  root.find("a.citation-marker").each((_, marker) => {
    const $marker = $(marker);
    if (!$marker.parent().length) return; // already absorbed into an earlier group

    // Cheerio's `.next()` skips straight to the next element, ignoring
    // text nodes in between — walk the raw sibling pointer instead so a
    // ", " separator (or its absence) can actually be inspected.
    const group = [$marker];
    let node = marker.next;
    while (node) {
      if (node.type === "tag" && node.name === "a" && $(node).hasClass("citation-marker")) {
        group.push($(node));
        node = node.next;
        continue;
      }
      if (node.type === "text" && /^\s*,\s*$/.test(node.data)) {
        const after = node.next;
        if (after && after.type === "tag" && after.name === "a" && $(after).hasClass("citation-marker")) {
          group.push($(after));
          $(node).remove();
          node = after.next;
          continue;
        }
      }
      break;
    }

    // A "(" immediately before the group and a ")" immediately after it
    // — e.g. "spatially(%%REF..%%, %%REF..%%)" — are just the author's
    // hand-typed wrapper around the token(s) and read as noise once the
    // token renders as "[N, M]" on its own; strip them.
    const prev = marker.prev;
    if (prev && prev.type === "text" && /\($/.test(prev.data)) {
      prev.data = prev.data.replace(/\($/, "");
    }
    if (node && node.type === "text" && /^\)/.test(node.data)) {
      node.data = node.data.replace(/^\)/, "");
    }

    const inner = group
      .map($m => `<a class="reference-marker citation-marker" href="${$m.attr("href")}" aria-label="${$m.attr("aria-label")}">${$m.text()}</a>`)
      .join(", ");

    $marker.replaceWith(`<span class="reference-marker-group">[${inner}]</span>`);
    group.slice(1).forEach($m => $m.remove());
  });

  let referencesHtml = "";
  if (refs.length) {
    const items = refs.map(ref => {
      // A pasted URL sometimes turns out to BE a whole markdown link
      // itself — e.g. "[GitHub - foo/bar: ...](https://github.com/foo/bar)"
      // copied in whole as the URL half of a %%REF...%% token or
      // [label](url) — which otherwise renders here as literal
      // brackets/parens and points nowhere useful. Unwrap it into
      // "Title, https://..." instead, linking to the real URL.
      const { label, url } = splitEmbeddedMarkdownLink(ref.href);
      const display = label ? `${escapeHtml(label)}, ${escapeHtml(url)}` : escapeHtml(url);
      return `
      <li id="ref-${ref.number}">
        <span class="reference-number">[${ref.number}]</span>
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${display}</a>
      </li>
    `;
    }).join("");

    referencesHtml = `<section class="references"><ol class="reference-list">${items}</ol></section>`;
  }

  // Side notes (CriticMarkup comments, see expandCriticMarkup): numbered
  // independently from References, in document order — each gets a
  // small superscript in the flowing text, plus its own comment text
  // rendered directly (small, no hover needed) in the page's outer
  // margin, level with its anchor (see placeMarginNotes in
  // static/reader.js). No bottom list.
  let commentNumber = 0;
  root.find("sup.comment-marker").each((_, marker) => {
    commentNumber += 1;
    const $marker = $(marker);
    $marker.find(".comment-number").text(String(commentNumber));
    const $margin = $marker.find(".comment-margin-marker");
    const rawComment = $margin.attr("data-comment") || "";
    // Use renderInline so inline markdown in the comment text (bold, italic,
    // book-title marks like 「**_text_**」) renders as HTML rather than
    // appearing as literal syntax.
    $margin.html(`${commentNumber}. ${md.renderInline(rawComment)}`);
  });

  // Drop cap: if the body opens directly with a paragraph (not a heading
  // or figure), mark it so CSS can enlarge and float the first letter.
  // Only the very first child matters — a heading first means "no drop cap."
  const firstChild = root.children().first();
  if (firstChild.is("p") && !firstChild.find("img").length) {
    firstChild.addClass("drop-cap");
  }

  // Plain-text excerpt for card previews on the list page: the first
  // remaining text paragraph (image-only paragraphs became figures above
  // and don't count).
  const firstParagraph = root.find("p").first();
  const excerpt = firstParagraph.length ? plainText($, firstParagraph).trim() : "";

  return {
    title,
    teaserHtml,
    excerpt,
    bodyHtml: root.html() || "",
    referencesHtml
  };
}

// Cache keyed by file id (path), invalidated by version (mtime locally,
// blob sha on GitHub) and, for local files, by the chokidar watcher
// too. Keyed by id rather than slug because the slug itself can depend
// on frontmatter we haven't read yet (see below).
const entryCache = new Map();

async function loadEntry({ id, version }) {
  const cached = entryCache.get(id);
  if (cached && cached.version === version) {
    return cached;
  }

  const raw = await entrySource.readFile(id);
  const { data, content } = matter(raw);
  const rendered = md.render(expandVaultLinks(expandCriticMarkup(expandInlineRefTokens(expandBookTitles(content)))));
  const { title, teaserHtml, excerpt, bodyHtml, referencesHtml } = postProcessMarkdown(rendered, id);

  // Renaming a file or moving it to a different folder changes its path
  // — and hashing the path (the fallback below) would break any
  // /entry/<hash> link already shared for it. An id field
  // (config.publish.idField), once written in frontmatter, survives
  // renames/moves, so it's used instead whenever present; it's hashed
  // like the path would be, so the URL stays just as opaque either way.
  const publishId = getPublishId(data[config.publish.idField]);
  const slug = slugify(publishId || id);
  const published = config.publish.require
    ? getPublishId(data[config.publish.require]) !== null
    : data.publish !== false && String(data.publish).toLowerCase() !== "false";

  const entry = {
    slug,
    id,
    version,
    title: title !== "Untitled" ? title : toTitleCase(path.basename(id, path.extname(id))),
    teaserHtml,
    excerpt,
    bodyHtml,
    referencesHtml,
    published,
    created: normalizeDate(data.created),
    updated: normalizeDate(data.updated),
    tags: collectionsOf(id, data, content)
  };

  entryCache.set(id, entry);
  return entry;
}

function sortByDateDesc(entries, field) {
  const other = field === "created" ? "updated" : "created";
  return [...entries].sort((a, b) => {
    const aKey = a[field] || a[other] || "";
    const bKey = b[field] || b[other] || "";
    if (aKey && bKey) return bKey.localeCompare(aKey);
    if (aKey) return -1;
    if (bKey) return 1;
    return a.id.localeCompare(b.id);
  });
}

// The collections a note belongs to (config.collections): its top-level
// folder, its tag fields, its inline #tags.
function collectionsOf(id, data, content) {
  const names = [];
  const rules = config.collections;
  if (rules.folders && id.includes("/")) names.push(id.split("/")[0]);
  for (const field of rules.tagFields || []) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    const list = Array.isArray(value) ? value : String(value).split(",");
    names.push(...list.map(String));
  }
  if (rules.inlineTags) {
    const text = content.replace(CODE_RE, " ");
    // Obsidian's rule: after a space or line start; letters, digits,
    // "_", "-", "/"; not only digits.
    for (const m of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_\/-]+)/gu)) {
      if (!/^\d+$/.test(m[1])) names.push(m[1]);
    }
  }
  return [...new Set(names.map(n => n.trim().replace(/^#/, "")).filter(Boolean))];
}

async function listEntries() {
  const { notes, assets } = await entrySource.listAll();
  const entries = (await Promise.all(notes.map(loadEntry))).filter(entry => entry.published);
  updateVaultIndex(entries, assets);
  return entries;
}

// `reader`: /entry and /contents — bodyHtml carries the entry flow in
// <template id="book-source"> plus an empty #book (see renderBook),
// and static/reader.js cuts the flow into pages and shows them.
function pageShell({ title, bodyHtml, bodyClass, reader = false }) {
  return `<!doctype html>
<html lang="en"${reader ? ' class="reader reader-loading"' : ""}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="${reader
    ? "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
    : "width=device-width, initial-scale=1"}" />
  <title>${escapeHtml(title)}</title>
  ${config.site.author ? `<meta name="author" content="${escapeHtml(config.site.author)}" />` : ""}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+SC:wght@300;400;500;600;700&family=Libre+Baskerville:ital,wght@0,400..700;1,400..700&family=Source+Serif+4:ital,opsz,wght@0,8..60,200..900;1,8..60,200..900&display=swap" rel="stylesheet" />
${adobeFontsHtml()}
${bodyHtml.includes("<math") ? `<link rel="stylesheet" href="${MATH_CSS}" crossorigin />
  ` : ""}<link rel="stylesheet" href="/static/journal.css" />
  <link rel="stylesheet" href="/static/print.css" media="print" />
</head>
<body class="${escapeHtml(bodyClass)}">
  ${bodyHtml}
  ${reader ? `<div id="reader-loader" aria-hidden="true"></div>` : ""}

  <script>
    ${reader ? "" : `
    // Remote images that fail show a local placeholder instead of a
    // broken-image icon (the reader does the same for its pages).
    document.querySelectorAll("img").forEach((img) => {
      img.addEventListener("error", () => {
        const placeholder = document.createElement("div");
        placeholder.className = "image-placeholder";
        placeholder.textContent = img.alt || "image unavailable";
        img.replaceWith(placeholder);
      }, { once: true });
    });
    `}
    ${entrySource.liveReload ? `
    // Live reload when Markdown/CSS in the watched folder changes.
    const events = new EventSource("/events");
    events.addEventListener("reload", () => location.reload());
    ` : ""}
  </script>
  ${reader ? `<script src="/static/reader.js"></script>` : ""}
</body>
</html>`;
}

// An Adobe Fonts (Typekit) web project (config.fonts.adobeKit), e.g.
// for a CJK serif: a large family, so its CDN connection and loader
// script start as early as possible — the preload lets the browser
// fetch the loader while it's still parsing <head>, and the inline
// loader then reuses that request.
function adobeFontsHtml() {
  const kit = config.fonts.adobeKit;
  if (!kit) return "";
  const id = JSON.stringify(String(kit));
  return `<link rel="preconnect" href="https://use.typekit.net" />
  <link rel="preconnect" href="https://p.typekit.net" crossorigin />
  <link rel="preload" href="https://use.typekit.net/${escapeHtml(kit)}.js" as="script" />
  <script>
    (function(d) {
      var config = {
        kitId: ${id},
        scriptTimeout: 3000,
        async: true
      },
      h=d.documentElement,t=setTimeout(function(){h.className=h.className.replace(/\\bwf-loading\\b/g,"")+" wf-inactive";},config.scriptTimeout),tk=d.createElement("script"),f=false,s=d.getElementsByTagName("script")[0],a;h.className+=" wf-loading";tk.src='https://use.typekit.net/'+config.kitId+'.js';tk.async=true;tk.onload=tk.onreadystatechange=function(){a=this.readyState;if(f||a&&a!="complete"&&a!="loaded")return;f=true;clearTimeout(t);try{Typekit.load(config)}catch(e){}};s.parentNode.insertBefore(tk,s)
    })(document);
  </script>`;
}

// The reader's input: the entry flow (articles) kept inert in a
// <template>, and the empty mount the pages go into.
async function renderBook(flowHtml) {
  return `<template id="book-source">${await addManagedImageSizes(flowHtml)}</template>
    <div id="book" class="book"></div>`;
}

function truncate(text, max = 160) {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

function sortByCreatedDate(entries) {
  return [...entries].sort((a, b) => {
    const aCreated = a.created || "";
    const bCreated = b.created || "";
    if (aCreated && bCreated) return bCreated.localeCompare(aCreated);
    if (aCreated) return -1;
    if (bCreated) return 1;
    return a.id.localeCompare(b.id);
  });
}

function renderWaterfallCards(entries) {
  return sortByCreatedDate(entries).map(entry => {
    const date = entry.created || "";
    const titleLang = /[\u3400-\u9fff]/u.test(entry.title) ? "zh-CN" : "en";
    const excerptLang = /[\u3400-\u9fff]/u.test(entry.excerpt || "") ? "zh-CN" : "en";

    // Cards with a teaser image show the image plus title/date; text-only
    // entries show a truncated first-paragraph preview instead of a thumb.
    const inner = `
      ${entry.teaserHtml ? `<div class="wf-thumb">${entry.teaserHtml}</div>` : ""}
      <div class="wf-card-body">
        <h2 lang="${titleLang}" class="wf-card-title">${escapeHtml(entry.title)}</h2>
        ${!entry.teaserHtml && entry.excerpt ? `<p lang="${excerptLang}" class="wf-card-excerpt">${escapeHtml(truncate(entry.excerpt))}</p>` : ""}
        ${date ? `<div class="wf-card-date">${escapeHtml(date)}</div>` : ""}
      </div>
    `;

    return `
      <a id="card-${entry.slug}" class="wf-card ${entry.teaserHtml ? "wf-card-image" : "wf-card-text"}" href="/entry/${entry.slug}">
        ${inner}
      </a>
    `;
  }).join("");
}

function renderEmptyState(entries) {
  return entries.length
    ? ""
    : `<p class="index-empty">No published notes yet${config.publish.require
      ? `. Add <code>${escapeHtml(config.publish.require)}: ...</code> to a note's frontmatter to publish it`
      : ""} (source: ${escapeHtml(entrySource.label)}).</p>`;
}

// Home page ("/"): title + a plain waterfall feed, no TOC. Space opens
// the tag-picker dialog; choosing a tag loads /contents/<tag>.
function renderHomePage(entries) {
  // Collect unique tags in sorted order for the picker.
  const allTags = [...new Set(entries.flatMap(e => e.tags))].sort();

  // Show the collection picker only when there are collections to choose.
  const needsPicker = allTags.length > 0;

  const dialogHtml = needsPicker ? `
  <dialog class="tag-dialog" id="tag-dialog" tabindex="-1">
    <p class="tag-dialog-prompt">choose a collection</p>
    <ul class="tag-dialog-list" id="tag-list"></ul>
  </dialog>
  <script>
  (function() {
    var TAGS = ${JSON.stringify(allTags)};
    var BASE = ${JSON.stringify(CONTENTS_PATH)};
    var dialog = document.getElementById('tag-dialog');
    var list = document.getElementById('tag-list');
    TAGS.forEach(function(tag) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = BASE + '/' + encodeURIComponent(tag);
      a.className = 'tag-dialog-item';
      a.textContent = tag;
      li.appendChild(a);
      list.appendChild(li);
    });
    function openDialog() {
      dialog.showModal();
      dialog.focus({ preventScroll: true });
    }
    dialog.addEventListener('close', function() {
      requestAnimationFrame(function() {
        if (document.activeElement && document.activeElement.blur) {
          document.activeElement.blur();
        }
      });
    });
    document.addEventListener('keydown', function(e) {
      if ((e.code === 'Space' || e.key === ' ') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var active = document.activeElement;
        var tag = active && active.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (active && active.isContentEditable)) return;
        e.preventDefault();
        if (dialog.open) dialog.close();
        else openDialog();
      }
    });
    dialog.addEventListener('click', function(e) {
      var r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        dialog.close();
      }
    });
  })();
  </script>` : "";

  const bodyHtml = `
  <div class="journal-home">
    <header class="index-header index-header-home">
      <div class="index-author">${escapeHtml(config.site.title)}</div>
    </header>

    <div class="journal-waterfall">
      ${renderEmptyState(entries)}
      ${renderWaterfallCards(entries)}
    </div>
  </div>
  ${dialogHtml}`;

  return pageShell({ title: config.site.browserTitle, bodyHtml, bodyClass: "page-index" });
}

// Contents view ("/contents" or "/contents/:tag"): the reading mode.
// When `tag` is provided, only entries in that collection are shown and
// the TOC panel gets a small label. Otherwise all entries are shown.
// The collection's layout (config.layouts) is "paper" or "zine".
async function renderContentsPage(entries, tag) {
  const isZine = layoutOf(config, tag) === "zine";

  const filtered = tag ? entries.filter(e => e.tags.includes(tag)) : entries;
  // Oldest first, newest last (a journal reads front-to-back
  // chronologically) — but the reader opens on the newest entry (see
  // latestSlug below), so it lands there first and pages backward
  // through history, rather than starting at day one.
  const orderedEntries = isZine
    ? [...filtered].sort((a, b) => (a.created || "").localeCompare(b.created || ""))
    : [...sortByDateDesc(filtered, "created")].reverse();

  const toc = orderedEntries.map(entry => {
    const date = entry.created || entry.updated || "";
    return `
      <li class="toc-item">
        <button type="button" data-jump="${escapeHtml(entry.slug)}">
          ${date ? `<span class="toc-date">${escapeHtml(date)}</span>` : ""}
          <span class="toc-title">${escapeHtml(entry.title)}</span>
        </button>
      </li>
    `;
  }).join("");

  const articleClass = isZine ? "paper zine-entry" : "paper";
  const hideByline = entry => config.byline.hideOnDateFilenames && isDateFilename(entry.id);
  const articles = orderedEntries.map(entry => `
    <article class="${articleClass}" id="card-${entry.slug}">
      ${renderEntryBody(entry, { mode: "plain", showByline: isZine || !hideByline(entry), zine: isZine })}
    </article>
  `).join("");

  // Oldest-to-newest order (above) means the last entry here is the
  // newest — the reader opens on the page where it starts (not the
  // last page of the whole book, which for a multi-page latest entry
  // would land somewhere past its title).
  const latestSlug = orderedEntries.length ? orderedEntries[orderedEntries.length - 1].slug : "";

  const bodyHtml = `
  ${orderedEntries.length ? `
  <dialog class="toc-dialog" id="toc-dialog">
    ${tag ? `<div class="toc-tag-label">${escapeHtml(tag)}</div>` : ""}
    <ul class="toc-list">${toc}</ul>
  </dialog>` : ""}

  <div class="entry-page" data-latest-slug="${escapeHtml(latestSlug)}">
    ${orderedEntries.length
      ? await renderBook(articles)
      : `<div class="journal-spreads">${renderEmptyState(entries)}</div>`}
  </div>`;

  const bodyClass = isZine ? "page-contents page-zine" : "page-contents";
  return pageShell({ title: tag || config.site.browserTitle, bodyHtml, bodyClass, reader: orderedEntries.length > 0 });
}

// A title containing "/" or ":" (either half- or full-width — "/",
// "／", ":", "：") is split at the FIRST such character into a main
// title and a subtitle, rendered as two separate lines (see .title-
// main/.title-sub in journal.css). No delimiter present just means no
// subtitle.
function splitTitleSubtitle(title) {
  // A ":" inside math isn't a delimiter.
  const masked = title.replace(MATH_SEGMENT_RE, m => "x".repeat(m.length));
  const match = /^(.*?)[/／:：]\s*(.+)$/s.exec(masked);
  if (!match) return { main: title, sub: null };
  const at = match[1].length;
  return { main: title.slice(0, at).trim(), sub: title.slice(at + 1).trim() };
}

// Chinese book-title marks: 《text》 → 「**_text_**」 (corner brackets,
// bold-italic content). Applied to raw Markdown before rendering so
// markdown-it handles the **_ nesting naturally. Outer 「」 are plain
// Unicode pass-through; inner bold-italic is standard Markdown syntax.
const BOOK_TITLE_RE = /《([^《》]+)》/g;

function expandBookTitles(markdown) {
  if (!config.typography.bookTitleMarks) return markdown;
  return markdown.replace(BOOK_TITLE_RE, (_, title) => `「**_${title}_**」`);
}

// A file name that's just a date (e.g. "2026-09-21.md") already says
// when it was written (see config.byline.hideOnDateFilenames).
function isDateFilename(id) {
  const base = path.basename(id, path.extname(id));
  return /^\d{4}-\d{2}-\d{2}$/.test(base);
}

function renderTitle(title) {
  const { main, sub } = splitTitleSubtitle(title);
  // Sentence case for the subtitle — its math untouched.
  const subDisplay = sub
    ? sub.split(/(\$[^$\n]+\$)/).map((part, i) => i % 2 ? part : part.toLowerCase()).join("")
        .replace(/^[^$]/, c => c.toUpperCase())
    : null;
  const titleHtml = subDisplay
    ? `<span class="title-main">${renderTitleText(main)}</span><span class="title-sub">${renderTitleText(subDisplay)}</span>`
    : renderTitleText(main);
  return `<h1 class="title">${titleHtml}</h1>`;
}

function renderByline(entry, { mode, zine = false }) {
  if (zine) {
    if (!entry.created) return "";
    return `<p class="byline-footer byline-footer--zine">${escapeHtml(entry.created)}</p>`;
  }

  // "written on <created>, and updated <updated>" — degrades to just
  // whichever date is present, or nothing at all if neither is.
  const parts = [];
  if (entry.created) parts.push(`written on ${escapeHtml(entry.created)}`);
  if (entry.updated) parts.push(`updated ${escapeHtml(entry.updated)}`);
  if (!parts.length) return "";

  const clause = parts.join(", and ");

  // "running" (/entry): moved by the reader into the first page's
  // bottom margin. "plain" (/contents): a small line right after the
  // entry's text.
  const modeClass = mode === "running" ? "byline-footer--running" : "byline-footer--inline";
  return `<p class="byline-footer ${modeClass}">${clause}</p>`;
}

// One entry's flow as the reader cuts it into pages (see
// static/reader.js): title, teaser, the two-column .body, then the
// blocks that must share a page with the body's last lines — the byline
// and References. The zine layout lists References in full width after the
// byline; everywhere else they're pinned to the bottom-right of the
// entry's last page, with a spacer holding their room at the spot they
// sit in the flow: inside .body when nothing follows the text (so they
// take room in whichever column it ends in), after the byline when one
// does.
function renderEntryBody(entry, { mode, showByline = true, zine = false }) {
  const byline = showByline ? renderByline(entry, { mode, zine }) : "";
  const running = mode === "running" ? byline : "";
  const trailing = mode === "running" ? "" : byline;
  const references = zine
    ? entry.referencesHtml.replace(`class="references"`, `class="references references--inline"`)
    : entry.referencesHtml;
  const referencesInBody = !zine && !trailing;

  return `
    ${renderTitle(entry.title)}
    ${running}
    ${entry.teaserHtml ? `<div class="teaser-slot">${entry.teaserHtml}</div>` : ""}
    <main class="body">${entry.bodyHtml}${referencesInBody ? references : ""}</main>
    ${trailing}${referencesInBody ? "" : references}
  `;
}

async function renderEntryPage(entry) {
  const bodyHtml = `
  <div class="entry-page">
    ${await renderBook(`<article class="paper">${renderEntryBody(entry, { mode: "running" })}</article>`)}
  </div>`;

  // A note on its own always uses the paper layout, but one from a zine
  // collection keeps the zine's lighter (non-bold) title.
  const isZine = entry.tags.some(t => layoutOf(config, t) === "zine");
  const bodyClass = isZine ? "page-entry entry-zine-title" : "page-entry";

  return pageShell({ title: entry.title, bodyHtml, bodyClass, reader: true });
}

// "/" and "/contents" are the only routes that let someone browse
// every published entry — that's why they live at HOME_PATH instead
// of a guessable path. A single entry's own /entry/:hash link (and
// /static/*) is unaffected either way.
app.get(HOME_PATH, async (_req, res) => {
  try {
    const entries = await listEntries();
    res.type("html").send(resolveVaultLinks(renderHomePage(entries)));
  } catch (error) {
    res.status(500).type("text").send(`Could not list entries from ${entrySource.label}\n\n${error.stack || error}`);
  }
});

// Every note as one book ("/contents"), or one collection.
app.get([CONTENTS_PATH, `${CONTENTS_PATH}/:tag`], async (req, res) => {
  try {
    const tag = req.params.tag;
    const entries = await listEntries();
    res.type("html").send(resolveVaultLinks(await renderContentsPage(entries, tag)));
  } catch (error) {
    res.status(500).type("text").send(`Could not list entries from ${entrySource.label}\n\n${error.stack || error}`);
  }
});

app.get("/entry/:slug", async (req, res) => {
  try {
    const entries = await listEntries();
    const entry = entries.find(e => e.slug === req.params.slug);
    if (!entry) {
      res.status(404).type("text").send(`No entry found for "${req.params.slug}"`);
      return;
    }
    res.type("html").send(resolveVaultLinks(await renderEntryPage(entry)));
  } catch (error) {
    res.status(500).type("text").send(`Could not render entry\n\n${error.stack || error}`);
  }
});

if (entrySource.liveReload) {
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
      entryCache.delete(path.relative(entrySource.rootDir, filePath));
    }
    notifyReload();
  });
}

// Starts the local server (`npm run dev`, or the md2book command in
// bin/). Deployed on Vercel, `api/index.js` imports `app` instead and
// Vercel handles listening.
export function start({ port = PORT, open = process.env.NO_OPEN !== "1" } = {}) {
  return app.listen(port, () => {
    const url = `http://localhost:${port}${HOME_PATH}`;
    console.log(`md2book: ${url}`);
    console.log(`Notes:   ${entrySource.label}`);
    console.log(`Config:  ${config.file || "(none — defaults)"}`);
    if (HOME_PATH !== "/") console.log(`(home path set — plain "/" won't list the notes)`);

    if (open) {
      const opener = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "start \"\""
        : "xdg-open";
      exec(`${opener} ${url}`);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();

export default app;
