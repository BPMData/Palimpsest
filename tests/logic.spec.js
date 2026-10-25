// Fast checks of the app's rules, without clicking through the screens.
// Each test runs the app's own modules in the browser. EPUBs are built on the spot with fflate,
// so every odd case is spelled out right here instead of hiding in a fixture file.
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => { await page.goto('/www/index.html'); });

/* Builds an EPUB from { path: text } and returns what Palimpsest thinks it is.
   A tiny real PNG is put at every path ending in .png. */
async function epub(page, files) {
  return page.evaluate(async (files) => {
    const { zipSync, strToU8 } = await import('/www/vendor/fflate@0.8.3/fflate.mjs');
    const { readZip, epubInfo } = await import('/www/js/books.js');
    const c = document.createElement('canvas'); c.width = 4; c.height = 6;
    const png = new Uint8Array(await (await new Promise((ok) => c.toBlob(ok, 'image/png'))).arrayBuffer());
    const z = {};
    for (const [k, v] of Object.entries(files)) z[k] = k.endsWith('.png') ? (v === 'big' ? new Uint8Array([...png, ...new Uint8Array(5000)]) : png) : strToU8(v);
    const info = epubInfo(readZip(zipSync(z)));
    return { status: info.status, pages: info.pages.map((e) => e.name), cover: info.cover && info.cover.name };
  }, files);
}
const CONTAINER = { 'META-INF/container.xml': '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>' };
const opf = (manifest, spine, meta = '') => `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata>${meta}</metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
const picPage = (src) => `<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="${src}"/></body></html>`;
const textPage = '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>' + 'It was a dark and stormy night. '.repeat(20) + '</p></body></html>';

/* n pages; the ones listed in `text` are prose, the rest are a single picture */
function book(n, text = [], meta = '') {
  const f = { ...CONTAINER }, items = [], refs = [];
  for (let i = 1; i <= n; i++) {
    items.push(`<item id="p${i}" href="p${i}.xhtml"/>`); refs.push(`<itemref idref="p${i}"/>`);
    f[`OPS/p${i}.xhtml`] = text.includes(i) ? textPage : picPage(`img/${i}.png`);
    if (!text.includes(i)) f[`OPS/img/${i}.png`] = '';
  }
  f['OPS/book.opf'] = opf(items.join(''), refs.join(''), meta);
  return f;
}

test.describe('what kind of EPUB is it', () => {
  test('nearly all picture pages, even without the fixed-layout flag: a comic', async ({ page }) => {
    const r = await epub(page, book(10, [10]));                                   // 9 of 10 pages are pictures
    expect(r.status).toBe('comic');
    expect(r.pages).toHaveLength(9);
    expect(r.pages[0]).toBe('OPS/img/1.png');
  });

  test('mostly prose with a few pictures: a text EPUB', async ({ page }) => {
    expect((await epub(page, book(5, [2, 3, 4, 5]))).status).toBe('text');
  });

  test('the fixed-layout flag makes it a comic even with some text pages', async ({ page }) => {
    const r = await epub(page, book(4, [3, 4], '<meta property="rendition:layout">pre-paginated</meta>'));
    expect(r.status).toBe('comic');
    expect(r.pages).toHaveLength(2);
  });

  const encryption = (alg, uri) => `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${alg}"/><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`;
  test('scrambled fonts are not DRM, whatever the font file is called', async ({ page }) => {
    for (const [alg, uri] of [['http://www.idpf.org/2008/embedding', 'OPS/fonts/a.otf'],
      ['http://www.idpf.org/2008/embedding', 'OPS/fonts/font.dat'],         // the scramble method alone says "font"
      ['http://ns.adobe.com/pdf/enc#RC', 'OPS/fonts/b.pfb']]) {               // Adobe's font scramble
      expect((await epub(page, { ...book(3), 'META-INF/encryption.xml': encryption(alg, uri) })).status).toBe('comic');
    }
  });

  test('encrypted pages are DRM', async ({ page }) => {
    const f = book(3);
    f['META-INF/encryption.xml'] = encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc', 'OPS/p1.xhtml');
    expect((await epub(page, f)).status).toBe('drm');
  });

  test('Apple’s DRM file (sinf.xml) is DRM', async ({ page }) => {
    expect((await epub(page, { ...book(2), 'META-INF/sinf.xml': '<fairplay/>' })).status).toBe('drm');
  });

  test('no container.xml: damaged', async ({ page }) => {
    const f = book(2); delete f['META-INF/container.xml'];
    expect((await epub(page, f)).status).toBe('broken');
  });

  test('tags with an opf: prefix, ../ paths and %20 in names all work', async ({ page }) => {
    const f = { ...CONTAINER,
      'OPS/book.opf': '<opf:package xmlns:opf="http://www.idpf.org/2007/opf"><opf:manifest><opf:item id="a" href="text/page%20one.xhtml"/></opf:manifest><opf:spine><opf:itemref idref="a"/></opf:spine></opf:package>',
      'OPS/text/page one.xhtml': picPage('../images/my%20page.png'),
      'OPS/images/my page.png': '' };
    const r = await epub(page, f);
    expect(r.pages).toEqual(['OPS/images/my page.png']);
    expect(r.status).toBe('comic');
  });

  test('a picture wrapped in SVG counts, and of two pictures the biggest is the page', async ({ page }) => {
    const f = { ...CONTAINER,
      'OPS/book.opf': opf('<item id="a" href="a.xhtml"/>', '<itemref idref="a"/>'),
      'OPS/a.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="small.png"/><image xlink:href="big.png"/></svg></body></html>',
      'OPS/small.png': '', 'OPS/big.png': 'big' };
    expect((await epub(page, f)).pages).toEqual(['OPS/big.png']);
  });

  test('the cover is the one the book names', async ({ page }) => {
    const f = book(2);
    f['OPS/book.opf'] = f['OPS/book.opf'].replace('<manifest>', '<manifest><item id="cv" href="img/front.png" properties="cover-image"/>');
    f['OPS/img/front.png'] = '';
    expect((await epub(page, f)).cover).toBe('OPS/img/front.png');
  });
});

