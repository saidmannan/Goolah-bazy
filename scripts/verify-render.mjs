// Focused render + interaction check for the Phase 1 field.
//
// Verifies WebGL shader compile, that the scene produces a non-uniform image,
// the mat layout and goolah placement, that both players of a team throw from
// the one shared line, that a full-power throw carries past mat 4, and that both
// players of the throwing team throw before the opposing team.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/appjet/browser/node_modules/playwright');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CHECK_PORT || 3107);
// CHECK_BASE points these checks at an already running instance (for example the
// deployed app) instead of spawning the local server. The loader wait is tunable
// because a cold start on a small host needs longer than a local build.
const EXTERNAL_BASE = process.env.CHECK_BASE || '';
const BASE = EXTERNAL_BASE || `http://127.0.0.1:${PORT}`;
const LOADER_TIMEOUT = Number(process.env.CHECK_LOADER_TIMEOUT || 20000);
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

const server = EXTERNAL_BASE
  ? null
  : spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
    });
let browser;

try {
  const up = await waitForServer(EXTERNAL_BASE ? `${BASE}/` : `${BASE}/api/health`);
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
  // The loader stays in the DOM and is dismissed with opacity 0 plus
  // pointer-events: none (.loader.hidden), so Playwright's visibility wait never
  // satisfies itself. Wait for the class that actually clears the veil.
  await page.waitForFunction(
    () => document.getElementById('loader')?.classList.contains('hidden') === true,
    undefined,
    { timeout: LOADER_TIMEOUT }
  );

  const stateOf = () => page.evaluate(() => window.__gb.game.state());

  /* ---------------------------------------------------- field layout --- */
  // Read the layout before the first throw, while every goolah waits at home.
  await page.waitForFunction(() => !!window.__gb?.game?.state, undefined, { timeout: 20000 });
  const before = await stateOf();

  check('four mats exist', before.mats.length === 4, `got ${before.mats.length}`);
  check(
    'mats alternate ownership 1-3 Shananda, 2-4 Orange',
    before.mats.map((m) => m.teamIndex).join(',') === '0,1,0,1',
    before.mats.map((m) => m.teamIndex).join(',')
  );
  const xs = before.mats.map((m) => m.x);
  check('mats share one straight line', xs.every((x) => Math.abs(x - xs[0]) < 1e-6), xs.join(','));
  const zs = before.mats.map((m) => m.z);
  const ascending = zs.every((z, i) => i === 0 || z > zs[i - 1]);
  check('mats are ordered along the throw direction', ascending, zs.join(','));
  check('mats are about 5 cm deep', Math.abs(before.matDepth - 0.05) < 1e-9, `depth=${before.matDepth}`);
  check('mats are small circles', before.matRadius > 0.3 && before.matRadius < 0.6, `r=${before.matRadius}`);

  // Home placement: each goolah waits beside the mat its team owns.
  const matZ = before.mats.map((m) => m.z);
  const ownerFor = (team, player) => team + player * 2;
  let homesOk = true;
  const homeDetail = [];
  for (const ball of before.balls) {
    const mat = before.mats[ownerFor(ball.teamIndex, ball.playerIndex)];
    const nearZ = Math.abs(ball.z - mat.z) < 1e-6;
    const beside = Math.abs(ball.x) > 0.3;
    if (!nearZ || !beside || ball.state !== 'home') homesOk = false;
    homeDetail.push(`T${ball.teamIndex}P${ball.playerIndex}:${ball.state}@(${ball.x},${ball.z})`);
  }
  check('goolahs start beside the mat their team owns', homesOk, homeDetail.join(' '));
  check(
    'the shared throw line sits behind mat 1',
    before.throwLineZ < matZ[0] - 1,
    `line=${before.throwLineZ} mat1=${matZ[0]}`
  );

  await page.click('#playBtn');

  /* ------------------------------------------------------ rendering --- */
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

  const waitReady = () =>
    page.waitForFunction(
      () => {
        const g = window.__gb?.game;
        return !!g && g.phase === 'ready' && g.turnLock <= 0 && g.inputEnabled;
      },
      undefined,
      { timeout: 40000 }
    );

  // The turn starts locked for a beat; wait until the field accepts input.
  // Software rendering here runs at a few FPS, so allow generous time.
  await waitReady();

  /* ------------------------------------- both players on one throw line --- */
  const staged = await stateOf();
  const teamZero = staged.balls.filter((b) => b.teamIndex === 0);
  const teamOne = staged.balls.filter((b) => b.teamIndex === 1);
  check(
    'both throwing-team goolahs stand on the shared line',
    teamZero.every((b) => b.state === 'staged' && Math.abs(b.z - staged.throwLineZ) < 0.02),
    teamZero.map((b) => `${b.state}@${b.z}`).join(' ')
  );
  check(
    'the two throwing positions are on that same line',
    Math.abs(teamZero[0].z - teamZero[1].z) < 1e-6 && Math.abs(teamZero[0].x - teamZero[1].x) > 0.2,
    teamZero.map((b) => `(${b.x},${b.z})`).join(' ')
  );
  check(
    'the opposing goolahs stay at their own mats',
    teamOne.every((b) => b.state === 'home'),
    teamOne.map((b) => b.state).join(' ')
  );

  const turnBefore = (await page.textContent('#turnText')).trim();
  check('turn indicator names the throwing team', /Shānanda/.test(turnBefore), turnBefore);
  check('turn indicator names player 1 first', /Player 1/.test(turnBefore), turnBefore);

  /* ----------------------------------- full-power throw past mat 4 --- */
  const dragThrow = async (px) => {
    await page.mouse.move(195, 640);
    await page.mouse.down();
    const steps = 14;
    for (let i = 1; i <= steps; i += 1) await page.mouse.move(195, 640 - (px * i) / steps);
    const power = await page.evaluate(() => {
      const fill = document.getElementById('powerFill');
      return fill ? fill.getBoundingClientRect().width : -1;
    });
    await page.mouse.up();
    return power;
  };

  const powerWidth = await dragThrow(200);
  check('power bar responds to the drag', powerWidth > 0, `fill width=${powerWidth}`);

  const launched = await page
    .waitForFunction(() => window.__gb?.game?.phase === 'flying', undefined, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('releasing a drag launches the goolah', launched, `phase=${await page.evaluate(() => window.__gb.game.phase)}`);

  const settle = async (prevSeq) => {
    await page
      .waitForFunction(
        (seq) => {
          const g = window.__gb?.game;
          if (!g) return false;
          return g.turnSeq !== seq && (g.phase === 'ready' || g.phase === 'roundEnd');
        },
        prevSeq,
        { timeout: 60000 }
      )
      .catch(() => {});
    return stateOf();
  };

  const afterFirst = await settle(staged.turnSeq);
  const thrown = afterFirst.balls.find((b) => b.teamIndex === 0 && b.playerIndex === 0);
  check(
    'a full-power throw carries beyond mat 4',
    thrown && thrown.z > matZ[3],
    thrown ? `rest z=${thrown.z}, mat 4 z=${matZ[3]}` : 'ball missing'
  );
  check(
    'the thrown goolah is not left overlapping another',
    afterFirst.balls.every((a, i) =>
      afterFirst.balls.every((b, j) =>
        i === j ? true : Math.hypot(a.x - b.x, a.z - b.z) > before.matRadius * 0.9
      )
    ),
    afterFirst.balls.map((b) => `(${b.x},${b.z})`).join(' ')
  );

  /* -------------------------------------------------- turn order --- */
  const turnAfterFirst = (await page.textContent('#turnText')).trim();
  check(
    'the same team keeps the turn for its second player',
    /Shānanda/.test(turnAfterFirst) && /Player 2/.test(turnAfterFirst),
    `${turnBefore} -> ${turnAfterFirst}`
  );

  await waitReady();
  await dragThrow(80);
  const afterSecond = await settle(afterFirst.turnSeq);
  const turnAfterSecond = (await page.textContent('#turnText')).trim();
  check(
    'the opposing team plays only after both players threw',
    /Orange/.test(turnAfterSecond) && /Player 1/.test(turnAfterSecond),
    `${turnAfterFirst} -> ${turnAfterSecond}`
  );
  check(
    'two goolahs are downfield after two throws',
    afterSecond.balls.filter((b) => b.z > matZ[0]).length >= 2,
    afterSecond.balls.map((b) => `T${b.teamIndex}P${b.playerIndex}@${b.z}`).join(' ')
  );
  check('no runtime console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await page.locator('#scene').screenshot({ path: '/tmp/gb-field-after.png' });

  console.log(
    JSON.stringify(
      {
        gl,
        image: { mean, stddev, colors },
        mats: before.mats,
        turnBefore,
        turnAfterFirst,
        turnAfterSecond,
        restZ: thrown?.z,
        consoleErrors: consoleErrors.slice(0, 5),
      },
      null,
      2
    )
  );
} catch (error) {
  failures.push(`unexpected error: ${error.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
}

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log('\nAll render/interaction checks passed.');
