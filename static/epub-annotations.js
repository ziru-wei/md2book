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

  // The soft green marker stroke used for highlights in PaperToaster.
  const G = "178 214 121";
  const STYLE = "::selection{background:rgba(110,110,110,.38);color:inherit}" +
    `.epub-hl{display:inline;color:inherit;cursor:pointer;border-radius:.18em;background:linear-gradient(103deg,transparent 1%,rgb(${G} / 84%) 3%,rgb(${G} / 58%) 7%,rgb(${G} / 32%) 91%,rgb(${G} / 62%) 96%,transparent 99%),linear-gradient(181deg,transparent 0%,rgb(${G} / 30%) 8%,transparent 16%);text-shadow:-.35em .3em .45em rgb(${G} / 18%);-webkit-box-decoration-break:clone;box-decoration-break:clone}` +
    `.epub-hl:hover{background:linear-gradient(103deg,transparent 1%,rgb(${G} / 92%) 3%,rgb(${G} / 70%) 7%,rgb(${G} / 44%) 91%,rgb(${G} / 74%) 96%,transparent 99%),linear-gradient(181deg,transparent 0%,rgb(${G} / 38%) 8%,transparent 16%)}` +
    ".epub-hl[data-note]{box-shadow:0 1px 0 rgba(110,150,60,.75)}" +
    // A selection waiting for Highlight/Note on a touch screen: grey, like selected text.
    ".epub-hl.is-pending,.epub-hl.is-pending:hover{background:rgba(110,110,110,.38);text-shadow:none}\n";

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
      const idx = index(body), hit = find(idx.text, h, true);
      if (!hit) continue;
      const pieces = segments(idx, hit.start, hit.end);
      for (const { node, from, to } of pieces.reverse()) {
        if (!node.data.slice(from, to).trim()) continue;
        const target = to < node.length ? (node.splitText(to), node) : node;
        const middle = from > 0 ? target.splitText(from) : target;
        const mark = body.ownerDocument.createElement("span");
        mark.className = h.pending ? "epub-hl is-pending" : "epub-hl"; mark.dataset.id = h.id;
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

  const api = { find, index, segments, paint, unpaint, describe };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.epubAnnotations = api;
})(typeof window !== "undefined" ? window : globalThis);
