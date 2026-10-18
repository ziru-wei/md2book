// Shared margin-note placement for Markdown and EPUB sheets.
window.readerNotes = {
  side(page, inLeftHalf) {
    const layout = document.documentElement.dataset.layout;
    if (layout === "phone") return "right";
    if (layout === "tablet") return page.classList.contains("page--left") ? "left" : "right";
    return inLeftHalf ? "left" : "right";
  },
  place(page, items) {
    if (!items.length) return;
    const box = page.getBoundingClientRect();
    const originTop = box.top + page.clientTop;
    const layer = document.createElement("div");
    layer.className = "page-comments";
    page.appendChild(layer);
    for (const item of items) {
      item.note.classList.add("comment-margin-marker--" + item.side);
      layer.appendChild(item.note);
    }

    // Notes stay between the first and last line of the text area.
    const area = page.querySelector(".page-area").getBoundingClientRect();
    const topLimit = area.top - originTop;
    const bottomLimit = area.bottom - originTop;
    const GAP = 6;
    for (const side of ["left", "right"]) {
      const column = items.filter(item => item.side === side);
      const heights = column.map(item => item.note.offsetHeight);
      const tops = column.map(item => item.top);
      // 1. Down: each note level with its anchor, or just below the note
      //    above it.
      for (let i = 0, cursor = topLimit; i < tops.length; i++) {
        tops[i] = Math.max(tops[i], cursor);
        cursor = tops[i] + heights[i] + GAP;
      }
      // 2. Up: a note running past the bottom moves up (giving up being
      //    level with its anchor), pushing the ones above it up too —
      //    but none above the first line.
      for (let i = tops.length - 1, limit = bottomLimit; i >= 0; i--) {
        tops[i] = Math.max(topLimit, Math.min(tops[i], limit - heights[i]));
        limit = tops[i] - GAP;
      }
      // 3. If they still don't all fit, keep them from overlapping and let
      //    the last one run off the bottom.
      for (let i = 0, cursor = topLimit; i < tops.length; i++) {
        tops[i] = Math.max(tops[i], cursor);
        cursor = tops[i] + heights[i] + GAP;
      }
      column.forEach((item, i) => { item.note.style.top = tops[i] + "px"; });
    }
    page.classList.add("page--notes");
  }
};
