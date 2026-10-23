// A pretend library folder for the browser tests: showDirectoryPicker() returns the files in
// tests/fixtures/library/, served by the test web server.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'fixtures', 'library');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).map((d) => d.isDirectory()
    ? { name: d.name, dir: true, children: walk(path.join(dir, d.name)) }
    : { name: d.name, size: fs.statSync(path.join(dir, d.name)).size });
}

async function useLibrary(page) {
  await page.addInitScript((tree) => {
    function fileHandle(f, url) {
      return { kind: 'file', name: f.name,
        async getFile() { const b = await (await fetch(url)).blob(); return new File([b], f.name, { lastModified: 1 }); } };
    }
    function dirHandle(name, children, url) {
      const kids = children.map((c) => c.dir ? dirHandle(c.name, c.children, url + encodeURIComponent(c.name) + '/') : fileHandle(c, url + encodeURIComponent(c.name)));
      return { kind: 'directory', name,
        async *values() { for (const k of kids) yield k; },
        async getDirectoryHandle(n) { const k = kids.find((x) => x.kind === 'directory' && x.name === n); if (!k) throw new DOMException('gone', 'NotFoundError'); return k; },
        async getFileHandle(n) { const k = kids.find((x) => x.kind === 'file' && x.name === n); if (!k) throw new DOMException('gone', 'NotFoundError'); return k; },
        async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } };
    }
    const root = dirHandle('My Library', tree, '/tests/fixtures/library/');
    window.showDirectoryPicker = async () => root;
  }, walk(ROOT));
}

async function openApp(page) {
  await useLibrary(page);
  await page.goto('/www/index.html');
  await page.getByRole('button', { name: 'Choose your library folder' }).click();
  await page.locator('.tile.folder').first().waitFor();
}

// pointer events as the board sends them: pen, touch or mouse, at page coordinates
async function stroke(page, points, { type = 'pen', id = 7, buttons = 1 } = {}) {
  await page.evaluate(({ points, type, id, buttons }) => {
    const stage = document.querySelector('.stage');
    const ev = (t, [x, y], b) => stage.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, composed: true,
      pointerId: id, pointerType: type, isPrimary: true, clientX: x, clientY: y, buttons: b, button: t === 'pointermove' ? -1 : 0, pressure: b ? 0.5 : 0 }));
    ev('pointerdown', points[0], buttons);
    for (const p of points.slice(1)) ev('pointermove', p, buttons);
    ev('pointerup', points[points.length - 1], 0);
  }, { points, type, id, buttons });
}

// how many pixels of a page's layer (img, hl or ink) are not see-through
async function inked(page, layer = 'ink', n = 0) {
  return page.evaluate(({ layer, n }) => {
    const c = document.querySelectorAll('.pg')[n].querySelector('canvas.' + layer);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) k++;
    return k;
  }, { layer, n });
}

// the middle of page n on screen
async function pageBox(page, n = 0) {
  return page.locator('.pg').nth(n).boundingBox();
}

module.exports = { useLibrary, openApp, stroke, inked, pageBox };
