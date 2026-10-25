/* The library: the folder the reader picked, browsed folder by folder, with covers.
   Covers are made in the background, one or two at a time, only for the tiles on screen,
   and kept in the database, so a big collection is slow only the first time it's browsed. */

import * as store from './store.js';
import { kindOf, JSON_FILE } from './source.js';
import * as backup from './backup.js';
import { makeCover, EPUB_WHY, ARCHIVES, isPicture, comicPages } from './books.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const title = (name) => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
const baseName = (e) => (e.kind === 'pics' ? e.name : e.name.replace(/\.[^.]+$/, ''));
const extOf = (name) => ((/\.([a-z0-9]+)$/i.exec(name) || [])[1] || '').toLowerCase();

/* Can Palimpsest handle this file? Every file in a folder is shown; the ones it can't handle say why.
   'yes'  opens, and you can write on it
   'view' opens, but you can't write on it (nothing is like this yet; kept for text EPUBs later)
   'no'   can't open it
   '?'    an EPUB not looked inside yet (that happens when its cover is made) */
const OTHER_WHY = [
  [/^(rar|7z|tar)$/, 'An archive. If it holds a comic, rename it to .cbr (RAR), .cb7 (7-Zip) or .cbt (tar) and Palimpsest can open it.'],
  [/^(mobi|azw\d?|kfx|prc)$/, 'A Kindle book. Convert it to EPUB (Calibre does this).'],
  [/^(jpe?g|png|webp|gif|avif|bmp|tiff?|heic)$/, 'A loose picture, not a book. (A folder of just pictures shows as a comic.)'],
  [/^(djvu|xps|fb2|lit|docx?|odt|rtf|txt|md|html?)$/, 'Palimpsest doesn’t read this kind of file.'],
];
/* A folder of just pictures reads as a comic. A few other files are fine (up to 2, or a fifth), like ComicInfo.xml.
   Its notes are kept under its name plus the pictures' total size, like a file's. */
export function pictureFolder(d, list) {
  const files = list.filter((x) => !x.dir), pics = comicPages({ entries: files.filter((x) => isPicture(x.name)) });
  if (list.some((x) => x.dir) || files.some((x) => x.kind !== 'other') || pics.length < 2 || files.length - pics.length > Math.max(2, files.length * 0.2)) return null;
  return { dir: false, kind: 'pics', name: d.name, size: pics.reduce((n, x) => n + (x.size || 0), 0), ref: d.ref, pages: pics };
}
/* what openBook and makeCover need: a file's bytes, or for a picture folder, its pages and a way to read them */
export const bookInput = (source, e) => (e.kind === 'pics' ? Promise.resolve({ pages: e.pages, read: source.read }) : source.read(e));

