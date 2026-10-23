const { test, expect } = require('@playwright/test');
const { openApp, stroke, inked, pageBox } = require('./support/library');

const label = (page) => page.locator('.rd-page');

async function openBook(page, folder, name) {
  if (folder) await page.locator('.tile.folder', { hasText: folder }).click();
  await page.locator('.tile.book', { hasText: name }).click();
  await expect(page.locator('#reader')).toBeVisible();
  await page.locator('.pg canvas.ink').first().waitFor({ state: 'attached' });
}

test('the library lists folders and books, and skips other files', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.tile')).toHaveText([/Books/, /Comics/]);
  await expect(page.locator('.tile', { hasText: /notes|hidden/ })).toHaveCount(0);
  await page.locator('.tile.folder', { hasText: 'Books' }).click();
  await expect(page.locator('.tile.book .name')).toHaveText(['Field Guide', 'Novel']);
  await expect(page.locator('.crumbs button')).toHaveText(['My Library', 'Books']);
});

test('covers are made for PDF, CBZ and EPUB', async ({ page }) => {
  await openApp(page);
  await page.locator('.tile.folder', { hasText: 'Books' }).click();
  await expect(page.locator('.tile.book[data-cover="done"]')).toHaveCount(2);
  await page.locator('.crumbs button', { hasText: 'My Library' }).click();
  await page.locator('.tile.folder', { hasText: 'Comics' }).click();
  await expect(page.locator('.tile.book[data-cover="done"]')).toHaveCount(1);
});

test('comic pages are in natural order (page9 before page10), junk skipped', async ({ page }) => {
  await page.goto('/www/index.html');
  const names = await page.evaluate(async () => {
    const { readZip, comicPages } = await import('/www/js/books.js');
    const buf = await (await fetch('/tests/fixtures/library/Comics/Saga%20Vol%201.cbz')).arrayBuffer();
    return comicPages(readZip(buf)).map((e) => e.name);
  });
  expect(names).toEqual(Array.from({ length: 11 }, (_, i) => `Saga/page${i + 1}.png`));
});

test('a comic opens as a spread in landscape and turns pages', async ({ page }) => {
  await openApp(page);
  await openBook(page, 'Comics', 'Saga Vol 1');
  await expect(label(page)).toHaveText('1 / 11');          // the cover is on its own
  await page.keyboard.press('ArrowRight');
  await expect(label(page)).toHaveText('2–3 / 11');
  await expect(page.locator('.pg')).toHaveCount(2);
  await page.keyboard.press('End');
  await expect(label(page)).toHaveText('10–11 / 11');
  await page.keyboard.press('ArrowLeft');
  await expect(label(page)).toHaveText('8–9 / 11');
  await page.getByRole('button', { name: 'Two pages' }).click();
  await expect(label(page)).toHaveText('8 / 11');
});

test('finger taps on the edges turn the page; the middle hides the bars', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 1200 });   // portrait: one page at a time
  await openApp(page);
  await openBook(page, 'Comics', 'Saga Vol 1');
  await stroke(page, [[760, 600]], { type: 'touch' });
  await expect(label(page)).toHaveText('2 / 11');
  await page.waitForTimeout(350);
  await stroke(page, [[40, 600]], { type: 'touch' });
  await expect(label(page)).toHaveText('1 / 11');
  await page.waitForTimeout(350);
  await stroke(page, [[400, 600]], { type: 'touch' });
  await expect(page.locator('#reader')).toHaveClass(/bare/);
  // a swipe turns too
  await page.waitForTimeout(350);
  await stroke(page, [[600, 600], [500, 600], [300, 605]], { type: 'touch' });
  await expect(label(page)).toHaveText('2 / 11');
  expect(await inked(page)).toBe(0);                            // fingers never wrote anything
});

test('the pen writes; undo, redo, and the ink is still there next time', async ({ page }) => {
  await openApp(page);
  await openBook(page, 'Comics', 'Saga Vol 1');
  const b = await pageBox(page);
  const line = [[b.x + 100, b.y + 200], [b.x + 150, b.y + 230], [b.x + 220, b.y + 240], [b.x + 300, b.y + 220]];
  await stroke(page, line);
  const n = await inked(page);
  expect(n).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Undo' }).click();
  expect(await inked(page)).toBe(0);
  await page.getByRole('button', { name: 'Redo' }).click();
  expect(await inked(page)).toBe(n);

  await page.getByRole('button', { name: 'Back to the library' }).click();
  await expect(page.locator('.tile.book .inked')).toHaveCount(1);   // the ✎ badge
  await page.locator('.tile.book', { hasText: 'Saga Vol 1' }).click();
  await page.locator('.pg canvas.ink').first().waitFor({ state: 'attached' });
  await expect.poll(() => inked(page)).toBe(n);
});

