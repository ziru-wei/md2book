/* EPUB layout report: what decides where each page of a book begins and ends
   on this device, for comparing two devices that cut the same book into
   different pages (the reader's menu → "Layout report").

   - The device and browser, and the page geometry the reader uses.
   - The fonts: which of the body font's families this browser has, and how
     wide a few test strings come out in it (a different font or different
     glyph widths moves every line after it).
   - Line breaking: where a narrow box breaks a set of CJK and punctuation
     pairs (rules that differ between browser and system versions).
   - The pages themselves, from the chapters laid out and kept on this device
     (static/epub-view.js): each page's first and last characters. */
window.md2bookLayoutReport = async function (ctx) {
  const { title, row, rendition, keep, toc = [] } = ctx;
  // A chapter as the reader sees it: its title(s) in the book's contents, or
  // the one before it (continued), never the file's place in the EPUB.
  const tocLabel = index => {
    const own = toc.filter(t => t.index === index).map(t => t.label);
    if (own.length) return own.join(" · ");
    const before = toc.filter(t => t.index < index).pop();
    return before ? `${before.label} (cont.)` : "(before the contents)";
  };
  const root = document.documentElement, css = getComputedStyle(root);
  const lines = [];
  const out = (...parts) => lines.push(parts.join(" "));
  const clean = text => text.replace(/\s+/g, "");
  const fnv = text => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return (h >>> 0).toString(16).padStart(8, "0"); };

  out("md2book layout report", new Date().toISOString());
  out("book:", title);
  out("\n[device]");
  out("ua:", navigator.userAgent);
  out("platform:", navigator.platform, "| touch points:", navigator.maxTouchPoints, "| dpr:", devicePixelRatio);
  out("screen:", `${screen.width}x${screen.height}`, "| viewport:", `${root.clientWidth}x${root.clientHeight}`, "| standalone:", matchMedia("(display-mode: standalone)").matches || navigator.standalone === true);
  out("layout:", root.dataset.layout, "| columns:", rendition?.columns, "| pages per spread:", rendition?.perSpread,
    "| paper:", css.getPropertyValue("--paper-width").trim() || "(book)", "x", css.getPropertyValue("--page-height").trim() || "(book)");
  out("row:", JSON.stringify(row));
  out("paper effects on:", ["show-through", "letterpress", "ink-bleed"].filter(name => root.classList.contains(name)).join(", ") || "none");

  // --- Fonts -------------------------------------------------------------
  out("\n[fonts]");
  const serif = css.getPropertyValue("--serif").trim(), bodySize = css.getPropertyValue("--body-size").trim() || "16px";
  out("--serif:", serif);
  out("--body-size:", bodySize, "| --body-leading:", css.getPropertyValue("--body-leading").trim());
  out("stylesheets:", [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => link.getAttribute("href")).filter(href => /font/.test(href)).join(" "));
  await document.fonts.ready;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;top:0;white-space:pre;visibility:hidden;font-kerning:none;font-variant-ligatures:none;text-rendering:geometricPrecision;font-synthesis:none";
  document.body.append(probe);
  const width = (family, text, size = "40px") => { probe.style.font = `${size} ${family}`; probe.textContent = text; return probe.getBoundingClientRect().width; };
  const sample = "国京都，。“”Ag";
  for (const family of serif.split(",").map(f => f.trim()).filter(Boolean)) {
    if (/^(serif|sans-serif|monospace)$/.test(family)) continue;
    // Present when it changes the width against both generic fallbacks.
    const present = width(`${family}, monospace`, sample) !== width("monospace", sample) && width(`${family}, sans-serif`, sample) !== width("sans-serif", sample);
    let loaded = "";
    try { loaded = document.fonts.check(`16px ${family}`, sample) ? "" : " (not all loaded)"; } catch { /* a system name */ }
    out(`  ${family}:`, present ? "yes" + loaded : "no");
  }
  const tests = ["京都的春天，哲学之道两旁的樱花开得正好。", "“国”国‘国’国", "国……国——国·国", "（国）《国》「国」【国】", "Lorem ipsum dolor sit amet, consectetur.", "2024年10月31日 iPad Safari"];
  for (const text of tests) {
    // Load the glyphs first, as the reader does before measuring.
    await document.fonts.load(`${bodySize} ${serif}`, text).catch(() => {});
    out(`  width(${text}):`, width(serif, text, bodySize).toFixed(3));
  }

  // --- Line breaking -------------------------------------------------------
  out("\n[line breaking]  (the browser's own rules, in a box two characters wide; the reader no longer uses them: it breaks lines by its own rules, see ownBreaks in epub-content.js)");
  const supports = ["text-spacing-trim: space-all", "text-autospace: no-autospace", "line-break: strict", "word-break: auto-phrase", "hanging-punctuation: allow-end", "text-wrap: pretty"];
  out("supports:", supports.map(rule => `${rule.split(":")[0]}=${CSS.supports(rule) ? "y" : "n"}`).join(" "));
  const box = document.createElement("div");
  box.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;font:${bodySize}/${bodySize} ${serif};width:2.05em;line-break:strict;overflow-wrap:normal;word-break:normal;font-kerning:none;font-variant-ligatures:none;text-spacing-trim:space-all;text-autospace:no-autospace`;
  document.body.append(box);
  const pairs = ["国”国", "国“国", "国，国", "国。”国", "国……国", "国——国", "国·国", "国（国", "国）国", "国《国", "国》国", "国：“国", "a国", "国a", "国1", "1国", "国、国", "国！国", "国？”国"];
  const results = [];
  for (const text of pairs) {
    box.textContent = text;
    const range = document.createRange();
    // Which characters start a new line: the break points.
    const starts = [];
    let lastTop = null;
    for (let i = 0; i < box.firstChild.length; i++) { range.setStart(box.firstChild, i); range.setEnd(box.firstChild, i + 1); const top = Math.round(range.getBoundingClientRect().top); if (lastTop !== null && top > lastTop) starts.push(i); lastTop = top; }
    results.push(`${text}→${starts.length ? text.slice(0, starts[0]) + "|" + text.slice(starts[0]) : "(one line)"}`);
  }
  out(results.join("  "));
  box.remove(); probe.remove();

  // --- Pages -------------------------------------------------------------
  out("\n[pages]  (each chapter by its title in the contents; each page by its page number in the book: first 10 … last 6 characters)");
  const current = rendition?.currentLocation?.();
  if (current) out("now at:", current.start?.cfi, "| page", current.pagination?.page ?? "?", "of", current.pagination?.total ?? "?");
  const spreadText = [...document.querySelectorAll(".spread.is-current .page[data-section]")].map(page => {
    // The page's own text (not its show-through or ink copies, nor stylesheets).
    const hosts = [...page.querySelectorAll(":scope > .page-area .epub-page-content")];
    const text = clean(hosts.map(host => [...(host.shadowRoot?.children || [])].find(el => el.localName === "html")?.textContent || "").join(""));
    return `ch${page.dataset.section} p${+page.dataset.sheet + 1}: ${text.slice(0, 10)} … ${text.slice(-6)}`;
  });
  if (spreadText.length) out("on screen:", spreadText.join("  |  "));
  if (!keep?.bookKey || !window.indexedDB) {
    out("(this device keeps no laid-out chapters, so only the pages on screen are listed)");
    return lines.join("\n");
  }
  const records = await new Promise(resolve => {
    const opening = indexedDB.open("md2book-epub-layout", 1);
    opening.onupgradeneeded = () => { opening.result.createObjectStore("chapters"); opening.result.createObjectStore("totals"); };
    opening.onerror = () => resolve([]);
    opening.onsuccess = () => {
      const db = opening.result, found = [];
      let tx;
      try { tx = db.transaction("chapters"); } catch { db.close(); return resolve([]); }
      const cursor = tx.objectStore("chapters").openCursor(IDBKeyRange.bound(keep.bookKey + "|", keep.bookKey + "|￿"));
      cursor.onsuccess = () => { const at = cursor.result; if (!at) return; found.push([String(at.key), at.value]); at.continue(); };
      tx.oncomplete = () => { db.close(); resolve(found); };
      tx.onerror = () => { db.close(); resolve(found); };
    };
  });
  // One layout per screen shape and settings: each listed on its own.
  const layouts = new Map();
  for (const [key, value] of records) {
    const [, sig, index] = key.split("|");
    if (!layouts.has(sig)) layouts.set(sig, []);
    layouts.get(sig).push([Number(index), value]);
  }
  if (!layouts.size) out("(no chapters kept yet: leave the book open for a while, then make the report again)");
  const scratch = document.createElement("div");
  // Lines are counted only in the chapter on screen: laying out every page of a
  // book again here is more than a tablet's memory takes.
  const measured = new Set([...document.querySelectorAll(".spread.is-current .page[data-section]")].map(page => Number(page.dataset.section)));
  out(`(lines counted in ${[...measured].map(i => `“${tocLabel(i)}” (file ${i})`).join(", ") || "the chapter on screen"})`);
  // Each kept page laid out again here, unseen, to count its lines and the
  // gaps between them: a line taller than the rest shows as an odd gap.
  const stage = document.createElement("div");
  stage.style.cssText = "position:absolute;left:-30000px;top:0;visibility:hidden;pointer-events:none";
  document.body.append(stage);
  const lineGaps = (sheet, cssText) => {
    const host = document.createElement("div");
    host.style.cssText = sheet.host;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style"); style.textContent = cssText; shadow.append(style);
    const html = document.createElement("html");
    for (const [name, value] of sheet.attrs) html.setAttribute(name, value);
    for (const part of sheet.parts) { const el = document.createElement(part.tag); for (const [n, v] of part.attrs) el.setAttribute(n, v); el.innerHTML = part.html; html.append(el); }
    shadow.append(html); stage.replaceChildren(host);
    const tops = new Map();   // text column -> line tops
    const walker = document.createTreeWalker(html, NodeFilter.SHOW_TEXT), range = document.createRange();
    for (let node; (node = walker.nextNode());) {
      if (!node.data.trim()) continue;
      range.selectNodeContents(node);
      const column = node.parentElement.closest(".epub-static-column") || html;
      for (const r of range.getClientRects()) {
        if (!r.width) continue;
        if (!tops.has(column)) tops.set(column, new Map());
        const top = Math.round(r.top * 2) / 2;
        if (!tops.get(column).has(top)) tops.get(column).set(top, node.data.trim().slice(0, 8));
      }
    }
    let lines = 0;
    const gaps = new Map();
    const odd = [];
    for (const map of tops.values()) {
      // Line fragments on one line differ by a pixel or two (sizes, fonts): one line.
      const sorted = [...map.keys()].sort((a, b) => a - b).filter((top, i, all) => i === 0 || top - all[i - 1] > 4);
      lines += sorted.length;
      const step = sorted.slice(1).map((top, i) => Math.round((top - sorted[i]) * 2) / 2);
      step.forEach(gap => gaps.set(gap, (gaps.get(gap) || 0) + 1));
      // A line set a pixel or two off (a glyph from another font) is followed by
      // one off the other way; a line that is really taller is not.
      let carry = 0;
      step.forEach((gap, i) => {
        const paragraph = gap > 44 && gap < 56;
        const delta = paragraph ? gap - 49.75 : gap - 30;
        if (Math.abs(delta) < 1 || gap > 60) { carry = 0; return; }
        carry += delta;
        if (Math.abs(carry) >= 1 && (i === step.length - 1 || Math.abs(carry + (step[i + 1] - (step[i + 1] > 44 && step[i + 1] < 56 ? 49.75 : 30))) >= 1)) {
          odd.push(`+${carry.toFixed(1)}px at “${map.get(sorted[i + 1]) || ""}”`);
          carry = 0;
        }
      });
    }
    return `${lines} lines, gaps ${[...gaps].sort((a, b) => b[1] - a[1]).map(([gap, n]) => `${gap}×${n}`).join(" ")}${odd.length ? " | taller: " + odd.join(", ") : ""}`;
  };
  for (const [sig, chapters] of layouts) {
    chapters.sort((a, b) => a[0] - b[0]);
    out(`layout ${sig}: ${chapters.length} chapters kept, ${chapters.reduce((sum, [, c]) => sum + c.total, 0)} pages`);
    // Page numbers run on through the book while every chapter before is kept.
    let first = 1, previous = -1;
    for (const [index, chapter] of chapters) {
      // A chapter not kept yet leaves a gap: the numbers after it are unknown.
      if (index !== previous + 1) first = null;
      previous = index;
      const pages = chapter.sheets.map(sheet => {
        scratch.innerHTML = sheet.parts.map(part => part.html).join("");
        return clean(scratch.textContent);
      });
      const numbered = first !== null;
      out(`${tocLabel(index)}  [${chapter.total} pages${numbered ? `, p. ${first}–${first + chapter.total - 1}` : ""}, ${fnv(pages.join("\u0000"))}, file ${index}]`);
      pages.forEach((text, i) => {
        let metrics = "";
        if (measured.has(index)) {
          try { metrics = " | " + lineGaps(chapter.sheets[i], chapter.styles[chapter.sheets[i].css]); } catch { /* not measurable */ }
        }
        out(`  ${numbered ? "p. " + (first + i) : "+" + (i + 1)}: ${text.slice(0, 10)} … ${text.slice(-6)}${metrics}`);
      });
      if (numbered) first += chapter.total;
    }
  }
  stage.remove();
  return lines.join("\n");
};