export function support(e, rec) {
  if (e.kind === 'pdf' || e.kind === 'cbz' || e.kind === 'pics' || ARCHIVES.has(e.kind)) return { can: 'yes' };
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
        <button class="btn quiet" data-act="file" title="Open one PDF, comic (CBZ, CBR, CB7) or EPUB file">Open a file</button>
        <button class="btn quiet" data-act="change" hidden>Change folder</button>
        <button class="btn quiet notes-btn" data-act="notes" title="Back up or restore your notes">Notes<i class="dot" hidden title="Notes changed since the last backup"></i></button>
      </div>
    </header>
    <main class="lib-body">
      <section class="welcome" hidden>
        <h2>Your comics and books, with a pen.</h2>
        <p>Pick the folder where you keep your PDFs, comics and EPUBs. Palimpsest only reads that folder, and your notes stay on this device.</p>
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
    <input type="file" class="one-file" accept=".pdf,.cbz,.cbr,.cb7,.cbt,.epub,application/pdf,application/epub+zip" hidden>
    <dialog class="notes-box" aria-labelledby="notes-title">
      <h2 id="notes-title">Your notes</h2>
      <p>Your notes and reading places are kept only on this device. Uninstalling the app or moving to a new tablet loses them, unless you’ve saved a backup. Keep the backup file somewhere safe, like Google Drive or your computer.</p>
      <p class="notes-last"></p>
      <div class="notes-actions">
        <button class="btn" data-act="backup">Save a backup</button>
        <button class="btn quiet" data-act="restore">Restore from a backup</button>
      </div>
      <p class="notes-result" role="status"></p>
      <button class="btn quiet notes-done" data-act="close-notes">Done</button>
    </dialog>
    <input type="file" class="restore-file" hidden>
    <div class="toast" role="status" hidden></div>`;

  const $ = (s) => root.querySelector(s);
  const grid = $('.grid'), folders = $('.folders'), crumbs = $('.crumbs'), filter = $('.filter'), empty = $('.empty');
  let rootDir = null, stack = [], entries = [], urls = [];   // stack: [{ name, ref }] from the library folder down
  let observer = null, cbzHere = new Set();
  const folderKinds = new Map();   // folder path -> picture-folder entry or null, looked at once per session

  /* ---------- covers ---------- */
  const queue = [], busy = new Set(), LIMIT = source.native ? 1 : 2;
  async function coverFor(tile) {
    const e = tile._entry, k = store.bookKey(e.name, e.size);
    const cached = await store.get('covers', k).catch(() => null);
    if (cached && (e.kind !== 'epub' || support(e, tile._rec).can !== '?')) return cached;
    const { cover, status } = await makeCover(e.kind, await bookInput(source, e));
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
    const copied = (ARCHIVES.has(b._entry.kind) || b._entry.kind === 'pics') && cbzHere.has(baseName(b._entry).toLowerCase() + '.cbz');
    b.dataset.copied = copied ? 'yes' : '';
    b.querySelector('.why').textContent = s.short || (copied ? 'Saved as CBZ' : '');
    b.title = b._entry.name + (s.why ? '\n' + s.why : '');
  }
  function otherRow(e) {
    const li = document.createElement('li'), s = support(e);
    li.innerHTML = `<span class="ext">${esc(extOf(e.name).toUpperCase().slice(0, 5) || 'FILE')}</span><span class="nm">${esc(e.name)}</span><span class="why">${esc(s.why)}</span>`;
    li.title = e.name;
    return li;
  }
  /* look inside a folder; if it's just pictures, its tile becomes a comic */
  const folderQueue = [];
  let folderBusy = 0;
  function checkFolder(tile, d, path) {
    folderQueue.push({ tile, d, path });
    pumpFolders();
  }
  function pumpFolders() {
    while (folderBusy < 2 && folderQueue.length) {
      const { tile, d, path } = folderQueue.shift();
      if (!tile.isConnected) continue;
      folderBusy++;
      const known = folderKinds.has(path) ? Promise.resolve(folderKinds.get(path)) : source.list(d.ref).then((l) => pictureFolder(d, l), () => null);
      known.then(async (pics) => {
        folderKinds.set(path, pics);
        if (!pics || !tile.isConnected) return;
        const recs = await store.get('books', store.bookKey(pics.name, pics.size)).catch(() => null);
        const book = bookTile(pics, recs);
        const after = [...grid.children].find((t) => t._entry && t._entry.name.localeCompare(pics.name, undefined, { numeric: true, sensitivity: 'base' }) > 0);
        grid.insertBefore(book, after || null);
        tile.remove();
        folders.hidden = !folders.children.length;
        empty.hidden = true;
        watch(book);
      }).finally(() => { folderBusy--; pumpFolders(); });
    }
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
    grid.textContent = ''; folders.textContent = ''; otherList.textContent = ''; folderQueue.length = 0;
    cbzHere = new Set(entries.filter((e) => e.kind === 'cbz').map((e) => e.name.toLowerCase()));
    const where = stack.map((s) => s.name).join('/');
    for (const e of shown) {
      if (e.dir) {
        const pics = folderKinds.get(where + '/' + e.name);
        if (pics) { const t = bookTile(pics, recs.get(store.bookKey(pics.name, pics.size))); grid.append(t); watch(t); continue; }
        const t = folderTile(e); folders.append(t);
        if (!folderKinds.has(where + '/' + e.name)) checkFolder(t, e, where + '/' + e.name);
        continue;
      }
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
    showNotesState();
  }

  /* ---------- notes backup ---------- */
  const notesBox = $('.notes-box'), notesResult = $('.notes-result');
  if (!source.native) $('.restore-file').accept = '.json,application/json';   // Android's file picker greys out JSON files when asked to filter
  async function showNotesState() {
    const [last, stale] = await Promise.all([backup.lastBackup(), backup.needsBackup()]);
    $('.notes-btn .dot').hidden = !stale;
    $('.notes-last').textContent = (last ? 'Last backup: ' + new Date(last).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) + '.' : 'No backup yet.') +
      (stale && last ? ' Your notes have changed since then.' : '');
  }
  async function saveBackup() {
    const data = await backup.makeBackup();
    const writer = await source.saveFile(backup.backupName(), { near: stack.length ? stack[stack.length - 1].ref : null, type: JSON_FILE });
    try { await writer.write(new TextEncoder().encode(JSON.stringify(data))); }
    catch (e) { await writer.abort().catch(() => {}); throw e; }
    const saved = await writer.close();
    await backup.markBackedUp();
    const inked = data.books.filter((b) => b.ink).length;
    notesResult.textContent = `Saved “${saved.name}”, with notes from ${inked} ${inked === 1 ? 'book' : 'books'}.`;
    await showNotesState();
  }
  $('.restore-file').addEventListener('change', async () => {
    const f = $('.restore-file').files[0]; if (!f) return;
    try {
      const r = await backup.restoreBackup(await f.text());
      notesResult.textContent = !r.books ? 'Done. This backup had reading places but no notes.'
        : `Brought back notes for ${r.books} ${r.books === 1 ? 'book' : 'books'}.` + (r.merged ? ` ${r.merged} already had notes here; you now have both.` : '');
      if (rootDir) await render(); else await showNotesState();
    } catch (err) { notesResult.textContent = err.message || String(err); }
  });

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
    const dir = e.kind === 'pics' ? { dir: true } : {};
    if (source.native) return e.kind === 'pics' ? { docId: e.ref.docId, ...dir } : { uri: e.ref.uri };
    return { path: stack.slice(1).map((s) => s.name).concat(e.name), ...dir };
  }
  function open(e) {
    onOpen({ ...e, path: stack.slice(1).map((s) => s.name).concat(e.name).join('/'), loc: locOf(e), folder: stack[stack.length - 1].ref });
  }
  async function reopen(r) {
    try {
      let ref, folder = null;
      if (r.loc.uri) ref = { uri: r.loc.uri };
      else if (r.loc.docId) ref = { docId: r.loc.docId };
      else {
        let dir = rootDir.ref;
        for (const seg of r.loc.path.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
        const last = r.loc.path[r.loc.path.length - 1];
        folder = dir;
        ref = r.loc.dir ? await dir.getDirectoryHandle(last) : await dir.getFileHandle(last);
      }
      if (r.loc.dir) {   // a picture folder: look at its pictures again
        const pics = pictureFolder({ name: r.name, ref }, await source.list(ref));
        if (!pics) throw new Error('moved');
        return onOpen({ ...pics, path: r.path, loc: r.loc, folder });
      }
      onOpen({ dir: false, name: r.name, size: r.size, kind: r.kind, ref, path: r.path, loc: r.loc, folder });
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
    showNotesState();
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
      else if (a === 'notes') { notesResult.textContent = ''; await showNotesState(); notesBox.showModal(); }
      else if (a === 'close-notes') notesBox.close();
      else if (a === 'backup') { notesResult.textContent = 'Saving…'; await saveBackup().catch((e) => { notesResult.textContent = ''; throw e; }); }
      else if (a === 'restore') { const f = $('.restore-file'); f.value = ''; f.click(); }
    } catch (err) {
      if (err && err.name !== 'AbortError' && !/cancel/i.test(err.message || '')) {
        if (notesBox.open) notesResult.textContent = err.message || String(err); else toast(err.message || String(err));
      }
    }
    if (b.dataset.depth !== undefined) { stack = stack.slice(0, +b.dataset.depth + 1); load(); }
  });
  $('.one-file').addEventListener('change', () => {
    const f = $('.one-file').files[0]; if (!f) return;
    const kind = kindOf(f.name);
    if (!kind) return toast('Palimpsest opens PDF, comic (CBZ, CBR, CB7, CBT) and EPUB files.');
    onOpen({ dir: false, name: f.name, size: f.size, kind, ref: null, file: f, path: f.name, loc: null });
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
