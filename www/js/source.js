/* Where the books come from: one library folder the reader picks once, read-only.
   - Android app: the system folder picker (Storage Access Framework) through the native Library plugin
     (android/app/src/main/java/.../LibraryPlugin.java). The app keeps permission to read that folder and nothing else.
   - Browser (desktop Chrome / Edge): the File System Access API (showDirectoryPicker).
   - iPad (later): a native plugin with the same methods (folder picker with a saved bookmark; saving through
     the system "Save to Files" screen). Nothing outside this file needs to know which one is in use.
   Every source has: restore(), pick(), list(folderRef), read(fileEntry), saveFile(name, { near, type }).
   type says what's being saved, like CBZ or JSON below (CBZ if left out).
   saveFile shows the system "Save as" screen; the app can write only the one new file the reader names there.
   It returns a writer: { write(Uint8Array), close() -> { name, size }, abort() } (abort removes the half-written file).
   Both give the same shape:
     folder entry: { dir: true, name, ref }
     file entry:   { dir: false, name, size, modified, kind: 'pdf' | 'cbz' | 'epub' | 'other', ref }
   Every file is listed, even ones Palimpsest can't open ('other'), so the reader can see they're there. */

import * as store from './store.js';

export const KINDS = { pdf: 'pdf', cbz: 'cbz', zip: 'cbz', epub: 'epub', cbr: 'cbr', cb7: 'cb7', cbt: 'cbt' };
export const CBZ = { mime: 'application/vnd.comicbook+zip', ext: '.cbz', description: 'Comic book (CBZ)' };
export const JSON_FILE = { mime: 'application/json', ext: '.json', description: 'Palimpsest notes backup' };

/* Uint8Array -> base64, in slices so big pages don't overflow the call stack */
function base64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function kindOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? KINDS[m[1].toLowerCase()] || null : null;
}
const JUNK = new Set(['__macosx', 'thumbs.db', 'desktop.ini']);   // things the computer made, not the reader
const visible = (name) => !name.startsWith('.') && !JUNK.has(name.toLowerCase());

const byName = (a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/* ---------- Android ---------- */
function androidSource(Plugin, Cap) {
  let root = null;   // { treeUri, docId, name }
  return {
    native: true,
    async restore() {
      const saved = await store.get('kv', 'android-root');
      if (!saved) return null;
      const { ok } = await Plugin.hasAccess({ treeUri: saved.treeUri });
      if (!ok) return { lost: true, name: saved.name };
      root = saved;
      return { name: root.name, ref: { docId: root.docId } };
    },
    async pick() {
      const r = await Plugin.pickFolder();   // rejects if the reader backs out
      root = { treeUri: r.treeUri, docId: r.docId, name: r.name };
      await store.put('kv', 'android-root', root);
      return { name: root.name, ref: { docId: root.docId } };
    },
    async list(ref) {
      const { items } = await Plugin.list({ treeUri: root.treeUri, docId: ref.docId });
      return items.filter((it) => visible(it.name)).map((it) => it.dir
        ? { dir: true, name: it.name, ref: { docId: it.docId } }
        : { dir: false, name: it.name, size: it.size, modified: it.modified, kind: kindOf(it.name) || 'other', ref: { uri: it.uri } }).sort(byName);
    },
    /* Android's "Save as" screen opens in the folder being browsed. The pages cross to Android in 1 MB pieces. */
    async saveFile(name, { near, type = CBZ } = {}) {
      const { id, name: saved } = await Plugin.saveStart({ name, mime: type.mime, treeUri: root && root.treeUri, docId: near && near.docId });
      let size = 0;
      return {
        async write(chunk) {
          for (let o = 0; o < chunk.length; o += 1 << 20) await Plugin.saveChunk({ id, data: base64(chunk.subarray(o, o + (1 << 20))) });
          size += chunk.length;
        },
        async close() { const r = await Plugin.saveFinish({ id }); return { name: r.name || saved, size }; },
        async abort() { await Plugin.saveAbort({ id }); },
      };
    },
    async read(entry) {
      // Capacitor's web server streams content:// files to the web view directly
      try {
        const res = await fetch(Cap.convertFileSrc(entry.ref.uri));
        if (res.ok) return await res.arrayBuffer();
      } catch {}
      // fallback: the plugin copies the file into the app's cache, which the web view can always read
      const { path } = await Plugin.copyToCache({ uri: entry.ref.uri });
      const res = await fetch(Cap.convertFileSrc('file://' + path));
      if (!res.ok) throw new Error('Could not read ' + entry.name);
      return res.arrayBuffer();
    },
  };
}

/* ---------- browser ---------- */
function webSource() {
  let rootHandle = null;
  return {
    native: false,
    supported: typeof window.showDirectoryPicker === 'function',
    async restore() {
      const h = await store.get('kv', 'web-root').catch(() => null);
      if (!h) return null;
      rootHandle = h;
      let state = 'granted';
      try { state = await h.queryPermission({ mode: 'read' }); } catch {}
      if (state !== 'granted') return { lost: true, name: h.name, again: true };
      return { name: h.name, ref: h };
    },
    /* after a browser restart: one tap gives permission again (must run inside a tap) */
    async again() {
      if ((await rootHandle.requestPermission({ mode: 'read' })) !== 'granted') throw new Error('No permission');
      return { name: rootHandle.name, ref: rootHandle };
    },
    async pick() {
      rootHandle = await window.showDirectoryPicker({ id: 'palimpsest-library', mode: 'read' });
      try { await store.put('kv', 'web-root', rootHandle); } catch {}   // handles can't always be stored (tests use plain objects)
      return { name: rootHandle.name, ref: rootHandle };
    },
    async list(dir) {
      const out = [];
      for await (const h of dir.values()) {
        if (!visible(h.name)) continue;
        if (h.kind === 'directory') out.push({ dir: true, name: h.name, ref: h });
        else {
          const f = await h.getFile();
          out.push({ dir: false, name: h.name, size: f.size, modified: f.lastModified, kind: kindOf(h.name) || 'other', ref: h });
        }
      }
      return out.sort(byName);
    },
    async read(entry) { return (await entry.ref.getFile()).arrayBuffer(); },
    async saveFile(name, { near, type = CBZ } = {}) {
      if (typeof window.showSaveFilePicker !== 'function') throw new Error('This browser can’t save files. Use Chrome or Edge.');
      const opts = { suggestedName: name, types: [{ description: type.description, accept: { [type.mime]: [type.ext] } }] };
      if (near && near.kind === 'directory') opts.startIn = near;
      let h;
      try { h = await window.showSaveFilePicker(opts); }
      catch (e) { if (e.name !== 'TypeError' || !opts.startIn) throw e; delete opts.startIn; h = await window.showSaveFilePicker(opts); }
      const w = await h.createWritable();   // the browser only replaces the file when close() succeeds
      let size = 0;
      return {
        async write(chunk) { await w.write(chunk); size += chunk.length; },
        async close() { await w.close(); return { name: h.name, size }; },
        async abort() {   // an old file the reader chose to replace stays as it was; only an empty new one is removed
          await w.abort().catch(() => {});
          try { if (h.remove && (await h.getFile()).size === 0) await h.remove(); } catch {}
        },
      };
    },
  };
}

export function makeSource() {
  const Cap = window.Capacitor;
  if (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) return androidSource(Cap.registerPlugin('Library'), Cap);
  return webSource();
}
