/* Palimpsest: start-up and moving between the library and the reader.
   The browser history holds where you are, so Android's Back button goes up a folder or closes the book. */

import { makeSource } from './source.js';
import { makeLibrary } from './library.js';
import { makeReader } from './reader.js';

const source = makeSource();
const libEl = document.getElementById('library'), readerEl = document.getElementById('reader');
const busy = document.getElementById('busy');

const reader = makeReader(readerEl, {
  onBack: () => history.back(),
  onClose: () => { libEl.hidden = false; library.refresh(); },
});

const library = makeLibrary(libEl, source, {
  onNavigate: (path) => history.pushState({ v: 'lib', d: path.length }, ''),
  onOpen: openBook,
});

async function openBook(entry) {
  busy.hidden = false;
  try {
    const bytes = entry.file ? await entry.file.arrayBuffer() : await source.read(entry);
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
