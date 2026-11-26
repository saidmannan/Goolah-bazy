// Focused render + interaction check for the Phase 1 field.
//
// Verifies WebGL shader compile, that the scene produces a non-uniform image,
// the Phase 2 start state (the throwing team on the one shared line, the
// defending team behind mats 1 and 3), and that a straight throw into the
// defender guarding mat 1 scores a Tir and grants the thrower an extra chance.
// Unobstructed reach past mat 4 is a physics property checked separately by
// scripts/test-phase1.mjs.
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

  // Team roles come from the engine: Zananda throws first in round 1 and the
  // roles swap every round, so nothing here may assume team 0 throws first.
  const matZ = before.mats.map((m) => m.z);
  const throwTeam = before.turn.teamIndex;
  const defendTeam = before.rules.defendingTeam;
  check(
    'the engine names this turn\'s team as the throwing team',
    throwTeam === before.rules.throwingTeam,
    `turn=${throwTeam} throwing=${before.rules.throwingTeam}`
  );

  // Rule 2: the defender on player 1 waits behind mat 1 and the player 2
  // defender behind mat 3, whichever mats their team owns.
  let defendersOk = true;
  const defenderDetail = [];
  for (const ball of before.balls.filter((b) => b.teamIndex === defendTeam)) {
    const mat = before.mats[ball.playerIndex === 0 ? 0 : 2];
    const gap = mat.z - ball.z;
    const behind = gap > 0.4 && gap < 1.6;
    const clearOfDish = Math.abs(ball.x) > before.matRadius;
    if (!behind || !clearOfDish || ball.state !== 'home') defendersOk = false;
    defenderDetail.push(`P${ball.playerIndex}:${ball.state}@(${ball.x},${ball.z}) mat@${mat.z}`);
  }
  check('defending goolahs wait behind mats 1 and 3', defendersOk, defenderDetail.join(' '));
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
  const throwers = staged.balls.filter((b) => b.teamIndex === throwTeam);
  check(
    'both throwing-team goolahs stand on the shared line',
    throwers.every((b) => b.state === 'staged' && Math.abs(b.z - staged.throwLineZ) < 0.02),
    throwers.map((b) => `${b.state}@${b.z}`).join(' ')
  );
  check(
    'the two throwing positions are on that same line',
    Math.abs(throwers[0].z - throwers[1].z) < 1e-6 && Math.abs(throwers[0].x - throwers[1].x) > 0.2,
    throwers.map((b) => `(${b.x},${b.z})`).join(' ')
  );

  const TEAM_NAMES = ['Shānanda', 'Zananda'];
  const turnBefore = (await page.textContent('#turnText')).trim();
  check(
    'turn indicator names the throwing team',
    turnBefore.includes(TEAM_NAMES[throwTeam]),
    turnBefore
  );
  check('turn indicator names player 1 first', /Player 1/.test(turnBefore), turnBefore);

  /* ------------------- a straight throw into the guard behind mat 1 --- */
  // The field is no longer empty: by rule the defenders stand behind mats 1 and
  // 3, so a full-power throw down the line meets the guard on mat 1. That
  // collision is the Tir asserted below; the extra chance it earns is then used.
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

  const phaseNow = () => page.evaluate(() => window.__gb?.game?.phase);
  // state() exposes no turn counter, so the field is followed through its phase.
  const waitPhase = (name, timeout) =>
    page
      .waitForFunction((p) => window.__gb?.game?.phase === p, name, { timeout })
      .then(() => true)
      .catch(() => false);

  const shooter = { ...staged.turn };
  const shooterStart = staged.balls.find(
    (b) => b.teamIndex === shooter.teamIndex && b.playerIndex === shooter.playerIndex
  );
  const guard = staged.balls.find(
    (b) => b.teamIndex === staged.rules.defendingTeam && b.playerIndex === 0
  );

  const powerWidth = await dragThrow(200);
  check('power bar responds to the drag', powerWidth > 0, `fill width=${powerWidth}`);

  const launched = await waitPhase('flying', 20000);
  check('releasing a drag launches the goolah', launched, `phase=${await phaseNow()}`);

  const settled = await waitPhase('ready', 120000);
  check('the throw settles and the field returns to aiming', settled, `phase=${await phaseNow()}`);

  const afterFirst = await stateOf();
  const shotBall = afterFirst.balls.find(
    (b) => b.teamIndex === shooter.teamIndex && b.playerIndex === shooter.playerIndex
  );
  check(
    'the thrown goolah travels downfield',
    Boolean(shotBall) && shotBall.z > shooterStart.z + 1,
    shotBall ? `rest z=${shotBall.z}, start z=${shooterStart.z}` : 'ball missing'
  );

  const guardAfter = afterFirst.balls.find(
    (b) => b.teamIndex === guard.teamIndex && b.playerIndex === guard.playerIndex
  );
  check(
    'a straight throw meets the defender behind mat 1',
    Boolean(guardAfter) && Math.abs(guardAfter.z - guard.z) > 0.05,
    guardAfter ? `guard z ${guard.z} -> ${guardAfter.z}` : 'guard missing'
  );
  check(
    'a Tir scores exactly one point',
    afterFirst.scores[shooter.teamIndex] === staged.scores[shooter.teamIndex] + 1,
    `scores ${staged.scores} -> ${afterFirst.scores}`
  );
  check(
    'a Tir grants an extra chance to the same player',
    afterFirst.turn.teamIndex === shooter.teamIndex &&
      afterFirst.turn.playerIndex === shooter.playerIndex,
    `turn ${JSON.stringify(afterFirst.turn)}`
  );

  /* ------------------------------------- the extra chance is playable --- */
  await waitReady().catch(() => {});
  await dragThrow(120);
  const relaunched = await waitPhase('flying', 20000);
  check('the extra chance can be thrown again', relaunched, `phase=${await phaseNow()}`);
  await waitPhase('ready', 120000);
  check('no runtime console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await page.locator('#scene').screenshot({ path: '/tmp/gb-field-after.png' });

  console.log(
    JSON.stringify(
      {
        gl,
        image: { mean, stddev, colors },
        mats: before.mats,
        throwTeam,
        turnBefore,
        scoresBefore: staged.scores,
        scoresAfter: afterFirst.scores,
        turnAfterThrow: afterFirst.turn,
        shotZ: shotBall?.z,
        guardZ: { before: guard.z, after: guardAfter?.z },
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
