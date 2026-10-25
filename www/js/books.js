/* Opening a book. Every kind gives the same small interface to the reader:
     count            number of pages
     size(i)          -> { w, h } of page i (any unit; only the shape matters)
     draw(i, canvas, pxW)  draws page i into canvas, pxW device pixels wide
     close()
   plus makeCover(kind, bytes) for the library's thumbnails. */

import { inflateSync } from '../vendor/fflate@0.8.3/fflate.mjs';

const MAX_PIXELS = 16e6;   // biggest canvas we draw a page into (16 MP), so huge zooms don't run the tablet out of memory

/* ---------- PDF (PDF.js) ---------- */
const PDFJS = new URL('../vendor/pdfjs-dist@4.10.38/', import.meta.url).href;
let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import(PDFJS + 'pdf.min.mjs').then((lib) => { lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; return lib; });
    pdfjsP.catch(() => { pdfjsP = null; });
  }
  return pdfjsP;
}

async function openPdf(bytes) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(bytes), cMapUrl: PDFJS + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: PDFJS + 'standard_fonts/', isEvalSupported: false }).promise;
  const sizes = new Map(), tasks = new Map();
  async function page(i) { return doc.getPage(i + 1); }
  return {
    kind: 'pdf', count: doc.numPages,
    async size(i) {
      if (!sizes.has(i)) { const vp = (await page(i)).getViewport({ scale: 1 }); sizes.set(i, { w: vp.width, h: vp.height }); }
      return sizes.get(i);
    },
    async draw(i, canvas, pxW) {
      const p = await page(i), vp1 = p.getViewport({ scale: 1 });
      let scale = pxW / vp1.width;
      scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (vp1.width * vp1.height)));
      const vp = p.getViewport({ scale });
      const off = document.createElement('canvas');   // draw off screen, then swap in, so the old picture stays until the new one is ready
      off.width = Math.round(vp.width); off.height = Math.round(vp.height);
      if (tasks.has(canvas)) tasks.get(canvas).cancel();
      const task = p.render({ canvasContext: off.getContext('2d'), viewport: vp, background: '#ffffff' });
      tasks.set(canvas, task);
      try { await task.promise; } catch (e) { if (e && e.name === 'RenderingCancelledException') return false; throw e; }
      finally { if (tasks.get(canvas) === task) tasks.delete(canvas); }
      canvas.width = off.width; canvas.height = off.height;
      canvas.getContext('2d').drawImage(off, 0, 0);
      return true;
    },
    close() { doc.destroy(); },
  };
}

/* ---------- zip (CBZ comics and EPUBs) ----------
   Reads the zip's table of contents once, then unpacks only the pages that are shown. */
