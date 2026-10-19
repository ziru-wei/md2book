// Screen geometry shared by the Markdown and EPUB viewers.
window.createReaderLayout = function createReaderLayout(root, { tabletAspectRatio, fixedTablet = false } = {}) {
  const isTouch =
    matchMedia("(pointer: coarse)").matches ||
    matchMedia("(hover: none)").matches ||
    navigator.maxTouchPoints > 1;
  // Tablets show a two-page spread in landscape, one page in portrait;
  // phones always one. Every iPad's short side is >= 744 CSS px, every
  // phone's well under 600.
  const isTablet = isTouch && Math.min(screen.width, screen.height) >= 600;
  // Safari (and every iOS browser — all WebKit) prints differently (see
  // print.css).
  root.classList.toggle("is-webkit-print", navigator.vendor === "Apple Computer, Inc.");
  root.classList.toggle("is-touch", isTouch);

  // Which page geometry to cut for (see book.css):
  // - "book": the fixed two-column page, scaled to fit — desktop, and a
  //   portrait tablet.
  // - "phone": the page IS the screen, one column, larger type.
  // - "tablet": a landscape tablet's two-page spread, each page half the
  //   screen, one column.
  // Only "book" pages are independent of the screen; the other two are
  // cut again whenever the screen's shape changes.
  // Desktop: opens on the book page, or — layout rows with one column
  // (.desktop-tablet) — on the tablet-style spread. The backslash key
  // switches between the two for this visit only: a reload opens the
  // page as the settings lay it out again.


  // The tablet-style spread on a computer, in a window too narrow for
  // two pages side by side: one page, the window's full width. Two
  // would leave each page's text under 300px between its margins (the
  // widest, with side comments: 250px and 120px, or 26% and 12% of the
  // page when narrower — see book.css).
  function tabletSingle() {
    if (fixedTablet || isTouch || root.dataset.layout !== "tablet") return false;
    const page = viewportWidth() / 2;
    return page - Math.min(250, page * 0.26) - Math.min(120, page * 0.12) < 300;
  }

  function layoutFor(wantsTablet) {
    if (!isTouch) return wantsTablet ? "tablet" : "book";
    if (!isTablet) return "phone";
    return fixedTablet ? (wantsTablet ? "tablet" : "book") : viewportWidth() > viewportHeight() ? "tablet" : "book";
  }

  let layoutKey = "";

  // Sets the layout and screen-derived page size; true if they changed.
  function applyLayout(wantsTablet) {
    const layout = layoutFor(wantsTablet);
    const w = viewportWidth();
    const h = viewportHeight();
    const key = layout === "book" ? layout : `${layout}:${w}x${h}`;
    if (key === layoutKey) return false;
    layoutKey = key;
    root.dataset.layout = layout;
    root.classList.toggle("tablet-single", tabletSingle());
    if (layout === "book") {
      root.style.removeProperty("--paper-width");
      root.style.removeProperty("--page-height");
    } else {
      let paperWidth = layout === "tablet" && !tabletSingle() ? w / 2 : w;
      let paperHeight = h;
      if (layout === "tablet" && tabletAspectRatio > 0) {
        // Fixed paper (EPUB): 1000 units tall, as wide as the ratio says.
        paperWidth = fixedTablet ? Math.round(1000 * tabletAspectRatio) : Math.min(paperWidth, h * tabletAspectRatio);
        paperHeight = paperWidth / tabletAspectRatio;
      }
      root.style.setProperty("--paper-width", Math.floor(paperWidth) + "px");
      root.style.setProperty("--page-height", Math.floor(paperHeight) + "px");
    }
    return true;
  }

  function viewportWidth() {
    return root.clientWidth || window.innerWidth;
  }

  // 100svh: the height with the mobile address bar shown. It stays put
  // while the bar slides in and out, unlike innerHeight, whose constant
  // changes would feed a resize -> rescale loop.
  function viewportHeight() {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:0;height:100svh;width:0;visibility:hidden;";
    document.body.appendChild(probe);
    const h = probe.offsetHeight || root.clientHeight || window.innerHeight;
    probe.remove();
    return h;
  }

  function pagesPerSpread(wantsDouble = true, pageCount = 2) {
    if (pageCount <= 1) return 1;
    // EPUB's fixed tablet paper: two sheets in a landscape window, one in a portrait
    // one, on an iPad and on a computer alike (a computer may still force the other
    // with "/": `wantsDouble` is then a boolean instead of null).
    if (fixedTablet && (isTablet || wantsDouble === null)) return viewportWidth() > viewportHeight() ? 2 : 1;
    if (isTouch) return root.dataset.layout === "tablet" ? 2 : 1;
    if (tabletSingle()) return 1;
    return wantsDouble ? 2 : 1;
  }

  return { isTouch, isTablet, viewportWidth, viewportHeight, tabletSingle, applyLayout, pagesPerSpread };
};
