/* The library: the folder the reader picked, browsed folder by folder, with covers.
   Covers are made in the background, one or two at a time, only for the tiles on screen,
   and kept in the database, so a big collection is slow only the first time it's browsed. */

import * as store from './store.js';
import { makeCover, EPUB_WHY } from './books.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const title = (name) => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
const extOf = (name) => ((/\.([a-z0-9]+)$/i.exec(name) || [])[1] || '').toLowerCase();

/* Can Palimpsest handle this file? Every file in a folder is shown; the ones it can't handle say why.
   'yes'  opens, and you can write on it
   'view' opens, but you can't write on it (nothing is like this yet; kept for text EPUBs later)
   'no'   can't open it
   '?'    an EPUB not looked inside yet (that happens when its cover is made) */
const OTHER_WHY = [
  [/^(cbr|cb7|rar|7z|cbt|tar)$/, 'A RAR/7z comic. Repack it as a CBZ (a plain zip) and Palimpsest can open it.'],
  [/^(mobi|azw\d?|kfx|prc)$/, 'A Kindle book. Convert it to EPUB (Calibre does this).'],
  [/^(jpe?g|png|webp|gif|avif|bmp|tiff?|heic)$/, 'A loose picture, not a book. Zip a folder of pages into a CBZ to read it as a comic.'],
  [/^(djvu|xps|fb2|lit|docx?|odt|rtf|txt|md|html?)$/, 'Palimpsest doesn’t read this kind of file.'],
];
export function support(e, rec) {
  if (e.kind === 'pdf' || e.kind === 'cbz') return { can: 'yes' };
  if (e.kind === 'epub') {
    const st = rec && rec.epub;
    if (!st) return { can: '?' };
    return st === 'ok' ? { can: 'yes' } : { can: 'no', why: EPUB_WHY[st], short: st === 'drm' ? 'Copy-protected' : st === 'text' ? 'Text EPUB' : 'Damaged' };
  }
  const ext = extOf(e.name);
  return { can: 'no', why: (OTHER_WHY.find(([re]) => re.test(ext)) || [0, 'Not a book file.'])[1] };
}

