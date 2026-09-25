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
// browse the journal. Nothing meant to be shared out — a single
// entry's /entry/<hash> link, or a tag's /contents/<tag> link (dream
// or not) — ever depends on this: CONTENTS_PATH is always the plain
// top-level "/contents", never prefixed with HOME_PATH, so pasting
// one of those URLs elsewhere can't leak the secret home path.
const HOME_PATH = process.env.HOME_PATH || "/";
const CONTENTS_PATH = "/contents";

// Built-in metadata: does not need to exist in Markdown.
const AUTHOR = "Ziru Wei";

// Optional PAT for a private image-hosting repo (may be a different
// GitHub account/repo entirely from GITHUB_TOKEN's content repo — see
// /img/:id below). Unset means unauthenticated fetches, which only
// works for images that are actually public.
const IMAGE_GITHUB_TOKEN = process.env.IMAGE_GITHUB_TOKEN || "";

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

// Proxies a private-repo image by opaque id — see "Private image
// proxy" further down for how ids get registered. The real GitHub URL
// never reaches the client: this fetches it server-side (with
// IMAGE_GITHUB_TOKEN, if the image repo needs auth) and streams the
// bytes back under this app's own domain instead.
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
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    res.status(502).type("text").send(`Could not fetch image\n\n${error.stack || error}`);
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

