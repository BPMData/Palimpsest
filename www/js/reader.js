/* The reader: one page (or a two-page spread in landscape), zoom, page turns, and the ink tools.

   Who does what:
   - the pen always writes (its eraser end, or side button, erases); fingers never write unless
     "Draw with finger" is on. A mouse counts as a finger.
   - finger: tap the left or right edge to turn the page, tap the middle to show or hide the bars,
     swipe to turn, pinch or double-tap to zoom, drag to move around a zoomed page.
   - while the pen is on the screen (and for a moment after), fingers and palms are ignored. */

import { openBook } from './books.js';
import { makeInk, UNITS } from './ink.js';
import { pointerKind, tint, confirmTap } from './ink-core.js';
import * as store from './store.js';

const PEN_COLORS = ['#111111', '#1565c0', '#d32f2f', '#e0218a', '#2e7d32'];
const HL_COLORS = ['#fdd835', '#7cb342', '#f06292', '#4fc3f7', '#ff8a3d'];
const PEN_SIZES = [1.2, 2, 3, 4.5, 7, 10];      // page units (page width = 1000)
const HL_SIZES = [10, 16, 24, 34];
const ERASER_PX = 28;                              // eraser size on screen, whatever the zoom
const MAX_ZOOM = 6;
const SAVES_AS_CBZ = new Set(['cbr', 'cb7', 'cbt', 'pics']);   // slow or loose comics worth saving as a CBZ

const $ = (sel, root = document) => root.querySelector(sel);

