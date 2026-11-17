import { chromium } from '/opt/appjet/browser/node_modules/playwright/index.js';

const BASE = 'http://127.0.0.1:3000';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('#loader.hidden', { timeout: 20000 });
await page.click('#playBtn');
await page.waitForTimeout(1800);

const glInfo = await page.evaluate(() => {
  const c = document.getElementById('scene');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return { ok: false, reason: 'no context' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ok: true,
    error: gl.getError(),
    version: gl.getParameter(gl.VERSION),
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a',
    width: c.width,
    height: c.height,
  };
});

await page.locator('#scene').screenshot({ path: '/tmp/field.png' });

const before = await page.textContent('#turnText');
const scoreBefore = await page.textContent('#scoreA');

// Swipe up on the field to throw (pointer events from mouse drag).
await page.mouse.move(195, 620);
await page.mouse.down();
for (let i = 1; i <= 12; i++) await page.mouse.move(195, 620 - i * 22);
await page.mouse.up();
await page.waitForTimeout(4500);

const after = await page.textContent('#turnText');
const scoreAfter = await page.textContent('#scoreA');
await page.locator('#scene').screenshot({ path: '/tmp/field-after.png' });

console.log(
  JSON.stringify(
    {
      glInfo,
      errors: errors.slice(0, 12),
      turnBefore: before,
      turnAfter: after,
      scoreBefore,
      scoreAfter,
      turnAdvanced: before !== after,
    },
    null,
    2
  )
);

await browser.close();
