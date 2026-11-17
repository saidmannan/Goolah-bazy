// Focused render + interaction check for the 3D field.
// Verifies WebGL shader compile, that the scene produces a non-uniform image,
// and that a swipe throw actually launches the goolah and advances the turn.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/appjet/browser/node_modules/playwright');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CHECK_PORT || 3107);
const BASE = `http://127.0.0.1:${PORT}`;
const failures = [];

function check(name, condition, detail) {
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForServer(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: repoRoot,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
let browser;

try {
  const up = await waitForServer(`${BASE}/api/health`);
  check('server starts', up);
  if (!up) throw new Error('local server did not become ready');

  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto(`${BASE}/?debug=1`, { waitUntil: 'load' });
  await page.waitForSelector('#loader.hidden', { timeout: 20000 });
  await page.click('#playBtn');

  // Shader compile/link status surfaces as gl errors + three.js console errors.
  await page.waitForTimeout(800);
  const gl = await page.evaluate(() => {
    const canvas = document.getElementById('scene');
    const ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!ctx) return { ok: false };
    return {
      ok: true,
      error: ctx.getError(),
      version: ctx.getParameter(ctx.VERSION),
      width: canvas.width,
      height: canvas.height,
      cssWidth: Math.round(canvas.getBoundingClientRect().width),
      cssHeight: Math.round(canvas.getBoundingClientRect().height),
    };
  });
  check('webgl context available', gl.ok === true);
  check('no gl error after first frames', gl.error === 0, `gl.getError()=${gl.error}`);
  // Low-end GPUs render at a reduced pixel ratio, so the backing store is
  // compared against the CSS size instead of assuming a 1:1 canvas.
  const tracksViewport =
    gl.width >= gl.cssWidth * 0.4 &&
    gl.height >= gl.cssHeight * 0.4 &&
    gl.width <= gl.cssWidth * 4 &&
    gl.height <= gl.cssHeight * 4;
  check('canvas backing store tracks the viewport', tracksViewport, JSON.stringify(gl));
  check(
    'canvas is not the default 300x150',
    !(gl.width === 300 && gl.height === 150),
    JSON.stringify(gl)
  );
  check(
    'no shader/program console errors',
    !consoleErrors.some((t) => /shader|program|webgl/i.test(t)),
    consoleErrors.slice(0, 3).join(' | ')
  );

  const shot = '/tmp/gb-field.png';
  await page.locator('#scene').screenshot({ path: shot });
  const stats = execFileSync('convert', [shot, '-format', '%[fx:mean] %[fx:standard_deviation] %k', 'info:'])
    .toString()
    .trim();
  const [mean, stddev, colors] = stats.split(/\s+/).map(Number);
  check('field image is not blank', mean > 0.02 && mean < 0.98, `mean=${mean}`);
  check('field image has visual variety', stddev > 0.05, `stddev=${stddev}`);
  check('field image is richly coloured', colors > 40, `colors=${colors}`);

  // The turn starts locked for a beat; wait until the field accepts input.
  // Software rendering here runs at a few FPS, so allow generous time.
  await page.waitForFunction(
    () => {
      const g = window.__gb?.game;
      return !!g && g.phase === 'ready' && g.turnLock <= 0 && g.inputEnabled;
    },
    undefined,
    { timeout: 40000 }
  );

  const turnBefore = (await page.textContent('#turnText')).trim();
  const ballStateBefore = await page.evaluate(() => window.__gb.game.activeBall.state);

  // Swipe up across the field to aim and throw.
  await page.mouse.move(195, 640);
  await page.mouse.down();
  for (let i = 1; i <= 14; i += 1) await page.mouse.move(195, 640 - i * 20);
  await page.mouse.up();

  const launched = await page
    .waitForFunction(
      () => {
        const g = window.__gb?.game;
        return !!g && g.phase === 'flying';
      },
      undefined,
      { timeout: 15000 }
    )
    .then(() => true)
    .catch(() => false);
  check('swipe launches the goolah', launched, `phase stayed ${await page.evaluate(() => window.__gb.game.phase)}`);

  let turnAfter = turnBefore;
  for (let i = 0; i < 80; i += 1) {
    await page.waitForTimeout(250);
    turnAfter = (await page.textContent('#turnText')).trim();
    if (turnAfter !== turnBefore) break;
  }
  check('throw advances the turn', turnAfter !== turnBefore, `${turnBefore} -> ${turnAfter}`);
  check('turn indicator names a team and player', /(Blue|Orange)/.test(turnAfter), turnAfter);
  check('no runtime console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await page.locator('#scene').screenshot({ path: '/tmp/gb-field-after.png' });

  console.log(
    JSON.stringify(
      { gl, image: { mean, stddev, colors }, turnBefore, turnAfter, ballStateBefore, consoleErrors: consoleErrors.slice(0, 5) },
      null,
      2
    )
  );
} catch (error) {
  failures.push(`unexpected error: ${error.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill('SIGTERM');
}

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log('\nAll render/interaction checks passed.');
