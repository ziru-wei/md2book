// Shared trackpad gesture detection: follow the fingers however slowly they
// move, commit once, suppress momentum.
window.createReaderWheel = function(pageTurn, { blocked = () => false, direction = () => 1 } = {}) {
    let wheelIdle = null;
    let wheelDone = false;
    let lastWheelAt = -Infinity;
    let doneAt = 0;
    let lowest = Infinity;
    let recent = [];
    let lastDir = 0;
    let creep = 0;
    const GESTURE_IDLE_GAP = 140;
    // Fingers resting on the trackpad send nothing, as lifted ones do: a
    // slow turn is held this long through a pause before the page settles.
    const HOLD_GAP = 700;

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
        creep = 0;
      }
      lastWheelAt = at;
      let delta = (e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX) * direction();
      const abs = Math.abs(delta);
      const dir = Math.sign(delta);
      recent.push(abs);
      if (recent.length > 6) recent.shift();
      // The fingers stopped with the page part-way: it settles. Whatever
      // the same swipe sends after that is part of it. Momentum (fingers
      // lifted mid-swipe: steadily shrinking steps) settles at once; a slow
      // drag, only after a real pause.
      clearTimeout(wheelIdle);
      const tail = recent.slice(-4);
      const coasting = tail.length === 4 && tail.every((v, i) => !i || v < tail[i - 1]) && Math.max(...recent) > 6;
      wheelIdle = setTimeout(() => {
        if (!pageTurn.turn || pageTurn.turn.anim) return;
        pageTurn.releaseTurn();
        wheelDone = true;
        doneAt = performance.now();
        lowest = Infinity;
      }, coasting ? GESTURE_IDLE_GAP : HOLD_GAP);

      if (wheelDone) {
        lowest = Math.min(lowest, abs);
        const reversed = dir && dir !== lastDir && abs > 6;
        if (!reversed && !freshSwipe(abs, at)) return;
        wheelDone = false;
      }
      // A swipe's first touch can report a tiny sign-flipped delta; a very
      // slow swipe sends only tiny ones. They are added up, and the page
      // starts to turn once they come to a few pixels one way.
      if (!pageTurn.turn && abs < 2) {
        creep += delta;
        if (Math.abs(creep) < 3) return;
        delta = creep;
      }
      creep = 0;
      if (dir) lastDir = dir;
      if (!pageTurn.dragTurn(delta, "wheel")) {
        wheelDone = true;
        doneAt = at;
        lowest = Infinity;
        return;
      }
      // The page follows the fingers all the way: it is done once it's over.
      if (pageTurn.turn && (pageTurn.turn.target ?? pageTurn.turn.progress) >= 1) {
        pageTurn.settleTurn(1);
        wheelDone = true;
        doneAt = at;
        lowest = Infinity;
      }
    };
    handle.destroy = () => clearTimeout(wheelIdle);
    return handle;
};
