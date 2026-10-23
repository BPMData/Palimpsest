/* Ink drawing core, ported from OverBoard (github.com/BPMData/OverBoard, shared/ink-core.js, MIT).
   Kept close to the original so fixes can move between the two projects.

   Stroke: { c: color, w: width, e: 1 if eraser, h: 1 if highlight, p: [x0,y0,x1,y1,...] }
   Coordinates are page units: the page is 1000 wide (height = 1000 × page height / page width),
   so ink stays put whatever size the page is drawn at. */

/* mix a #rrggbb color toward white (amt 0..1) */
export function tint(hex, amt) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const m = (c) => Math.round(c + (255 - c) * amt);
  return '#' + ((1 << 24) | (m(r) << 16) | (m(g) << 8) | m(b)).toString(16).slice(1);
}

/* Android stylus: "pen"; its eraser end (or the side button on some pens) sets buttons & 32.
   Fingers report "touch", a mouse "mouse". */
export function pointerKind(e) {
  if (e.pointerType === 'pen' && ((e.buttons & 32) || e.button === 5)) return 'eraser';
  if (e.pointerType === 'touch') return 'finger';
  if (e.pointerType === 'mouse') return 'mouse';
  return 'pen';
}

/* highlights go on the multiply layer under the ink */
export const seeThrough = (s) => !!s.h;

function inkStyle(g, s, sc, ox, oy) {
  g.setTransform(sc, 0, 0, sc, ox, oy);
  g.globalCompositeOperation = s.e ? 'destination-out' : 'source-over';
  g.strokeStyle = s.c; g.fillStyle = s.c; g.lineWidth = s.w;
  g.lineCap = 'round'; g.lineJoin = 'round';
}

/* one whole stroke: quadratic curves through the midpoints between samples, so corners come out round.
   Ink coordinates map to canvas px as x*sc+ox. */
export function paintStroke(g, s, sc, ox = 0, oy = 0) {
  const p = s.p; g.save(); inkStyle(g, s, sc, ox, oy);
  g.beginPath();
  if (p.length < 4) { g.arc(p[0], p[1], s.w / 2, 0, 6.2832); g.fill(); }
  else {
    g.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length - 2; i += 2) g.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
    g.lineTo(p[p.length - 2], p[p.length - 1]);
    g.stroke();
  }
  g.restore();
}

/* ---- live drawing: the same curve as paintStroke, piece by piece as points arrive ----
   live = { fx, fy: smoothed pen position; ex, ey: where the drawn line ends; k: points drawn so far } */
export const liveStart = (x, y) => ({ fx: x, fy: y, ex: x, ey: y, k: 1 });

/* add one raw sample through the smoothing filter (level 0-8). Returns true if a point was kept. */
export function liveAdd(s, live, x, y, level) {
  const k = level / 10, n = s.p.length;
  live.fx = live.fx * k + x * (1 - k);
  live.fy = live.fy * k + y * (1 - k);
  const px = Math.round(live.fx * 10) / 10, py = Math.round(live.fy * 10) / 10;
  if (Math.abs(px - s.p[n - 2]) + Math.abs(py - s.p[n - 1]) < 0.3) return false;
  s.p.push(px, py);
  return true;
}

/* pieces not drawn yet: [x0,y0,cx,cy,x1,y1] (cx null = straight line) */
export function livePieces(s, live) {
  const p = s.p, n = p.length / 2, pieces = [];
  while (live.k < n) {
    const k = live.k;
    if (k >= 2) {
      const bx = p[2 * k - 2], by = p[2 * k - 1], mx = (bx + p[2 * k]) / 2, my = (by + p[2 * k + 1]) / 2;
      pieces.push([live.ex, live.ey, bx, by, mx, my]);
      live.ex = mx; live.ey = my;
    }
    live.k++;
  }
  return pieces;
}

/* the last straight bit to where the pen lifted; call once at the end of a stroke */
export function liveEndPieces(s, live) {
  const p = s.p, n = p.length;
  if (n < 4) return [];
  const pieces = livePieces(s, live);
  pieces.push([live.ex, live.ey, null, null, p[n - 2], p[n - 1]]);
  return pieces;
}

export function paintPieces(g, s, pieces, sc, ox = 0, oy = 0) {
  if (!pieces.length) return;
  g.save(); inkStyle(g, s, sc, ox, oy);
  for (const q of pieces) {
    g.beginPath(); g.moveTo(q[0], q[1]);
    if (q[2] === null) g.lineTo(q[4], q[5]); else g.quadraticCurveTo(q[2], q[3], q[4], q[5]);
    g.stroke();
  }
  g.restore();
}

/* finish the stroke where the pen lifted (smoothing trails slightly behind) */
export function liveLift(s, x, y) {
  const n = s.p.length;
  if (n >= 4 && Math.abs(x - s.p[n - 2]) + Math.abs(y - s.p[n - 1]) >= 0.3) s.p.push(x, y);
}

/* first tap arms ("Sure?"), second tap within 3 s does it */
export function confirmTap(btn, fn, sure = 'Sure?') {
  if (!btn.classList.contains('warn')) {
    btn._label = btn.innerHTML; btn.classList.add('warn'); btn.textContent = sure;
    btn._timer = setTimeout(() => { btn.classList.remove('warn'); btn.innerHTML = btn._label; }, 3000);
    return;
  }
  clearTimeout(btn._timer); btn.classList.remove('warn'); btn.innerHTML = btn._label; fn();
}
