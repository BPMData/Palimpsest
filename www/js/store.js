/* Everything Palimpsest remembers, in the app's own IndexedDB database:
   kv      small settings and the library folder (on the web: its handle; on Android: its tree URI)
   books   per book: { key, name, path, page, pages, opened, inked, inkedAt }  (inkedAt: when its notes last changed)
   ink     per book: { v: 1, pages: { "0": [strokes], ... } }
   covers  per book: a small JPEG Blob
   A book's key is its file name plus its size, so moving or renaming a folder keeps its ink. */

const DB_NAME = 'palimpsest', DB_VERSION = 1, STORES = ['kv', 'books', 'ink', 'covers'];
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((ok, bad) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => bad(req.error);
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((ok, bad) => {
    const tx = db.transaction(store, mode), req = fn(tx.objectStore(store));
    tx.oncomplete = () => ok(req ? req.result : undefined);
    tx.onerror = tx.onabort = () => bad(tx.error);
  }));
}

export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const put = (store, key, val) => run(store, 'readwrite', (s) => s.put(val, key));
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));
export const all = (store) => run(store, 'readonly', (s) => s.getAll());
/* [key, value] pairs, read together so they match up */
export async function entries(store) {
  const db = await open();
  return new Promise((ok, bad) => {
    const tx = db.transaction(store, 'readonly'), s = tx.objectStore(store);
    const keys = s.getAllKeys(), vals = s.getAll();
    tx.oncomplete = () => ok(keys.result.map((k, i) => [k, vals.result[i]]));
    tx.onerror = tx.onabort = () => bad(tx.error);
  });
}

export const bookKey = (name, size) => name + '|' + size;

/* recently opened books, newest first */
export async function recent(n = 8) {
  const list = await all('books');
  return list.filter((b) => b.opened).sort((a, b) => b.opened - a.opened).slice(0, n);
}

/* update a book's record (creates it if needed) */
export async function touchBook(key, fields) {
  const rec = (await get('books', key)) || { key };
  Object.assign(rec, fields);
  await put('books', key, rec);
  return rec;
}

/* a saved copy of a book (Save as CBZ) gets the same notes, place and cover as the original */
export async function copyBook(from, to, fields) {
  const [ink, rec, cover] = await Promise.all([get('ink', from), get('books', from), get('covers', from)]);
  if (ink) await put('ink', to, ink);
  if (cover) await put('covers', to, cover);
  const { page, pages, inked } = rec || {};
  await touchBook(to, { page, pages, inked, ...fields });
}

/* small settings: localStorage, which can throw or be empty, so every read has a default */
export function setting(name, def) {
  try { const v = localStorage.getItem('pal-' + name); return v === null ? def : JSON.parse(v); } catch { return def; }
}
export function saveSetting(name, v) {
  try { localStorage.setItem('pal-' + name, JSON.stringify(v)); } catch {}
}
