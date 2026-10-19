/* EPUB highlights: anchoring by quoted text, and painting into a page's
   shadow tree. Pure text helpers have no DOM dependency (see
   test/epub-annotations.test.js). */
(function (root) {
  const common = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };

  // Where a highlight sits in `text`: the occurrence of its quote whose
  // surroundings best match the saved prefix/suffix. With `strict` (a page
  // holds only part of a chapter), an occurrence must also match all the
  // context the page can show, so a repeated phrase elsewhere stays plain. A
  // quote cut by a column or page edge matches its visible head or tail.
  function find(text, h, strict = false) {
    const quote = h.quote || "";
    if (!quote) return null;
    const prefix = h.prefix || "", suffix = h.suffix || "";
    let best = null, at = text.indexOf(quote);
    while (at >= 0) {
      const before = text.slice(Math.max(0, at - 64), at), after = text.slice(at + quote.length);
      const reversed = [...prefix].reverse().join("");
      const p = common(reversed, [...before].reverse().join(""));
      const q = common(suffix, after);
      const fits = p >= Math.min(prefix.length, before.length) && q >= Math.min(suffix.length, after.length);
      if ((!strict || fits) && (!best || p + q > best.score)) best = { start: at, end: at + quote.length, score: p + q };
      at = text.indexOf(quote, at + 1);
    }
    if (best) return { start: best.start, end: best.end };
    const min = Math.min(4, quote.length);
    for (let k = quote.length - 1; k >= min; k--) {
      if (text.endsWith(quote.slice(0, k))) return { start: text.length - k, end: text.length };
      if (text.startsWith(quote.slice(quote.length - k))) return { start: 0, end: k };
    }
    return null;
  }

  // Text nodes under `node`, in order, with their offsets in the joined text.
  function index(node) {
    const doc = node.ownerDocument, walker = doc.createTreeWalker(node, 4 /* SHOW_TEXT */);
    const parts = []; let text = "";
    for (let n; (n = walker.nextNode());) { parts.push({ node: n, start: text.length }); text += n.data; }
    return { text, parts };
  }

  // The pieces of text nodes covering [start, end).
  function segments(idx, start, end) {
    const out = [];
    for (const { node, start: s } of idx.parts) {
      const from = Math.max(start, s) - s, to = Math.min(end, s + node.length) - s;
      if (to > from) out.push({ node, from, to });
    }
    return out;
  }

  // PaperToaster's soft green marker stroke.
  const G = "178 214 121";
  const STYLE = "::selection{background:rgba(110,110,110,.38);color:inherit}" +
    "@media (pointer:coarse){body,body *{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}}" +
    `.epub-hl{display:inline;color:inherit;cursor:pointer;border-radius:.18em;background:linear-gradient(103deg,transparent 1%,rgb(${G} / 84%) 3%,rgb(${G} / 58%) 7%,rgb(${G} / 32%) 91%,rgb(${G} / 62%) 96%,transparent 99%),linear-gradient(181deg,transparent 0%,rgb(${G} / 30%) 8%,transparent 16%);-webkit-box-decoration-break:clone;box-decoration-break:clone;text-shadow:-.35em .3em .45em rgb(${G} / 18%)}` +
    `.epub-hl:hover{background:linear-gradient(103deg,transparent 1%,rgb(${G} / 92%) 3%,rgb(${G} / 70%) 7%,rgb(${G} / 44%) 91%,rgb(${G} / 74%) 96%,transparent 99%),linear-gradient(181deg,transparent 0%,rgb(${G} / 38%) 8%,transparent 16%)}` +
    // A note: a plain, thick, straight underline in dark green.
    ".epub-hl[data-note]{text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px;text-decoration-skip-ink:none;text-decoration-color:rgb(78 112 40)}" +
    // A selection waiting for Highlight/Note on a touch screen: grey, like selected text.
    ".epub-hl.is-pending,.epub-hl.is-pending:hover{background:rgba(110,110,110,.38);text-shadow:none}" +
    // Highlight erased, note kept: only the note's underline remains.
    ".epub-hl.bare,.epub-hl.bare:hover{background:none;text-shadow:none}\n";

  function unpaint(shadow) {
    for (const mark of [...shadow.querySelectorAll("span.epub-hl")]) {
      const parent = mark.parentNode;
      mark.replaceWith(...mark.childNodes);
      parent.normalize();
    }
  }

  function paint(shadow, list) {
    unpaint(shadow);
    const body = shadow.querySelector("body");
    if (!body) return;
    // Selected text is grey, whether or not the page has highlights.
    if (!shadow.querySelector("style[data-epub-hl]")) {
      const style = body.ownerDocument.createElement("style");
      style.dataset.epubHl = ""; style.textContent = STYLE;
      shadow.append(style);
    }
    if (!list.length) return;
    for (const h of list) {
      if (h.shadow && h.shadow !== shadow) continue;
      const idx = index(body), hit = h.offsets ? { start: h.offsets[0], end: h.offsets[1] } : find(idx.text, h, true);
      if (!hit) continue;
      const pieces = segments(idx, hit.start, hit.end);
      for (const { node, from, to } of pieces.reverse()) {
        if (!node.data.slice(from, to).trim()) continue;
        const target = to < node.length ? (node.splitText(to), node) : node;
        const middle = from > 0 ? target.splitText(from) : target;
        const mark = body.ownerDocument.createElement("span");
        mark.className = "epub-hl" + (h.pending ? " is-pending" : "") + (h.marker === false ? " bare" : ""); mark.dataset.id = h.id;
        if (h.note) mark.dataset.note = "";
        middle.replaceWith(mark); mark.append(middle);
      }
    }
  }

  // The text of `range` and its surroundings within `body`, for saving.
  function describe(body, range) {
    const before = body.ownerDocument.createRange();
    before.setStart(body, 0); before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length, quote = range.toString();
    const text = index(body).text;
    return { quote, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(start + quote.length, start + quote.length + 32) };
  }

  // --- Touch selection: our own, by character offsets in a page's text ------

  // The character under (x, y) on a page: its index and the nearest boundary.
  function pointToOffset(shadow, x, y) {
    const body = shadow.querySelector("body");
    if (!body) return null;
    const idx = index(body), range = body.ownerDocument.createRange();
    let best = null;
    for (const part of idx.parts) {
      const node = part.node;
      if (!node.data.trim()) continue;
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (y < box.top - 6 || y > box.bottom + 6) continue;
      for (let i = 0; i < node.length; i++) {
        range.setStart(node, i); range.setEnd(node, i + 1);
        for (const r of range.getClientRects()) {
          if (!r.width || !r.height) continue;
          const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
          const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
          const d = dy * 4 + dx;
          if (!best || d < best.d) best = { d, char: part.start + i, offset: part.start + i + (x > (r.left + r.right) / 2 ? 1 : 0) };
        }
      }
    }
    return best && best.d < 60 ? best : null;
  }

  // The word around character `at` (a CJK run is split by the browser's word rules).
  function wordAt(text, at) {
    at = Math.max(0, Math.min(text.length - 1, at));
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      for (const seg of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) {
        const end = seg.index + seg.segment.length;
        if (at >= seg.index && at < end) return seg.isWordLike ? [seg.index, end] : [at, at + 1];
      }
    }
    const word = /[\p{L}\p{N}_'’-]/u;
    let s = at, e = at + 1;
    if (!word.test(text[at])) return [at, e];
    while (s > 0 && word.test(text[s - 1])) s--;
    while (e < text.length && word.test(text[e])) e++;
    return [s, e];
  }

  function rangeAt(body, start, end) {
    const idx = index(body), segs = segments(idx, start, end);
    if (!segs.length) return null;
    const range = body.ownerDocument.createRange();
    range.setStart(segs[0].node, segs[0].from);
    const last = segs[segs.length - 1];
    range.setEnd(last.node, last.to);
    return range;
  }

  // What to save for the text at [start, end), and where it is on screen.
  function measure(body, start, end) {
    const text = index(body).text, range = rangeAt(body, start, end);
    if (!range) return null;
    const rects = [...range.getClientRects()].filter(r => r.width && r.height);
    const first = rects[0] || range.getBoundingClientRect(), last = rects[rects.length - 1] || first;
    return { quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32),
      rect: range.getBoundingClientRect(),
      startPoint: { x: first.left, y: first.top, h: first.height }, endPoint: { x: last.right, y: last.top, h: last.height } };
  }

  // Where a painted highlight sits in a page's text: [start, end) of its marks.
  function spanOffsets(body, id) {
    const idx = index(body);
    let start = Infinity, end = -1;
    for (const part of idx.parts) {
      const mark = part.node.parentElement && part.node.parentElement.closest("span.epub-hl");
      if (mark && mark.dataset.id === id) { start = Math.min(start, part.start); end = Math.max(end, part.start + part.node.length); }
    }
    return end < 0 ? null : [start, end];
  }

  const api = { find, index, segments, paint, unpaint, describe, pointToOffset, wordAt, rangeAt, measure, spanOffsets };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.epubAnnotations = api;
})(typeof window !== "undefined" ? window : globalThis);