const IMAGE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function readZip(bytes) {
  const u8 = new Uint8Array(bytes), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u32 = (o) => dv.getUint32(o, true), u16 = (o) => dv.getUint16(o, true), u64 = (o) => u32(o) + u32(o + 4) * 2 ** 32;
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (u32(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This file is not a zip/CBZ archive.');
  let count = u16(eocd + 10), cdOff = u32(eocd + 16);
  if ((cdOff === 0xffffffff || count === 0xffff) && eocd >= 20 && u32(eocd - 20) === 0x07064b50) {   // zip64
    const z = u64(eocd - 12);
    if (u32(z) === 0x06064b50) { count = u64(z + 32); cdOff = u64(z + 48); }
  }
  const utf8 = new TextDecoder('utf-8'), entries = [];
  let o = cdOff;
  for (let n = 0; n < count && u32(o) === 0x02014b50; n++) {
    const method = u16(o + 10), nameLen = u16(o + 28), extraLen = u16(o + 30), commentLen = u16(o + 32);
    let comp = u32(o + 20), size = u32(o + 24), local = u32(o + 42);
    const name = utf8.decode(u8.subarray(o + 46, o + 46 + nameLen));
    if (comp === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {   // zip64 sizes live in the extra field
      let e = o + 46 + nameLen; const end = e + extraLen;
      while (e + 4 <= end) {
        const id = u16(e), len = u16(e + 2); let f = e + 4;
        if (id === 1) {
          if (size === 0xffffffff) { size = u64(f); f += 8; }
          if (comp === 0xffffffff) { comp = u64(f); f += 8; }
          if (local === 0xffffffff) { local = u64(f); }
        }
        e += 4 + len;
      }
    }
    if (!name.endsWith('/')) entries.push({ name, method, comp, size, local });
    o += 46 + nameLen + extraLen + commentLen;
  }
  function data(entry) {
    const l = entry.local;
    if (u32(l) !== 0x04034b50) throw new Error('Damaged archive: ' + entry.name);
    const start = l + 30 + u16(l + 26) + u16(l + 28), raw = u8.subarray(start, start + entry.comp);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateSync(raw, { out: new Uint8Array(entry.size) });
    throw new Error('Unsupported compression in ' + entry.name);
  }
  return { entries, data, find: (name) => entries.find((e) => e.name === name) };
}

const mimeOf = (name) => MIME[(/\.([a-z]+)$/i.exec(name) || [])[1]?.toLowerCase()] || 'application/octet-stream';
const bitmapOf = (zip, entry) => createImageBitmap(new Blob([zip.data(entry)], { type: mimeOf(entry.name) }));

export function comicPages(zip) {
  return zip.entries.filter((e) => IMAGE.test(e.name) && !/(^|\/)(__MACOSX|\.)/.test(e.name)).sort((a, b) => natural(a.name, b.name));
}

/* Pictures from a zip, one per page: CBZ comics, and comic EPUBs. Unpacks only the pages shown. */
function openPictures(kind, zip, pages) {
  if (!pages.length) throw new Error('No pictures found in this comic.');
  const cache = new Map();   // page -> Promise<ImageBitmap>, the last few only
  function bitmap(i) {
    if (cache.has(i)) { const b = cache.get(i); cache.delete(i); cache.set(i, b); return b; }   // most recent last
    const b = bitmapOf(zip, pages[i]);
    cache.set(i, b);
    while (cache.size > 6) { const [k, old] = cache.entries().next().value; cache.delete(k); old.then((x) => x.close?.(), () => {}); }
    return b;
  }
  return {
    kind, count: pages.length,
    async size(i) { const b = await bitmap(i); return { w: b.width, h: b.height }; },
    async draw(i, canvas, pxW) {
      const b = await bitmap(i);
      let w = Math.min(pxW, b.width * 2), h = w * b.height / b.width;   // never blow a page up past twice its real size
      if (w * h > MAX_PIXELS) { const k = Math.sqrt(MAX_PIXELS / (w * h)); w *= k; h *= k; }
      canvas.width = Math.round(w); canvas.height = Math.round(h);
      const g = canvas.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(b, 0, 0, canvas.width, canvas.height);
      return true;
    },
    close() { for (const b of cache.values()) b.then((x) => x.close?.(), () => {}); cache.clear(); },
  };
}

/* ---------- EPUB ----------
   Comic EPUBs (Humble Bundle, Kobo, most publishers) are "fixed layout": every page is a tiny web page
   holding one full-page picture. Palimpsest reads those pictures in order, just like a CBZ.
   Text EPUBs (novels) and copy-protected (DRM) EPUBs can't be opened yet; epubInfo says which is which. */
const xml = (zip, e) => new DOMParser().parseFromString(new TextDecoder().decode(zip.data(e)), 'application/xml');
const tags = (doc, name) => [...doc.getElementsByTagNameNS('*', name)];
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
function joinPath(base, href) {
  let clean = href.split('#')[0].split('?')[0];
  try { clean = decodeURIComponent(clean); } catch {}
  const out = [];
  for (const p of (base + clean).split('/')) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

/* Fonts are often scrambled ("obfuscated") even in DRM-free books; anything else encrypted means DRM. */
const FONT_SCRAMBLE = /idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/;
function isLocked(zip) {
  if (zip.find('META-INF/rights.xml') || zip.find('META-INF/sinf.xml')) return true;   // Adobe, Apple
  const enc = zip.find('META-INF/encryption.xml');
  if (!enc) return false;
  return tags(xml(zip, enc), 'EncryptedData').some((d) => {
    const alg = tags(d, 'EncryptionMethod')[0]?.getAttribute('Algorithm') || '';
    const uri = tags(d, 'CipherReference')[0]?.getAttribute('URI') || '';
    return !FONT_SCRAMBLE.test(alg) && !/\.(otf|ttf|woff2?)$/i.test(uri);
  });
}

/* The one picture on a page (the biggest, if there are several), and how much text sits beside it. */
function pagePicture(zip, path) {
  const e = zip.find(path);
  if (!e) return null;
  if (IMAGE.test(path)) return { entry: e, words: 0 };
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(zip.data(e)), 'text/html');
  const refs = [...doc.querySelectorAll('img[src]')].map((i) => i.getAttribute('src'))
    .concat([...doc.getElementsByTagName('image')].map((i) => i.getAttribute('xlink:href') || i.getAttribute('href')));
  const pics = refs.filter(Boolean).map((r) => zip.find(joinPath(dirOf(path), r))).filter((x) => x && IMAGE.test(x.name));
  if (!pics.length) return null;
  const words = (doc.body?.textContent || '').trim().length;
  return { entry: pics.reduce((a, b) => (b.size > a.size ? b : a)), words };
}

/* What kind of EPUB this is: { status: 'comic' | 'text' | 'drm' | 'broken', pages, cover } */
export function epubInfo(zip) {
  if (isLocked(zip)) return { status: 'drm', pages: [], cover: null };
  const container = zip.find('META-INF/container.xml');
  const opfPath = container && tags(xml(zip, container), 'rootfile')[0]?.getAttribute('full-path');
  const opfEntry = opfPath && zip.find(opfPath);
  if (!opfEntry) return { status: 'broken', pages: [], cover: null };
  const opf = xml(zip, opfEntry), base = dirOf(opfPath);
  const items = tags(opf, 'item'), byId = new Map(items.map((i) => [i.getAttribute('id'), i]));
  const metas = tags(opf, 'meta');
  const fixed = metas.some((m) => m.getAttribute('property') === 'rendition:layout' && m.textContent.trim() === 'pre-paginated') ||
    metas.some((m) => m.getAttribute('name') === 'fixed-layout' && m.getAttribute('content') === 'true');

  const spine = tags(opf, 'itemref').map((r) => byId.get(r.getAttribute('idref'))).filter(Boolean);
  const pages = []; let pictureOnly = 0;
  for (const item of spine) {
    const pic = pagePicture(zip, joinPath(base, item.getAttribute('href') || ''));
    if (!pic) continue;   // a page with no picture, like a text credits page
    pages.push(pic.entry);
    if (pic.words < 100) pictureOnly++;
  }
  // a comic: the book says it's fixed layout, or nearly every page is just a picture
  const comic = pages.length > 0 && (fixed || pictureOnly >= spine.length * 0.8);

  const metaId = metas.find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const coverItem = items.find((i) => (i.getAttribute('properties') || '').split(/\s+/).includes('cover-image')) ||
    (metaId && byId.get(metaId)) ||
    items.find((i) => /cover/i.test(i.getAttribute('id') + i.getAttribute('href')) && IMAGE.test(i.getAttribute('href') || ''));
  const cover = (coverItem && zip.find(joinPath(base, coverItem.getAttribute('href') || ''))) || pages[0] ||
    zip.entries.filter((e) => IMAGE.test(e.name)).sort((a, b) => natural(a.name, b.name))[0] || null;
  return { status: comic ? 'comic' : 'text', pages, cover };
}

/* why an EPUB can't be opened, in words for the reader */
export const EPUB_WHY = {
  text: 'This is a text EPUB (a novel or similar). Palimpsest reads comic EPUBs; text EPUBs come later.',
  drm: 'This EPUB is copy-protected (DRM). Palimpsest can only open DRM-free files.',
  broken: 'This EPUB looks damaged: its list of pages is missing.',
};

export async function openBook(kind, bytes) {
  if (kind === 'pdf') return openPdf(bytes);
  if (kind === 'cbz') { const zip = readZip(bytes); return openPictures('cbz', zip, comicPages(zip)); }
  if (kind === 'epub') {
    const zip = readZip(bytes), info = epubInfo(zip);
    if (info.status !== 'comic') throw new Error(EPUB_WHY[info.status]);
    return openPictures('epub', zip, info.pages);
  }
  throw new Error('Palimpsest can’t open this kind of file.');
}

/* ---------- covers: a small JPEG for the library ---------- */
async function toJpeg(source, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.round(w); c.height = Math.round(h);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, c.width, c.height);
  return new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.82));
}

/* A book's cover for the library, and whether Palimpsest can open it:
   { cover: Blob | null, status: 'ok' | 'text' | 'drm' | 'broken' } (only EPUBs can be anything but 'ok') */
export async function makeCover(kind, bytes, width = 320) {
  if (kind === 'pdf') {
    const book = await openPdf(bytes);
    try {
      const c = document.createElement('canvas');
      await book.draw(0, c, width);
      return { cover: await toJpeg(c, c.width, c.height), status: 'ok' };
    } finally { book.close(); }
  }
  const zip = readZip(bytes);
  let entry = null, status = 'ok';
  if (kind === 'epub') { const info = epubInfo(zip); entry = info.cover; status = info.status === 'comic' ? 'ok' : info.status; }
  else entry = comicPages(zip)[0];
  if (!entry) return { cover: null, status };
  try {
    const b = await bitmapOf(zip, entry);
    try { return { cover: await toJpeg(b, width, width * b.height / b.width), status }; } finally { b.close?.(); }
  } catch { return { cover: null, status }; }   // a locked book's cover is often scrambled too
}
