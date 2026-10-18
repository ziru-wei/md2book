// Shared font-metric alignment for Markdown and EPUB drop caps.
(() => {
  const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;


  window.fitReaderDropCaps = function(area) {
    const document = area.ownerDocument, root = document.documentElement;
    const getComputedStyle = document.defaultView.getComputedStyle.bind(document.defaultView);
    const measureCanvas = document.createElement("canvas").getContext("2d");
    if (root.classList.contains("no-drop-cap")) return;
    for (const p of area.querySelectorAll("p.drop-cap")) {
      const initial = p.textContent.trimStart().match(/^[^\p{L}\p{N}]*[\p{L}\p{N}]/u)?.[0];
      const letter = initial && [...initial].at(-1);
      if (!letter) continue;
      const style = getComputedStyle(p);
      const size = parseFloat(style.fontSize);
      const lineHeight = parseFloat(style.lineHeight) || size * 1.2;
      const cjk = CJK_CHAR.test(letter);
      // What the letter spans: a capital's height, or a character's.
      const ref = cjk ? "国" : "H";
      const font = px => `${style.fontStyle} 400 ${px}px ${style.fontFamily}`;
      const ink = (text, px) => {
        measureCanvas.font = font(px);
        return measureCanvas.measureText(text);
      };
      const body = ink(ref, size);
      const up = body.actualBoundingBoxAscent;
      const down = cjk ? body.actualBoundingBoxDescent : 0;
      const unit = ink(ref, 100);
      const dropSize = (lineHeight + up + down) / ((unit.actualBoundingBoxAscent + (cjk ? unit.actualBoundingBoxDescent : 0)) / 100);

      // Where the paragraph's first baseline is, and where the drop
      // letter's own baseline sits in its box (line-height = its size).
      const probe = () => {
        const el = document.createElement("span");
        el.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
        return el;
      };
      const firstLine = probe();
      p.classList.remove("drop-cap");
      // A paragraph under three lines is too short to hold one.
      if (p.getBoundingClientRect().height < 2.5 * lineHeight) continue;
      p.prepend(firstLine);
      // A long EPUB paragraph spans several columns. Its union rectangle
      // starts at the top of a later column, not at the opening line.
      const firstFragment = p.getClientRects()[0];
      const baseline = firstLine.getBoundingClientRect().bottom - firstFragment.top;
      firstLine.remove();
      p.classList.add("drop-cap");
      const box = document.createElement("div");
      box.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${font(dropSize)};line-height:${dropSize}px`;
      const own = probe();
      box.append(initial, own);
      area.appendChild(box);
      const dropBaseline = own.getBoundingClientRect().bottom - box.getBoundingClientRect().top;
      box.remove();

      // The letter's ink top, where the first line's starts.
      const top = (baseline - up) - (dropBaseline - unit.actualBoundingBoxAscent / 100 * dropSize);
      const drop = ink(initial, dropSize);
      const gap = 0.45 * size;
      p.style.setProperty("--drop-size", dropSize + "px");
      p.style.setProperty("--drop-line", dropSize + "px");
      p.style.setProperty("--drop-top", top + "px");
      // The float ends just above the third line, so only two wrap it.
      p.style.setProperty("--drop-bottom", (2 * lineHeight - 0.5 - top - dropSize) + "px");
      p.style.setProperty("--drop-left", drop.actualBoundingBoxLeft + "px");
      p.style.setProperty("--drop-right", (gap - (drop.width - drop.actualBoundingBoxRight)) + "px");
    }
  }

})();

// Cache ink spread once per sheet; both readers use the same paper layer.
// EPUB supplies a flattened copy because DOM cloning cannot copy iframe contents.
window.addReaderInkBleed = function(list, copyPage) {
  for (const page of list) {
    if (page.querySelector(":scope > .page-bleed")) continue;
    const frozen = copyPage?.(page);
    const source = frozen?.copy || page;
    const layers = source.querySelectorAll(":scope > :is(.page-area, .page-foot, .page-number, .page-comments)");
    if (!layers.length) continue;
    const bleed = document.createElement("div");
    bleed.className = "page-bleed";
    bleed.setAttribute("aria-hidden", "true"); bleed.inert = true;
    for (const layer of layers) bleed.appendChild(frozen ? layer : layer.cloneNode(true));
    for (const el of bleed.querySelectorAll("[id]")) el.removeAttribute("id");
    page.appendChild(bleed); frozen?.restore();
  }
};