test('highlighter goes under the page; the pen eraser end rubs out both', async ({ page }) => {
  await openApp(page);
  await openBook(page, 'Books', 'Field Guide');
  const b = await pageBox(page);
  await page.getByRole('button', { name: 'Highlight' }).click();
  await stroke(page, [[b.x + 60, b.y + 120], [b.x + 300, b.y + 120]]);
  expect(await inked(page, 'hl')).toBeGreaterThan(100);
  expect(await inked(page, 'ink')).toBe(0);
  await page.getByRole('button', { name: 'Pen' }).click();
  await stroke(page, [[b.x + 60, b.y + 200], [b.x + 300, b.y + 200]]);
  expect(await inked(page, 'ink')).toBeGreaterThan(100);
  // the pen's eraser end (buttons 32) wipes across both lines
  for (let x = 40; x < 330; x += 8) await stroke(page, [[b.x + x, b.y + 90], [b.x + x, b.y + 230]], { buttons: 32 });
  expect(await inked(page, 'hl')).toBeLessThan(40);
  expect(await inked(page, 'ink')).toBeLessThan(40);
});

test('"Finger draws" lets a finger write, and two fingers still zoom', async ({ page }) => {
  await openApp(page);
  await openBook(page, 'Comics', 'Saga Vol 1');
  await page.getByRole('button', { name: 'Finger draws' }).click();
  const b = await pageBox(page);
  await stroke(page, [[b.x + 80, b.y + 300], [b.x + 200, b.y + 320]], { type: 'touch' });
  expect(await inked(page)).toBeGreaterThan(50);
  // pinch: two fingers spreading apart
  await page.evaluate(({ cx, cy }) => {
    const s = document.querySelector('.stage');
    const ev = (t, id, x, y) => s.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: y, buttons: t === 'pointerup' ? 0 : 1 }));
    ev('pointerdown', 1, cx - 40, cy); ev('pointerdown', 2, cx + 40, cy);
    for (let k = 1; k <= 10; k++) { ev('pointermove', 1, cx - 40 - k * 12, cy); ev('pointermove', 2, cx + 40 + k * 12, cy); }
    ev('pointerup', 1, cx - 160, cy); ev('pointerup', 2, cx + 160, cy);
  }, { cx: b.x + b.width / 2, cy: b.y + b.height / 2 });
  const t = await page.locator('.spread').evaluate((el) => el.style.transform);
  expect(Number(/scale\(([\d.]+)\)/.exec(t)[1])).toBeGreaterThan(2);
  expect(await inked(page)).toBeGreaterThan(50);    // the pinch didn't leave a line, and kept the old one
});

test('double-tap zooms in and back out', async ({ page }) => {
  await openApp(page);
  await openBook(page, 'Comics', 'Saga Vol 1');
  const b = await pageBox(page);
  const tap = () => stroke(page, [[b.x + b.width / 2, b.y + 200]], { type: 'touch' });
  await tap(); await tap();
  await expect(page.locator('.stage')).toHaveClass(/zoomed/);
  await tap(); await tap();
  await expect(page.locator('.stage')).not.toHaveClass(/zoomed/);
});

test('the place in a book is remembered and shown under Continue reading', async ({ page }) => {
  await openApp(page);
  await openBook(page, 'Books', 'Field Guide');
  await page.getByRole('button', { name: 'Two pages' }).click();   // single pages
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(label(page)).toHaveText('3 / 3');
  await page.getByRole('button', { name: 'Back to the library' }).click();
  await page.locator('.crumbs button', { hasText: 'My Library' }).click();
  await expect(page.locator('.recent .tile')).toHaveCount(1);
  await page.locator('.recent .tile').click();
  await expect(label(page)).toHaveText('3 / 3');
});

test('EPUB says it is coming next instead of failing', async ({ page }) => {
  await openApp(page);
  await page.locator('.tile.folder', { hasText: 'Books' }).click();
  await page.locator('.tile.book', { hasText: 'Novel' }).click();
  await expect(page.locator('.toast')).toContainText('EPUB reading is coming');
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('.crumbs [aria-current]')).toHaveText('Books');   // still in the same folder
});

test('the browser Back button closes the book, then goes up a folder', async ({ page }) => {
  await openApp(page);
  await openBook(page, 'Comics', 'Saga Vol 1');
  await page.goBack();
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('.crumbs [aria-current]')).toHaveText('Comics');
  await page.goBack();
  await expect(page.locator('.crumbs [aria-current]')).toHaveText('My Library');
});

test('phone width: no sideways scrolling in the library or the reader', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await openBook(page, 'Comics', 'Saga Vol 1');
  const tools = await page.locator('.rd-bottom').boundingBox();
  expect(tools.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
