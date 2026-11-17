// Temporary diagnostic: prints live game state around a swipe gesture.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/appjet/browser/node_modules/playwright');

const PORT = 3109;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

const waitForServer = async (url) => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

let browser;
try {
  await waitForServer(`${BASE}/api/health`);
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });

  await page.goto(`${BASE}/?debug=1`, { waitUntil: 'load' });
  await page.waitForSelector('#loader.hidden', { timeout: 20000 });
  await page.click('#playBtn');
  await page.waitForTimeout(1200);

  const snapshot = () =>
    page.evaluate(() => {
      const g = window.__gb.game;
      return {
        phase: g.phase,
        inputEnabled: g.inputEnabled,
        turnLock: Number(g.turnLock.toFixed(2)),
        overlayOpen: g.ui.overlayOpen,
        aimPower: Number(g.aim.power.toFixed(2)),
        pointer: g.pointer ? 'down' : 'none',
        activeBall: g.activeBall ? g.activeBall.state : 'none',
        balls: g.balls.map((b) => ({
          state: b.state,
          y: Number(b.group.position.y.toFixed(2)),
          v: [Number(b.vel.x.toFixed(2)), Number(b.vel.y.toFixed(2)), Number(b.vel.z.toFixed(2))],
        })),
        turnText: document.getElementById('turnText').textContent,
        hint: document.getElementById('turnHint').textContent,
      };
    });

  const before = await snapshot();

  await page.evaluate(() => {
    const c = document.getElementById('scene');
    const mk = (type, x, y) =>
      new PointerEvent(type, {
        pointerId: 7,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        isPrimary: true,
      });
    c.dispatchEvent(mk('pointerdown', 195, 600));
    window.__diagDown = true;
    for (let i = 1; i <= 6; i += 1) c.dispatchEvent(mk('pointermove', 195, 600 - i * 18));
  });
  const midAim = await snapshot();

  await page.evaluate(() => {
    const c = document.getElementById('scene');
    const mk = (type, x, y) =>
      new PointerEvent(type, {
        pointerId: 7,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        isPrimary: true,
      });
    for (let i = 7; i <= 14; i += 1) c.dispatchEvent(mk('pointermove', 195, 600 - i * 18));
    c.dispatchEvent(mk('pointerup', 195, 600 - 14 * 18));
  });
  await page.waitForTimeout(600);
  const afterRelease = await snapshot();
  await page.waitForTimeout(4000);
  const afterSettle = await snapshot();

  console.log(JSON.stringify({ before, midAim, afterRelease, afterSettle, errs: errs.slice(0, 6) }, null, 2));
} catch (error) {
  console.error('DIAG ERROR', error.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill('SIGTERM');
}
