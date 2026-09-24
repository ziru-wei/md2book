import express from "express";
import chokidar from "chokidar";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import markdownItMark from "markdown-it-mark";
import * as cheerio from "cheerio";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { createEntrySource } from "./lib/source.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT || 3000);
const LOCAL_ENTRIES_DIR = path.resolve(
  process.cwd(),
  process.argv[2] || process.env.JOURNAL_DIR || "entries"
);

const entrySource = createEntrySource(LOCAL_ENTRIES_DIR);

// Where the entry-listing pages actually live. Defaults to "/" for
// local dev; set HOME_PATH (e.g. "/pw") on a public deployment so
// the real "/" reveals nothing and only whoever knows this path can
// browse the journal. A single entry's own /entry/<hash> link never
// depends on this.
const HOME_PATH = process.env.HOME_PATH || "/";
const CONTENTS_PATH = HOME_PATH === "/" ? "/contents" : `${HOME_PATH}/contents`;

// Built-in metadata: does not need to exist in Markdown.
const AUTHOR = "Ziru Wei";

const md = new MarkdownIt({
  html: true,
  linkify: false,
  typographer: true
}).use(markdownItMark);

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

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

// One frontmatter field instead of two: `publishID: <anything>` both
// marks the note published AND supplies the stable id its URL hash is
// derived from (so renaming the file or moving it in Obsidian doesn't
// change the URL). Missing/empty means unpublished.
function getPublishId(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

// --- Managed remote PNG placeholders for Paged.js pagination ---------
//
// Paged.js can stall generating a page while an <img> on it still has
// unknown/unfinished layout, and a raw.githubusercontent.com PNG can
// take a while to arrive. Rather than let pagination wait on the
// network, matching <img>s get swapped — only in the HTML handed to
// Paged.js, never in the Markdown renderer's own output or the home
// page's waterfall thumbnails — for a same-aspect-ratio inline SVG
// placeholder with the real, pre-resolved width/height already set, so
// pagination only ever waits on a local, instantly-resolving image. The
// real URL (kept on data-real-src) is restored client-side once
// pagination has fully settled — see hydratePagedImages in pageShell's
// script below.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isManagedPngUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.hostname === "raw.githubusercontent.com" && url.pathname.toLowerCase().endsWith(".png");
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

// Cached by URL — both in-flight promises (so concurrent requests for
// the same image share one fetch) and resolved results, for the
// lifetime of the process. Only the PNG header is ever requested
// (Range: bytes=0-23, exactly the signature + IHDR's width/height);
// if the remote server doesn't honor Range and answers with a full 200
// instead, the body is cancelled unread rather than downloaded.
const pngDimensionCache = new Map();

async function resolvePngDimensions(rawUrl) {
  if (pngDimensionCache.has(rawUrl)) return pngDimensionCache.get(rawUrl);

  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(rawUrl, {
        headers: { Range: "bytes=0-23" },
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

  pngDimensionCache.set(rawUrl, promise);
  return promise;
}

function pngPlaceholderDataUri(width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Swaps every matching raw-GitHub PNG <img src> in `html` for a local,
// same-aspect-ratio, visually-transparent SVG placeholder — used only
// on the HTML assembled for Paged.js on paginated /entry and /contents
// views (see renderEntryPage/renderContentsPage). Images whose
// dimensions can't be resolved (non-PNG, non-raw-GitHub, network
// failure) are left completely unchanged.
async function preparePagedImagePlaceholders(html) {
  const $ = cheerio.load(`<div id="__wrap">${html}</div>`, null, false);
  const wrap = $("#__wrap");

  await Promise.all(wrap.find("img[src]").toArray().map(async img => {
    const $img = $(img);
    const src = $img.attr("src");
    if (!src || !isManagedPngUrl(src)) return;

    const dims = await resolvePngDimensions(src);
    if (!dims) return;

    $img.attr("data-real-src", src);
    $img.attr("src", pngPlaceholderDataUri(dims.width, dims.height));
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
  return markdown.replace(REF_TOKEN_RE, (_match, _meta, url) => {
    const trimmed = url.trim();
    return trimmed ? `<a class="citation-ref" href="${escapeHtml(trimmed)}"></a>` : "";
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

function postProcessMarkdown(renderedHtml) {
  // Wrap rendered fragment so Cheerio can safely transform it.
  const $ = cheerio.load(`<main id="root">${renderedHtml}</main>`, null, false);
  const root = $("#root");

  // First H1 becomes the publication title and is removed from body flow.
  const firstH1 = root.find("h1").first();
  const title = firstH1.length ? firstH1.text().trim() : "Untitled";
  if (firstH1.length) firstH1.remove();

  // A "## Note" heading (any letter case) marks a private end-of-file
  // scratchpad — that heading and everything after it in the document
  // is stripped entirely here, before figures/references/excerpt are
  // computed, so none of it is ever rendered, numbered, or previewed.
  const noteHeading = root.find("h2").filter((_, h) => $(h).text().trim().toLowerCase() === "note").first();
  if (noteHeading.length) {
    noteHeading.nextAll().remove();
    noteHeading.remove();
  }

  // Turn standalone Markdown images into figures. A "//teaser" marker
  // promotes one image under the metadata; either form (marker, and/or
  // a "(caption)") can be soft-wrapped into the image's own paragraph,
  // or written as its own separate paragraph(s) (blank line before):
  //
  // ![alt](https://...)      ![alt](https://...)
  // //teaser
  // (some caption)     or    //teaser
  //
  //                          (some caption)
  function parseFigureMarker(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const teaserMatch = /^\/\/\s*teaser\s*(?:\((.+)\))?$/is.exec(trimmed);
    if (teaserMatch) {
      return { isTeaser: true, caption: teaserMatch[1] ? teaserMatch[1].trim() : null };
    }
    const captionMatch = /^\((.+)\)$/s.exec(trimmed);
    if (captionMatch) {
      return { isTeaser: false, caption: captionMatch[1].trim() };
    }
    return null;
  }

  // parseFigureMarker above matches against a node's plain .text(),
  // which flattens any inline formatting markdown-it already rendered
  // inside the caption (e.g. "**bold**" is <strong>bold</strong> in the
  // HTML by this point) down to plain text — so a bold marker in a
  // caption would otherwise just vanish. The "//teaser" marker and the
  // wrapping parentheses are always plain literal characters even when
  // the caption itself has inline HTML in it, so the exact same two
  // regexes apply just as safely to the node's raw .html() — this
  // extracts the caption as HTML instead, preserving that formatting.
  function captionHtmlFromMarker(html, marker) {
    const trimmed = (html || "").trim();
    if (marker.isTeaser) {
      const m = /^\/\/\s*teaser\s*(?:\((.+)\))?$/is.exec(trimmed);
      return m && m[1] ? m[1].trim() : escapeHtml(marker.caption || "");
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

    let marker = { isTeaser: false, caption: null };
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

    if (!isTeaser && !$figure.find("figcaption").length) {
      const next = $figure.next();
      if (next.length && next.is("p")) {
        const parsed = parseFigureMarker(next.text());
        if (parsed) {
          const nextHtml = next.html();
          next.remove();
          isTeaser = parsed.isTeaser;
          if (parsed.caption) {
            const captionHtml = captionHtmlFromMarker(nextHtml, parsed);
            $figure.append(`<figcaption data-figcaption="1">${captionHtml}</figcaption>`);
          }
        }
      }
    }

    // A bare "//teaser" (no caption yet) may still have its caption on
    // the very next paragraph after it.
    if (isTeaser && !$figure.find("figcaption").length) {
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

    $figure.removeAttr("data-teaser-pending");
    if (isTeaser) $figure.addClass("is-teaser-candidate");
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
    $caption.prepend(`Figure ${figureNumber}. `);
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
  // References are appended at the end of the same two-column flow.
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

    root.append(`
      <section class="references">
        <h2>References</h2>
        <ol class="reference-list">${items}</ol>
      </section>
    `);
  }

  // Plain-text excerpt for card previews on the list page: the first
  // remaining text paragraph (image-only paragraphs became figures above
  // and don't count).
  const excerpt = root.find("p").first().text().trim();

  return {
    title,
    teaserHtml,
    excerpt,
    bodyHtml: root.html() || ""
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
  const rendered = md.render(expandInlineRefTokens(content));
  const { title, teaserHtml, excerpt, bodyHtml } = postProcessMarkdown(rendered);

  // Renaming a file or moving it to a different folder in Obsidian
  // changes its path — and hashing the path (the fallback below) would
  // silently break any /entry/<hash> link already shared for it.
  // publishID, once written in frontmatter, survives renames/moves, so
  // it's used instead whenever present; it's still hashed like the
  // path would be, so the URL stays just as opaque either way.
  const publishId = getPublishId(data.publishID);
  const slug = slugify(publishId || id);

  const entry = {
    slug,
    id,
    version,
    title: title !== "Untitled" ? title : path.basename(id, path.extname(id)),
    teaserHtml,
    excerpt,
    bodyHtml,
    published: publishId !== null,
    created: normalizeDate(data.created),
    updated: normalizeDate(data.updated)
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

async function listEntries() {
  const files = await entrySource.listFiles();

  return (await Promise.all(files.map(loadEntry)))
    .filter(entry => entry.published);
}

function pageShell({ title, bodyHtml, bodyClass, paginated = false }) {
  return `<!doctype html>
<html lang="en"${paginated ? ' class="paged-loading"' : ""}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="${paginated
    ? "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
    : "width=device-width, initial-scale=1"}" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/static/journal.css" />
  ${paginated ? `<script>window.PagedConfig = { auto: false };</script>
  <script src="https://unpkg.com/pagedjs/dist/paged.polyfill.js"></script>` : ""}
</head>
<body class="${escapeHtml(bodyClass)}">
  ${bodyHtml}
  ${paginated ? `<div id="paged-loader" aria-hidden="true"></div>` : ""}

  <script>
    function attachImageFallback(root) {
      (root || document).querySelectorAll("img").forEach((img) => {
        img.addEventListener("error", () => {
          const placeholder = document.createElement("div");
          placeholder.className = "image-placeholder";
          placeholder.textContent = img.alt || "image unavailable";
          img.replaceWith(placeholder);
        }, { once: true });
      });
    }

    ${entrySource.liveReload ? `
    // Live reload when Markdown/CSS in the watched folder changes.
    const events = new EventSource("/events");
    events.addEventListener("reload", () => location.reload());
    ` : ""}

    ${paginated ? `
    // Each md file's content lives in this <template> unrendered; Paged.js
    // slices it into fixed-size page boxes, overflowing into as many
    // pages as the content needs.
    (async function () {
      const source = document.getElementById("pagedjs-source");
      const target = document.getElementById("pagedjs-target");
      const toggle = document.getElementById("spread-toggle");
      if (!source || !target) return;

      // Touch devices (phones, iPads) get an e-reader instead: one page
      // per screen, swipe sideways to turn. Detected by the primary
      // pointer being a finger rather than by screen width, so a
      // landscape iPad (wider than any "mobile" breakpoint) counts too.
      // navigator.maxTouchPoints also catches iPadOS, whose Safari
      // presents itself as a desktop Mac by default.
      const isTouchBook =
        matchMedia("(pointer: coarse)").matches ||
        matchMedia("(hover: none)").matches ||
        navigator.maxTouchPoints > 1;
      // Tablets show a two-page spread in landscape, one page in
      // portrait; phones always show one. Split by the device's short
      // side — every iPad is >= 744 CSS px there, every phone well
      // under 600. Pages themselves stay the same fixed 850x1100 shape
      // on every device (see @page in journal.css) — only how many fit
      // per screen, and how much they're visually scaled to fit, differ.
      const isTablet = isTouchBook && Math.min(screen.width, screen.height) >= 600;

      // Layout-neutral pending gate, switched on BEFORE rendering —
      // visibility-only (see html.touch-pending in journal.css), never
      // touch viewer presentation. Adding .touch-book itself this
      // early used to actively corrupt Paged.js's output: its CSS
      // (flex/width/margin overrides on .pagedjs_pages, #pagedjs-target,
      // .pagedjs_page) was live while pagination was still running, so
      // Paged.js was pagination against a moving target instead of the
      // same neutral 850x1100 layout desktop gets — the actual cause of
      // titles/teasers landing on their own page, duplicated figures,
      // and breaks happening too early on touch. .touch-book is now
      // only ever added once by activateTouchBook(), below, after the
      // final page DOM is fully known.
      if (isTouchBook) {
        document.documentElement.classList.add("touch-pending");
        // Safety net: if anything in the render/fit chain fails before
        // the normal end-of-flow activation, activate anyway after a
        // while — through the same activateTouchBook() path (grouped +
        // scaled), never by exposing raw ungrouped pages — rather than
        // leave the screen hidden forever.
        setTimeout(() => activateTouchBook(), 10000);
      }

      // Screen width in CSS px. NOT window.innerWidth: on iOS that is
      // the visual viewport, which shrinks/grows with pinch/auto zoom —
      // it read ~850 on a phone that had zoomed out, so pages weren't
      // scaled down at all (and each zoom change looked like a resize).
      function viewportWidth() {
        return document.documentElement.clientWidth || window.innerWidth;
      }

      // @page's own size is a FIXED, literal design size (850x1100 —
      // see journal.css) and never changes at runtime: it's the basis
      // every font-size/margin/image-max-height in journal.css was
      // authored against, so scaling it dynamically (tried previously)
      // scales the page box but not those values, leaving text looking
      // bigger or smaller *relative to the page* depending on the
      // viewer's screen. Filling the viewport is instead done with
      // \`zoom\` on the whole rendered page — zoom scales a box AND
      // everything inside it together, uniformly, so the text-to-page
      // ratio is identical for every viewer no matter the absolute
      // size it ends up rendered at.
      const NOMINAL_WIDTH = 850;
      const NOMINAL_HEIGHT = 1100;

      // Single-page mode: each page individually zoomed to fill the
      // viewport's height.
      function applySinglePageZoom() {
        const scale = window.innerHeight / NOMINAL_HEIGHT;
        target.querySelectorAll(".pagedjs_page").forEach(page => {
          page.style.zoom = scale;
        });
      }

      // Double-page mode: the pair zoomed together (not per-page — they
      // need to shrink/grow as one unit to stay the same size as each
      // other) to fill the available width.
      function fitSpreadWidth() {
        const pages = target.querySelector(".pagedjs_pages");
        if (!pages) return;

        // Per-page zoom from single-page mode would otherwise compound
        // with the spread's own zoom below.
        target.querySelectorAll(".pagedjs_page").forEach(page => {
          page.style.zoom = "";
        });

        if (!target.classList.contains("spread-mode")) {
          pages.style.zoom = "";
          applySinglePageZoom();
          return;
        }

        // journal.css's grid-template-columns still reads the static
        // --paper-width variable — override it inline, at !important
        // priority so it actually beats that rule, to keep the two
        // columns sized to the fixed nominal page width (the zoom
        // below is what actually scales them, same as single-page).
        pages.style.setProperty(
          "grid-template-columns",
          \`repeat(2, \${NOMINAL_WIDTH}px)\`,
          "important"
        );
        // No upper cap: when there's more than enough room for both
        // pages at their natural size, scale UP to actually fill it
        // instead of leaving the extra space as centered padding.
        const scale = target.clientWidth / (NOMINAL_WIDTH * 2);
        // Kept in sync so pages Paged.js is still inserting mid-preview
        // (see the spread-mode CSS's \`zoom: var(--spread-zoom, 1)\`)
        // are born at approximately the right scale before this ever
        // gets to run against the finished set.
        target.style.setProperty("--spread-zoom", scale);
        pages.style.zoom = scale;
      }

      // The user's intended spread state, independent of how many pages
      // currently happen to exist — a mid-repagination page count (or a
      // one-page doc's forced single-page fallback) must never overwrite
      // this, so a later corrected multi-page render can restore it.
      let wantsSpread = !!(toggle && toggle.classList.contains("is-on"));

      if (toggle && !isTouchBook) {
        toggle.addEventListener("click", () => {
          wantsSpread = !wantsSpread;
          toggle.classList.toggle("is-on", wantsSpread);
          target.classList.toggle("spread-mode", wantsSpread);
          fitSpreadWidth();
        });
        window.addEventListener("resize", () => {
          if (target.classList.contains("spread-mode")) {
            fitSpreadWidth();
          } else {
            applySinglePageZoom();
          }
        });
      }

      // Height the book is fitted into. 100svh ("small viewport height")
      // is the height with the mobile address bar SHOWN — it stays put
      // as the bar slides in and out, unlike window.innerHeight, whose
      // constant changes previously fed a resize -> re-zoom -> resize
      // loop (text starting tiny, jumping around, ending up huge).
      function stableViewportHeight() {
        const probe = document.createElement("div");
        probe.style.cssText = "position:fixed;top:0;height:100svh;width:0;visibility:hidden;";
        document.body.appendChild(probe);
        const h = probe.offsetHeight || document.documentElement.clientHeight || window.innerHeight;
        probe.remove();
        return h;
      }

      // Pages are laid out in full-viewport "slides" inside a horizontal
      // scroll-snap track: a swipe turns exactly one screen (one page,
      // or a two-page spread on a landscape tablet) with the browser's
      // own native gesture and momentum — no custom touch code. The
      // slide (100vw x 100svh) is never itself scaled; only an inner
      // wrapper holding the page(s) at their real, fixed 850x1100 (or
      // 1700x1100 for a pair) size is transform:scale()'d to fit —
      // pagination always runs against that one fixed page size (see
      // @page in journal.css), on every device, so nothing about the
      // document itself changes with screen shape.
      let cleanupTouchBook = null;

      function setupTouchBook() {
        // finishUp() (and therefore setupTouchBook()) can run again
        // after a staging repagination swap — drop any listener from a
        // previous run first, or they'd accumulate, including ones
        // still closing over an already-detached .pagedjs_pages track.
        cleanupTouchBook?.();
        cleanupTouchBook = null;

        const track = target.querySelector(".pagedjs_pages");
        if (!track) return;
        const pages = Array.from(track.querySelectorAll(".pagedjs_page"));

        function currentPerScreen() {
          return isTablet && viewportWidth() > stableViewportHeight() ? 2 : 1;
        }

        // (Re)groups the flat list of pages into slide wrappers of
        // \`perScreen\` pages each. Pure DOM wrapping — Paged.js has
        // already paginated the content and is never touched again.
        function layoutSlides(perScreen) {
          track.querySelectorAll(".touch-slide-inner").forEach(inner => {
            while (inner.firstChild) track.appendChild(inner.firstChild);
          });
          track.querySelectorAll(".touch-slide").forEach(slide => slide.remove());

          for (let i = 0; i < pages.length; i += perScreen) {
            const group = pages.slice(i, i + perScreen);
            const slide = document.createElement("div");
            slide.className = "touch-slide";
            const inner = document.createElement("div");
            inner.className = "touch-slide-inner" + (group.length === 2 ? " is-spread" : "");
            slide.appendChild(inner);
            group.forEach(page => inner.appendChild(page));
            track.appendChild(slide);
          }
        }

        // Fixed logical page size the whole document is paginated
        // against, regardless of device — see @page in journal.css.
        function applyScale() {
          const w = viewportWidth();
          const h = stableViewportHeight();
          track.querySelectorAll(".touch-slide-inner").forEach(inner => {
            const isSpread = inner.classList.contains("is-spread");
            const scale = isSpread
              ? Math.min(w / (NOMINAL_WIDTH * 2), h / NOMINAL_HEIGHT)
              : Math.min(w / NOMINAL_WIDTH, h / NOMINAL_HEIGHT);
            inner.style.transform = \`scale(\${scale})\`;
          });
        }

        // Reuses the desktop spread styling (center-gutter shadow,
        // odd/even pairing) for the landscape tablet spread.
        let perScreen = currentPerScreen();
        target.classList.toggle("spread-mode", perScreen === 2);
        layoutSlides(perScreen);
        applyScale();
        // Slides are placed and scaled now — safe to show (see journal.css).
        document.documentElement.classList.add("touch-book-ready");

        // Current position tracked as a logical slide INDEX, not a
        // pixel offset — slides are always exactly one viewport wide,
        // so it survives a rescale (or a tablet regrouping) untouched.
        let currentSlide = 0;
        let lastWidth = viewportWidth();
        function handleTouchResize() {
          const w = viewportWidth();
          if (w === lastWidth) {
            // Height-only change (mobile address bar sliding) — just
            // rescale in place, no reflow, no repagination.
            applyScale();
            return;
          }

          currentSlide = Math.round(track.scrollLeft / lastWidth);
          lastWidth = w;

          const nextPerScreen = currentPerScreen();
          if (nextPerScreen !== perScreen) {
            // Tablet rotated between portrait/landscape: regroup pages
            // into the new slide size, converting the index across the
            // grouping change so the same page stays in view.
            currentSlide = Math.floor((currentSlide * perScreen) / nextPerScreen);
            perScreen = nextPerScreen;
            target.classList.toggle("spread-mode", perScreen === 2);
            layoutSlides(perScreen);
          }

          applyScale();
          track.scrollLeft = currentSlide * viewportWidth();
        }

        window.addEventListener("resize", handleTouchResize);
        cleanupTouchBook = () => {
          window.removeEventListener("resize", handleTouchResize);
        };
      }

      // Activates the touch viewer exactly once, only after the final
      // page DOM is fully installed in \`target\` (i.e. after any
      // corrective/staging repagination has already landed) — never
      // from an intermediate finishUp() call. Adds .touch-book (which
      // is what actually switches on the touch viewer's presentation
      // CSS) and runs setupTouchBook() together, synchronously, so
      // .touch-book is never present without a grouped/scaled result
      // right behind it, then finally lifts .touch-pending.
      let touchActivated = false;
      function activateTouchBook() {
        if (!isTouchBook || touchActivated) return;
        touchActivated = true;

        document.documentElement.classList.add("touch-book");
        setupTouchBook();
        document.documentElement.classList.remove("touch-pending");
      }

      // Removes the loading gate on the next animation frame. Called
      // once, right after the FIRST preview()'s pages get their final
      // layout applied (see finishUp/applyDesktopPageLayout below) —
      // never before that, so the first visible frame is never an
      // un-fitted single-page flash ahead of the default double spread,
      // and never later than that either: images and the reference-
      // overlap retry are left to resolve visibly afterward instead of
      // blocking first paint.
      function revealPagedReader() {
        requestAnimationFrame(() => {
          document.documentElement.classList.remove("paged-loading");
        });
      }

      // Desktop-only: applies the default double spread (or single-page
      // fallback for a one-page document) to whatever pages currently
      // exist in \`target\`. Idempotent and safe to call again after an
      // overlap-retry swaps in corrected pages — it only ever reads the
      // current page count and re-applies fitting, same as the first
      // time. The one-page fallback disables the toggle UI but never
      // touches \`wantsSpread\` itself, so if a later corrected render
      // turns out to have multiple pages after all, the user's actual
      // intended (or default) spread state comes back automatically.
      function applyDesktopPageLayout() {
        const pageCount = target.querySelectorAll(".pagedjs_page").length;
        if (pageCount <= 1) {
          // Nothing to spread — a single page has no facing page to
          // sit beside, so default to single-page regardless of
          // wantsSpread.
          if (toggle) {
            toggle.disabled = true;
            toggle.classList.remove("is-on");
          }
          target.classList.remove("spread-mode");
          applySinglePageZoom();
          return;
        }

        if (toggle) {
          toggle.disabled = false;
          toggle.classList.toggle("is-on", wantsSpread);
        }
        target.classList.toggle("spread-mode", wantsSpread);

        if (wantsSpread) {
          fitSpreadWidth();
        } else {
          applySinglePageZoom();
        }
      }

      // Final setup for whatever pages currently exist in \`target\` —
      // called once right after the first preview() (before images or
      // the reference-overlap check), and again, idempotently, after an
      // overlap retry swaps in corrected pages. Does NOT itself decide
      // when to reveal — see revealPagedReader, called once by the
      // caller right after the first call to this. Desktop-only:
      // touch's own layout (setupTouchBook, via activateTouchBook) is
      // deliberately NOT run from here, since finishUp() can run before
      // the final page DOM is known — touch stays under .touch-pending
      // (target hidden, no touch-book presentation CSS active) through
      // every intermediate call, and is activated exactly once, at the
      // very end of the whole flow.
      function finishUp() {
        attachImageFallback(target);

        if (!isTouchBook) {
          applyDesktopPageLayout();
        }
      }

      // Restores the real raw-GitHub PNG src (from data-real-src) once
      // pagination is completely final — called only after any overlap/
      // repagination correction has already landed, never before or
      // during it, so Paged.js never has to wait on the network again.
      // width/height are left in place throughout: the box is already
      // the real image's own size, so nothing here can shift page
      // geometry. data-real-src (and the loading background it drives,
      // via journal.css's .paged-image-loading) stays on the element
      // until the real PNG actually finishes loading (or fails) —
      // removing it immediately on hydration would drop the loading
      // indicator the instant the real request starts, not when it ends.
      function hydratePagedImages(root) {
        for (const img of root.querySelectorAll("img[data-real-src]")) {
          const realSrc = img.dataset.realSrc;
          if (!realSrc) continue;

          img.classList.add("paged-image-loading");

          const done = () => {
            img.classList.remove("paged-image-loading");
            img.removeAttribute("data-real-src");
          };
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });

          img.src = realSrc;
        }
      }

      // Extra clearance required beyond a bare touch — both because a
      // late-loading image can still nudge layout a little after this
      // check runs (waitForImages below covers the common case, this
      // is backup margin for anything that slips past it), and because
      // "just barely not touching" still reads as cramped.
      const OVERLAP_MARGIN_PX = 24;

      // Paged.js's own promise resolves once layout is done, but an
      // <img> that hadn't finished loading/decoding yet can still
      // resize afterwards and shift content down — right into
      // territory the overlap checks below already cleared. Wait for
      // every image actually inserted by this render before measuring
      // anything.
      async function waitForImages() {
        // Managed placeholder images (data-real-src) are local SVGs that
        // resolve instantly and are deliberately NOT hydrated to their
        // real remote src yet — pagination geometry is governed by their
        // already-known width/height, not by whether the eventual real
        // PNG has loaded, so they're excluded here entirely rather than
        // waited on.
        const images = Array.from(target.querySelectorAll("img"))
          .filter(img => !img.hasAttribute("data-real-src"));
        // loading="lazy" images that are hidden or off-screen (every
        // page but the first in the touch swipe track) never start
        // loading on iOS — waiting on them hung the reader forever.
        images.forEach(img => { img.loading = "eager"; });
        const allLoaded = Promise.all(images.map(img => {
          if (img.complete) return Promise.resolve();
          return new Promise(resolve => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          });
        }));
        // Never let one slow image block the whole book.
        await Promise.race([allLoaded, new Promise(r => setTimeout(r, 5000))]);
      }

      // References are pinned absolute (bottom-right of whatever page
      // they land on), so nothing reserves space for them — if that
      // page's normal content already runs close to the bottom, they
      // can visually collide. Detect that after the first render and,
      // for just the entries where it actually happened, insert a page
      // break before their References and re-paginate once.
      function findOverlappingReferenceSlugs() {
        const slugs = [];
        target.querySelectorAll(".references[data-ref-for]").forEach(ref => {
          const prev = ref.previousElementSibling;
          if (!prev) return;
          const refRect = ref.getBoundingClientRect();
          const prevRect = prev.getBoundingClientRect();
          if (prevRect.bottom + OVERLAP_MARGIN_PX > refRect.top) {
            slugs.push(ref.getAttribute("data-ref-for"));
          }
        });
        return slugs;
      }

      // .byline-footer no longer needs any detection on /contents — it's
      // plain in-flow content there now (see renderByline's "plain"
      // mode), which can never overlap anything because normal document
      // flow guarantees whatever follows it comes after, not because
      // something measured it and hoped for the best. That JS approach
      // was tried twice (once with an absolute-position + negative
      // offset, once with absolute-position + overlap-detected forced
      // breaks) and both times corrupted pagination across the whole
      // multi-entry flow instead of just fixing the footer.

      function withForcedBreaksBefore(refSlugs) {
        const scratch = document.createElement("div");
        scratch.innerHTML = source.innerHTML;

        refSlugs.forEach(slug => {
          const ref = scratch.querySelector(\`.references[data-ref-for="\${slug}"]\`);
          if (!ref) return;
          const breaker = document.createElement("div");
          breaker.className = "force-page-break";
          ref.parentNode.insertBefore(breaker, ref);
        });

        return scratch.innerHTML;
      }

      // Paginated pages hold every image up front anyway; lazy loading
      // only ever made off-screen/hidden ones stall (notably on iOS).
      source.innerHTML = source.innerHTML.replace(/ loading="lazy"/g, "");

      // Same fixed 850x1100 @page stylesheet on every device — pagination
      // geometry never changes with screen shape (see setupTouchBook).
      const pageStylesheets = ["/static/journal.css"];

      // Desktop only: prime the spread presentation BEFORE Paged.js
      // inserts anything, so \`.spread-mode\` and an approximate
      // \`--spread-zoom\` already exist the moment the first \`.pagedjs_pages\`
      // grid is born mid-preview — pages arrive already close to their
      // final scale instead of at 1:1 before fitSpreadWidth() can run.
      if (!isTouchBook && wantsSpread) {
        target.classList.add("spread-mode");
        target.style.setProperty("--spread-zoom", target.clientWidth / (NOMINAL_WIDTH * 2));
      }

      // Desktop progressive reveal: rather than waiting for the whole
      // \`preview()\` promise (which only resolves once EVERY page has
      // been generated) a target-scoped MutationObserver reveals the
      // reader as soon as the FIRST page exists — spread-mode and the
      // explicit two-column grid are already primed above, so page 1
      // lands in the left spread slot with an empty right slot, and
      // page 2 (and beyond) fill in progressively as Paged.js keeps
      // appending them into the now-visible \`.pagedjs_pages\` — no
      // waiting for a full pair before the reader is shown at all.
      // Scoped to \`target\` (not a global Paged.Handler) so it can never
      // fire for the hidden retry/staging Previewer below.
      let progressiveRevealed = false;

      function revealProgressiveDesktop() {
        const pageCount = target.querySelectorAll(".pagedjs_page").length;

        if (progressiveRevealed || isTouchBook) return;

        if (pageCount < 1) return;

        progressiveRevealed = true;

        if (wantsSpread) {
          target.classList.add("spread-mode");
          fitSpreadWidth();
        } else {
          applySinglePageZoom();
        }

        revealPagedReader();
      }

      const progressiveObserver = !isTouchBook
        ? new MutationObserver(() => revealProgressiveDesktop())
        : null;
      progressiveObserver?.observe(target, { childList: true, subtree: true });

      const previewer = new Paged.Previewer();
      await previewer.preview(source.innerHTML, pageStylesheets, target);
      progressiveObserver?.disconnect();

      // A real one-page document (or touch, where the observer never
      // runs) never got progressively revealed above — reveal it now
      // that pagination is actually done. Otherwise the progressive
      // path already applied final layout and revealed.
      if (!progressiveRevealed) {
        finishUp();
        revealPagedReader();
      } else {
        finishUp();
      }

      // An <img> still incomplete during this first pass can change
      // content flow/page breaks once its real intrinsic size lands —
      // a correctness issue independent of (and in addition to) the
      // reference-overlap check below, so it also has to force the
      // final corrective repagination pass. Managed placeholder images
      // are excluded — their reserved width/height is already final and
      // authoritative for pagination; the real PNG loading in behind
      // them later (after hydratePagedImages, below) must never trigger
      // this.
      const hadIncompleteImages = Array.from(target.querySelectorAll("img"))
        .filter(img => !img.hasAttribute("data-real-src"))
        .some(img => !img.complete);

      await waitForImages();
      const overlappingRefs = findOverlappingReferenceSlugs();
      const needsFinalRepagination = hadIncompleteImages || overlappingRefs.length > 0;

      if (needsFinalRepagination) {
        // Exactly one hidden final pass, covering both correction
        // reasons at once. Render into an off-screen staging element
        // instead of clearing the live, already-visible target — the
        // current book must stay on screen for the whole retry, with
        // no second full-screen loader.
        const finalSource = overlappingRefs.length > 0
          ? withForcedBreaksBefore(overlappingRefs)
          : source.innerHTML;

        // Deliberately NOT copying target's current className here —
        // that could carry over spread-mode or (were it ever present)
        // touch viewer state, none of which staging needs: Paged.js
        // only needs a plain, neutral mount point, and it must see the
        // exact same 850x1100 layout the very first preview did.
        const staging = document.createElement("div");
        staging.style.cssText =
          "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;";
        document.body.appendChild(staging);

        const retryPreviewer = new Paged.Previewer();
        await retryPreviewer.preview(finalSource, pageStylesheets, staging);

        // Atomic swap: the corrected pages replace the old ones in one
        // move, no intermediate empty state.
        target.replaceChildren(...staging.childNodes);
        staging.remove();

        finishUp();
      }

      // Pagination is now completely final (including any overlap
      // correction above) — safe to swap in the real raw-GitHub PNGs.
      // They load into their already-reserved, already-correctly-sized
      // boxes from here on, visibly, without affecting page geometry.
      hydratePagedImages(target);
      attachImageFallback(target);

      // The final page DOM is now fully known — safe to turn on the
      // touch viewer (a no-op on desktop). Never earlier than this.
      activateTouchBook();
    })();
    ` : `attachImageFallback();`}
  </script>
</body>
</html>`;
}

function truncate(text, max = 160) {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

// Back link + double-page checkbox, both hidden by default and revealed
// on hover near the left edge of the viewport — kept out of the way of
// a full-width double-page spread. Shared by the entry page and the
// contents (reading mode) page.
function renderEdgeControls({ href, showBack = true, showToggle }) {
  return `
  <div class="edge-controls">
    ${showBack ? `<nav class="entry-nav"><a href="${href}">Back</a></nav>` : ""}
    ${showToggle ? `<button type="button" id="spread-toggle" class="mode-toggle is-on">Double</button>` : ""}
  </div>`;
}

function renderLogo(href) {
  return `
    <a href="${href}" class="index-logo" aria-label="Journal">
      <img src="/static/owl.png" alt="Journal" />
    </a>
    <div class="index-author">${escapeHtml(AUTHOR)}</div>
  `;
}

function renderWaterfallCards(entries) {
  return sortByDateDesc(entries, "updated").map(entry => {
    const date = entry.updated || entry.created || "";

    // Cards with a teaser image show the image plus title/date; text-only
    // entries show a truncated first-paragraph preview instead of a thumb.
    const inner = `
      ${entry.teaserHtml ? `<div class="wf-thumb">${entry.teaserHtml}</div>` : ""}
      <div class="wf-card-body">
        <h2 class="wf-card-title">${escapeHtml(entry.title)}</h2>
        ${!entry.teaserHtml && entry.excerpt ? `<p class="wf-card-excerpt">${escapeHtml(truncate(entry.excerpt))}</p>` : ""}
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
    : `<p class="index-empty">No published entries yet. Add <code>publishID: ...</code> to a Markdown file's frontmatter (source: ${escapeHtml(entrySource.label)}).</p>`;
}

// Home page ("/"): logo + author + a plain waterfall feed, no TOC.
// Clicking the logo goes into the "contents" view below.
function renderHomePage(entries) {
  const bodyHtml = `
  <div class="journal-home">
    <header class="index-header index-header-home">
      ${renderLogo(CONTENTS_PATH)}
    </header>

    <div class="journal-waterfall">
      ${renderEmptyState(entries)}
      ${renderWaterfallCards(entries)}
    </div>
  </div>`;

  return pageShell({ title: "Journal", bodyHtml, bodyClass: "page-index" });
}

// Contents view ("/contents"): the reading mode. Dark background, no
// logo, a left sidebar table of contents (date + title, sorted by created
// date), and every entry rendered in full as a stacked "spread" — the
// same two-column paper look as the single entry page, with a faint
// inner gutter shadow standing in for a book's spine. Order matches the
// TOC (by created date) so scrolling down tracks the sidebar top to
// bottom.
async function renderContentsPage(entries) {
  const orderedEntries = sortByDateDesc(entries, "created");

  const toc = orderedEntries.map(entry => {
    const date = entry.created || entry.updated || "";
    return `
      <li class="toc-item">
        <a href="#card-${entry.slug}">
          ${date ? `<span class="toc-date">${escapeHtml(date)}</span>` : ""}
          <span class="toc-title">${escapeHtml(entry.title)}</span>
        </a>
      </li>
    `;
  }).join("");

  const spreads = orderedEntries.map(entry => `
    <article class="paper spread" id="card-${entry.slug}">
      ${renderEntryBody(entry, { mode: "plain" })}
    </article>
  `).join("");

  // Only the HTML actually handed to Paged.js gets its raw-GitHub PNGs
  // swapped for local placeholders — home/waterfall thumbnails never go
  // through this.
  const pagedSpreads = orderedEntries.length ? await preparePagedImagePlaceholders(spreads) : "";

  const bodyHtml = `
  ${renderEdgeControls({ href: HOME_PATH, showToggle: orderedEntries.length > 0 })}

  ${orderedEntries.length ? `
  <div class="toc-panel">
    <ul class="toc-list">${toc}</ul>
  </div>` : ""}

  <div class="entry-page${orderedEntries.length ? " has-toc" : ""}">
    ${orderedEntries.length
      ? `<template id="pagedjs-source">${pagedSpreads}</template>
         <div id="pagedjs-target" class="journal-spreads"></div>`
      : `<div class="journal-spreads">${renderEmptyState(entries)}</div>`}
  </div>`;

  return pageShell({ title: "Journal", bodyHtml, bodyClass: "page-contents", paginated: orderedEntries.length > 0 });
}

function renderByline(entry, { mode }) {
  // "This article is written on <created>, and updated <updated> by
  // <author>." — degrades gracefully if either date is missing.
  const parts = [];
  if (entry.created) parts.push(`is written on ${escapeHtml(entry.created)}`);
  if (entry.updated) parts.push(`updated ${escapeHtml(entry.updated)}`);

  const clause = parts.length
    ? `This article ${parts.join(", and ")} by ${escapeHtml(AUTHOR)}.`
    : `This article is written by ${escapeHtml(AUTHOR)}.`;

  // "running" (/entry): pulled out of the flow entirely by CSS
  // (position: running()) into page 1's margin box — real reserved
  // layout space, can't overlap body text, no JS involved.
  //
  // "plain" (/contents): every entry is concatenated into ONE shared
  // Paged.js document there, so a per-entry "pin to the bottom of
  // THIS entry's first page" has no reliable implementation — the
  // native trick above only ever matches the very first page of the
  // WHOLE flow (no "first page of this section" selector exists in
  // the spec), and the JS alternative (absolutely position it, detect
  // overlap after the fact, insert a forced page-break to dodge it)
  // was tried and repeatedly corrupted pagination across the whole
  // multi-entry flow — the same failure mode a negative CSS offset
  // caused earlier, just from a different angle. Plain in-flow content
  // is what's actually reliable: it sits under the title instead of at
  // the page bottom, a real (visible) difference from /entry, traded
  // for /contents' column/page breaks staying correct.
  const modeClass = mode === "running" ? "byline-footer--running" : "";
  return `<p class="byline-footer ${modeClass}">${clause}</p>`;
}

function renderEntryBody(entry, { mode }) {
  const byline = renderByline(entry, { mode });
  const bodyMain = `
    <main class="body">
      ${entry.bodyHtml.replace(
        '<section class="references"',
        `<section class="references" data-ref-for="${escapeHtml(entry.slug)}"`
      )}
    </main>
  `;

  return `
    <h1 class="title">${escapeHtml(entry.title)}</h1>

    ${mode === "running" ? byline : ""}

    ${entry.teaserHtml ? `<div class="teaser-slot">${entry.teaserHtml}</div>` : ""}

    ${bodyMain}

    ${mode === "running" ? "" : byline}
  `;
}

async function renderEntryPage(entry) {
  const articleHtml = `
      <article class="paper">
        ${renderEntryBody(entry, { mode: "running" })}
      </article>
    `;
  // Only the HTML actually handed to Paged.js gets its raw-GitHub PNGs
  // swapped for local placeholders.
  const pagedArticleHtml = await preparePagedImagePlaceholders(articleHtml);

  const bodyHtml = `
  ${renderEdgeControls({ href: HOME_PATH, showBack: false, showToggle: true })}

  <div class="entry-page">
    <template id="pagedjs-source">${pagedArticleHtml}</template>
    <div id="pagedjs-target"></div>
  </div>`;

  return pageShell({ title: entry.title, bodyHtml, bodyClass: "page-entry", paginated: true });
}

// "/" and "/contents" are the only routes that let someone browse
// every published entry — that's why they live at HOME_PATH instead
// of a guessable path. A single entry's own /entry/:hash link (and
// /static/*) is unaffected either way.
app.get(HOME_PATH, async (_req, res) => {
  try {
    const entries = await listEntries();
    res.type("html").send(renderHomePage(entries));
  } catch (error) {
    res.status(500).type("text").send(`Could not list entries from ${entrySource.label}\n\n${error.stack || error}`);
  }
});

app.get(CONTENTS_PATH, async (_req, res) => {
  try {
    const entries = await listEntries();
    res.type("html").send(await renderContentsPage(entries));
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
    res.type("html").send(await renderEntryPage(entry));
  } catch (error) {
    res.status(500).type("text").send(`Could not render entry\n\n${error.stack || error}`);
  }
});

if (entrySource.liveReload) {
  const watchTargets = [
    entrySource.rootDir,
    path.join(__dirname, "static", "journal.css")
  ];

  chokidar.watch(watchTargets, { ignoreInitial: true }).on("all", (_event, filePath) => {
    if (filePath && filePath.endsWith(".md")) {
      entryCache.delete(path.relative(entrySource.rootDir, filePath));
    }
    notifyReload();
  });
}

// Running directly (`node server.js` / `npm run dev`) starts a local
// server. Deployed on Vercel, `api/index.js` imports `app` instead and
// Vercel handles listening, so this block never runs there.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}${HOME_PATH}`;
    console.log(`Journal: ${url}`);
    console.log(`Source:  ${entrySource.label}`);
    if (HOME_PATH !== "/") console.log(`(HOME_PATH set — plain "/" won't show the journal)`);

    if (process.env.NO_OPEN !== "1") {
      const opener = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "start \"\""
        : "xdg-open";
      exec(`${opener} ${url}`);
    }
  });
}

export default app;