test.describe('which folders are comics', () => {
  async function check(page, files) {
    return page.evaluate(async (files) => {
      const { pictureFolder } = await import('/www/js/library.js');
      const list = files.map((n) => (n.endsWith('/') ? { dir: true, name: n.slice(0, -1) }
        : { dir: false, name: n, size: 10, kind: /\.(pdf|cbz|epub|cbr|cb7|cbt)$/.test(n) ? 'x' : 'other' }));
      const r = pictureFolder({ name: 'F', ref: null }, list);
      return r && r.pages.map((p) => p.name);
    }, files);
  }
  test('pictures in page order, page 10 after page 9', async ({ page }) => {
    expect(await check(page, ['p10.jpg', 'p9.jpg', 'p1.jpg'])).toEqual(['p1.jpg', 'p9.jpg', 'p10.jpg']);
  });
  test('two stray files are fine', async ({ page }) => {
    expect(await check(page, ['1.png', '2.png', 'ComicInfo.xml', 'readme.txt'])).toHaveLength(2);
  });
  test('three strays with two pictures: not a comic', async ({ page }) => {
    expect(await check(page, ['1.png', '2.png', 'a.txt', 'b.txt', 'c.txt'])).toBeNull();
  });
  test('one picture is not a comic', async ({ page }) => {
    expect(await check(page, ['cover.jpg'])).toBeNull();
  });
  test('a folder with books or subfolders stays a folder', async ({ page }) => {
    expect(await check(page, ['1.png', '2.png', 'Vol 1.cbz'])).toBeNull();
    expect(await check(page, ['1.png', '2.png', 'Chapter 2/'])).toBeNull();
  });
});

test('every file it can’t open gets a reason that fits', async ({ page }) => {
  const why = await page.evaluate(async () => {
    const { support } = await import('/www/js/library.js');
    const s = (name, kind = 'other', rec) => support({ name, kind }, rec);
    return {
      mobi: s('a.mobi').why, azw3: s('a.azw3').why, rar: s('a.rar').why, jpg: s('a.JPG').why, odd: s('a.xyz').why, none: s('README').why,
      cbr: s('a.cbr', 'cbr').can, pics: s('F', 'pics').can, epubNew: s('a.epub', 'epub').can,
      drm: s('a.epub', 'epub', { epub: 'drm' }).short, text: s('a.epub', 'epub', { epub: 'text' }).short, ok: s('a.epub', 'epub', { epub: 'ok' }).can,
    };
  });
  expect(why.mobi).toContain('Kindle');
  expect(why.azw3).toContain('Kindle');
  expect(why.rar).toContain('rename it to .cbr');
  expect(why.jpg).toContain('loose picture');
  expect(why.odd).toBe('Not a book file.');
  expect(why.none).toBe('Not a book file.');
  expect([why.cbr, why.pics, why.epubNew, why.ok]).toEqual(['yes', 'yes', '?', 'yes']);
  expect([why.drm, why.text]).toEqual(['Copy-protected', 'Text EPUB']);
});

