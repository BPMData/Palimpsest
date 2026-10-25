/* Backing up notes. Notes live only in this app's own storage on the device, so uninstalling the app,
   clearing its data, or moving to a new tablet would lose them. A backup is one plain JSON file:
     { app: 'Palimpsest', what: 'notes', v: 1, saved: '2026-10-25T…', books: [
         { key, name, size, kind, page, pages, opened, ink: { "0": [strokes], … } }, … ] }
   Covers are left out (the app remakes them) and so is where each book was found (that's per device).
   Restoring merges: it never throws away notes that are already here. */

import * as store from './store.js';

export const VERSION = 1;
const KEEP = ['name', 'size', 'kind', 'page', 'pages', 'opened', 'path'];   // what's kept from each book's record

const today = () => new Date().toISOString().slice(0, 10);
export const backupName = () => `Palimpsest notes ${today()}.json`;

/* every book that has notes or a place to come back to */
export async function makeBackup() {
  const [books, inks] = await Promise.all([store.entries('books'), store.entries('ink')]);
  const ink = new Map(inks);
  const out = [];
  for (const [key, rec] of books) {
    const pages = ink.get(key)?.pages || {};
    const hasInk = Object.values(pages).some((s) => s.length);
    if (!hasInk && !rec.opened) continue;
    const b = { key };
    for (const f of KEEP) if (rec[f] !== undefined) b[f] = rec[f];
    if (hasInk) b.ink = Object.fromEntries(Object.entries(pages).filter(([, s]) => s.length));
    out.push(b);
  }
  return { app: 'Palimpsest', what: 'notes', v: VERSION, saved: new Date().toISOString(), books: out };
}

/* Two lists of strokes for the same page, merged without losing any.
   Usually one is the other plus a few more strokes (a backup made earlier): keep the longer one.
   Otherwise keep what's here, and add the backup's strokes that aren't here yet, in order. */
export function mergeStrokes(here = [], backup = []) {
  const id = (s) => JSON.stringify(s);
  const a = here.map(id), b = backup.map(id);
  const startsWith = (long, short) => short.every((x, i) => long[i] === x);
  if (startsWith(a, b)) return here;
  if (startsWith(b, a)) return backup;
  const seen = new Set(a);
  return here.concat(backup.filter((s, i) => !seen.has(b[i])));
}

/* what a file's text holds, or a reason it can't be used */
export function readBackup(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('This isn’t a Palimpsest backup file.'); }
  if (!d || d.app !== 'Palimpsest' || d.what !== 'notes' || !Array.isArray(d.books)) throw new Error('This isn’t a Palimpsest backup file.');
  if (d.v > VERSION) throw new Error('This backup was made by a newer Palimpsest. Update the app, then try again.');
  return d;
}

/* -> { books, merged, pages } : books with notes restored, how many already had notes here, pages of notes in all */
export async function restoreBackup(text) {
  const d = readBackup(text);
  const savedAt = Date.parse(d.saved) || 1;
  let books = 0, merged = 0, pages = 0;
  for (const b of d.books) {
    if (!b || typeof b.key !== 'string') continue;
    const [rec, ink] = await Promise.all([store.get('books', b.key), store.get('ink', b.key)]);
    const fields = {};
    for (const f of KEEP) if (b[f] !== undefined && (rec?.[f] === undefined || f === 'name' || f === 'kind')) fields[f] = b[f];
    if (b.opened && (!rec?.opened || b.opened > rec.opened)) { fields.page = b.page; fields.opened = b.opened; }   // the newer place wins
    if (b.ink && Object.keys(b.ink).length) {
      const here = ink?.pages || {};
      const hadInk = Object.values(here).some((s) => s.length);
      const out = { ...here };
      for (const [p, strokes] of Object.entries(b.ink)) if (Array.isArray(strokes)) out[p] = mergeStrokes(here[p], strokes);
      await store.put('ink', b.key, { v: 1, pages: out });
      // notes that only came from the backup are already backed up; merged ones are new, so they count as changed
      fields.inked = true; fields.inkedAt = hadInk ? Date.now() : savedAt;
      books++; if (hadInk) merged++;
      pages += Object.values(out).filter((s) => s.length).length;
    }
    await store.touchBook(b.key, fields);
  }
  if (!(await lastBackup())) await store.put('kv', 'last-backup', savedAt);   // a new device: this backup is its last one
  return { books, merged, pages };
}

/* ---------- reminders ---------- */
export const lastBackup = () => store.get('kv', 'last-backup').catch(() => null);
export const markBackedUp = () => store.put('kv', 'last-backup', Date.now());
/* true when notes changed after the last backup (or there are notes and never a backup) */
export async function needsBackup() {
  const [last, books] = await Promise.all([lastBackup(), store.all('books').catch(() => [])]);
  return books.some((r) => r.inked && (r.inkedAt || 1) > (last || 0));
}
