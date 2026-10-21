// Shared by the Markdown and EPUB readers. Opened from the home page
// (static/home.js), a book loads in a frame named "md2book-reader" while the
// home page shows how far it has got: the reader tells it each step, and
// where its page is once the first spread is on screen. A double click on the
// dark around the pages, or "<-- Back" in the contents menu, goes back to the
// home page.
(function () {
  "use strict";
  const framed = window.name === "md2book-reader" && window.parent !== window;
  let readySent = false;
  const tell = message => {
    if (framed) parent.postMessage({ md2book: "opening", ...message }, location.origin);
  };

  // The home page shares this page's thread, and laying out a book can hold it
  // for seconds: a step waits a moment, for the home page's animation to start
  // (once started, it runs on even while this page works).
  window.md2bookOpening = {
    step(name) {
      if (readySent) return Promise.resolve();
      tell({ step: name });
      return framed ? new Promise(resolve => setTimeout(resolve, 80)) : Promise.resolve();
    },
    // Once the first spread has been drawn (drawing it can take seconds too):
    // the page the cover settles on — the right-hand one of the spread on
    // screen, or the only one — and whether it is the book's own cover.
    ready() {
      if (readySent) return;
      readySent = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const pages = [...document.querySelectorAll(".spread.is-current .page:not(.page--absent)")];
        const page = pages[pages.length - 1], r = page && page.getBoundingClientRect();
        tell({ step: "ready", rect: r && r.width ? { left: r.left, top: r.top, width: r.width, height: r.height } : null, cover: !!page && page.classList.contains("epub-cover") });
      }));
    },
    failed() { if (!readySent) { readySent = true; tell({ step: "failed" }); } }
  };
  tell({ step: "arrived" });

  // The home page: the one that opened this book, the browser version's, the
  // one last visited here (its path may be private, so it is never in the page),
  // else wherever this page was opened from.
  function goHome() {
    if (framed) { tell({ step: "close" }); return; }
    try { if (window.parent !== window && parent.md2book && parent.md2book.go) { parent.md2book.go("/"); return; } } catch { /* another site's frame */ }
    let home = null;
    try { home = localStorage.getItem("md2book-home-path"); } catch { /* storage unavailable */ }
    if (home) location.href = home;
    else if (document.referrer && new URL(document.referrer).origin === location.origin) history.back();
  }
  document.addEventListener("dblclick", event => {
    if (event.target.closest && event.target.closest(".page, dialog, a, button, input, textarea, select, label, .epub-popup, .epub-handle, [role='button']")) return;
    goHome();
  });
  // And from the contents menu: "<-- Back" at its top left.
  for (const menu of document.querySelectorAll("dialog.toc-dialog")) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "toc-back";
    back.textContent = "<-- Back";
    back.addEventListener("click", () => { menu.close(); goHome(); });
    menu.prepend(back);
  }
})();