test.describe('Save as CBZ, the writing part', () => {
  /* a pretend book of n tiny pages, and a writer that can be told to fail on its k-th write */
  async function save(page, n, failAt = 0) {
    return page.evaluate(async ({ n, failAt }) => {
      const { writeCbz, readZip } = await import('/www/js/books.js');
      const book = { count: n, name: (i) => `x/page${i}.${i % 2 ? 'png' : 'JPEG'}`, data: async (i) => new Uint8Array([i % 256, 1, 2, 3]) };
      const parts = []; let writes = 0, aborted = false, progress = [];
      const writer = {
        async write(c) { if (++writes === failAt) throw new Error('disk full'); parts.push(c.slice()); },
        async close() { return { name: 'out.cbz', size: parts.reduce((s, p) => s + p.length, 0) }; },
        async abort() { aborted = true; },
      };
      try {
        const r = await writeCbz(book, writer, (f) => progress.push(f));
        const zip = readZip(await new Blob(parts).arrayBuffer());
        return { ok: true, size: r.size, names: zip.entries.map((e) => e.name), page3: [...zip.data(zip.entries[3])], last: progress[progress.length - 1] };
      } catch (e) { return { ok: false, message: e.message, aborted }; }
    }, { n, failAt });
  }
  test('pages are numbered in order with their own picture type, and come out unchanged', async ({ page }) => {
    const r = await save(page, 12);
    expect(r.ok).toBe(true);
    expect(r.names.slice(0, 3)).toEqual(['001.jpeg', '002.png', '003.jpeg']);
    expect(r.names[11]).toBe('012.png');
    expect(r.page3).toEqual([3, 1, 2, 3]);
    expect(r.last).toBe(1);
    expect(r.size).toBeGreaterThan(12 * 4);
  });
  test('a book of 1000 pages or more gets four-digit numbers, so they still sort', async ({ page }) => {
    const r = await save(page, 1000);
    expect(r.names[0]).toBe('0001.jpeg');
    expect(r.names[999]).toBe('1000.png');
  });
  test('if writing fails halfway, the half-written file is thrown away', async ({ page }) => {
    const r = await save(page, 12, 5);
    expect(r).toEqual({ ok: false, message: 'disk full', aborted: true });
  });
});

test.describe('archives', () => {
  async function count(page, file, kind) {
    return page.evaluate(async ({ file, kind }) => {
      const { openBook } = await import('/www/js/books.js');
      const bytes = await (await fetch('/tests/fixtures/library/' + file)).arrayBuffer();
      try { const b = await openBook(kind, bytes); const n = b.count; b.close(); return n; } catch (e) { return e.message; }
    }, { file, kind });
  }
  test('a RAR with a .cbz name still opens', async ({ page }) => {
    expect(await count(page, 'Comics/Old%20Comic.cbr', 'cbz')).toBe(3);
  });
  test('a password-protected CB7 says so', async ({ page }) => {
    expect(await count(page, 'Trouble/Secret.cb7', 'cb7')).toContain('password-protected');
  });
  test('a damaged CBR says it couldn’t be unpacked', async ({ page }) => {
    expect(await count(page, 'Trouble/Broken.cbr', 'cbr')).toContain('couldn’t unpack');
  });
});

test.describe('restoring a backup never loses notes', () => {
  async function merge(page, here, backup) {
    return page.evaluate(async ({ here, backup }) => (await import('/www/js/backup.js')).mergeStrokes(here, backup), { here, backup });
  }
  const s = (n) => ({ c: '#000', w: 2, p: [n, n, n + 1, n + 1] });
  test('a backup made earlier: what’s here already has it all', async ({ page }) => {
    expect(await merge(page, [s(1), s(2), s(3)], [s(1), s(2)])).toEqual([s(1), s(2), s(3)]);
  });
  test('a backup with more on it: the backup has it all', async ({ page }) => {
    expect(await merge(page, [s(1)], [s(1), s(2)])).toEqual([s(1), s(2)]);
  });
  test('different notes on each side: both are kept, nothing doubled', async ({ page }) => {
    expect(await merge(page, [s(1), s(2)], [s(1), s(3)])).toEqual([s(1), s(2), s(3)]);
  });
  test('nothing here yet', async ({ page }) => {
    expect(await merge(page, undefined, [s(5)])).toEqual([s(5)]);
  });
  test('files that aren’t backups, or come from a newer app, are turned away kindly', async ({ page }) => {
    const why = await page.evaluate(async () => {
      const { readBackup } = await import('/www/js/backup.js');
      const t = (x) => { try { readBackup(x); return 'ok'; } catch (e) { return e.message; } };
      return [t('not json'), t('{"app":"Other"}'), t(JSON.stringify({ app: 'Palimpsest', what: 'notes', v: 99, books: [] })), t(JSON.stringify({ app: 'Palimpsest', what: 'notes', v: 1, books: [] }))];
    });
    expect(why[0]).toContain('isn’t a Palimpsest backup');
    expect(why[1]).toContain('isn’t a Palimpsest backup');
    expect(why[2]).toContain('newer Palimpsest');
    expect(why[3]).toBe('ok');
  });
});
