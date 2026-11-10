import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const editor = new URL('../../prototypes/wavecraft-web-prototype.html', import.meta.url);
let browser;
before(async () => {
  const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ channel });
});
after(async () => browser?.close());

test('releasing a dragged point preserves the zoom window', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(editor.href);
  await page.locator('[data-tool="off"]').click();
  const points = async () => JSON.parse(await page.inputValue('#source')).points;
  const original = await points();
  const index = original.findIndex(([time]) => time === 48);
  const zoom = () => Promise.all(['#overview-first', '#overview-last'].map(id => page.inputValue(id)));
  const window = await zoom();
  assert.deepEqual(window.map(Number), [40, 100]);
  const marker = page.locator('[data-point="' + index + '"]');
  await marker.scrollIntoViewIfNeeded();
  const box = await marker.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 5, y - 8, { steps: 3 });
  await page.mouse.up();
  assert.notDeepEqual((await points())[index], original[index]);
  assert.deepEqual(await zoom(), window);
});

async function prepare(t, side, method, first, second) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(editor.href);
  await page.locator('.insert-menu summary').click();
  await page.locator('#insert-relative-open').click();
  const source = await page.locator('#source').inputValue();
  const points = JSON.parse(source).points;
  const anchor = points.findIndex(([time, amplitude]) => time === 48 && amplitude === 80);
  assert.ok(anchor >= 0, 'Expected the load-step reference point at 48 µs and 80 A');
  await page.selectOption('#insert-reference', String(anchor));
  await page.selectOption('#insert-side', side);
  await page.selectOption('#insert-method', method);
  await page.fill('#insert-first', String(first));
  await page.fill('#insert-second', String(second));
  return { page, source, points, anchor };
}

for (const [method, side, first, second, expected] of [
  ['xy', 'after', 50, 85, [50, 85]],
  ['delta', 'before', -2, -5, [46, 75]],
  ['rate-time', 'before', 3, 46, [46, 74]],
  ['rate-level', 'after', -5, 70, [50, 70]],
]) {
  test(method + ' inserts ' + side + ' the reference and preserves the zoom', async t => {
    const { page, points, anchor } = await prepare(t, side, method, first, second);
    const zoom = () => Promise.all(['#overview-first', '#overview-last'].map(id => page.inputValue(id)));
    const originalZoom = await zoom();
    await page.click('#insert-confirm');
    const index = anchor + Number(side === 'after');
    points.splice(index, 0, expected);
    assert.deepEqual(JSON.parse(await page.inputValue('#source')).points, points);
    assert.equal(Number(await page.inputValue('#point-choice')), index);
    assert.deepEqual(await zoom(), originalZoom);
  });
}

for (const [method, first, second, message] of [
  ['xy', 55, 85, /strictly between adjacent points/i],
  ['rate-level', 0, 70, /zero slew rate/i],
]) {
  test(method + ' rejects invalid input without changing the waveform', async t => {
    const { page, source } = await prepare(t, 'after', method, first, second);
    const confirm = page.locator('#insert-confirm');
    if (await confirm.isEnabled()) await confirm.click();
    assert.ok(await confirm.isVisible());
    assert.match(await page.locator('#insert-result').innerText(), message);
    assert.equal(await page.inputValue('#source'), source);
  });
}
