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

async function downloadBytes(page, button, activate = selector => page.click(selector)) {
  const pending = page.waitForEvent('download');
  await activate(button);
  const download = await pending;
  assert.equal(await download.failure(), null);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return { name: download.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

for (const [device, width, height] of [
  ['desktop', 1440, 900], ['tablet', 768, 1024], ['phone', 390, 844], ['narrow phone', 320, 640],
]) {
  test('load-step edit updates measurements and SPICE export on ' + device, async t => {
    const touch = device !== 'desktop';
    const page = await browser.newPage({
      viewport: { width, height }, hasTouch: touch, isMobile: width <= 390,
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
    const activate = selector => touch ? page.tap(selector) : page.click(selector);
    await page.goto(editor.href);
    if (device === 'desktop') {
      await activate('#tool-load-step');
    } else {
      await activate('.studio-samples > summary');
      await activate('#canvas-sample');
    }
    await page.getByRole('heading', { name: 'Load step characterization', exact: true }).waitFor();

    const toolbox = await page.locator('.studio-toolbox').boundingBox();
    const plot = await page.locator('.studio-plot').boundingBox();
    const inspector = await page.locator('#studio-inspector').boundingBox();
    if (device === 'desktop') {
      assert.ok(toolbox.x + toolbox.width <= plot.x && plot.x + plot.width <= inspector.x);
      assert.equal(toolbox.y, plot.y);
      assert.equal(inspector.y, plot.y);
      assert.ok((await page.locator('#plot').boundingBox()).height >= 600);
      assert.ok((await page.locator('.studio-header').boundingBox()).height <= 48);
    } else {
      assert.ok(toolbox.y + toolbox.height <= plot.y && plot.y + plot.height <= inspector.y);
      assert.equal(toolbox.x, plot.x);
      assert.equal(inspector.x, plot.x);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    const plotBackground = await page.locator('#plot').evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(plotBackground, 'rgb(255, 255, 255)');
    assert.ok(await page.locator('#plot .grid-minor').count() > 0);
    const measurements = page.locator('#wave-measurements');
    assert.match(await measurements.innerText(), /DC mean\s+80\.062 A/);
    await activate('[data-tool="off"]');
    const point = page.locator('#plot [data-point="6"]');
    if (touch) {
      await point.scrollIntoViewIfNeeded();
      const hitArea = await point.boundingBox();
      await page.touchscreen.tap(hitArea.x + hitArea.width / 2, hitArea.y + hitArea.height / 2);
    } else {
      await point.click();
    }
    assert.equal(await page.inputValue('#point-time'), '48');
    assert.equal(await page.inputValue('#point-value'), '80');
    if (touch) {
      await activate('#focus-point-inspector');
      assert.ok(await page.locator('#canvas-editing > summary').evaluate(el => el === document.activeElement));
    }
    await page.fill('#point-value', '100');
    await activate('#update-point');
    assert.match(await measurements.innerText(), /DC mean\s+80\.662 A/);
    assert.match(await measurements.innerText(), /Total RMS\s+86\.65 A/);
    await activate('[data-tool="a"]');
    assert.match(await page.locator('#canvas-readout').innerText(), /ΔI -5 A/);

    await activate('#studio-export');
    await page.selectOption('#studio-export-kind', 'simulator');
    await page.selectOption('#format', 'pwl');
    const file = await downloadBytes(page, '#download', activate);
    assert.match(file.name, /\.cir$/);
    const netlist = file.bytes.toString('utf8');
    assert.match(netlist, /PWL/);
    assert.match(netlist, /^\+ 0\.000048 100\s*$/m);
  });
}