function toTitleCase(text) {
  const tokens = text.split(/(\s+)/);
  const wordIndices = [];
  tokens.forEach((token, i) => {
    if (token && !/^\s+$/.test(token)) wordIndices.push(i);
  });
  if (!wordIndices.length) return text;
  const firstWordIndex = wordIndices[0];
  const lastWordIndex = wordIndices[wordIndices.length - 1];

  return tokens.map((token, i) => {
    if (!token || /^\s+$/.test(token)) return token;
    const lower = token.toLowerCase();
    const isEdge = i === firstWordIndex || i === lastWordIndex;
    if (TITLE_CASE_SMALL_WORDS.has(lower) && !isEdge) return lower;
    return token.charAt(0).toUpperCase() + token.slice(1);
  }).join("");
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

// --- Private image proxy ----------------------------------------------
//
// Every raw.githubusercontent.com <img src> is swapped, in
// postProcessMarkdown below, for an opaque same-origin URL
// (/img/<id>) — the point being that a visitor should never see
// "github.com", an owner name, or a repo name anywhere: not in page
// source, not in the Network tab, not after the browser actually
// fetches the image. imageProxyMap remembers id -> the real URL (and
// whether it's a PNG, for the pagination-placeholder machinery below)
// for the lifetime of the process; the /img/:id route fetches the real
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

// --- Managed remote PNG placeholders for Paged.js pagination ---------
//
// Paged.js can stall generating a page while an <img> on it still has
// unknown/unfinished layout, and a raw-GitHub PNG can take a while to
// arrive. Rather than let pagination wait on the network, matching
// <img>s get swapped — only in the HTML handed to Paged.js, never in
// the Markdown renderer's own output or the home page's waterfall
// thumbnails — for a same-aspect-ratio inline SVG placeholder with the
// real, pre-resolved width/height already set, so pagination only ever
// waits on a local, instantly-resolving image. The proxy URL (kept on
// data-real-src, NOT the real GitHub one — that never reaches the
// client at all) is restored client-side once pagination has fully
// settled — see hydratePagedImages in pageShell's script below.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// `src` here is always one of OUR OWN /img/<id> proxy URLs by this
// point (postProcessMarkdown already swapped every raw-GitHub <img>
// before this ever runs) — never a real raw.githubusercontent.com one.
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

function pngPlaceholderDataUri(width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Swaps every managed PNG <img src> (already one of our own /img/<id>
// proxy URLs by this point — see isGithubRawUrl/registerImageProxy) in
// `html` for a local, same-aspect-ratio, visually-transparent SVG
// placeholder — used only on the HTML assembled for Paged.js on
// paginated /entry and /contents views (see renderEntryPage/
// renderContentsPage). Images whose dimensions can't be resolved
// (non-PNG, unmanaged, network failure) are left completely unchanged.
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

// Inline margin-comment tokens. The annotated text can sit on EITHER
// side of the {>>{json}@@comment<<} envelope — both are written in
// the wild:
//   %%<annotated text>{>>{"author":"...","time":...}@@<comment><<}%%
//   %%{>>{"author":"...","time":...}@@<comment><<}<annotated text>%%
// Same envelope as the %%REF...%% citation token, but with real text
// (left exactly as-is, still plain Markdown) on one side instead of a
// fixed "REF" keyword — so this only ever runs AFTER
// expandInlineRefTokens has already replaced every %%REF...%%
// occurrence, or it would swallow those too. The JSON blob is metadata
// only (author/time) and is discarded, same as for citations.
// Numbered independently from References (own counter) in
// postProcessMarkdown; the comment's own text renders directly, small,
// in the page's outer margin — no hover needed to read it. See
// .comment-marker/.comment-margin-marker in journal.css.
const COMMENT_TOKEN_RE = /%%(.*?)\{>>(\{[^{}]*\})@@(.*?)<<\}(.*?)%%/gs;

function expandInlineCommentTokens(markdown) {
  return markdown.replace(COMMENT_TOKEN_RE, (_match, textBefore, _meta, comment, textAfter) => {
    const text = textBefore + textAfter;
    const trimmedComment = comment.trim();
    if (!trimmedComment) return text;
    return `${text}<sup class="comment-marker"><span class="comment-number"></span><span class="comment-margin-marker" data-comment="${escapeHtml(trimmedComment)}"></span></sup>`;
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
  const title = firstH1.length ? toTitleCase(firstH1.text().trim()) : "Untitled";
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

  // Every remaining heading in the body (h2–h6 — h1 was already pulled
  // out above) gets the same Title Case treatment.
  root.find("h2, h3, h4, h5, h6").each((_, h) => {
    const $h = $(h);
    $h.text(toTitleCase($h.text()));
  });

  // Every raw-GitHub <img src> becomes an opaque /img/<id> proxy URL
  // here, before anything else touches images (figure-wrapping, teaser
  // promotion, the PNG-placeholder pass) — so every downstream use
  // (body, teaser, waterfall thumbnails) only ever sees the proxy path,
  // never the real GitHub URL. See "Private image proxy" above.
  root.find("img[src]").each((_, img) => {
    const $img = $(img);
    const src = $img.attr("src");
    if (src && isGithubRawUrl(src)) {
      $img.attr("src", registerImageProxy(src));
    }
  });

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
        <ol class="reference-list">${items}</ol>
      </section>
    `);
  }

  // Margin comments (%%text{>>{...}@@comment<<}%%): numbered
  // independently from References, in document order — each gets a
  // small superscript in the flowing text, plus its own comment text
  // rendered directly (small, no hover needed) in the page's outer
  // margin, both pinned via CSS relative to the <sup> itself (not
  // JS-measured, since the latter has a history of corrupting Paged.js
  // pagination in this app — see setupTouchBook/the References-overlap
  // comments elsewhere). No bottom list.
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
  const rendered = md.render(expandInlineCommentTokens(expandInlineRefTokens(expandBookTitles(content))));
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
    title: title !== "Untitled" ? title : toTitleCase(path.basename(id, path.extname(id))),
    teaserHtml,
    excerpt,
    bodyHtml,
    published: publishId !== null,
    created: normalizeDate(data.created),
    updated: normalizeDate(data.updated),
    tags: data.publishTag
      ? (Array.isArray(data.publishTag) ? data.publishTag : [data.publishTag]).map(String).filter(Boolean)
      : []
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
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <!-- Source Han Serif SC (the Chinese serif in --serif, below) loads
       from Adobe/Typekit, not Google Fonts — it's a large CJK family
       (thousands of glyphs) so it's inherently slow relative to a
       Latin webfont, but two real, fixable chunks of that latency are
       the DNS/TLS handshake to Adobe's CDN (paid for here, before the
       loader script even runs) and the loader script itself only
       starting to fetch once this inline script executes and appends
       it — a <link rel=preload> lets the browser's preload scanner
       discover and start that same fetch in parallel while still
       parsing the rest of <head>, well before this script block runs
       at all; the inline loader's own dynamically-created <script>
       tag then just reuses that already-in-flight (or already cached)
       request instead of starting a fresh one. -->
  <link rel="preconnect" href="https://use.typekit.net" />
  <link rel="preconnect" href="https://p.typekit.net" crossorigin />
  <link rel="preload" href="https://use.typekit.net/vlg3xva.js" as="script" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+SC:wght@300;400;500;600;700&family=Libre+Baskerville:ital,wght@0,400..700;1,400..700&family=Source+Serif+4:ital,opsz,wght@0,8..60,200..900;1,8..60,200..900&display=swap" rel="stylesheet" />
  <script>
    (function(d) {
      var config = {
        kitId: 'vlg3xva',
        scriptTimeout: 3000,
        async: true
      },
      h=d.documentElement,t=setTimeout(function(){h.className=h.className.replace(/\\bwf-loading\\b/g,"")+" wf-inactive";},config.scriptTimeout),tk=d.createElement("script"),f=false,s=d.getElementsByTagName("script")[0],a;h.className+=" wf-loading";tk.src='https://use.typekit.net/'+config.kitId+'.js';tk.async=true;tk.onload=tk.onreadystatechange=function(){a=this.readyState;if(f||a&&a!="complete"&&a!="loaded")return;f=true;clearTimeout(t);try{Typekit.load(config)}catch(e){}};s.parentNode.insertBefore(tk,s)
    })(document);
  </script>
  <link rel="stylesheet" href="/static/journal.css" />
  <link rel="stylesheet" href="/static/print.css" media="print" />
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
      const tocDialog = document.getElementById("toc-dialog");
      if (!source || !target) return;

      // Opt-in overlay for diagnosing pagination/teaser lifecycle bugs
      // — only active with ?debugPaged=1 in the URL, otherwise a no-op.
      // Not wired into any behavior; purely observational.
      const debugPaged = new URLSearchParams(location.search).has("debugPaged");

      function pagedDebug(label, root) {
        if (!debugPaged) return;

        // For the "source" stage, the caller passes source.content —
        // <template> contents live in their own DocumentFragment and
        // are invisible to a normal document.querySelectorAll(). Every
        // other stage queries the live document (default), where the
        // generated .pagedjs_page nodes actually live.
        const scope = root || document;
        const pages = [...scope.querySelectorAll(".pagedjs_page")];
        const teasers = [...scope.querySelectorAll(".teaser-figure")];
        const teaserImgs = [...scope.querySelectorAll(".teaser-figure img")];

        const lines = [
          \`\${label}\`,
          \`pages=\${pages.length}\`,
          \`teasers=\${teasers.length}\`,
          \`teaserImgs=\${teaserImgs.length}\`,
          ...pages.map((page, i) => {
            const titleCount = page.querySelectorAll(".title").length;
            const pageTeasers = page.querySelectorAll(".teaser-figure").length;
            const pageTeaserImgs = page.querySelectorAll(".teaser-figure img").length;
            const bodyEls = page.querySelectorAll("main.body, .body");
            const bodyH = bodyEls[0]
              ? String(Math.round(bodyEls[0].getBoundingClientRect().height))
              : "-";
            const contentEl = page.querySelector(".pagedjs_page_content");
            const contentH = contentEl
              ? String(Math.round(contentEl.getBoundingClientRect().height))
              : "-";
            const splitEl = page.querySelector("[data-split-from], [data-split-to]");
            const splitFrom = splitEl ? splitEl.getAttribute("data-split-from") : null;
            const splitTo = splitEl ? splitEl.getAttribute("data-split-to") : null;
            const split = (splitFrom || splitTo) ? \`\${splitFrom || "-"}->\${splitTo || "-"}\` : "-";
            // No regex here on purpose — a backslash-escape sequence
            // like \\s written directly in this file would be consumed
            // by the OUTER server-side template literal's own escaping
            // (the same class of bug \\n caused earlier) before the
            // client ever sees it. split/join sidesteps that entirely.
            const normalized = (page.textContent || "")
              .split(String.fromCharCode(10)).join(" ")
              .split(String.fromCharCode(9)).join(" ")
              .trim();
            const text = normalized.slice(0, 80);
            return \`page=\${i} title=\${titleCount} teaser=\${pageTeasers} teaserImgs=\${pageTeaserImgs} body=\${bodyEls.length} bodyH=\${bodyH} contentH=\${contentH} split=\${split} text="\${text}"\`;
          })
        ];

        let box = document.getElementById("paged-debug-overlay");
        if (!box) {
          box = document.createElement("pre");
          box.id = "paged-debug-overlay";
          Object.assign(box.style, {
            position: "fixed",
            top: "8px",
            left: "8px",
            zIndex: 99999,
            maxWidth: "90vw",
            maxHeight: "40vh",
            overflow: "auto",
            margin: 0,
            padding: "8px",
            background: "rgba(0,0,0,.8)",
            color: "#fff",
            font: "11px/1.35 monospace",
            whiteSpace: "pre-wrap"
          });
          document.body.appendChild(box);
        }

        box.textContent += String.fromCharCode(10, 10) +
          lines.join(String.fromCharCode(10));
      }

      pagedDebug("source", source.content);

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

      // Single-page mode: the page zoomed to fill the viewport, capped
      // by whichever of width/height is tighter — height-only fit
      // (the old formula) could overflow past the bottom of narrower/
      // shorter windows with nothing to scroll it back into view.
      function applySinglePageZoom() {
        const scale = Math.min(
          viewportWidth() / NOMINAL_WIDTH,
          stableViewportHeight() / NOMINAL_HEIGHT
        );
        target.querySelectorAll(".pagedjs_page").forEach(page => {
          page.style.zoom = scale;
        });
      }

      // Double-page mode: the pair zoomed together (not per-page — they
      // need to shrink/grow as one unit to stay the same size as each
      // other) to fill the available space — same width-or-height cap
      // as applySinglePageZoom, so a wide-but-short window can't zoom
      // past the viewport's actual height (this used to be width-fit
      // only, the same bug applySinglePageZoom had).
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
        const scale = Math.min(
          target.clientWidth / (NOMINAL_WIDTH * 2),
          stableViewportHeight() / NOMINAL_HEIGHT
        );
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
      // Defaults to true (matching the old #spread-toggle button's
      // default "is-on" state) — there's no button anymore to read an
      // initial value from.
      let wantsSpread = true;

      // Desktop pager: exactly one page (or one spread's worth, in
      // double-page mode) is ever visible — everything else just sits
      // display:none. No scrolling, no lock, no custom zoom: with only
      // the current page/spread ever on screen, native pinch/Ctrl-zoom
      // is safe again (there's nothing adjacent to accidentally scroll
      // into), so it's left completely alone here.
      let currentUnit = 0;

      function unitSize() {
        return wantsSpread ? 2 : 1;
      }

      function unitPages(index) {
        const pages = Array.from(target.querySelectorAll(".pagedjs_page"));
        const size = unitSize();
        return pages.slice(index * size, index * size + size);
      }

      function unitCount() {
        const pages = target.querySelectorAll(".pagedjs_page").length;
        return Math.max(1, Math.ceil(pages / unitSize()));
      }

      // "01/09"-style page number, one per .pagedjs_page (not a single
      // shared overlay) — appended once pagination is fully final (see
      // createPageIndicators below), each showing THAT page's own
      // real position/total. Static per page, not live: a CSS counter
      // would skip display:none elements entirely (exactly why the
      // old @page @bottom-center counter(page) was stuck on "1"/"2"),
      // and a single shared overlay only ever showed the first page of
      // whatever unit was current, which is wrong for the second page
      // of a double-page spread. Being real per-page content instead
      // of a fixed-position screen overlay also means it survives
      // print's display:block override for free — no separate
      // print-only visibility rule needed.
      function createPageIndicators() {
        const pages = Array.from(target.querySelectorAll(".pagedjs_page"));
        const total = pages.length;
        const digits = Math.max(2, String(total).length);
        const pad = n => String(n).padStart(digits, "0");
        pages.forEach((page, i) => {
          const label = document.createElement("div");
          label.className = "page-number";
          label.setAttribute("aria-hidden", "true");
          label.textContent = pad(i + 1) + "/" + pad(total);
          page.appendChild(label);
        });
      }

      function showUnit(index) {
        currentUnit = Math.min(Math.max(index, 0), unitCount() - 1);
        const visible = new Set(unitPages(currentUnit));
        target.querySelectorAll(".pagedjs_page").forEach(p => {
          p.style.display = visible.has(p) ? "" : "none";
        });
      }

      // No #spread-toggle button anymore (removed along with the rest
      // of the side edge-controls) — '/' drives this directly instead
      // of dispatching a click.
      function toggleSpread() {
        const oldSize = unitSize();
        wantsSpread = !wantsSpread;
        target.classList.toggle("spread-mode", wantsSpread);
        fitSpreadWidth();
        // Same index-remapping trick setupTouchBook's tablet-rotation
        // handler uses when its own perScreen changes — keeps roughly
        // the same content in view across the single/double regroup
        // instead of snapping back to page 1.
        showUnit(Math.floor(currentUnit * oldSize / unitSize()));
      }

      if (!isTouchBook) {
        window.addEventListener("resize", () => {
          if (target.classList.contains("spread-mode")) {
            fitSpreadWidth();
          } else {
            applySinglePageZoom();
          }
        });
      }

      // Finds which page a /contents entry (marked with id="card-
      // <slug>" — see renderContentsPage) starts on, and jumps the
      // pager straight to its unit. Paged.js clones a split element's
      // attributes (including id) onto every page fragment it spans —
      // same fact the existing data-ref-for lookup already relies on —
      // so querySelector here reliably lands on the entry's first page
      // in document order even if the id is duplicated across later
      // fragments of the same (long) entry.
      function jumpToEntry(slug) {
        const marker = target.querySelector("#card-" + CSS.escape(slug));
        const page = marker && marker.closest(".pagedjs_page");
        if (!page) return;
        const pages = Array.from(target.querySelectorAll(".pagedjs_page"));
        const pageIndex = pages.indexOf(page);
        if (pageIndex === -1) return;
        showUnit(Math.floor(pageIndex / unitSize()));
      }

      if (tocDialog) {
        tocDialog.querySelectorAll("[data-jump]").forEach(btn => {
          btn.addEventListener("click", () => {
            jumpToEntry(btn.dataset.jump);
            tocDialog.close();
          });
        });
        tocDialog.addEventListener("click", (e) => {
          const r = tocDialog.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
            tocDialog.close();
          }
        });
      }

      // '/' toggles single/double page. 'a'/ArrowLeft/(physical) Left
      // Shift move to the previous page or spread; 'd'/ArrowRight/
      // Right Shift move to the next. Space opens/closes the TOC
      // popup where one exists (/contents only — no-op on /entry,
      // which has no tocDialog). A trackpad swipe also flips a page —
      // see the wheel listener below, added after this keydown one —
      // except while zoomed in, where the same gesture pans instead,
      // until it hits the left/right edge of what's pannable. While
      // the TOC popup is open, only Space (to close it) is handled —
      // navigation/'/' underneath are ignored so they can't silently
      // change pages behind the open popup.
      if (!isTouchBook) {
        document.addEventListener("keydown", (e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return;

          const active = document.activeElement;
          const activeTag = (active && active.tagName) || "";
          if (activeTag === "INPUT" || activeTag === "TEXTAREA" || active?.isContentEditable) return;

          if (e.code === "Space" || e.key === " ") {
            if (!tocDialog) return;
            e.preventDefault();
            if (tocDialog.open) {
              tocDialog.close();
            } else {
              tocDialog.showModal();
            }
            return;
          }

          if (tocDialog && tocDialog.open) {
            // 'w'/'s' move focus up/down among the TOC items — Space
            // is already taken (closes the dialog), so Enter is what
            // actually activates the focused item, via the button's
            // own native keyboard handling (untouched here).
            const isUp = e.key === "w" || e.key === "W";
            const isDown = e.key === "s" || e.key === "S";
            if (isUp || isDown) {
              e.preventDefault();
              const items = Array.from(tocDialog.querySelectorAll("[data-jump]"));
              if (items.length) {
                const current = items.indexOf(document.activeElement);
                const next = current === -1
                  ? (isDown ? 0 : items.length - 1)
                  : Math.max(0, Math.min(items.length - 1, current + (isDown ? 1 : -1)));
                items[next].focus();
              }
            }
            return;
          }

          if (e.key === "/") {
            e.preventDefault();
            toggleSpread();
            return;
          }

          const isPrev = e.key === "a" || e.key === "A" || e.key === "ArrowLeft" || e.code === "ShiftLeft";
          const isNext = e.key === "d" || e.key === "D" || e.key === "ArrowRight" || e.code === "ShiftRight";
          if (isPrev || isNext) {
            e.preventDefault();
            showUnit(currentUnit + (isNext ? 1 : -1));
          }
        });

        // Trackpad two-finger swipe reports as a wheel event with a
        // horizontal (deltaX) component. While zoomed in (native
        // pinch-zoom — never managed by this app's own JS), the
        // gesture is left completely alone so it can pan the zoomed
        // view. While not zoomed, the first clearly horizontal event
        // (deltaX bigger than deltaY) flips a page immediately — no
        // threshold, no accumulation.
        //
        // Guaranteeing one flip per swipe needs actually knowing when
        // the swipe ends, which a fixed-duration cooldown can't do —
        // a real swipe plus its trackpad inertia commonly outlasts
        // any reasonable fixed guess, which is how a single swipe
        // flipped through several pages before. So the lock instead
        // releases on a genuine gap in wheel events (inertia has
        // actually finished), however long that takes. The one
        // exception: a CLEAR direction reversal releases it
        // immediately — otherwise a quick "flip back" swipe started
        // while the previous swipe's inertia was still fading would
        // just get swallowed by the lock that old gesture was still
        // holding, since its own trailing events keep pushing the
        // idle timer back out.
        let flipLocked = false;
        let lockedDirection = 0;
        let gestureIdleTimer = null;
        const GESTURE_IDLE_GAP = 150;

        window.addEventListener("wheel", (e) => {
          if (e.ctrlKey) return;
          if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
          if (tocDialog && tocDialog.open) return;

          const vv = window.visualViewport;
          // Trackpad pinch-zoom is analog — zooming back out rarely
          // lands exactly on 1.0, so a tight threshold here left the
          // page thinking it was still zoomed (and so ignoring every
          // swipe for flipping, routing it all to "let it pan"
          // instead) well after it visually looked back to normal.
          if (vv && vv.scale > 1.05) return; // zoomed in — leave the gesture alone entirely, let it pan

          e.preventDefault();

          // A single continuous swipe's own natural acceleration
          // ramp-up (start) or deceleration (tail) can occasionally
          // report one tiny, sign-flipped delta even though the
          // gesture is logically one-directional throughout — with
          // zero noise tolerance, that got misread as a genuine
          // reversal, instantly unlocking and firing a second flip
          // the opposite way. Net effect: flip forward, immediately
          // flip back (or the reverse) — looks exactly like swiping
          // that direction "does nothing", and which direction it
          // cancels out depends on which way the noise happened to
          // point that time. A small noise floor on the delta used
          // for direction — not a distance-to-accumulate gate, still
          // reacts on the first real event — filters this out.
          if (Math.abs(e.deltaX) < 4) return;

          const dir = Math.sign(e.deltaX);
          if (flipLocked && dir !== lockedDirection) {
            flipLocked = false;
          }

          clearTimeout(gestureIdleTimer);
          gestureIdleTimer = setTimeout(() => { flipLocked = false; }, GESTURE_IDLE_GAP);

          if (flipLocked) return;

          // Already at the first/last page and swiping further that
          // way: showUnit() clamps and nothing visibly changes, but
          // the lock would still engage for the full idle-gap window
          // regardless — feeling exactly like "stuck" even though the
          // swipe itself did nothing wrong. Only lock when the page
          // actually changed.
          const before = currentUnit;
          showUnit(currentUnit + (dir > 0 ? 1 : -1));
          if (currentUnit === before) return;

          lockedDirection = dir;
          flipLocked = true;
        }, { passive: false });
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
            // Debug-only bookkeeping (see pagedDebug above) — not read
            // by any layout/scroll logic here.
            slide.dataset.slideIndex = String(i / perScreen);
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
        // /contents/:tag lists entries oldest-first (see
        // renderContentsPage) but should open on the newest entry's
        // own TITLE slide, not just "the final slide" — for a multi-
        // page latest entry those aren't the same thing, since the
        // final slide lands wherever that entry's own content happens
        // to end, past its title. Finding the slide that contains the
        // newest entry's own marker (id="card-<slug>", still present
        // regardless of the regrouping above, which only moves the
        // .pagedjs_page elements themselves) via data-latest-slug
        // (embedded server-side, see renderContentsPage) gets the
        // actual title slide regardless of how long that entry is —
        // falling back to the last slide only if that lookup fails.
        // /entry/:slug has no data-latest-slug at all, so it still
        // opens on the first slide as before.
        if (document.body.classList.contains("page-contents")) {
          const latestSlug = document.querySelector(".entry-page")?.dataset.latestSlug;
          const marker = latestSlug && target.querySelector("#card-" + CSS.escape(latestSlug));
          const slide = marker && marker.closest(".touch-slide");
          const slides = Array.from(track.querySelectorAll(".touch-slide"));
          const slideIndex = slide ? slides.indexOf(slide) : -1;
          currentSlide = slideIndex !== -1 ? slideIndex : Math.max(0, slides.length - 1);
          track.scrollLeft = currentSlide * viewportWidth();
        }
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
        pagedDebug("after setupTouchBook");
        document.documentElement.classList.remove("touch-pending");
      }

      // Desktop counterpart to activateTouchBook() — same timing
      // (final page DOM fully known, called once), same idea (turn on
      // the reader's real presentation right before reveal): adds
      // .desktop-pager (see journal.css — kills scroll entirely) and
      // shows page/spread 1.
      let desktopPagerActivated = false;
      function activateDesktopPager() {
        if (isTouchBook || desktopPagerActivated) return;
        desktopPagerActivated = true;

        document.documentElement.classList.add("desktop-pager");
        // /contents/:tag lists entries oldest-first (see
        // renderContentsPage) but should open on the newest entry's
        // own TITLE page, not just "the final page of the whole
        // document" — for a multi-page latest entry those aren't the
        // same thing, since the final page lands wherever that
        // entry's own content happens to end, past its title. Reusing
        // jumpToEntry (same lookup the TOC popup's own links use) via
        // the newest entry's slug (embedded server-side as
        // data-latest-slug, see renderContentsPage) gets the actual
        // title page regardless of how long that entry is.
        // /entry/:slug has no such "oldest to newest" concept (it's
        // one entry's own pages) and has no data-latest-slug at all,
        // so it still opens on the first unit as before.
        const latestSlug = document.querySelector(".entry-page")?.dataset.latestSlug;
        if (latestSlug) {
          jumpToEntry(latestSlug);
        } else {
          showUnit(0);
        }
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
      // time. The one-page fallback never touches \`wantsSpread\` itself,
      // so if a later corrected render turns out to have multiple pages
      // after all, the user's actual intended (or default) spread state
      // comes back automatically.
      function applyDesktopPageLayout() {
        const pageCount = target.querySelectorAll(".pagedjs_page").length;
        if (pageCount <= 1) {
          // Nothing to spread — a single page has no facing page to
          // sit beside, so default to single-page regardless of
          // wantsSpread.
          target.classList.remove("spread-mode");
          applySinglePageZoom();
          return;
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

      // References are position:absolute (bottom-right of the page),
      // so they take zero space in the flow — Paged.js can place body
      // text right where the references will render. A second
      // preview() pass to detect and fix that was tried and abandoned
      // (it corrupts Paged.js output on every engine).
      //
      // Two different fixes for two different contexts:
      // - Non-dream /contents/:tag: a plain .references (bottom-right
      //   of the page) sharing a page with a two-entry (or longer)
      //   flow is where this actually broke in practice — an in-flow
      //   spacer sized from a real measurement of .reference-list
      //   still overlapped in confirmed cases (references at the very
      //   end of the whole document — Paged.js's own overflow
      //   handling for a content-less trailing spacer didn't reliably
      //   force a fresh page the way ordinary text overflow does), and
      //   a post-hoc shrink-to-fit made the text illegibly small. So
      //   this context just forces every .references onto its own
      //   fresh page — the guaranteed-correct fix, at the cost of a
      //   page that would otherwise have had room to spare.
      // - Everywhere else (/entry/:slug, any mode) — unchanged,
      //   dream's inline references are unaffected either way (never
      //   matched by :not(.references--inline) below): the measured
      //   spacer, since a single entry's own references overlapping
      //   its own tail hasn't been the confirmed-broken case.
      {
        const scratch = document.createElement("div");
        scratch.innerHTML = source.innerHTML;

        const isNonDreamContentPage =
          document.body.classList.contains("page-contents") &&
          !document.body.classList.contains("page-dream");

        if (isNonDreamContentPage) {
          scratch.querySelectorAll(".references:not(.references--inline)").forEach(ref => {
            const breaker = document.createElement("div");
            breaker.className = "force-page-break";
            breaker.setAttribute("aria-hidden", "true");
            ref.parentNode.insertBefore(breaker, ref);
          });
        } else {
          // 150 is --pad-x from journal.css (@page's own parser can't
          // resolve custom properties, so that file already keeps this
          // value as a hand-synced literal — same reasoning applies
          // here). .references' own width:45% is relative to the
          // page's CONTENT box (NOMINAL_WIDTH minus both side
          // margins), not the full page width.
          const PAD_X = 150;
          const referencesWidth = (NOMINAL_WIDTH - PAD_X * 2) * 0.45;

          const measureBox = document.createElement("div");
          measureBox.style.cssText =
            "position:fixed;left:-99999px;top:0;visibility:hidden;" +
            "width:" + referencesWidth + "px;";
          document.body.appendChild(measureBox);

          scratch.querySelectorAll(".references:not(.references--inline)").forEach(ref => {
            const list = ref.querySelector(".reference-list");
            if (!list) return;
            measureBox.innerHTML = list.outerHTML;
            const listHeight = measureBox.firstElementChild.offsetHeight;
            // .references::before's own 3em gap, at the font-size it
            // actually inherits (--body-size, 11.5px) — plus a small
            // safety margin.
            const h = Math.round(3 * 11.5 + listHeight + 10);

            const spacer = document.createElement("div");
            spacer.className = "references-spacer";
            spacer.style.height = h + "px";
            spacer.setAttribute("aria-hidden", "true");
            ref.parentNode.insertBefore(spacer, ref);
          });

          measureBox.remove();
        }

        source.innerHTML = scratch.innerHTML;
      }

      // Same fixed 850x1100 @page stylesheet on every device — pagination
      // geometry never changes with screen shape (see setupTouchBook).
      const pageStylesheets = ["/static/journal.css"];

      // No progressive/early reveal, on desktop or touch: the whole
      // reader stays hidden under .paged-loading (desktop)/
      // .touch-pending (touch) until pagination is fully final. Once
      // only one page/spread is ever shown at a time, there's no
      // benefit to revealing page 1 mid-pagination (the eventual page
      // count can still change what "unit 1" even contains), and
      // touching the pager's page-list mid-run reopens exactly the
      // kind of DOM-mutation-during-pagination corruption the touch
      // viewer already avoids by waiting for the final page DOM.
      const previewer = new Paged.Previewer();
      await previewer.preview(source.innerHTML, pageStylesheets, target);
      pagedDebug("after first preview");

      // Dream mode's continuous flow (.dream-entry has no forced
      // break-before, unlike the fresh-page-per-entry .spread) can
      // still land a title alone at the bottom of a page with its
      // whole entry pushed to the next one — confirmed via an actual
      // print: break-after/break-before: avoid-page on .title/.body
      // did NOT stop it, so this isn't a wrong CSS value, it's Paged.js's
      // own chunker not honoring that hint across a multi-column
      // sibling boundary. Same class of problem as the .references
      // overlap issue elsewhere in this file, and the same fix shape:
      // detect it after the one and only preview() pass, then fix the
      // DOM directly — no second preview() pass (confirmed elsewhere
      // in this file to corrupt WebKit's output), just relocating an
      // already-placed element between two already-existing pages.
      function fixOrphanedDreamTitles() {
        // Paged.js clones .dream-entry (and .paper) PER PAGE when an
        // entry spans more than one — so title.closest(".dream-entry")
        // is only ITS page's clone, and wrapper.querySelector(".body")
        // returns null whenever .body landed in a different clone on
        // a different page — which is exactly, and only, the orphan
        // case this function exists to fix. That made an earlier
        // version silently no-op every real orphan it found. Finding
        // .body by document order instead of by ancestor lookup
        // sidesteps the whole cloning problem: entries flow strictly
        // sequentially, so the first .body anywhere in the document
        // that comes AFTER a given element is necessarily that same
        // entry's own body, regardless of which clone either one
        // ended up in.
        //
        // A later version tried to move title's whole remaining
        // sibling list (title + whatever else, e.g. a teaser image,
        // sat after it in its own pre-move parent) in one step — but
        // that assumed title's own parent at that point contains
        // ONLY this entry's own leftover content, which isn't
        // guaranteed (still confirmed broken, especially where an
        // entry's continuation gets wrapped/positioned differently —
        // touch's slide grouping runs later and doesn't affect this,
        // but the underlying per-page cloning it's built on top of
        // clearly isn't as uniform as that assumed). Reuniting title
        // and any teaser with .body as two independent, identically-
        // verified moves — each found by the same document-order
        // lookup, each only moved if it's actually on a different
        // page than .body — has no assumption about what else shares
        // either element's current parent to get wrong.
        const allBodies = Array.from(target.querySelectorAll(".dream-entry .body"));

        function ownBody(el) {
          return allBodies.find(b => el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        }

        function reuniteWithBody(el) {
          const body = ownBody(el);
          if (!body) return;
          const elPage = el.closest(".pagedjs_page");
          const bodyPage = body.closest(".pagedjs_page");
          if (!elPage || !bodyPage || elPage === bodyPage) return;
          body.parentNode.insertBefore(el, body);
        }

        // Title first, so it lands immediately before .body — then
        // the teaser (if any), which lands immediately before
        // whatever's now right in front of .body (title, just
        // placed) — reconstructing the original title/teaser/body
        // order regardless of which page(s) either one started on.
        target.querySelectorAll(".dream-entry .title").forEach(reuniteWithBody);
        target.querySelectorAll(".dream-entry .teaser-slot").forEach(reuniteWithBody);
      }
      fixOrphanedDreamTitles();

      // Same orphan, opposite end: the byline (created/updated date)
      // sits at the tail of .body, right before any inline references
      // — a page break can just as easily land right BEFORE it,
      // stranding it alone at the top of a fresh page with the
      // paragraph it belongs to left behind on the previous one.
      // Column breaks are separately handled by plain CSS
      // (break-before: avoid-column on .byline-footer--dream/
      // --inline, in journal.css) since those are native browser
      // multi-column layout, not Paged.js's chunker — only the
      // page-level case needs this DOM fix, for the same reason
      // fixOrphanedDreamTitles needs one above it.
      function fixOrphanedByline() {
        const pages = Array.from(target.querySelectorAll(".pagedjs_page"));
        target.querySelectorAll(".byline-footer--dream, .byline-footer--inline").forEach(byline => {
          // Body content already precedes it in this same fragment —
          // not orphaned.
          if (byline.previousElementSibling) return;

          const page = byline.closest(".pagedjs_page");
          const prevPage = pages[pages.indexOf(page) - 1];
          if (!prevPage) return;

          const bodies = prevPage.querySelectorAll(".body");
          const lastBody = bodies[bodies.length - 1];
          if (!lastBody) return;

          // Dream mode's inline references immediately follow the
          // byline in source order — if both got pushed together,
          // move them together so references don't end up newly
          // orphaned on their own right after "fixing" the byline.
          const next = byline.nextElementSibling;
          const trailingRef = next && next.classList.contains("references--inline") ? next : null;

          lastBody.appendChild(byline);
          if (trailingRef) lastBody.appendChild(trailingRef);
        });
      }
      fixOrphanedByline();

      // Margin comments used to just stack top-aligned in the page's
      // right margin, one under another, regardless of where their
      // anchor actually fell in the text — real per-line alignment was
      // "tried and abandoned" earlier specifically because measuring
      // Paged.js's own output was assumed unsafe. But every other fix
      // in this pipeline (page numbers, the title/byline orphan fixes
      // above) already treats Paged.js's finished layout as a plain,
      // external fact to read — not something to influence — and
      // measures it directly with getBoundingClientRect() rather than
      // trying to predict it. Same approach here: read each anchor's
      // real column AND vertical position, then place its note at
      // that same height in WHICHEVER margin is nearest (left column
      // → left margin, right column → right margin) — falling back to
      // pushing a note down just enough to clear whichever note is
      // directly above it IN THE SAME MARGIN when two same-side
      // anchors sit close enough that their notes would otherwise
      // overlap (a taller note "borrows" room from the gap below it,
      // same idea academic margin-note layouts use; left- and right-
      // margin notes never compete with each other), so notes are
      // guaranteed not to overlap while staying as close as possible
      // to their real anchor.
      //
      // Must run HERE, before activateDesktopPager() below sets
      // display:none on every page but the current one — that would
      // zero out getBoundingClientRect() for any comment not on that
      // one page, the same bug that broke the reference-overlap check
      // when it ran too late.
      function layoutPageComments(root) {
        root.querySelectorAll(".pagedjs_page").forEach(page => {
          const markers = Array.from(page.querySelectorAll(".comment-margin-marker"));
          if (!markers.length) return;

          const pageRect = page.getBoundingClientRect();
          const midX = pageRect.left + pageRect.width / 2;

          // Measured while still nested in the flowing text, before
          // moving anything — .comment-number is the small, stable
          // part of the anchor (the margin-marker itself still holds
          // its full comment text at this point, which would inflate
          // a measurement taken from the whole <sup>).
          const items = markers.map(marker => {
            const numberEl = marker.closest(".comment-marker")?.querySelector(".comment-number");
            const anchorRect = (numberEl || marker).getBoundingClientRect();
            return {
              marker,
              top: anchorRect.top - pageRect.top,
              side: anchorRect.left < midX ? "left" : "right",
            };
          });

          const stack = document.createElement("div");
          stack.className = "page-comments";
          // Appended directly onto .pagedjs_page itself (not a nested
          // Paged.js-internal box whose own positioning behavior isn't
          // guaranteed) — journal.css gives .pagedjs_page an explicit
          // position:relative for exactly this, so .page-comments's
          // position:absolute is unambiguously anchored to this one
          // physical page, regardless of how many pages exist.
          page.appendChild(stack);
          items.forEach(item => {
            item.marker.classList.add("comment-margin-marker--" + item.side);
            stack.appendChild(item.marker);
          });

          const GAP = 6;
          ["left", "right"].forEach(side => {
            let cursor = 0;
            items.filter(item => item.side === side).forEach(item => {
              const top = Math.max(item.top, cursor);
              item.marker.style.top = top + "px";
              cursor = top + item.marker.offsetHeight + GAP;
            });
          });
        });
      }
      layoutPageComments(target);

      finishUp();
      // Both must run BEFORE revealPagedReader() — otherwise the
      // reader would flash the old fully-stacked, unnumbered layout
      // for a frame before the pager hides everything but the current
      // unit. Safe this early on both counts: the final page DOM is
      // already fully known at this point (the corrective repagination
      // pass below is permanently disabled — see needsFinalRepagination
      // — and hydratePagedImages never changes page count/structure,
      // only swaps <img src>). createPageIndicators() runs
      // unconditionally (not just !isTouchBook) — touch and print both
      // want real per-page numbers too, not just the desktop pager.
      createPageIndicators();
      activateDesktopPager();
      revealPagedReader();

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
      // Kept computed (findOverlappingReferenceSlugs still measures the
      // real thing) even though nothing acts on it below — the spacer
      // inserted above should prevent overlaps without a second pass.
      // Left in place for monitoring / debugging.
      const overlappingRefs = findOverlappingReferenceSlugs();
      // No second/staging Paged.Previewer().preview() pass on ANY
      // device, permanently — confirmed to corrupt WebKit's pagination
      // output (title-only page, duplicated teaser, blank pages), and
      // Mac/iPad Safari share that engine, so this isn't scoped to
      // touch. hadIncompleteImages was already excluded before this
      // (managed PNG geometry is fixed by placeholders).
      const needsFinalRepagination = false;

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
        pagedDebug("after staging swap");

        finishUp();
      }

      // Pagination is now completely final (including any overlap
      // correction above) — safe to swap in the real raw-GitHub PNGs.
      // They load into their already-reserved, already-correctly-sized
      // boxes from here on, visibly, without affecting page geometry.
      hydratePagedImages(target);
      attachImageFallback(target);

      // The final page DOM is now fully known — safe to turn on the
      // touch viewer (a no-op on desktop). The desktop pager already
      // activated earlier, right before reveal (see above) — no image
      // hydration or comment layout it needs to wait on.
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
    : `<p class="index-empty">No published entries yet. Add <code>publishID: ...</code> to a Markdown file's frontmatter (source: ${escapeHtml(entrySource.label)}).</p>`;
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
      <div class="index-author">Roaming2026</div>
    </header>

    <div class="journal-waterfall">
      ${renderEmptyState(entries)}
      ${renderWaterfallCards(entries)}
    </div>
  </div>
  ${dialogHtml}`;

  return pageShell({ title: "meroaming2026", bodyHtml, bodyClass: "page-index" });
}

// Contents view ("/contents" or "/contents/:tag"): the reading mode.
// When `tag` is provided, only entries with that tag are shown and the
// TOC panel gets a small label. Otherwise all entries are shown.
async function renderContentsPage(entries, tag) {
  const isDream = tag && tag.toLowerCase().includes("dream");

  const filtered = tag ? entries.filter(e => e.tags.includes(tag)) : entries;
  // Oldest first, newest last (a journal reads front-to-back
  // chronologically) — but the pager still opens on the LAST unit
  // (see activateDesktopPager/setupTouchBook), so the reader lands on
  // the newest entry first and pages backward through history from
  // there, rather than starting at day one.
  const orderedEntries = isDream
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

  const articleClass = isDream ? "paper dream-entry" : "paper spread";
  const spreads = orderedEntries.map(entry => `
    <article class="${articleClass}" id="card-${entry.slug}">
      ${renderEntryBody(entry, { mode: "plain", showByline: isDream || !isDateFilename(entry.id), dream: isDream })}
    </article>
  `).join("");

  // Only the HTML actually handed to Paged.js gets its raw-GitHub PNGs
  // swapped for local placeholders — home/waterfall thumbnails never go
  // through this.
  const pagedSpreads = orderedEntries.length ? await preparePagedImagePlaceholders(spreads) : "";

  // Oldest-to-newest order (above) means the last entry here is the
  // newest — the default open position (see activateDesktopPager/
  // setupTouchBook) needs its slug to jump straight to that entry's
  // own title page, not just "the final page of the whole document"
  // (which, for a multi-page latest entry, would be somewhere past
  // its title, into its own content).
  const latestSlug = orderedEntries.length ? orderedEntries[orderedEntries.length - 1].slug : "";

  const bodyHtml = `
  ${orderedEntries.length ? `
  <dialog class="toc-dialog" id="toc-dialog">
    ${tag ? `<div class="toc-tag-label">${escapeHtml(tag)}</div>` : ""}
    <ul class="toc-list">${toc}</ul>
  </dialog>` : ""}

  <div class="entry-page" data-latest-slug="${escapeHtml(latestSlug)}">
    ${orderedEntries.length
      ? `<template id="pagedjs-source">${pagedSpreads}</template>
         <div id="pagedjs-target" class="journal-spreads"></div>`
      : `<div class="journal-spreads">${renderEmptyState(entries)}</div>`}
  </div>`;

  const bodyClass = isDream ? "page-contents page-dream" : "page-contents";
  return pageShell({ title: tag || "Journal", bodyHtml, bodyClass, paginated: orderedEntries.length > 0 });
}

// A title containing "/" or ":" (either half- or full-width — "/",
// "／", ":", "：") is split at the FIRST such character into a main
// title and a subtitle, rendered as two separate lines (see .title-
// main/.title-sub in journal.css). No delimiter present just means no
// subtitle.
function splitTitleSubtitle(title) {
  const match = /^(.*?)[/／:：]\s*(.+)$/s.exec(title);
  if (!match) return { main: title, sub: null };
  return { main: match[1].trim(), sub: match[2].trim() };
}

// Chinese book-title marks: 《text》 → 「**_text_**」 (corner brackets,
// bold-italic content). Applied to raw Markdown before rendering so
// markdown-it handles the **_ nesting naturally. Outer 「」 are plain
// Unicode pass-through; inner bold-italic is standard Markdown syntax.
const BOOK_TITLE_RE = /《([^《》]+)》/g;

function expandBookTitles(markdown) {
  return markdown.replace(BOOK_TITLE_RE, (_, title) => `「**_${title}_**」`);
}

// A source filename that's just a date (e.g. "2026-09-21.md") reads as
// its own label already on /contents' shared TOC/flow — the "written
// on/updated" footnote there is redundant for those entries (but still
// shown on that entry's own standalone /entry page, where there's no
// surrounding date context).
function isDateFilename(id) {
  const base = path.basename(id, path.extname(id));
  return /^\d{4}-\d{2}-\d{2}$/.test(base);
}

function renderByline(entry, { mode, dream = false }) {
  if (dream) {
    if (!entry.created) return "";
    return `<p class="byline-footer byline-footer--dream">${escapeHtml(entry.created)}</p>`;
  }

  // "written on <created>, and updated <updated>" — degrades to just
  // whichever date is present, or nothing at all if neither is.
  const parts = [];
  if (entry.created) parts.push(`written on ${escapeHtml(entry.created)}`);
  if (entry.updated) parts.push(`updated ${escapeHtml(entry.updated)}`);
  if (!parts.length) return "";

  const clause = parts.join(", and ");

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
  const modeClass = mode === "running" ? "byline-footer--running" : "byline-footer--inline";
  return `<p class="byline-footer ${modeClass}">${clause}</p>`;
}

function renderEntryBody(entry, { mode, showByline = true, dream = false }) {
  const byline = showByline ? renderByline(entry, { mode, dream }) : "";

  let referencesHtml = entry.bodyHtml;
  const refTag = `<section class="references"`;
  const refTagDream = `<section class="references references--inline" data-ref-for="${escapeHtml(entry.slug)}"`;
  const refTagNormal = `<section class="references" data-ref-for="${escapeHtml(entry.slug)}"`;

  if (dream) {
    // Extract references from bodyHtml so we can place them after the byline
    let extractedRef = "";
    const refStart = referencesHtml.indexOf(refTag);
    if (refStart !== -1) {
      const refEnd = referencesHtml.indexOf("</section>", refStart);
      if (refEnd !== -1) {
        extractedRef = referencesHtml.slice(refStart, refEnd + "</section>".length)
          .replace(refTag, refTagDream);
        referencesHtml = referencesHtml.slice(0, refStart) + referencesHtml.slice(refEnd + "</section>".length);
      }
    }

    const bodyMain = `<main class="body">${referencesHtml}${byline}${extractedRef}</main>`;

    const { main, sub } = splitTitleSubtitle(entry.title);
    const subDisplay = sub ? sub.charAt(0).toUpperCase() + sub.slice(1).toLowerCase() : null;
    const titleHtml = subDisplay
      ? `<span class="title-main">${escapeHtml(main)}</span><span class="title-sub">${escapeHtml(subDisplay)}</span>`
      : escapeHtml(main);

    return `
      <h1 class="title">${titleHtml}</h1>
      ${entry.teaserHtml ? `<div class="teaser-slot">${entry.teaserHtml}</div>` : ""}
      ${bodyMain}
    `;
  }

  const plainByline = mode === "plain" && showByline
    ? renderByline(entry, { mode, dream: false })
    : "";

  // Byline is spliced in right before the .references section (not
  // just prepended to referencesHtml, which is the WHOLE body content
  // with .references appended inside it — prepending there would push
  // the byline above every paragraph, not just above references).
  // It also has to go before .references specifically, not after: the
  // client-side spacer that reserves room for the absolutely-
  // positioned .references box gets inserted directly before it (see
  // pageShell), so if the byline followed .references here, that
  // invisible reserved gap would land between the last paragraph and
  // the byline, pushing it down with a big blank space above it.
  let bodyContent = referencesHtml.replace(refTag, refTagNormal);
  if (plainByline) {
    const refStart = bodyContent.indexOf(refTagNormal);
    bodyContent = refStart !== -1
      ? bodyContent.slice(0, refStart) + plainByline + bodyContent.slice(refStart)
      : bodyContent + plainByline;
  }

  const bodyMain = `
    <main class="body">
      ${bodyContent}
    </main>
  `;

  const { main, sub } = splitTitleSubtitle(entry.title);
  const subDisplay = sub ? sub.charAt(0).toUpperCase() + sub.slice(1).toLowerCase() : null;
  const titleHtml = subDisplay
    ? `<span class="title-main">${escapeHtml(main)}</span><span class="title-sub">${escapeHtml(subDisplay)}</span>`
    : escapeHtml(main);

  return `
    <h1 class="title">${titleHtml}</h1>

    ${mode === "running" ? byline : ""}

    ${entry.teaserHtml ? `<div class="teaser-slot">${entry.teaserHtml}</div>` : ""}

    ${bodyMain}
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
  <div class="entry-page">
    <template id="pagedjs-source">${pagedArticleHtml}</template>
    <div id="pagedjs-target"></div>
  </div>`;

  // Standalone /entry/:slug rendering always uses the plain (non-
  // dream) layout — mode:"running" above, no dream:true — but a
  // dream-tagged entry should still lose the bold title here, same as
  // it would on its /contents/dream card.
  const isDream = entry.tags.some(t => t.toLowerCase().includes("dream"));
  const bodyClass = isDream ? "page-entry entry-dream-title" : "page-entry";

  return pageShell({ title: entry.title, bodyHtml, bodyClass, paginated: true });
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

app.get(`${CONTENTS_PATH}/:tag`, async (req, res) => {
  try {
    const tag = req.params.tag;
    const entries = await listEntries();
    res.type("html").send(await renderContentsPage(entries, tag));
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
