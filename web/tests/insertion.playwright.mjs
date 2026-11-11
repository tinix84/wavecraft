import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { unpackProject } from '../src/project/index.ts';

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

test('point insertion invalidates analysis and refreshes metrics through the committed edit', async t => {
  const { page, points } = await prepare(t, 'after', 'xy', 50, 85);
  const metrics = page.locator('#wave-measurements');
  const previousMetrics = await metrics.innerText();
  await page.click('#insert-confirm');
  assert.equal(JSON.parse(await page.inputValue('#source')).points.length, points.length + 1);
  assert.equal(await page.locator('#spectrum-results').isVisible(), false);
  assert.equal(await page.locator('#spectrum-csv').isDisabled(), true);
  assert.notEqual(await metrics.innerText(), previousMetrics);
  assert.match(await metrics.innerText(), /80\.113 A/);
  await page.click('#spectrum-analyze');
  assert.equal(await page.locator('#spectrum-results').isVisible(), true);
  assert.match(await page.locator('#spectrum-summary').textContent(), /DC average: 80\.1125 A/);
  await page.waitForFunction(() => document.getElementById('recovery-state').textContent.startsWith('Browser recovery saved.'));
  const archive = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('wavecraft-project-recovery');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction('revisions').objectStore('revisions').get('latest');
        request.onsuccess = () => resolve(Array.from(request.result.archive));
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  });
  assert.equal(JSON.parse(unpackProject(new Uint8Array(archive)).source).points.length, points.length + 1);
  await page.click('#undo');
  assert.equal(await page.locator('#spectrum-results').isVisible(), false);
  assert.equal(await metrics.innerText(), previousMetrics);
  await page.click('#spectrum-analyze');
  await page.click('#redo');
  assert.equal(await page.locator('#spectrum-results').isVisible(), false);
  assert.match(await metrics.innerText(), /80\.113 A/);
});

test('point insertion invalidates a reviewed reconstruction preview', async t => {
  const { page, anchor } = await prepare(t, 'after', 'xy', 50, 85);
  await page.click('#insert-cancel');
  await page.setInputFiles('#open-file', {
    name: 'trace.csv', mimeType: 'text/csv', buffer: Buffer.from('time,level\n0,10\n100,20\n'),
  });
  await page.selectOption('#digitize-dimension', 'current');
  await page.selectOption('#digitize-time-unit', 'us');
  await page.selectOption('#digitize-value-unit', 'A');
  await page.check('#digitize-map-confirm');
  await page.click('#digitize-stage-csv');
  await page.fill('#digitize-assumptions', 'Manual trace with linear interpolation between recorded points.');
  await page.check('#digitize-overlay-review');
  assert.equal(await page.locator('#digitize-overlay-review').isChecked(), true);
  await page.click('#canvas-workspace summary');
  await page.click('#studio-project');
  await page.click('.insert-menu summary');
  await page.click('#insert-relative-open');
  await page.selectOption('#insert-reference', String(anchor));
  await page.selectOption('#insert-side', 'after');
  await page.selectOption('#insert-method', 'xy');
  await page.fill('#insert-first', '50');
  await page.fill('#insert-second', '85');
  await page.click('#insert-confirm');
  assert.equal(await page.locator('#digitize-overlay-review').isChecked(), false);
  assert.equal(await page.locator('#use-trace').isDisabled(), true);
});

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
