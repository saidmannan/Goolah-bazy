// Measures how long the 3D canvas takes to become visible on the deployed app
// and reports the state of the scene/canvas while it waits. Exits non-zero if the
// canvas never paints, so it can be used as a first-paint guard.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/appjet/browser/node_modules/playwright');

const TARGET = process.env.LIVE_URL || 'https://lg1tmrbmx3.dev.onappjet.com';
const BUDGET_MS = Number(process.env.BUDGET_MS || 40000);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

let visibleAt = null;
let loaderHiddenAt = null;
const problems = [];

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  const throttle = Number(process.env.THROTTLE || 1);
  if (throttle > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }

  const phaseLogs = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    else if (msg.text().includes('[goolah-bazy]')) phaseLogs.push(msg.text());
  });
  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`${res.status()} ${res.url()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

  const t0 = Date.now();
  await page.goto(`${TARGET}${TARGET.includes('?') ? '&' : '?'}debug=1`, { waitUntil: 'domcontentloaded' });

  let firstSample = null;
  let lastSample = null;

  while (Date.now() - t0 < BUDGET_MS) {
    const sample = await page.evaluate(() => {
      const canvas = document.getElementById('scene');
      const loader = document.getElementById('loader');
      const app = document.getElementById('app');
      if (!canvas) return { missing: true };
      const cs = getComputedStyle(canvas);
      const box = canvas.getBoundingClientRect();
      const appBox = app ? app.getBoundingClientRect() : null;
      return {
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        cssW: Math.round(box.width),
        cssH: Math.round(box.height),
        bufW: canvas.width,
        bufH: canvas.height,
        appW: appBox ? Math.round(appBox.width) : null,
        appH: appBox ? Math.round(appBox.height) : null,
        debugHandle: !!window.__gb,
        loaderHidden: loader ? loader.classList.contains('hidden') : null,
        dpr: window.devicePixelRatio,
        readyState: document.readyState,
      };
    });

    if (!firstSample) firstSample = sample;
    lastSample = sample;

    const visible =
      sample.cssW > 0 && sample.cssH > 0 && sample.visibility !== 'hidden' && Number(sample.opacity) > 0;
    if (visible && visibleAt === null) visibleAt = Date.now() - t0;
    if (sample.loaderHidden && loaderHiddenAt === null) loaderHiddenAt = Date.now() - t0;
    if (visibleAt !== null && loaderHiddenAt !== null) break;

    await page.waitForTimeout(200);
  }

  console.log(
    JSON.stringify(
      {
        target: TARGET,
        canvasVisibleAfterMs: visibleAt,
        loaderHiddenAfterMs: loaderHiddenAt,
        firstSample,
        lastSample,
        throttle,
        phaseLogs,
        problems: problems.slice(0, 8),
      },
      null,
      2
    )
  );
} finally {
  await browser.close().catch(() => {});
}

if (visibleAt === null) {
  console.error('\nFAILED: the 3D canvas never became visible.');
  process.exit(1);
}
console.log(`\nCanvas painted after ${visibleAt} ms; loader cleared after ${loaderHiddenAt} ms.`);
