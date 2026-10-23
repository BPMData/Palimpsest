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

/* ---------- zip (CBZ comics, and EPUB covers) ----------
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

async function openCbz(bytes) {
  const zip = readZip(bytes), pages = comicPages(zip);
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
    kind: 'cbz', count: pages.length,
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

export async function openBook(kind, bytes) {
  if (kind === 'pdf') return openPdf(bytes);
  if (kind === 'cbz') return openCbz(bytes);
  if (kind === 'epub') throw new Error('EPUB reading is coming in the next version. For now Palimpsest reads PDF and CBZ.');
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

function epubCoverEntry(zip) {
  const text = (e) => new TextDecoder().decode(zip.data(e));
  const container = zip.find('META-INF/container.xml');
  if (container) {
    const opfPath = (/full-path="([^"]+)"/.exec(text(container)) || [])[1];
    const opfEntry = opfPath && zip.find(opfPath);
    if (opfEntry) {
      const opf = new DOMParser().parseFromString(text(opfEntry), 'application/xml');
      const items = [...opf.getElementsByTagName('item')];
      const metaId = [...opf.getElementsByTagName('meta')].find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
      const item = items.find((i) => (i.getAttribute('properties') || '').split(/\s+/).includes('cover-image')) ||
        (metaId && items.find((i) => i.getAttribute('id') === metaId)) ||
        items.find((i) => /cover/i.test(i.getAttribute('id') + i.getAttribute('href')) && IMAGE.test(i.getAttribute('href') || ''));
      if (item) {
        const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
        const href = decodeURIComponent(item.getAttribute('href'));
        const parts = (base + href).split('/'), out = [];
        for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
        const e = zip.find(out.join('/'));
        if (e) return e;
      }
    }
  }
  return zip.entries.filter((e) => IMAGE.test(e.name)).sort((a, b) => natural(a.name, b.name))[0] || null;
}

export async function makeCover(kind, bytes, width = 320) {
  if (kind === 'pdf') {
    const book = await openPdf(bytes);
    try {
      const c = document.createElement('canvas');
      await book.draw(0, c, width);
      return await toJpeg(c, c.width, c.height);
    } finally { book.close(); }
  }
  const zip = readZip(bytes);
  const entry = kind === 'epub' ? epubCoverEntry(zip) : comicPages(zip)[0];
  if (!entry) return null;
  const b = await bitmapOf(zip, entry);
  try { return await toJpeg(b, width, width * b.height / b.width); } finally { b.close?.(); }
}
