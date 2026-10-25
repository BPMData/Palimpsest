/* Palimpsest: start-up and moving between the library and the reader.
   The browser history holds where you are, so Android's Back button goes up a folder or closes the book. */

import { makeSource } from './source.js';
import { makeLibrary, bookInput } from './library.js';
import { makeReader } from './reader.js';
import { writeCbz } from './books.js';
import * as store from './store.js';

const source = makeSource();
const libEl = document.getElementById('library'), readerEl = document.getElementById('reader');
const busy = document.getElementById('busy'), busyText = busy.querySelector('.busy-text');

const reader = makeReader(readerEl, {
  onBack: () => history.back(),
  onClose: () => { libEl.hidden = false; library.refresh(); },
  onSave: saveAsCbz,
});

const library = makeLibrary(libEl, source, {
  onNavigate: (path) => history.pushState({ v: 'lib', d: path.length }, ''),
  onOpen: openBook,
});

async function openBook(entry) {
  busy.hidden = false;
  try {
    const bytes = entry.file ? await entry.file.arrayBuffer() : await bookInput(source, entry);
    history.pushState({ v: 'reader' }, '');
    libEl.hidden = true;
    await reader.open(entry, bytes);
  } catch (err) {
    readerEl.hidden = true; libEl.hidden = false;
    library.toast(err.message || String(err));
    if (history.state && history.state.v === 'reader') { skipPop = true; history.back(); }
  } finally {
    busy.hidden = true;
  }
}

/* Save as CBZ: the system "Save as" screen picks where; the pages are written one at a time;
   the copy gets the same notes, place and cover. The original is never changed. */
async function saveAsCbz(entry, book) {
  const base = entry.kind === 'pics' ? entry.name : entry.name.replace(/\.[^.]+$/, '');
  let writer;
  try { writer = await source.saveFile(base + '.cbz', { near: entry.folder }); }
  catch (err) {
    if (err && err.name !== 'AbortError' && !/cancel/i.test(err.message || '')) reader.say(err.message || String(err));
    return;
  }
  busy.hidden = false;
  busyText.textContent = 'Saving as CBZ…';
  try {
    const saved = await writeCbz(book, writer, (f) => { busyText.textContent = `Saving as CBZ… ${Math.round(f * 100)}%`; });
    await reader.flush();
    await store.copyBook(store.bookKey(entry.name, entry.size), store.bookKey(saved.name, saved.size), { name: saved.name, size: saved.size, kind: 'cbz' });
    reader.say(`Saved “${saved.name}”. Your notes and place came along.`);
  } catch (err) {
    reader.say('Could not save the CBZ: ' + (err.message || err) + ' Nothing was changed.');
  } finally {
    busy.hidden = true; busyText.textContent = '';
  }
}

let skipPop = false;
addEventListener('popstate', () => {
  if (skipPop) { skipPop = false; return; }
  if (reader.isOpen()) reader.close();
  else library.up();
});

/* save ink when the app goes to the background (Android may close it there) */
document.addEventListener('visibilitychange', () => { if (document.hidden) reader.flush(); });
addEventListener('pagehide', () => reader.flush());

history.replaceState({ v: 'lib', d: 1 }, '');
library.start();
window.__pal = { reader, library, source };   // for the tests
