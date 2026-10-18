// Shared paper-fold engine. Both readers supply laid-out page leaves;
// pagination and content loading remain owned by their respective readers.
window.createPageTurn = function createPageTurn(state) {
  "use strict";
  let turn = null;

  const div = window.createPageTurn.element;

  // Each frame of a turn only moves and fades what's already drawn — no
  // page, shape or shade is drawn again — so the browser can keep up at
  // full speed. The fold cuts by clipping, not by clip-path (whose shapes
  // are drawn afresh every frame): each page lies in a .leaf, inside a
  // large square .leaf-plane that clips what's outside it. Turned so one
  // edge runs along the fold, a plane shows just one side of it, and the
  // page inside is turned back so it stays put (or lands where the fold
  // throws it). The shades are gradients drawn once, faded in and out.

  // 2D affine maps, as CSS matrix(a, b, c, d, e, f): x' = a x + c y + e,
  // y' = b x + d y + f.
  const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const translate = (x, y) => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
  const rotate = angle => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
  };
  const compose = (P, Q) => ({
    a: P.a * Q.a + P.c * Q.b,
    b: P.b * Q.a + P.d * Q.b,
    c: P.a * Q.c + P.c * Q.d,
    d: P.b * Q.c + P.d * Q.d,
    e: P.a * Q.e + P.c * Q.f + P.e,
    f: P.b * Q.e + P.d * Q.f + P.f
  });
  const invert = M => {
    const det = M.a * M.d - M.b * M.c;
    return {
      a: M.d / det, b: -M.b / det, c: -M.c / det, d: M.a / det,
      e: (M.c * M.f - M.d * M.e) / det,
      f: (M.b * M.e - M.a * M.f) / det
    };
  };
  const css = M => `matrix(${[M.a, M.b, M.c, M.d, M.e, M.f].map(v => +v.toFixed(5)).join(", ")})`;

  // The plane's size: wide enough to hold a page however it's turned.
  const planeSize = () => 3 * Math.hypot(state.pageWidth, state.pageHeight);

  // A leaf: `content` on a plane, `width` x `height` at the leaf's top
  // left. book.css lays the plane out centred on that corner, the
  // content in its middle.
  function leaf(className, content, width = state.pageWidth, height = state.pageHeight) {
    const el = div("leaf" + (className ? " " + className : ""));
    el.style.width = width + "px";
    el.style.height = height + "px";
    const plane = div("leaf-plane");
    plane.append(...content);
    el.appendChild(plane);
    return el;
  }

  // Puts `el`'s plane on the side of the fold line (through M) that `s`
  // points to, and each of `items` ([element, map from its own
  // coordinates to the sheet's]) where its map takes it. `origin`: where
  // the leaf's corner is, on the sheet.
  function cutAlong(el, M, s, items, origin = 0) {
    const L = planeSize();
    const half = L / 2;
    // The plane's own square, [0, L]², onto the sheet: its left edge on
    // the fold line, the rest on side `s`.
    const along = [-s[1], s[0]];
    const H = { a: s[0], b: s[1], c: -s[1], d: s[0], e: M[0] - along[0] * half, f: M[1] - along[1] * half };
    el.firstChild.style.transform = css(compose(translate(-origin + half, half), H));
    const back = compose(translate(-half, -half), invert(H));
    for (const [item, map] of items) item.style.transform = css(compose(back, map));
  }

  // Lays leaf `el` and what's on it flat again.
  function uncut(el) {
    el.firstChild.style.transform = "";
    for (const item of el.firstChild.children) item.style.transform = "";
  }

  // Paper can't stretch: the corner stays within reach of both ends of
  // the spine.
  function withinReach(p, center, radius) {
    const dx = p[0] - center[0];
    const dy = p[1] - center[1];
    const d = Math.hypot(dx, dy);
    return d <= radius ? p : [center[0] + dx * radius / d, center[1] + dy * radius / d];
  }

  // A soft shade band along the fold, fading out in direction `g`: drawn
  // once (`background`, at full strength), then only placed and faded.
  function band(width, background) {
    const el = div("turn-band");
    el.style.width = 2 * Math.hypot(state.pageWidth, state.pageHeight) + "px";
    el.style.height = width + "px";
    el.style.background = background;
    return el;
  }

  function bandMap(el, at, g) {
    const len = parseFloat(el.style.width);
    return compose(compose(translate(at[0], at[1]), rotate(Math.atan2(-g[0], g[1]))), translate(-len / 2, 0));
  }

  // `grabY`: page height at which the page was taken (touch) — the
  // corner nearest it is the one that turns.
  function beginTurn(dir, grabY = null) {
    const to = state.current + dir;
    if (!state.spreads.length || to < 0 || to >= state.spreads.length) return null;
    state.navigated = true;

    const from = state.current;
    const double = state.perSpread === 2;
    const A = state.spreadPages[from];
    const B = state.spreadPages[to];
    const W = state.pageWidth;
    const H = state.pageHeight;

    // The pages turn where they lie, in their spreads (all laid out,
    // stacked in one place). Two pages a spread: the next spread goes on
    // top — its page under the turning one shows where the flap has
    // lifted off, and its facing page is the flap, folded over. One page:
    // the spread with the turning page goes on top, cut back to the
    // fold, over the other.
    let sheetX;      // where the turning page sits in its spread
    let hingeX;      // its bound edge, in its own coordinates
    let frontPage;
    let backPage = null;
    let underPage = null;
    let top;
    if (double) {
      top = to;
      if (dir > 0) {
        sheetX = W;
        hingeX = 0;
        frontPage = A[1];
        backPage = B[0];
        underPage = B[1];
      } else {
        sheetX = 0;
        hingeX = W;
        frontPage = A[0];
        backPage = B[1];
        underPage = B[0];
      }
    } else {
      top = dir > 0 ? from : to;
      sheetX = 0;
      hingeX = 0;
      frontPage = dir > 0 ? A[0] : B[0];
    }

    const leafOf = page => page.parentElement.parentElement;
    const overlay = (className, content, inner) => {
      const el = leaf("turn-leaf " + className, content);
      el.style.left = sheetX + "px";
      inner.appendChild(el);
      return el;
    };
    const dark = a => `rgba(6, 12, 22, ${a})`;
    const topInner = state.spreads[top].firstElementChild;
    const frontBand = band(W * 0.16, `linear-gradient(to bottom, ${dark(0.1)}, ${dark(0)})`);
    const frontShade = overlay("turn-front-shade", [frontBand], leafOf(frontPage).parentElement);
    const castBand = band(W * 0.3, `linear-gradient(to bottom, ${dark(0.32)}, ${dark(0)})`);
    const cast = overlay("turn-cast", [castBand], topInner);
    // The flap's light (and a lone page's plain back): on a sheet the
    // size of the page, folded over with it.
    const backBand = band(W * 0.45,
      `linear-gradient(to bottom, rgba(255, 255, 255, .5), ${dark(0.1)} 22%, ${dark(0)} 70%)`);
    const backSheet = div("turn-back-sheet" + (backPage ? "" : " turn-paper"));
    backSheet.style.width = W + "px";
    backSheet.style.height = H + "px";
    backSheet.appendChild(backBand);
    // One page a screen: nothing lies beyond the spine, so the flap is
    // cut at the page's edge — it slides away round the spine rather
    // than across the dark desk.
    const backShade = overlay("turn-back-shade" + (double ? "" : " turn-on-page"), [backSheet], topInner);

    const frontLeaf = leafOf(frontPage);
    const backLeaf = backPage && leafOf(backPage);
    const underLeaf = underPage && leafOf(underPage);
    if (backLeaf) backLeaf.classList.add("is-turn-back");

    state.spreads[from].classList.add("is-near");
    state.spreads[to].classList.add("is-near");
    state.spreads[top].style.zIndex = 4;
    state.spreads[top === from ? to : from].style.zIndex = 3;

    turn = {
      dir, from, to, top, double, hingeX,
      frontLeaf, backLeaf, underLeaf, backPage, underPage, frontPage,
      frontShade, cast, backShade, backSheet, frontBand, castBand, backBand,
      // Where the flap's page lies, on the sheet.
      backOrigin: backLeaf ? backLeaf.offsetLeft - sheetX : 0,
      corner: grabY !== null && grabY < H / 2 ? 0 : H,
      // Backward with one page per screen: the previous page comes back
      // over the current one — a forward turn of it, run in reverse.
      reversed: !double && dir < 0,
      progress: 0,
      yBias: 0,
      anim: null
    };
    drawTurn(0);
    return turn;
  }

  function drawTurn(progress) {
    const t = turn;
    t.progress = Math.min(1, Math.max(0, progress));
    const p = t.reversed ? 1 - t.progress : t.progress;
    const W = state.pageWidth;
    const H = state.pageHeight;
    const freeX = W - t.hingeX;
    const endX = 2 * t.hingeX - freeX;
    const cy = t.corner;

    // The corner's path: across to the far side of the spine, lifting
    // off the page edge on the way (or wherever the finger holds it).
    let P = [
      freeX + (endX - freeX) * p,
      cy + (cy ? -1 : 1) * H * 0.1 * Math.sin(Math.PI * p) + t.yBias * Math.sin(Math.PI * p)
    ];
    P = withinReach(P, [t.hingeX, cy], W);
    P = withinReach(P, [t.hingeX, H - cy], Math.hypot(W, H));

    const C = [freeX, cy];
    const dx = P[0] - C[0];
    const dy = P[1] - C[1];
    const len = Math.hypot(dx, dy);
    const flapParts = [t.backShade, t.cast, t.frontShade, t.backLeaf, t.underLeaf].filter(Boolean);
    if (len < 0.5) {
      // iframe views can override inherited visibility; opacity hides the
      // entire folded surface, including independently composited children.
      for (const el of flapParts) el.style.opacity = "0";
      if (!t.double) uncut(t.frontLeaf);
      return;
    }
    for (const el of flapParts) el.style.opacity = "";

    // Fold line: through M, normal n (pointing away from the corner).
    const n = [dx / len, dy / len];
    const m = [-n[0], -n[1]];
    const M = [(C[0] + P[0]) / 2, (C[1] + P[1]) / 2];

    // The flap is the back of the sheet: mirrored left-right (it's the
    // other side), then reflected across the fold — on the kept side.
    const r11 = 1 - 2 * n[0] * n[0];
    const r12 = -2 * n[0] * n[1];
    const r22 = 1 - 2 * n[1] * n[1];
    const md = 2 * (M[0] * n[0] + M[1] * n[1]);
    const flip = { a: -r11, b: -r12, c: r12, d: r22, e: r11 * W + md * n[0], f: r12 * W + md * n[1] };

    // Light: the page bends into the fold, the flap catches light where
    // it curls over, and it shades the page it uncovers.
    const curl = Math.sin(Math.PI * Math.min(1, p * 1.4));
    t.frontBand.style.opacity = curl.toFixed(3);
    t.castBand.style.opacity = ((0.28 * curl + 0.04) / 0.32).toFixed(3);
    t.backBand.style.opacity = curl.toFixed(3);
    t.backBand.style.transform = css(bandMap(t.backBand, [W - M[0], M[1]], [n[0], -n[1]]));

    if (t.double) {
      // The page underneath shows where the flap lifted off; the facing
      // page of the next spread is the flap.
      cutAlong(t.underLeaf, M, m, [[t.underPage, IDENTITY]]);
      cutAlong(t.backLeaf, M, n, [[t.backPage, flip]], t.backOrigin);
    } else {
      // The turning page, cut back to the fold.
      cutAlong(t.frontLeaf, M, n, [[t.frontPage, IDENTITY]]);
    }
    cutAlong(t.backShade, M, n, [[t.backSheet, flip]]);
    cutAlong(t.frontShade, M, n, [[t.frontBand, bandMap(t.frontBand, M, n)]]);
    cutAlong(t.cast, M, m, [[t.castBand, bandMap(t.castBand, M, m)]]);
  }

  // Lays every page flat again and shows `index`.
  function endTurn(index) {
    const t = turn;
    turn = null;
    if (t.anim) cancelAnimationFrame(t.anim);
    if (t.follow) cancelAnimationFrame(t.follow);
    state.current = index;
    state.markSpreads();
    for (const i of [t.from, t.to]) state.spreads[i].style.zIndex = "";
    for (const el of [t.frontLeaf, t.backLeaf, t.underLeaf]) {
      if (!el) continue;
      uncut(el);
      el.style.opacity = "";
      el.classList.remove("is-turn-back");
    }
    for (const el of [t.frontShade, t.cast, t.backShade]) el?.remove();
  }

  function cancelTurn() {
    if (turn) endTurn(turn.from);
  }

  // Animates the held turn to done (1) or back (0), easing out; a
  // finger's height offset eases away with it.
  function settleTurn(target, speed = 1) {
    const t = turn;
    if (!t) return;
    if (t.anim) cancelAnimationFrame(t.anim);
    if (t.follow) cancelAnimationFrame(t.follow);
    t.follow = null;
    t.target = null;
    const start = t.progress;
    const bias = t.yBias;
    const duration = Math.max(120, 420 * Math.abs(target - start)) / speed;
    const t0 = performance.now();
    const step = now => {
      if (turn !== t) return;
      const k = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      t.yBias = bias * (1 - eased);
      drawTurn(start + (target - start) * eased);
      if (k < 1) t.anim = requestAnimationFrame(step);
      else endTurn(target === 1 ? t.to : t.from);
    };
    t.anim = requestAnimationFrame(step);
  }

  // Keys: a whole animated turn. A turn still settling is finished
  // first, so quick presses keep up.
  function turnPage(dir) {
    if (turn) {
      if (turn.dir === dir && turn.anim) endTurn(turn.to);
      else cancelTurn();
    }
    if (!beginTurn(dir)) return;
    const t = turn;
    t.anim = requestAnimationFrame(t0 => {
      const run = now => {
        if (turn !== t) return;
        const k = Math.min(1, (now - t0) / 380);
        drawTurn(k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
        if (k < 1) t.anim = requestAnimationFrame(run);
        else endTurn(t.to);
      };
      run(t0);
    });
  }

  // Screen px of travel for a whole turn. A finger carries the corner
  // itself (two page widths across the spine of a spread; a little over
  // one for a lone page); a trackpad swipe needs about one page width.
  function turnDistance(source) {
    const pages = source !== "touch" ? 0.9 : turn && turn.double ? 2 : 1.2;
    return pages * state.pageWidth * state.viewScale;
  }

  // A trackpad's wheel events come unevenly — several in one frame, then
  // none — so the page isn't drawn at each one: it eases toward where
  // they've taken it (`target`), once a frame.
  function followTarget() {
    const t = turn;
    if (!t || t.target === null || t.target === undefined) return;
    const step = () => {
      if (turn !== t || t.target === null) return;
      const gap = t.target - t.progress;
      if (Math.abs(gap) < 0.002) {
        drawTurn(t.target);
        t.follow = null;
        return;
      }
      drawTurn(t.progress + gap * 0.35);
      t.follow = requestAnimationFrame(step);
    };
    if (!t.follow) t.follow = requestAnimationFrame(step);
  }

  // Follows a drag of `delta` screen px (positive: toward the next
  // page). `clientY` (touch): where the finger is, which the corner
  // follows. Returns false when there's no page that way.
  function dragTurn(delta, source, clientY = null) {
    if (turn && turn.anim) endTurn(turn.progress > 0.5 ? turn.to : turn.from);
    const pageY = () => {
      const box = state.spreads[state.current].getBoundingClientRect();
      return (clientY - (box.top + (box.height - state.pageHeight * state.viewScale) / 2)) / state.viewScale;
    };
    if (!turn) {
      if (!beginTurn(Math.sign(delta), clientY === null ? null : pageY())) return false;
    }
    const distance = turnDistance(source);
    if (source === "wheel") {
      const from = turn.target ?? turn.progress;
      const next = from + (delta * turn.dir) / distance;
      if (next < 0) {
        const rest = next * distance * turn.dir;
        cancelTurn();
        return rest === 0 ? true : dragTurn(rest, source, clientY);
      }
      turn.target = Math.min(1, next);
      followTarget();
      return true;
    }
    const next = turn.progress + (delta * turn.dir) / distance;
    if (next < 0) {
      // Dragged back past where it started: turn the other way instead.
      const rest = next * distance * turn.dir;
      cancelTurn();
      return rest === 0 ? true : dragTurn(rest, source, clientY);
    }
    if (clientY !== null) {
      // Hold the corner at the finger's height (relative to the arc).
      const s = Math.sin(Math.PI * (turn.reversed ? 1 - next : next));
      const arc = turn.corner + (turn.corner ? -1 : 1) * state.pageHeight * 0.1 * s;
      turn.yBias = s > 0.05 ? Math.max(-state.pageHeight, Math.min(state.pageHeight, (pageY() - arc) / s)) : 0;
    }
    drawTurn(next);
    return true;
  }

  // A released drag completes if it went past a quarter of the way or
  // was still moving that way (px/ms); otherwise the page falls back.
  function releaseTurn(velocity = 0) {
    if (!turn) return;
    const along = velocity * turn.dir;
    const reached = turn.target ?? turn.progress;
    settleTurn(reached > 0.25 || along > 0.35 ? 1 : 0, Math.max(1, Math.abs(velocity)));
  }


  return { leaf, planeSize, beginTurn, drawTurn, endTurn, cancelTurn, settleTurn, turnPage, dragTurn, releaseTurn,
    get turn() { return turn; } };
};

window.createPageTurn.element = function(className) {
    const el = document.createElement("div");
    el.className = className;
    return el;
  };
