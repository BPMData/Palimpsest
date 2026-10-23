/* Ink on the pages of one open book.
   Each page element (.pg) holds three canvases: the page picture, a highlighter layer that multiplies
   (so printed lines and words stay dark under a highlight), and the pen layer on top.
   Strokes are stored in page units (page width = 1000), so zooming or rotating never moves ink. */

import { paintStroke, liveStart, liveAdd, livePieces, liveEndPieces, paintPieces, liveLift, seeThrough } from './ink-core.js';
import * as store from './store.js';

export const UNITS = 1000;

export function makeInk(bookKey) {
  let data = { v: 1, pages: {} }, undo = [], redo = [], saveTimer = null, dirty = false;
  const listeners = new Set();
  const changed = () => { for (const f of listeners) f(); };

  const list = (i) => data.pages[i] || (data.pages[i] = []);

  async function load() {
    const d = await store.get('ink', bookKey).catch(() => null);
    if (d && d.pages) data = d;
  }
  function save(now) {
    dirty = true;
    clearTimeout(saveTimer);
    const write = () => {
      if (!dirty) return Promise.resolve();
      dirty = false;
      const inked = Object.values(data.pages).some((s) => s.length);
      return Promise.all([store.put('ink', bookKey, data), store.touchBook(bookKey, { inked })]).catch(() => { dirty = true; });
    };
    if (now) return write();
    saveTimer = setTimeout(write, 600);
    return Promise.resolve();
  }
  function flush() { clearTimeout(saveTimer); return dirty ? save(true) : Promise.resolve(); }

  /* ---- canvases ---- */
  function layers(pg) {
    if (!pg._hl) {
      pg._hl = document.createElement('canvas'); pg._hl.className = 'hl';
      pg._ink = document.createElement('canvas'); pg._ink.className = 'ink';
      pg.append(pg._hl, pg._ink);
    }
    return pg;
  }
  /* size the ink layers for a page shown cssW × cssH at `density` device px per css px, then repaint */
  function layout(pg, cssW, cssH, density) {
    layers(pg);
    const w = Math.max(1, Math.round(cssW * density)), h = Math.max(1, Math.round(cssH * density));
    for (const c of [pg._hl, pg._ink]) { if (c.width !== w) c.width = w; if (c.height !== h) c.height = h; }
    pg._sc = w / UNITS;
    repaint(pg);
  }
  function repaint(pg) {
    if (!pg._hl) return;
    const i = +pg.dataset.page, sc = pg._sc || 1, hl = pg._hl.getContext('2d'), ink = pg._ink.getContext('2d');
    hl.setTransform(1, 0, 0, 1, 0, 0); hl.clearRect(0, 0, pg._hl.width, pg._hl.height);
    ink.setTransform(1, 0, 0, 1, 0, 0); ink.clearRect(0, 0, pg._ink.width, pg._ink.height);
    for (const s of data.pages[i] || []) {
      if (s.e) { paintStroke(hl, s, sc); paintStroke(ink, s, sc); }
      else paintStroke(seeThrough(s) ? hl : ink, s, sc);
    }
  }

  /* ---- drawing one stroke ---- */
  function point(pg, e) {
    const r = pg.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * UNITS, (e.clientY - r.top) / r.height * (UNITS * r.height / r.width)];
  }
  /* tool: { kind: 'pen' | 'hl' | 'eraser', color, width (page units), smooth (0-8) } */
  function start(pg, e, tool) {
    layers(pg);
    const i = +pg.dataset.page, [x, y] = point(pg, e);
    const s = { c: tool.color, w: tool.width, p: [Math.round(x * 10) / 10, Math.round(y * 10) / 10] };
    if (tool.kind === 'eraser') { s.e = 1; s.c = '#000'; }
    if (tool.kind === 'hl') s.h = 1;
    const live = liveStart(x, y), targets = s.e ? [pg._hl, pg._ink] : [s.h ? pg._hl : pg._ink];
    const draw = (pieces) => { for (const c of targets) paintPieces(c.getContext('2d'), s, pieces, pg._sc); };
    for (const c of targets) paintStroke(c.getContext('2d'), s, pg._sc);   // a dot right away, where the pen touched
    return {
      move(ev) {
        const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
        for (const c of (evs.length ? evs : [ev])) { const [px, py] = point(pg, c); liveAdd(s, live, px, py, tool.smooth); }
        draw(livePieces(s, live));
      },
      end(ev) {
        if (ev) { const [px, py] = point(pg, ev); liveLift(s, px, py); }
        draw(liveEndPieces(s, live));
        list(i).push(s);
        undo.push({ page: i, stroke: s }); redo = [];
        repaint(pg);   // repaint from the stored strokes, so what's on screen is exactly what's saved (and what Undo/Redo show)
        save(); changed();
      },
      cancel() { repaint(pg); },
    };
  }

  /* ---- history ---- */
  function apply(step, back, pgs) {
    if (step.clear !== undefined) {
      if (back) data.pages[step.clear] = step.before.slice();
      else data.pages[step.clear] = [];
    } else {
      const l = list(step.page);
      if (back) { const k = l.lastIndexOf(step.stroke); if (k >= 0) l.splice(k, 1); }
      else l.push(step.stroke);
    }
    for (const pg of pgs) repaint(pg);
    save(); changed();
    return step.clear !== undefined ? step.clear : step.page;
  }

  return {
    load, flush, layout, repaint,
    start,
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    count: (i) => (data.pages[i] || []).length,
    canUndo: () => undo.length > 0, canRedo: () => redo.length > 0,
    undo(pgs) { const s = undo.pop(); if (!s) return null; redo.push(s); return apply(s, true, pgs); },
    redo(pgs) { const s = redo.pop(); if (!s) return null; undo.push(s); return apply(s, false, pgs); },
    clearPage(i, pgs) {
      const before = (data.pages[i] || []).slice();
      if (!before.length) return;
      undo.push({ clear: i, before }); redo = [];
      apply({ clear: i, before }, false, pgs);
    },
  };
}