export function makeLibrary(root, source, { onOpen, onNavigate }) {
  root.innerHTML = `
    <header class="lib-top">
      <h1 class="mark">Palimpsest</h1>
      <nav class="crumbs" aria-label="Folders"></nav>
      <div class="lib-actions">
        <input class="filter" type="search" placeholder="Find in this folder" aria-label="Find in this folder" hidden>
        <button class="btn quiet" data-act="file" title="Open one PDF, CBZ or EPUB file">Open a file</button>
        <button class="btn quiet" data-act="change" hidden>Change folder</button>
      </div>
    </header>
    <main class="lib-body">
      <section class="welcome" hidden>
        <h2>Your comics and books, with a pen.</h2>
        <p>Pick the folder where you keep your PDFs, CBZ comics and EPUBs. Palimpsest only reads that folder, and your notes stay on this device.</p>
        <button class="btn big" data-act="pick">Choose your library folder</button>
        <p class="hint web-only" hidden>This browser can’t open folders. Use <b>Open a file</b> above, or Chrome or Edge on a computer.</p>
      </section>
      <section class="again" hidden>
        <p>Palimpsest needs permission to read <b class="again-name"></b> again.</p>
        <button class="btn big" data-act="again">Open my library</button>
        <button class="btn quiet" data-act="pick">Choose a different folder</button>
      </section>
      <section class="recent" hidden><h2>Continue reading</h2><div class="shelf"></div></section>
      <section class="folder"><div class="folders"></div><div class="grid"></div><p class="empty" hidden></p>
        <div class="others" hidden><h2>Other files <span>Palimpsest can’t open these</span></h2><ul></ul></div></section>
    </main>
    <input type="file" class="one-file" accept=".pdf,.cbz,.epub,application/pdf,application/epub+zip" hidden>
    <div class="toast" role="status" hidden></div>`;

  const $ = (s) => root.querySelector(s);
  const grid = $('.grid'), folders = $('.folders'), crumbs = $('.crumbs'), filter = $('.filter'), empty = $('.empty');
  let rootDir = null, stack = [], entries = [], urls = [];   // stack: [{ name, ref }] from the library folder down
  let observer = null;

  /* ---------- covers ---------- */
  const queue = [], busy = new Set(), LIMIT = source.native ? 1 : 2;
  async function coverFor(tile) {
    const e = tile._entry, k = store.bookKey(e.name, e.size);
    const cached = await store.get('covers', k).catch(() => null);
    if (cached && (e.kind !== 'epub' || support(e, tile._rec).can !== '?')) return cached;
    const { cover, status } = await makeCover(e.kind, await source.read(e));
    if (cover) await store.put('covers', k, cover).catch(() => {});
    if (e.kind === 'epub') {   // remember what kind of EPUB it is, and show it on the tile
      tile._rec = await store.touchBook(k, { epub: status }).catch(() => ({ ...tile._rec, epub: status }));
      markTile(tile);
    }
    return cover;
  }
  function pump() {
    while (busy.size < LIMIT && queue.length) {
      const tile = queue.shift();
      if (!tile.isConnected || tile.dataset.cover) continue;
      busy.add(tile);
      tile.dataset.cover = 'loading';
      coverFor(tile).then((blob) => {
        if (!blob) { tile.dataset.cover = 'none'; return; }
        const u = URL.createObjectURL(blob); urls.push(u);
        const img = tile.querySelector('.cover');
        img.style.backgroundImage = `url("${u}")`;
        tile.dataset.cover = 'done';
      }, () => { tile.dataset.cover = 'none'; }).finally(() => { busy.delete(tile); pump(); });
    }
  }
  function watch(tile) {
    if (!observer) observer = new IntersectionObserver((list) => {
      for (const it of list) if (it.isIntersecting) { observer.unobserve(it.target); queue.push(it.target); }
      pump();
    }, { rootMargin: '300px' });
    observer.observe(tile);
  }

  /* ---------- drawing the folder ---------- */
  function bookTile(e, rec) {
    const b = document.createElement('button');
    b.className = 'tile book'; b._entry = e; b._rec = rec;
    const pct = rec && rec.pages ? Math.round(((rec.page || 0) + 1) / rec.pages * 100) : 0;
    b.innerHTML = `<span class="cover" data-kind="${e.kind}"><span class="kind">${e.kind.toUpperCase()}</span>${rec && rec.inked ? '<span class="inked" title="Has your notes">✎</span>' : ''}<span class="badge"></span></span>
      <span class="name">${esc(title(e.name))}</span><span class="why"></span>
      ${pct ? `<span class="progress" title="Page ${(rec.page || 0) + 1} of ${rec.pages}"><i style="width:${pct}%"></i></span>` : ''}`;
    markTile(b);
    b.addEventListener('click', () => {
      const s = support(e, b._rec);
      if (s.can === 'no') toast(s.why); else open(e);
    });
    return b;
  }
  /* a book Palimpsest can't open (or can't write on) is dimmed, with a badge and the reason */
  function markTile(b) {
    const s = support(b._entry, b._rec);
    b.dataset.support = s.can;
    b.querySelector('.badge').textContent = s.can === 'no' ? 'Can’t open' : s.can === 'view' ? 'No notes' : '';
    b.querySelector('.why').textContent = s.short || '';
    b.title = b._entry.name + (s.why ? '\n' + s.why : '');
  }
  function otherRow(e) {
    const li = document.createElement('li'), s = support(e);
    li.innerHTML = `<span class="ext">${esc(extOf(e.name).toUpperCase().slice(0, 5) || 'FILE')}</span><span class="nm">${esc(e.name)}</span><span class="why">${esc(s.why)}</span>`;
    li.title = e.name;
    return li;
  }
  function folderTile(d) {
    const b = document.createElement('button');
    b.className = 'tile folder';
    b.innerHTML = `<span class="icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 014.5 5H9l2 2h8.5A1.5 1.5 0 0121 8.5v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z"/></svg></span><span class="name">${esc(d.name)}</span>`;
    b.addEventListener('click', () => enter(d));
    return b;
  }

  async function render() {
    for (const u of urls) URL.revokeObjectURL(u);
    urls = []; queue.length = 0;
    if (observer) observer.disconnect();
    crumbs.innerHTML = stack.map((s, i) => `<button data-depth="${i}" ${i === stack.length - 1 ? 'aria-current="page"' : ''}>${esc(s.name)}</button>`).join('<span class="sep">/</span>');
    const q = filter.value.trim().toLowerCase();
    const shown = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
    const recs = new Map((await store.all('books').catch(() => [])).map((r) => [r.key, r]));
    const others = $('.others'), otherList = $('.others ul');
    grid.textContent = ''; folders.textContent = ''; otherList.textContent = '';
    for (const e of shown) {
      if (e.dir) { folders.append(folderTile(e)); continue; }
      if (e.kind === 'other') { otherList.append(otherRow(e)); continue; }
      const tile = bookTile(e, recs.get(store.bookKey(e.name, e.size)));
      grid.append(tile);
      watch(tile);
    }
    folders.hidden = !folders.children.length;
    others.hidden = !otherList.children.length;
    empty.hidden = folders.children.length + grid.children.length > 0;
    empty.textContent = q ? 'Nothing here matches “' + filter.value.trim() + '”.' : 'No PDFs, comics or EPUBs in this folder.';
    await renderRecent();
  }

  async function renderRecent() {
    const sec = $('.recent'), shelf = $('.shelf');
    const list = stack.length === 1 && !filter.value ? (await store.recent(8).catch(() => [])).filter((r) => r.loc) : [];
    sec.hidden = !list.length;
    shelf.textContent = '';
    for (const r of list) {
      const b = document.createElement('button');
      b.className = 'tile book small';
      const pct = r.pages ? Math.round(((r.page || 0) + 1) / r.pages * 100) : 0;
      b.innerHTML = `<span class="cover" data-kind="${r.kind}"><span class="kind">${(r.kind || '').toUpperCase()}</span></span><span class="name">${esc(title(r.name))}</span><span class="progress"><i style="width:${pct}%"></i></span>`;
      b.title = r.name + (r.pages ? ` (page ${(r.page || 0) + 1} of ${r.pages})` : '');
      store.get('covers', r.key).then((blob) => {
        if (!blob) return;
        const u = URL.createObjectURL(blob); urls.push(u);
        b.querySelector('.cover').style.backgroundImage = `url("${u}")`;
        b.dataset.cover = 'done';
      }).catch(() => {});
      b.addEventListener('click', () => reopen(r));
      shelf.append(b);
    }
  }

  async function load(push = true) {
    const here = stack[stack.length - 1];
    grid.setAttribute('aria-busy', 'true');
    try { entries = await source.list(here.ref); }
    catch (err) { entries = []; toast('Could not read this folder: ' + err.message); }
    grid.removeAttribute('aria-busy');
    filter.value = '';
    filter.hidden = entries.length < 12;
    await render();
    if (push) onNavigate(stack.map((s) => s.name));
  }

  function enter(d) { stack.push({ name: d.name, ref: d.ref }); load(); }

  /* ---------- opening ---------- */
  function locOf(e) {
    if (source.native) return { uri: e.ref.uri };
    return { path: stack.slice(1).map((s) => s.name).concat(e.name) };
  }
  function open(e) {
    onOpen({ ...e, path: stack.slice(1).map((s) => s.name).concat(e.name).join('/'), loc: locOf(e) });
  }
  async function reopen(r) {
    try {
      let ref;
      if (r.loc.uri) ref = { uri: r.loc.uri };
      else {
        let dir = rootDir.ref;
        for (const seg of r.loc.path.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
        ref = await dir.getFileHandle(r.loc.path[r.loc.path.length - 1]);
      }
      onOpen({ dir: false, name: r.name, size: r.size, kind: r.kind, ref, path: r.path, loc: r.loc });
    } catch { toast('“' + title(r.name) + '” has moved. Find it in its folder.'); }
  }

  /* ---------- the library folder ---------- */
  function showState(state, name) {
    $('.welcome').hidden = state !== 'welcome';
    $('.again').hidden = state !== 'again';
    $('.folder').hidden = state !== 'folder';
    $('[data-act="change"]').hidden = state !== 'folder';
    if (name) $('.again-name').textContent = name;
    if (state === 'welcome' && !source.native && !source.supported) {
      $('.welcome .web-only').hidden = false;
      $('.welcome [data-act="pick"]').hidden = true;
    }
    if (state !== 'folder') { crumbs.textContent = ''; $('.recent').hidden = true; filter.hidden = true; }
  }
  async function useRoot(r) {
    rootDir = r; stack = [{ name: r.name, ref: r.ref }];
    showState('folder');
    await load();
  }
  async function start() {
    let r = null;
    try { r = await source.restore(); } catch {}
    if (!r) return showState('welcome');
    if (r.lost) return r.again ? showState('again', r.name) : (showState('welcome'), toast('Palimpsest lost access to “' + r.name + '”. Choose it again.'));
    await useRoot(r);
  }

  root.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const a = b.dataset.act;
    try {
      if (a === 'pick' || a === 'change') await useRoot(await source.pick());
      else if (a === 'again') await useRoot(await source.again());
      else if (a === 'file') { const f = $('.one-file'); f.value = ''; f.click(); }
    } catch (err) {
      if (err && err.name !== 'AbortError' && !/cancel/i.test(err.message || '')) toast(err.message || String(err));
    }
    if (b.dataset.depth !== undefined) { stack = stack.slice(0, +b.dataset.depth + 1); load(); }
  });
  $('.one-file').addEventListener('change', () => {
    const f = $('.one-file').files[0]; if (!f) return;
    const kind = (/\.(pdf|cbz|epub|zip)$/i.exec(f.name) || [])[1];
    if (!kind) return toast('Palimpsest opens PDF, CBZ and EPUB files.');
    onOpen({ dir: false, name: f.name, size: f.size, kind: kind.toLowerCase() === 'zip' ? 'cbz' : kind.toLowerCase(), ref: null, file: f, path: f.name, loc: null });
  });
  filter.addEventListener('input', () => render());

  let toastTimer = null;
  function toast(text) {
    const t = $('.toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  return {
    start, toast,
    refresh: () => (rootDir ? render() : null),
    /* the Back button: up one folder; false when already at the top */
    up() { if (stack.length <= 1) return false; stack.pop(); load(false); return true; },
    depth: () => stack.length,
  };
}
