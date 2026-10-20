// Adapt EPUB XHTML inside its own document. Preserve node order for saved CFIs.
window.createEpubContent = function(book, root, row, fixedLayout) {
  // Firefox follows an older UAX #14 than Safari and Chrome: it never breaks
  // beside a curly quote, even between CJK characters, so its lines (and so its
  // page numbers) drift from theirs. An empty <wbr> restores the break; CFIs
  // skip it (SOFT_BREAK), so saved positions are the same in every browser.
  const SOFT_BREAK = "epub-brk";
  // Not only Firefox: Obsidian's Chromium 130 binds a curly quote to the next
  // character the same way (a line that fits wrapped a character early and the
  // book drifted a page). Ask the engine rather than read its name: set 国”国
  // in a box too narrow for all of it; if it may break after the quote the
  // quote stays on the first line, otherwise nothing can break and it is one line.
  let oldQuoteRules = null;
  function bindsQuotes() {
    if (oldQuoteRules === null) {
      if (/Firefox\//.test(navigator.userAgent)) oldQuoteRules = true;
      else {
        const box = document.createElement("div");
        box.style.cssText = "position:absolute;visibility:hidden;left:0;top:0;width:1.8em;font:20px/30px var(--serif),serif;line-break:strict;overflow-wrap:normal";
        box.textContent = "\u56fd\u201d\u56fd"; document.body.append(box);
        oldQuoteRules = box.getBoundingClientRect().height < 45;
        box.remove();
      }
    }
    return oldQuoteRules;
  }
  const CJK = "\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff";
  const afterQuote = new RegExp(`(?<=[\u201d\u2019])(?=[${CJK}\u201c\u2018\u300a\u3008\u300c\u300e\uff08\u3010\u3014\uff3b\uff5b])`, "gu");
  const beforeQuote = new RegExp(`(?<=[${CJK}\uff0c\u3002\u3001\uff1b\uff1a\uff01\uff1f\uff09\u300b\u3009\u300d\u300f\u3011\u3015\uff3d\uff5d\u2026\u2014\u201d\u2019])(?=[\u201c\u2018])`, "gu");
  function softBreaks(doc, body) {
    if (!bindsQuotes()) return;
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT), texts = [];
    for (let node; (node = walker.nextNode());) if (/[\u2018\u2019\u201c\u201d]/.test(node.data)) texts.push(node);
    for (const node of texts) {
      const at = new Set();
      for (const re of [afterQuote, beforeQuote]) for (const m of node.data.matchAll(re)) if (m.index > 0 && m.index < node.length) at.add(m.index);
      for (const index of [...at].sort((a, b) => b - a)) {
        const tail = node.splitText(index), mark = doc.createElementNS("http://www.w3.org/1999/xhtml", "wbr");
        mark.className = SOFT_BREAK;
        tail.before(mark);
      }
    }
  }
  const cssURL = document.querySelector('link[href$="static/book.css"]').href;
  const fontURLs = [...document.querySelectorAll('link[rel="stylesheet"]')].filter(link => /fonts/.test(link.href)).map(link => link.href);
  const documents = new Map(), notes = new Map(), snapshotStyles = new WeakMap(), sharedSheets = new Map();
  const load = url => {
    if (!documents.has(url)) {
      const pending = book.load(url).catch(error => { documents.delete(url); throw error; });
      documents.set(url, pending);
      if (documents.size > 12) documents.delete(documents.keys().next().value);
    }
    return documents.get(url);
  };
  const type = el => el.getAttribute("epub:type") || el.getAttributeNS("http://www.idpf.org/2007/ops", "type") || "";
  function isReference(a) {
    if (/noteref/.test(type(a)) || a.getAttribute("role") === "doc-noteref") return true;
    const label = a.textContent.trim();
    return /^[\[（(【]?\s*\d+\s*[\]）)】]?$/.test(label) &&
      (a.closest('sup,[class*="super"],[class*="noteref"]') || a.querySelector("sup") || /note|foot/i.test(a.getAttribute("href") + " " + a.className));
  }
  async function notesFor(section) {
    if (!notes.has(section.index)) notes.set(section.index, (async () => {
      const doc = await load(section.url);
      const result = [];
      for (const a of doc.querySelectorAll("a[href]")) {
        if (!isReference(a)) continue;
        const href = a.getAttribute("href"), hash = href.indexOf("#");
        if (hash < 0) continue;
        const path = href.slice(0, hash), id = decodeURIComponent(href.slice(hash + 1));
        if (/^[a-z]+:/i.test(path) || path.startsWith("//")) continue;
        const url = path ? new URL(path, new URL(section.url, "https://epub.invalid/")).pathname : section.url;
        try {
          const source = path ? await load(url) : doc;
          let target = source.getElementById(id);
          if (!target) continue;
          // Calibre often puts the target id on a backlink inside a paragraph.
          if (target.matches("a,span,sup")) target = target.closest("p,li,aside,div") || target;
          const text = target.textContent.trim();
          if (!text || text === a.textContent.trim()) continue;
          result.push({ href, id, local: !path || url === section.url, text, label: a.textContent.trim() });
        } catch { /* Keep the original link usable when a note cannot be resolved. */ }
      }
      return result;
    })().catch(error => { notes.delete(section.index); throw error; }));
    return notes.get(section.index);
  }
  // Load shared reader CSS once, outside the hidden chapter frames. Safari
  // can defer their link load events, blocking the navigation queue per sheet.
  const styles = new Map();
  // Adobe's kit (the Chinese serif) sends only the glyphs it finds in the
  // page's own DOM, and never looks inside the shadow roots the pages are
  // shown in: the rest of a chapter would stay in the system sans for good.
  // So each chapter's characters are also set, unseen, in the page itself,
  // and the first chapter waits for the kit to deliver them.
  const kitGlyphs = new Set();
  let kitFeed = null, kitWaited = false;
  async function feedKit(glyphs) {
    if (!document.querySelector('script[src*="typekit.net"],link[href*="typekit.net"]')) return;
    const fresh = [...glyphs].filter(char => char.trim() && !kitGlyphs.has(char));
    if (!fresh.length) return;
    fresh.forEach(char => kitGlyphs.add(char));
    if (!kitFeed) {
      kitFeed = document.createElement("div");
      kitFeed.setAttribute("aria-hidden", "true");
      kitFeed.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none";
      for (const family of ["--serif", "--title-serif"]) {
        const span = document.createElement("span");
        span.style.fontFamily = `var(${family})`;
        kitFeed.append(span);
      }
      document.body.append(kitFeed);
    }
    for (const span of kitFeed.children) span.append(fresh.join(""));
    if (kitWaited) return;
    kitWaited = true;
    const deadline = performance.now() + 8000;
    let calm = performance.now();
    while (performance.now() < deadline) {
      if (document.documentElement.classList.contains("wf-loading") || document.fonts.status === "loading") calm = performance.now();
      else if (performance.now() - calm > 700) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  function absoluteURLs(text, base) {
    return text.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (match, double, single, bare) => {
      const url = (double ?? single ?? bare).trim();
      if (!url || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(url)) return match;
      return `url(${JSON.stringify(new URL(url, base).href)})`;
    });
  }
  function stylesheet(doc, href) {
    if (!styles.has(href)) styles.set(href, (async () => {
      let text;
      try {
        const sheet = [...document.styleSheets].find(sheet => sheet.href === href);
        if (sheet) text = [...sheet.cssRules].map(rule => rule.cssText).join("\n");
      } catch { /* Cross-origin font stylesheets require a CORS fetch. */ }
      if (text === undefined) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(href, { signal: controller.signal });
          if (!response.ok) throw new Error(`Stylesheet request failed (${response.status})`);
          text = await response.text();
        } catch (error) {
          if (href === cssURL) throw error;
          text = "";
        } finally { clearTimeout(timer); }
      }
      return absoluteURLs(text, href);
    })());
    return styles.get(href).then(text => {
      const style = doc.createElement("style");
      style.textContent = text; doc.head.append(style);
    });
  }
  async function prepare(contents, references) {
    if (fixedLayout) return;
    await Promise.all([cssURL, ...fontURLs].map(url => stylesheet(contents.document, url)));
    const doc = contents.document, body = contents.content, vars = getComputedStyle(root);
    body.classList.add("body", "epub-ink");
    doc.documentElement.classList.toggle("no-drop-cap", !row.dropCap);
    doc.documentElement.classList.toggle("letterpress", !!row.letterpress);
    doc.documentElement.classList.toggle("ink-bleed", !!row.inkBleed);
    const style = doc.createElement("style");
    style.textContent = `:root { ${["--serif", "--title-serif", "--body-size", "--body-leading", "--column-gap", "--paper", "--ink", "--letterpress", "--ink-bleed"].map(key => `${key}:${vars.getPropertyValue(key) || '.5'};`).join("")} }
      html { background:transparent !important; -webkit-text-size-adjust:none; text-size-adjust:none; }
      /* Keep inline annotations from enlarging line boxes, and avoid
         engine-specific column widow/orphan defaults. */
      body.body { -webkit-line-box-contain:initial !important; }
      body.body * { orphans:1 !important; widows:1 !important;
        line-break:strict; text-spacing-trim:space-all; text-autospace:no-autospace;
        font-kerning:none; font-variant-ligatures:none; text-rendering:geometricPrecision; font-synthesis:none; hyphens:manual; -webkit-hyphens:manual; }
      body.body :is(sup,sub,.math-super) { line-height:0 !important; }
      body.body { min-height:0 !important; margin:0 !important; padding-top:0 !important; padding-bottom:0 !important; column-count:auto !important;
        font-family:var(--serif) !important; font-size:var(--body-size) !important; line-height:var(--body-leading) !important; }
      body.body :is(p,li,blockquote) { font-family:inherit !important; font-size:inherit !important; line-height:inherit !important; }
      body.body p.drop-cap { text-indent:0 !important; }
      h1 { font-family:var(--title-serif); font-size:2em; }
      img,svg { max-width:100%; max-height:${contents.height()}px; object-fit:contain; }
      [data-epub-number]::before { content:attr(data-epub-number); }
      [data-epub-note-hidden] { display:none !important; }
      a[data-epub-noteref], a[data-epub-noteref]:visited, a[data-epub-noteref] * {
        color:var(--ink) !important; text-decoration:none !important; border-bottom:0 !important; box-shadow:none !important;
      }
      @media (pointer:coarse) { html,body { touch-action:pan-y pinch-zoom; } }`;
    doc.head.append(style);
    const number = (selector, enabled, label) => {
      if (!enabled) return;
      let n = 0;
      for (const el of body.querySelectorAll(selector)) {
        n++;
        if (/^(?:\d|[一二三四五六七八九十]+[、.．]|第|figure\s*\d|table\s*\d)/i.test(el.textContent.trim())) continue;
        el.dataset.epubNumber = label ? `${label} ${n}. ` : `${n}. `;
      }
    };
    number("h2,h3,h4", row.numberHeadings, "");
    number("figure:not(:has(table)) > figcaption", row.numberFigures, "Figure");
    number("table > caption,figure:has(table) > figcaption", row.numberTables, "Table");
    for (const a of body.querySelectorAll("a[href]")) {
      if (isReference(a)) a.dataset.epubNoteref = "";
    }
    for (const ref of references) {
      if (!ref.local) continue;
      const target = doc.getElementById(ref.id);
      if (target) (target.matches("a,span,sup") ? target.closest("p,li,aside,div") || target : target).dataset.epubNoteHidden = "";
    }
    softBreaks(doc, body);
    // Settle fonts and images before reading column counts. No late page drift.
    // Flush the new style before observing FontFaceSet.ready: an idle set can
    // resolve before the browser has discovered this chapter's font subsets.
    // Load every glyph used by the chapter, including offscreen columns.
    void body.offsetHeight;
    const glyphs = [...new Set(body.textContent)].join("");
    const bodyStyle = doc.defaultView.getComputedStyle(body);
    await feedKit(glyphs);
    // Programmatically loaded configured faces (including Adobe kits) share
    // the reader's FontFaceSet. CSS-connected faces come from the styles above.
    for (const face of document.fonts) {
      try { doc.fonts.add(face); } catch { /* CSS-connected face. */ }
    }
    // A blocked or offline font (Adobe kit behind a tracker blocker) must fall back, not fail the chapter.
    await doc.fonts.load(`${bodyStyle.fontSize} ${bodyStyle.fontFamily}`, glyphs || "国A").catch(() => {});
    await doc.fonts.ready;
    if (row.dropCap) {
      const opening = [...body.querySelectorAll("p")].find(p => {
        if (!p.textContent.trim() || p.querySelector("img,svg") || p.closest('nav,aside,[data-epub-note-hidden]')) return false;
        const style = doc.defaultView.getComputedStyle(p);
        return p.getBoundingClientRect().height >= 2.5 * (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2);
      });
      if (opening) opening.classList.add("drop-cap");
    }
    window.fitReaderDropCaps(body);
    await Promise.all([...doc.images].map(img => img.decode?.().catch(() => {}) || Promise.resolve()));
  }
  function placeNotes(page, contents, references) {
    if (!references.length) return;
    const byHref = new Map(references.map(ref => [ref.href, ref]));
    const pageBox = page.getBoundingClientRect(), items = [];
    for (const content of contents) {
      const area = page.querySelector(".page-area").getBoundingClientRect();
      for (const a of content.document.querySelectorAll("a[href]")) {
        const ref = byHref.get(a.getAttribute("href"));
        if (!ref) continue;
        const rect = a.getBoundingClientRect();
        const x = rect.left, y = rect.top;
        if (x < area.left - 1 || x >= area.right || y < area.top - 2 || y > area.bottom) continue;
        const note = document.createElement("span"); note.className = "comment-margin-marker epub-ink";
        note.textContent = ref.text.startsWith(ref.label) ? ref.text : `${ref.label} ${ref.text}`;
        a.addEventListener("click", event => {
          event.preventDefault(); event.stopImmediatePropagation();
          note.animate([{ backgroundColor: "var(--highlight)" }, { backgroundColor: "transparent" }], { duration: 1400 });
        }, true);
        items.push({ note, top: y - pageBox.top - page.clientTop, side: window.readerNotes.side(page, x < pageBox.left + pageBox.width / 2) });
      }
    }
    window.readerNotes.place(page, items);
  }
  function hasPage(contents, left, width) {
    const doc = contents.document, range = doc.createRange();
    const intersects = rect => rect.width > 0 && rect.height > 0 && rect.right > left + .5 && rect.left < left + width - .5;
    const walker = doc.createTreeWalker(contents.content, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      if (!node.textContent.trim()) continue;
      range.selectNodeContents(node);
      if ([...range.getClientRects()].some(intersects)) return true;
    }
    return [...contents.content.querySelectorAll("img,svg,math,video,canvas,object")]
      .some(el => [...el.getClientRects()].some(intersects));
  }
  function startCfi(contents, left, width) {
    const doc = contents.document, range = doc.createRange();
    const walker = doc.createTreeWalker(contents.content, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      if (!node.textContent.trim()) continue;
      range.selectNodeContents(node);
      if (![...range.getClientRects()].some(rect => rect.width && rect.left < left + width && rect.right > left + 1)) continue;
      // EPUB.js's word-based mapping can anchor CJK to the preceding column.
      // Find the first character actually inside this sheet without changing
      // the XHTML tree (existing CFI bookmarks therefore remain valid).
      let low = 0, high = node.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        range.setStart(node, mid); range.setEnd(node, mid + 1);
        const rect = range.getClientRects()[0];
        if (!rect || rect.left < left - .5) low = mid + 1;
        else high = mid;
      }
      if (low < node.length) {
        range.setStart(node, low); range.collapse(true);
        return contents.cfiFromRange(range, SOFT_BREAK);
      }
    }
    return null;
  }
  // Like Markdown's freezeColumns, retain only the laid-out column fragments.
  // The source XHTML remains untouched for CFI navigation and selection.
  function freezeVisibleColumns(doc, html, frame, page) {
    const body = doc.body, css = doc.defaultView.getComputedStyle(body);
    const width = parseFloat(css.columnWidth), gap = parseFloat(css.columnGap) || 0;
    if (!width || css.direction === "rtl" || css.writingMode !== "horizontal-tb") return;
    const frameBox = frame.getBoundingClientRect(), area = page.querySelector(":scope > .page-area").getBoundingClientRect();
    const scale = frameBox.width / frame.offsetWidth;
    const left = (area.left - frameBox.left) / scale;
    const right = (area.right - frameBox.left) / scale;
    const padding = parseFloat(css.paddingLeft) || 0, stride = width + gap;
    const first = Math.max(0, Math.floor((left - padding + gap / 2) / stride));
    const count = Math.max(1, Math.round((right - left + gap) / stride));
    const nodes = [], walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT), range = doc.createRange();
    for (let node; (node = walker.nextNode());) {
      const atomic = node.nodeType === 1 && node.matches("img,svg,math,video,audio,object,canvas,hr");
      if (node.parentElement?.closest("svg,math,video,audio,object,canvas")) continue;
      if (!atomic && (node.nodeType !== 3 || !node.textContent.trim())) continue;
      if (atomic) range.selectNode(node); else range.selectNodeContents(node);
      const rects = [...range.getClientRects()];
      if (rects.length) nodes.push({ node, rects, atomic });
    }
    function boundary(x) {
      for (const { node, rects, atomic } of nodes) {
        if (!rects.some(rect => rect.width && rect.right > x + 1)) continue;
        if (atomic) return { node: node.parentNode, offset: [...node.parentNode.childNodes].indexOf(node) };
        let low = 0, high = node.length;
        while (low < high) {
          const mid = (low + high) >> 1;
          range.setStart(node, mid); range.setEnd(node, mid + 1);
          const rect = range.getBoundingClientRect();
          if (rect.right <= x + 1) low = mid + 1; else high = mid;
        }
        if (low < node.length) return { node, offset: low };
      }
      return { node: body, offset: body.childNodes.length };
    }
    const frozen = html.querySelector("body"); frozen.replaceChildren();
    html.style.width = count * stride + "px";
    frozen.style.width = count * stride + "px";
    frozen.style.setProperty("column-width", "auto", "important");
    frozen.style.setProperty("column-count", "auto", "important");
    frozen.style.setProperty("padding", "0", "important");
    for (let col = first; col < first + count; col++) {
      const x = padding + col * stride, start = boundary(x), end = boundary(x + stride);
      if (start.node === body && start.offset === body.childNodes.length) continue;
      range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
      let fragment = range.cloneContents();
      // cloneContents omits its common ancestor; restore its formatting shells.
      let ancestor = range.commonAncestorContainer;
      if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentElement;
      while (ancestor && ancestor !== body) {
        const shell = ancestor.cloneNode(false); shell.append(fragment); fragment = shell;
        ancestor = ancestor.parentElement;
      }
      let top = start.node === body ? body.childNodes[start.offset] : start.node.nodeType === 1 ? start.node : start.node.parentElement;
      while (top.parentElement && top.parentElement !== body) top = top.parentElement;
      const blockRects = [...top.getClientRects()];
      const blockRect = blockRects.find(rect => rect.left < x + width && rect.right > x);
      const before = doc.createRange(); before.setStart(top, 0); before.setEnd(start.node, start.offset);
      const continued = !!before.toString().trim();
      const column = doc.createElement("div");
      column.className = "epub-static-column";
      column.style.cssText = `position:absolute;left:${x - first * stride}px;top:${Math.max(0, blockRect?.top || 0)}px;width:${width}px;`;
      column.append(fragment);
      const firstBlock = column.firstElementChild;
      if (firstBlock) {
        firstBlock.style.setProperty("margin-top", "0", "important");
        if (continued) {
          firstBlock.classList.remove("drop-cap");
          firstBlock.style.setProperty("text-indent", "0", "important");
        }
      }
      // A paragraph cut at the column edge was justified in the source.
      if (end.node !== body) {
        const last = [...column.querySelectorAll("p")].filter(p => p.textContent.trim()).at(-1);
        const source = (end.node.nodeType === 1 ? end.node : end.node.parentElement).closest("p");
        if (last && source && doc.defaultView.getComputedStyle(source).textAlign === "justify") {
          const prefix = doc.createRange(); prefix.setStart(source, 0); prefix.setEnd(end.node, end.offset);
          if (prefix.toString().trim()) last.style.textAlignLast = "justify";
        }
      }
      frozen.append(column);
    }
    return { offset: first * stride, width: count * stride };
  }
  // One stable reading document owns all pages. Shadow roots isolate publisher
  // selectors; they do not create separate browsing contexts or font documents.
  function freezePage(page, contents, readingDocument) {
    const doc = contents.document, frame = contents.window.frameElement;
    const html = doc.documentElement.cloneNode(false);
    html.append(doc.head.cloneNode(false), doc.body.cloneNode(false));
    const frozen = freezeVisibleColumns(doc, html, frame, page);
    if (!frozen) {
      // Fixed-layout/vertical books retain their native layout in a clipped DOM
      // surface. They still never keep a live rendition in an animated leaf.
      html.replaceChildren(...[...doc.documentElement.childNodes].map(node => node.cloneNode(true)));
    }
    html.querySelectorAll("script,link,style,base").forEach(el => el.remove());
    if (!snapshotStyles.has(doc)) snapshotStyles.set(doc, [...doc.styleSheets].map(sheet => {
      try { return absoluteURLs([...sheet.cssRules].map(rule => rule.cssText).join("\n"), sheet.href || doc.baseURI); }
      catch { return sheet.ownerNode?.textContent || ""; }
    }).join("\n"));
    const css = snapshotStyles.get(doc);
    // Font faces belong to the document FontFaceSet, not to a shadow tree.
    for (const sheet of doc.styleSheets) {
      try { for (const rule of sheet.cssRules) if (rule.type === 5) {
        const text = absoluteURLs(rule.cssText, sheet.href || doc.baseURI);
        if (!readingDocument._epubFontRules) readingDocument._epubFontRules = new Set();
        if (!readingDocument._epubFontRules.has(text)) {
          readingDocument._epubFontRules.add(text);
          const style = readingDocument.createElement("style"); style.textContent = text; readingDocument.head.append(style);
        }
      } } catch { /* Same resources have already been loaded by prepare(). */ }
    }
    const host = readingDocument.createElement("div"); host.className = "epub-page-content";
    host.style.cssText = `position:absolute;inset:0;overflow:hidden;width:${page.querySelector('.epub-viewport').offsetWidth}px;height:${page.querySelector('.epub-viewport').offsetHeight}px`;
    const shadow = host.attachShadow({ mode: "open" });
    const style = readingDocument.createElement("style");
    style.textContent = css.replace(/:root\b/g, "html") + "\nhtml, body { overflow:visible !important; background:transparent !important; } html { position:relative; height:100%; }";
    if (!frozen) {
      const offset = frame.getBoundingClientRect().left - page.querySelector('.epub-viewport').getBoundingClientRect().left;
      html.style.transform = `translateX(${offset}px)`;
      html.style.width = frame.offsetWidth + "px";
    }
    if (readingDocument.defaultView.CSSStyleSheet?.prototype.replaceSync) {
      if (!sharedSheets.has(style.textContent)) {
        const sheet = new readingDocument.defaultView.CSSStyleSheet();
        sheet.replaceSync(style.textContent); sharedSheets.set(style.textContent,sheet);
      }
      shadow.adoptedStyleSheets = [sharedSheets.get(style.textContent)];
    } else shadow.append(style);
    shadow.append(readingDocument.importNode(html, true));
    return host;
  }
  function clonePage(source, bleed = false) {
    const copy = source.cloneNode(true);
    const hosts = [...source.querySelectorAll('.epub-page-content')];
    [...copy.querySelectorAll('.epub-page-content')].forEach((host, i) => {
      const shadow = host.attachShadow({mode:"open"});
      shadow.adoptedStyleSheets = hosts[i].shadowRoot.adoptedStyleSheets;
      shadow.append(...[...hosts[i].shadowRoot.childNodes].map(node => node.cloneNode(true)));
    });
    copy.querySelectorAll('.page-back,.page-bleed,.epub-bleed').forEach(el => el.remove());
    for (const host of copy.querySelectorAll('.epub-page-content')) {
      const style = host.ownerDocument.createElement('style');
      style.textContent = '* {text-shadow:none !important;-webkit-text-stroke:0 !important;mix-blend-mode:normal !important}' + (bleed ? 'img,svg,hr,table {visibility:hidden !important}' : 'img {filter:saturate(.15)}');
      host.shadowRoot.append(style);
    }
    copy.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    return copy;
  }
  function showThrough(page, source) {
    if (!row.showThrough || root.dataset.layout === "phone" || !source || page.querySelector('.page-back')) return;
    const copy = clonePage(source);
    copy.className = "page-back"; copy.inert = true; copy.setAttribute("aria-hidden", "true");
    copy.dataset.side = source.classList.contains("page--right") ? "right" : "left";
    if (source.classList.contains("page--notes")) copy.dataset.notes = "";
    page.prepend(copy);
  }
  return { load, stylesheet, notesFor, prepare, placeNotes, showThrough, startCfi, hasPage, freezePage, clonePage,
    addBleed: page => window.addReaderInkBleed([page], () => ({copy:clonePage(page,true),restore(){}})) };
};
