/* Where the books come from: one library folder the reader picks once.
   - Android app: the system folder picker (Storage Access Framework) through the native Library plugin
     (android/app/src/main/java/.../LibraryPlugin.java). The app keeps permission to that folder and nothing else.
   - Browser (desktop Chrome / Edge): the File System Access API (showDirectoryPicker).
   Both give the same shape:
     folder entry: { dir: true, name, ref }
     file entry:   { dir: false, name, size, modified, kind: 'pdf' | 'cbz' | 'epub' | 'other', ref }
   Every file is listed, even ones Palimpsest can't open ('other'), so the reader can see they're there. */

import * as store from './store.js';

export const KINDS = { pdf: 'pdf', cbz: 'cbz', zip: 'cbz', epub: 'epub' };
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
  };
}

export function makeSource() {
  const Cap = window.Capacitor;
  if (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) return androidSource(Cap.registerPlugin('Library'), Cap);
  return webSource();
}
