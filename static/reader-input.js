// Shared trackpad gesture detection: follow the fingers, commit once, suppress momentum.
window.createReaderWheel = function(pageTurn, { blocked = () => false, direction = () => 1 } = {}) {
    let wheelIdle = null;
    let wheelDone = false;
    let lastWheelAt = -Infinity;
    let doneAt = 0;
    let lowest = Infinity;
    let recent = [];
    let lastDir = 0;
    const GESTURE_IDLE_GAP = 140;
    const COMMIT_AT = 0.33;

    function freshSwipe(abs, now) {
      if (now - doneAt < 250 || recent.length < 4) return false;
      const [a, b, c, d] = recent.slice(-4);
      return a < b && b < c && c < d && abs > Math.max(14, lowest * 4);
    }

    const handle = e => {
      if (e.ctrlKey || blocked()) return;
      if (!pageTurn.turn && !wheelDone && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;

      e.preventDefault();

      // Safari has given event times since 1970 rather than since the
      // page opened: on one clock with performance.now() either way.
      const at = e.timeStamp > 1e12 ? e.timeStamp - performance.timeOrigin : e.timeStamp;
      if (at - lastWheelAt > GESTURE_IDLE_GAP) {
        wheelDone = false;
        recent = [];
      }
      lastWheelAt = at;
      // The fingers stopped with the page part-way: it settles. Whatever
      // the same swipe sends after that is part of it.
      clearTimeout(wheelIdle);
      wheelIdle = setTimeout(() => {
        if (!pageTurn.turn || pageTurn.turn.anim) return;
        pageTurn.releaseTurn();
        wheelDone = true;
        doneAt = performance.now();
        lowest = Infinity;
      }, GESTURE_IDLE_GAP);

      const delta = (e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX) * direction();
      const abs = Math.abs(delta);
      const dir = Math.sign(delta);
      recent.push(abs);
      if (recent.length > 6) recent.shift();
      if (wheelDone) {
        lowest = Math.min(lowest, abs);
        const reversed = dir && dir !== lastDir && abs > 6;
        if (!reversed && !freshSwipe(abs, at)) return;
        wheelDone = false;
      }
      // A swipe's first touch can report a tiny sign-flipped delta.
      if (!pageTurn.turn && abs < 2) return;
      if (dir) lastDir = dir;
      if (!pageTurn.dragTurn(delta, "wheel")) {
        wheelDone = true;
        doneAt = at;
        lowest = Infinity;
        return;
      }
      if (pageTurn.turn && (pageTurn.turn.target ?? pageTurn.turn.progress) >= COMMIT_AT) {
        pageTurn.settleTurn(1);
        wheelDone = true;
        doneAt = at;
        lowest = Infinity;
      }
    };
    handle.destroy = () => clearTimeout(wheelIdle);
    return handle;
};