export function makeReader(root, { onClose, onBack, onSave }) {
  root.innerHTML = `
    <div class="stage" tabindex="-1"><div class="spread"></div><div class="rd-msg" hidden></div></div>
    <header class="rd-top">
      <button class="rd-back" data-act="back" aria-label="Back to the library" title="Back to the library">‹ <span>Library</span></button>
      <div class="rd-title"></div>
      <button class="btn quiet rd-save" data-act="save" hidden title="Save a copy as a CBZ: it opens faster, and other comic apps can read it. Your notes come along.">Save as CBZ</button>
      <div class="rd-page" aria-live="polite"></div>
    </header>
    <footer class="rd-bottom">
      <input class="rd-scrub" type="range" min="1" value="1" aria-label="Go to page">
      <div class="rd-tools" role="toolbar" aria-label="Ink tools">
        <div class="grp">
          <button data-tool="pen" title="Pen">${icon('pen')}<span>Pen</span></button>
          <button data-tool="hl" title="Highlighter">${icon('hl')}<span>Highlight</span></button>
          <button data-tool="eraser" title="Eraser (the pen's eraser end works too)">${icon('eraser')}<span>Erase</span></button>
        </div>
        <div class="grp swatches"></div>
        <div class="grp size">
          <button data-act="smaller" aria-label="Thinner" title="Thinner">−</button>
          <span class="size-dot" aria-hidden="true"><i></i></span>
          <button data-act="bigger" aria-label="Thicker" title="Thicker">+</button>
        </div>
        <div class="grp">
          <button data-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
          <button data-act="redo" aria-label="Redo" title="Redo (Ctrl+Y)">${icon('redo')}</button>
          <button data-act="clear" title="Clear this page's ink">Clear page</button>
        </div>
        <div class="grp">
          <button data-act="finger" aria-pressed="false" title="Let your finger (or mouse) draw. Off: the finger turns pages and zooms; only the pen draws.">${icon('finger')}<span>Finger draws</span></button>
          <button data-act="spread" aria-pressed="false" title="Show two pages side by side when the screen is wider than tall">${icon('spread')}<span>Two pages</span></button>
        </div>
      </div>
    </footer>`;

  const stage = $('.stage', root), spreadEl = $('.spread', root), msg = $('.rd-msg', root);
  const scrub = $('.rd-scrub', root), pageLabel = $('.rd-page', root), titleEl = $('.rd-title', root);

  const S = {
    tool: store.setting('tool', 'pen'),
    penColor: store.setting('pen-color', PEN_COLORS[0]),
    hlColor: store.setting('hl-color', HL_COLORS[0]),
    penSize: store.setting('pen-size', 2),
    hlSize: store.setting('hl-size', 1),
    finger: store.setting('finger', false),
    spread: store.setting('spread', true),
  };
  let book = null, entry = null, key = null, ink = null, unlisten = null;
  let first = 0;               // first page shown
  let shown = [];              // page numbers shown now
  let zoom = 1, tx = 0, ty = 0; // zoom and pan of the spread
  let base = null;             // { left, top, w, h } of the spread at zoom 1
  let renderToken = 0, sharpenTimer = null, chrome = true;

  /* ---------- tools ---------- */
  function syncTools() {
    for (const b of root.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === S.tool);
    const colors = S.tool === 'hl' ? HL_COLORS : PEN_COLORS, cur = S.tool === 'hl' ? S.hlColor : S.penColor;
    const sw = $('.swatches', root);
    sw.innerHTML = colors.map((c) => `<button data-color="${c}" style="--c:${S.tool === 'hl' ? tint(c, 0.15) : c}" aria-label="Color ${c}" class="${c === cur && S.tool !== 'eraser' ? 'on' : ''}"></button>`).join('');
    sw.classList.toggle('dim', S.tool === 'eraser');
    const dot = $('.size-dot i', root), units = S.tool === 'hl' ? HL_SIZES[S.hlSize] : PEN_SIZES[S.penSize];
    dot.style.width = dot.style.height = Math.max(3, Math.min(26, units * (S.tool === 'hl' ? 0.7 : 2.2))) + 'px';
    dot.style.background = S.tool === 'hl' ? tint(S.hlColor, 0.15) : S.penColor;
    $('.size', root).classList.toggle('dim', S.tool === 'eraser');
    $('[data-act="finger"]', root).setAttribute('aria-pressed', String(S.finger));
    $('[data-act="spread"]', root).setAttribute('aria-pressed', String(S.spread));
    $('[data-act="undo"]', root).disabled = !(ink && ink.canUndo());
    $('[data-act="redo"]', root).disabled = !(ink && ink.canRedo());
    stage.classList.toggle('finger-draws', S.finger);
    for (const k of ['tool', 'penColor', 'hlColor', 'penSize', 'hlSize', 'finger', 'spread'])
      store.saveSetting(k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), S[k]);
  }
  function toolFor(kind, pg) {
    const t = kind === 'eraser' ? 'eraser' : S.tool;
    if (t === 'eraser') {
      const r = pg.getBoundingClientRect();   // the same size on screen at any zoom
      return { kind: 'eraser', color: '#000', width: ERASER_PX / r.width * UNITS, smooth: 0 };
    }
    if (t === 'hl') return { kind: 'hl', color: tint(S.hlColor, 0.15), width: HL_SIZES[S.hlSize], smooth: 3 };
    return { kind: 'pen', color: S.penColor, width: PEN_SIZES[S.penSize], smooth: 3 };
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) { S.tool = b.dataset.tool; return syncTools(); }
    if (b.dataset.color) { if (S.tool === 'hl') S.hlColor = b.dataset.color; else { S.penColor = b.dataset.color; if (S.tool === 'eraser') S.tool = 'pen'; } return syncTools(); }
    const a = b.dataset.act;
    if (a === 'back') onBack();
    else if (a === 'save') onSave(entry, book);
    else if (a === 'smaller' || a === 'bigger') {
      const d = a === 'bigger' ? 1 : -1;
      if (S.tool === 'hl') S.hlSize = Math.max(0, Math.min(HL_SIZES.length - 1, S.hlSize + d));
      else S.penSize = Math.max(0, Math.min(PEN_SIZES.length - 1, S.penSize + d));
      syncTools();
    }
    else if (a === 'undo') history('undo');
    else if (a === 'redo') history('redo');
    else if (a === 'clear') confirmTap(b, () => { for (const i of shown) ink.clearPage(i, pages()); syncTools(); });
    else if (a === 'finger') { S.finger = !S.finger; syncTools(); }
    else if (a === 'spread') { S.spread = !S.spread; syncTools(); go(first, true); }
  });

  function history(which) {
    const i = ink[which](pages());
    if (i !== null && i !== undefined && !shown.includes(i)) go(i);   // jump to the page that changed
    syncTools();
  }

  /* ---------- pages and layout ---------- */
  const pages = () => [...spreadEl.children];
  const twoUp = () => S.spread && stage.clientWidth > stage.clientHeight * 1.1 && book && book.count > 1;
  /* a spread starts on an odd page (page 1 is the cover, on its own) */
  const spreadStart = (i) => (i <= 0 ? 0 : i % 2 === 1 ? i : i - 1);
  function pagesAt(i) {
    if (!twoUp()) return [i];
    const s = spreadStart(i);
    return s === 0 ? [0] : [s, s + 1].filter((p) => p < book.count);
  }
  const nextFirst = () => (twoUp() ? (spreadStart(first) === 0 ? 1 : spreadStart(first) + 2) : first + 1);
  const prevFirst = () => (twoUp() ? Math.max(0, spreadStart(first) - 2) : first - 1);

  async function go(i, force) {
    if (!book) return;
    i = Math.max(0, Math.min(book.count - 1, i));
    const want = pagesAt(i);
    if (!force && want.join() === shown.join()) return;
    first = want[0]; shown = want;
    resetZoom(false);
    spreadEl.textContent = '';
    for (const p of want) {
      const pg = document.createElement('div');
      pg.className = 'pg'; pg.dataset.page = p;
      const img = document.createElement('canvas'); img.className = 'img';
      pg.append(img);
      spreadEl.append(pg);
    }
    updateLabel();
    await layout();
    store.touchBook(key, { page: first, pages: book.count, opened: Date.now() }).catch(() => {});
    // get the next pages ready while this one is read
    for (const p of pagesAt(nextFirst())) if (p < book.count) book.size(p).catch(() => {});
  }

  function updateLabel() {
    const n = book.count, label = shown.length > 1 ? `${shown[0] + 1}–${shown[1] + 1}` : String(shown[0] + 1);
    pageLabel.textContent = `${label} / ${n}`;
    scrub.max = n; scrub.value = shown[0] + 1;
  }

  async function layout() {
    const token = ++renderToken;
    const sizes = await Promise.all(shown.map((p) => book.size(p)));
    if (token !== renderToken) return;
    // the pages fit between the bars while they show, and the whole screen when they're hidden
    const top = chrome ? $('.rd-top', root).offsetHeight : 0, bottom = chrome ? $('.rd-bottom', root).offsetHeight : 0;
    const W = stage.clientWidth, H = Math.max(100, stage.clientHeight - top - bottom), gap = 0;
    // every page shown at the same height; the spread fits the space
    const ratios = sizes.map((s) => s.w / s.h), sumR = ratios.reduce((a, b) => a + b, 0);
    let h = Math.min(H, (W - gap * (shown.length - 1)) / sumR), w = h * sumR + gap * (shown.length - 1);
    base = { left: (W - w) / 2, top: top + (H - h) / 2, w, h };
    spreadEl.style.left = base.left + 'px'; spreadEl.style.top = base.top + 'px';
    spreadEl.style.width = w + 'px'; spreadEl.style.height = h + 'px';
    pages().forEach((pg, k) => { pg.style.width = h * ratios[k] + 'px'; pg.style.height = h + 'px'; pg.style.aspectRatio = ''; });
    applyTransform();
    await sharpen(token);
  }

  /* draw the pictures and ink at the resolution the current zoom needs */
  async function sharpen(token = ++renderToken) {
    const density = (window.devicePixelRatio || 1) * zoom;
    await Promise.all(pages().map(async (pg) => {
      const i = +pg.dataset.page, cssW = parseFloat(pg.style.width), cssH = parseFloat(pg.style.height);
      const img = pg.querySelector('canvas.img');
      try { await book.draw(i, img, Math.round(cssW * density)); }
      catch (e) { if (token === renderToken) showMsg('Could not draw page ' + (i + 1) + ': ' + e.message); return; }
      if (token !== renderToken) return;
      ink.layout(pg, cssW, cssH, Math.min(density, 4096 / cssW));
    }));
  }

  /* ---------- zoom and pan ---------- */
  function clampPan() {
    if (zoom <= 1.001) { tx = ty = 0; return; }
    const W = stage.clientWidth, H = stage.clientHeight, w = base.w * zoom, h = base.h * zoom;
    // screen position of the spread's corner = base + t; keep the page covering the screen, or centered when smaller
    const lo = (size, view, b) => (size <= view ? (view - size) / 2 - b : view - size - b);
    const hi = (size, view, b) => (size <= view ? (view - size) / 2 - b : -b);
    tx = Math.min(hi(w, W, base.left), Math.max(lo(w, W, base.left), tx));
    ty = Math.min(hi(h, H, base.top), Math.max(lo(h, H, base.top), ty));
  }
  function applyTransform() {
    if (!base) return;
    clampPan();
    spreadEl.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
    stage.classList.toggle('zoomed', zoom > 1.01);
  }
  function zoomAt(z, cx, cy) {   // cx, cy: screen point (relative to the stage) that stays put
    z = Math.max(1, Math.min(MAX_ZOOM, z));
    const px = (cx - base.left - tx) / zoom, py = (cy - base.top - ty) / zoom;
    zoom = z; tx = cx - base.left - px * zoom; ty = cy - base.top - py * zoom;
    applyTransform();
    clearTimeout(sharpenTimer);
    sharpenTimer = setTimeout(() => sharpen(), 220);
  }
  function resetZoom(redraw = true) {
    const was = zoom; zoom = 1; tx = 0; ty = 0; applyTransform();
    if (redraw && was !== 1) { clearTimeout(sharpenTimer); sharpenTimer = setTimeout(() => sharpen(), 50); }
  }

  /* ---------- input ---------- */
  const touches = new Map();   // finger/mouse pointers: id -> { x, y, x0, y0, t0 }
  let stroke = null, strokeId = null, penUntil = 0, pinch = null, lastTap = null, tapTimer = null;
  const local = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const pageAt = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); return el && el.closest && el.closest('.pg'); };

  stage.addEventListener('pointerdown', (e) => {
    if (!book) return;
    const kind = pointerKind(e);
    const fingerLike = kind === 'finger' || kind === 'mouse';
    if (kind === 'mouse' && e.button !== 0) return;
    if (fingerLike && Date.now() < penUntil) return;            // a palm resting while writing
    e.preventDefault();
    stage.focus({ preventScroll: true });

    const drawsHere = !fingerLike || (S.finger && touches.size === 0);
    if (drawsHere) {
      const pg = pageAt(e);
      if (!pg || stroke) return;
      if (!fingerLike) penUntil = Date.now() + 1e9;
      stroke = ink.start(pg, e, toolFor(kind, pg)); strokeId = e.pointerId;
      try { stage.setPointerCapture(e.pointerId); } catch {}
      if (fingerLike) touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: Date.now(), drawing: true });
      return;
    }
    // a second finger while a finger was drawing: that was a pinch, not a line
    if (stroke && touches.has(strokeId)) { stroke.cancel(); stroke = null; touches.get(strokeId).drawing = false; strokeId = null; }
    try { stage.setPointerCapture(e.pointerId); } catch {}
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: Date.now() });
    if (touches.size === 2) startPinch();
  });

  stage.addEventListener('pointermove', (e) => {
    if (stroke && e.pointerId === strokeId) { stroke.move(e); return; }
    const t = touches.get(e.pointerId); if (!t) return;
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    t.x = e.clientX; t.y = e.clientY;
    if (pinch && touches.size >= 2) return movePinch();
    if (zoom > 1.01 && touches.size === 1) { tx += dx; ty += dy; applyTransform(); }
  });

  function endPointer(e) {
    if (stroke && e.pointerId === strokeId) {
      if (e.type === 'pointercancel') stroke.cancel(); else stroke.end(e);
      stroke = null; strokeId = null;
      touches.delete(e.pointerId);
      if (pointerKind(e) !== 'finger' && pointerKind(e) !== 'mouse') penUntil = Date.now() + 400;
      syncTools();
      return;
    }
    const t = touches.get(e.pointerId); if (!t) return;
    touches.delete(e.pointerId);
    if (pinch) { if (touches.size < 2) { pinch = null; for (const o of touches.values()) { o.x0 = o.x; o.y0 = o.y; o.t0 = 0; } } return; }
    if (e.type === 'pointercancel') return;
    const dx = e.clientX - t.x0, dy = e.clientY - t.y0, dt = Date.now() - t.t0;
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 350) return tap(e);
    if (zoom <= 1.01 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 800) turn(dx < 0 ? 1 : -1);
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  function startPinch() {
    const [a, b] = [...touches.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    clearTimeout(tapTimer); lastTap = null;
  }
  function movePinch() {
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const r = stage.getBoundingClientRect();
    tx += mx - pinch.mx; ty += my - pinch.my;   // two fingers moving together pan
    pinch.mx = mx; pinch.my = my;
    zoomAt(pinch.z * d / pinch.d, mx - r.left, my - r.top);
  }

  function tap(e) {
    const [x, y] = local(e), now = Date.now();
    if (lastTap && now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {   // double tap: zoom in there, or back out
      clearTimeout(tapTimer); lastTap = null;
      if (zoom > 1.01) resetZoom(); else zoomAt(2.5, x, y);
      return;
    }
    lastTap = { t: now, x, y };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      lastTap = null;
      const W = stage.clientWidth;
      if (zoom <= 1.01 && x < W * 0.28) turn(-1);
      else if (zoom <= 1.01 && x > W * 0.72) turn(1);
      else setChrome(!chrome);
    }, 260);
  }

  function turn(d) {
    if (!book) return;
    const to = d > 0 ? nextFirst() : prevFirst();
    if (to < 0 || to >= book.count) return flash(d > 0 ? 'Last page' : 'First page');
    go(to);
  }

  stage.addEventListener('wheel', (e) => {
    if (!book) return;
    e.preventDefault();
    const [x, y] = local(e);
    if (e.ctrlKey || e.metaKey) return zoomAt(zoom * Math.exp(-e.deltaY / 300), x, y);
    if (zoom > 1.01) { tx -= e.deltaX; ty -= e.deltaY; return applyTransform(); }
    wheelSum += e.deltaY;
    clearTimeout(wheelTimer); wheelTimer = setTimeout(() => { wheelSum = 0; }, 250);
    if (Math.abs(wheelSum) > 80) { turn(wheelSum > 0 ? 1 : -1); wheelSum = -1e5 * Math.sign(wheelSum); }   // one turn per flick
  }, { passive: false });
  let wheelSum = 0, wheelTimer = null;

  function onKey(e) {
    if (!book || root.hidden) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); return history(e.shiftKey ? 'redo' : 'undo'); }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); return history('redo'); }
    if (e.target.closest && e.target.closest('input')) return;
    if (['ArrowRight', 'PageDown', ' '].includes(k)) { e.preventDefault(); turn(1); }
    else if (['ArrowLeft', 'PageUp'].includes(k)) { e.preventDefault(); turn(-1); }
    else if (k === 'Home') go(0);
    else if (k === 'End') go(book.count - 1);
    else if (k === 'Escape' && zoom > 1.01) resetZoom();
  }
  document.addEventListener('keydown', onKey);

  scrub.addEventListener('input', () => { pageLabel.textContent = `${scrub.value} / ${book.count}`; });
  scrub.addEventListener('change', () => go(+scrub.value - 1));

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!book || root.hidden) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => go(first, true), 120);   // orientation can switch spreads on or off
  });

  function setChrome(on) {
    if (chrome === on) return;
    chrome = on; root.classList.toggle('bare', !on);
    if (book && zoom <= 1.01) layout();   // the pages grow into the space the bars leave
  }
  let flashTimer = null;
  function flash(text) { showMsg(text); clearTimeout(flashTimer); flashTimer = setTimeout(() => { msg.hidden = true; }, 1200); }
  function showMsg(text) { msg.textContent = text; msg.hidden = false; }
  function say(text) { showMsg(text); clearTimeout(flashTimer); flashTimer = setTimeout(() => { msg.hidden = true; }, 4000); }

  /* ---------- open / close ---------- */
  async function open(e, bytes) {
    entry = e; key = store.bookKey(e.name, e.size);
    titleEl.textContent = e.kind === 'pics' ? e.name : e.name.replace(/\.[^.]+$/, '');
    root.hidden = false; msg.hidden = true; spreadEl.textContent = ''; chrome = true; root.classList.remove('bare');
    book = await openBook(e.kind, bytes);
    $('.rd-save', root).hidden = !SAVES_AS_CBZ.has(book.kind);
    ink = makeInk(key);
    await ink.load();
    unlisten = ink.onChange(syncTools);
    const rec = await store.get('books', key).catch(() => null);
    await store.touchBook(key, { name: e.name, kind: e.kind, path: e.path || e.name, size: e.size, pages: book.count, opened: Date.now(), ...(e.loc ? { loc: e.loc } : {}) });
    syncTools();
    shown = [];
    await go(rec && rec.page < book.count ? rec.page : 0, true);
  }
  async function close() {
    if (!book) return;
    if (ink) await ink.flush();
    if (unlisten) unlisten();
    book.close(); book = null; ink = null; shown = [];
    spreadEl.textContent = '';
    root.hidden = true;
    onClose(entry);
  }

  syncTools();
  return { open, close, say, isOpen: () => !!book, go: (i) => go(i), get page() { return first; }, flush: () => ink && ink.flush() };
}

/* small line icons, drawn here so the app needs no icon font or image files */
function icon(name) {
  const p = {
    pen: '<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/>',
    hl: '<path d="M6 15l9-9 4 4-9 9H6z"/><path d="M4 21h8"/>',
    eraser: '<path d="M8 20l-4-4L14 6l6 6-8 8z"/><path d="M8 20h12"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>',
    finger: '<path d="M9 11V5a2 2 0 014 0v6"/><path d="M13 10a2 2 0 014 0v3a7 7 0 01-7 7H9a5 5 0 01-5-5v-2a2 2 0 014 0"/>',
    spread: '<rect x="3" y="5" width="8" height="14" rx="1"/><rect x="13" y="5" width="8" height="14" rx="1"/>',
  }[name];
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
