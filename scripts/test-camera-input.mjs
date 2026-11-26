// Focused check for the Phase 4 controls: free 360-degree camera and
// full-direction aiming.
//
// Everything here goes through the real pointer handlers on the canvas, so it
// verifies the shipped input path rather than re-implementing it:
//   * two fingers orbit yaw, change pitch and pinch-zoom, all within limits
//   * a two-finger gesture never throws and never scores
//   * one finger aims in any direction, including straight backwards, with no
//     maximum angle, and the arrow and preview follow that direction
//   * releasing throws exactly along the aimed direction
//   * the camera target follows the goolah in play and the thrown goolah
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/appjet/browser/node_modules/playwright');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CHECK_PORT || 3111);
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
  // The loader keeps its #loader element and only gains the hidden class, so it
  // must be waited on as attached, never as visible.
  await page.waitForSelector('#loader.hidden', { state: 'attached', timeout: 30000 });
  await page.waitForFunction(() => !!window.__gb?.game?.state, undefined, { timeout: 30000 });
  await page.click('#playBtn');

  const waitReady = () =>
    page.waitForFunction(
      () => {
        const g = window.__gb?.game;
        return !!g && g.phase === 'ready' && g.turnLock <= 0 && g.inputEnabled;
      },
      undefined,
      { timeout: 40000 }
    );
  await waitReady();

  const rig = () =>
    page.evaluate(() => {
      const g = window.__gb.game;
      return { yaw: g.camRig.yaw, pitch: g.camRig.pitch, dist: g.camRig.dist };
    });
  const snapshot = () =>
    page.evaluate(() => {
      const g = window.__gb.game;
      return {
        ball: { x: g.activeBall.body.pos.x, z: g.activeBall.body.pos.z },
        phase: g.phase,
        scores: g.rules.state.scores.slice(),
        target: { x: g.camRig.target.x, z: g.camRig.target.z },
        cam: { x: g.camera.position.x, y: g.camera.position.y, z: g.camera.position.z },
      };
    });

  const limits = await page.evaluate(() => {
    const c = window.__gb.game.camRig;
    return { yaw: c.yaw, pitch: c.pitch, dist: c.dist };
  });
  check('camera rig starts behind the throw line looking down the mats', Math.abs(limits.yaw) < 1e-6, `yaw=${limits.yaw}`);
  check('camera starts at a raised viewing angle', limits.pitch > 0.3 && limits.pitch < 1.0, `pitch=${limits.pitch}`);
  check('camera starts at a sensible distance', limits.dist > 10 && limits.dist < 26, `dist=${limits.dist}`);

  const touchAction = await page.evaluate(
    () => getComputedStyle(document.getElementById('scene')).touchAction
  );
  check('canvas disables browser touch scrolling/zoom', touchAction === 'none', `touch-action=${touchAction}`);

  /* ------------------------------------------------- two-finger camera --- */
  // Dispatch real pointer events at the canvas, exactly as iOS would.
  const gesture = (a0, b0, a1, b1) =>
    page.evaluate(
      ({ a0, b0, a1, b1 }) => {
        const canvas = document.getElementById('scene');
        const fire = (type, id, p) =>
          canvas.dispatchEvent(
            new PointerEvent(type, {
              pointerId: id,
              pointerType: 'touch',
              clientX: p.x,
              clientY: p.y,
              bubbles: true,
              cancelable: true,
              button: 0,
              buttons: type === 'pointerup' ? 0 : 1,
            })
          );
        fire('pointerdown', 1, a0);
        fire('pointerdown', 2, b0);
        for (let i = 1; i <= 6; i += 1) {
          const t = i / 6;
          fire('pointermove', 1, { x: a0.x + (a1.x - a0.x) * t, y: a0.y + (a1.y - a0.y) * t });
          fire('pointermove', 2, { x: b0.x + (b1.x - b0.x) * t, y: b0.y + (b1.y - b0.y) * t });
        }
        const g = window.__gb.game;
        const out = {
          yaw: g.camRig.yaw,
          pitch: g.camRig.pitch,
          dist: g.camRig.dist,
          phase: g.phase,
          ball: { x: g.activeBall.body.pos.x, z: g.activeBall.body.pos.z },
          scores: g.rules.state.scores.slice(),
          pointers: g.pointers.size,
        };
        fire('pointerup', 1, a1);
        fire('pointerup', 2, b1);
        return out;
      },
      { a0, b0, a1, b1 }
    );

  const before = await snapshot();

  // Horizontal two-finger drag spins the camera around the field.
  const orbited = await gesture({ x: 120, y: 520 }, { x: 240, y: 520 }, { x: 300, y: 520 }, { x: 420, y: 520 });
  check(
    'two-finger drag rotates the camera around the field',
    Math.abs(orbited.yaw - limits.yaw) > 0.4,
    `yaw ${limits.yaw} -> ${orbited.yaw}`
  );
  check('camera rotation does not throw', orbited.phase === 'ready', `phase=${orbited.phase}`);
  check(
    'camera gestures move no goolah',
    Math.hypot(orbited.ball.x - before.ball.x, orbited.ball.z - before.ball.z) < 1e-6,
    `${JSON.stringify(before.ball)} -> ${JSON.stringify(orbited.ball)}`
  );
  check(
    'camera rotation does not score',
    orbited.scores.join(',') === before.scores.join(','),
    `${before.scores} -> ${orbited.scores}`
  );

  // A vertical two-finger drag changes the viewing height.
  const raised = await gesture({ x: 150, y: 600 }, { x: 240, y: 600 }, { x: 150, y: 380 }, { x: 240, y: 380 });
  check(
    'two-finger vertical drag changes the viewing height',
    Math.abs(raised.pitch - orbited.pitch) > 0.2,
    `pitch ${orbited.pitch} -> ${raised.pitch}`
  );

  // Spreading two fingers apart (pinch out) pulls the camera in; pinching them
  // together pushes it out. Both stay inside the rig's limits.
  const zoomedIn = await gesture({ x: 180, y: 500 }, { x: 220, y: 500 }, { x: 60, y: 500 }, { x: 340, y: 500 });
  check(
    'pinching out zooms the camera closer',
    zoomedIn.dist < raised.dist - 0.5,
    `dist ${raised.dist} -> ${zoomedIn.dist}`
  );
  check('zoom stays within the near limit', zoomedIn.dist >= 7.5 - 1e-6, `dist=${zoomedIn.dist}`);

  const zoomedOut = await gesture({ x: 60, y: 500 }, { x: 340, y: 500 }, { x: 180, y: 500 }, { x: 220, y: 500 });
  check(
    'pinching in zooms the camera away',
    zoomedOut.dist > zoomedIn.dist + 0.5,
    `dist ${zoomedIn.dist} -> ${zoomedOut.dist}`
  );
  check('zoom stays within the far limit', zoomedOut.dist <= 32 + 1e-6, `dist=${zoomedOut.dist}`);

  // Extreme vertical drags must not put the camera under the ground.
  const flat = await gesture({ x: 150, y: 200 }, { x: 240, y: 200 }, { x: 150, y: 2000 }, { x: 240, y: 2000 });
  check('viewing height is clamped at the top', flat.pitch <= 1.36 + 1e-6, `pitch=${flat.pitch}`);
  const low = await gesture({ x: 150, y: 900 }, { x: 240, y: 900 }, { x: 150, y: -900 }, { x: 240, y: -900 });
  check('viewing height is clamped near the ground', low.pitch >= 0.14 - 1e-6, `pitch=${low.pitch}`);

  // Back to the default view so the aiming checks are deterministic.
  await page.evaluate(() => {
    const g = window.__gb.game;
    g.camRig.yaw = 0;
    g.camRig.pitch = 0.52;
    g.camRig.dist = 18.2;
  });

  /* ------------------------------------------------------- aiming --- */
  const aimDrag = (from, to) =>
    page.evaluate(
      ({ from, to }) => {
        const canvas = document.getElementById('scene');
        const fire = (type, id, p) =>
          canvas.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 7,
              pointerType: 'touch',
              clientX: p.x,
              clientY: p.y,
              bubbles: true,
              cancelable: true,
              button: 0,
              buttons: type === 'pointerup' ? 0 : 1,
            })
          );
        fire('pointerdown', 7, from);
        for (let i = 1; i <= 8; i += 1) {
          const t = i / 8;
          fire('pointermove', 7, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
        }
        const g = window.__gb.game;
        const dir = { x: g.aim.dir.x, z: g.aim.dir.z };
        const axis = { x: Math.sin(g.camRig.yaw), z: Math.cos(g.camRig.yaw) };
        const ball = g.activeBall.body.pos;
        return {
          phase: g.phase,
          angle: g.aim.angle,
          power: g.aim.power,
          dir,
          axis,
          dotAxis: dir.x * axis.x + dir.z * axis.z,
          arrow: g.aimGroup.rotation.y,
          arrowMatches: Math.abs(
            Math.atan2(Math.sin(g.aimGroup.rotation.y - Math.atan2(dir.x, dir.z)), Math.cos(g.aimGroup.rotation.y - Math.atan2(dir.x, dir.z)))
          ),
          dotsVisible: g.dots.visible,
          preview: g.lastPreview ? { x: g.lastPreview.rest.x, z: g.lastPreview.rest.z } : null,
          ball: { x: ball.x, z: ball.z },
        };
      },
      { from, to }
    );

  // Drag DOWN the screen: that is straight back toward the camera.
  const back = await aimDrag({ x: 195, y: 420 }, { x: 195, y: 700 });
  check('a one-finger drag starts aiming', back.phase === 'aiming', `phase=${back.phase}`);
  check('aiming helpers are shown', back.dotsVisible === true);
  check(
    'dragging backwards throws behind the thrower',
    back.dotAxis < -0.95,
    `dot(aim, cameraAxis)=${back.dotAxis.toFixed(3)}`
  );
  check(
    'the old maximum aim angle no longer applies',
    Math.abs(back.angle) > 0.35,
    `angle=${back.angle.toFixed(3)} rad`
  );
  check('the aim arrow points where the throw will go', back.arrowMatches < 1e-6, `delta=${back.arrowMatches}`);
  const previewVec = back.preview
    ? { x: back.preview.x - back.ball.x, z: back.preview.z - back.ball.z }
    : { x: 0, z: 0 };
  const previewLen = Math.hypot(previewVec.x, previewVec.z);
  const previewDot =
    previewLen > 0 ? (previewVec.x * back.dir.x + previewVec.z * back.dir.z) / previewLen : 0;
  check(
    'the trajectory preview runs in the aimed direction',
    previewLen > 0.2 && previewDot > 0.5,
    `len=${previewLen.toFixed(2)} dot=${previewDot.toFixed(3)} rest=${JSON.stringify(back.preview)}`
  );

  // A second finger must cancel this aim without throwing.
  const cancelled = await page.evaluate(() => {
    const canvas = document.getElementById('scene');
    const fire = (type, id, p) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          clientX: p.x,
          clientY: p.y,
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
        })
      );
    fire('pointerdown', 8, { x: 260, y: 500 });
    const g = window.__gb.game;
    const during = { phase: g.phase, power: g.aim.power, pointers: g.pointers.size };
    fire('pointerup', 7, { x: 195, y: 700 });
    fire('pointerup', 8, { x: 260, y: 500 });
    return {
      during,
      after: { phase: g.phase, ball: { x: g.activeBall.body.pos.x, z: g.activeBall.body.pos.z }, scores: g.rules.state.scores.slice() },
    };
  });
  check(
    'a second finger cancels the aim in progress',
    cancelled.during.phase === 'ready' && cancelled.during.power === 0,
    JSON.stringify(cancelled.during)
  );
  check(
    'camera gestures never fire a throw',
    cancelled.after.phase === 'ready' &&
      Math.hypot(cancelled.after.ball.x - before.ball.x, cancelled.after.ball.z - before.ball.z) < 1e-6,
    JSON.stringify(cancelled.after)
  );

  // Drag RIGHT: a sideways throw, also impossible under the old clamp.
  const sideways = await aimDrag({ x: 195, y: 500 }, { x: 500, y: 500 });
  check(
    'dragging sideways throws sideways',
    Math.abs(sideways.angle) > 1.2 && Math.abs(sideways.dotAxis) < 0.2,
    `angle=${sideways.angle.toFixed(3)} dot=${sideways.dotAxis.toFixed(3)}`
  );
  // Cancel it with a second finger: releasing here would spend the human turn.
  const sidewaysCancelled = await page.evaluate(() => {
    const canvas = document.getElementById('scene');
    const fire = (type, id, p) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          clientX: p.x,
          clientY: p.y,
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
        })
      );
    fire('pointerdown', 8, { x: 260, y: 500 });
    const g = window.__gb.game;
    fire('pointerup', 7, { x: 500, y: 500 });
    fire('pointerup', 8, { x: 260, y: 500 });
    return { phase: g.phase, pointers: g.pointers.size };
  });
  check(
    'a sideways aim can be cancelled without throwing',
    sidewaysCancelled.phase === 'ready' && sidewaysCancelled.pointers === 0,
    JSON.stringify(sidewaysCancelled)
  );

  /* ------------------------------- the real throw matches the preview --- */
  const thrown = await page.evaluate(async () => {
    const canvas = document.getElementById('scene');
    const fire = (type, id, p) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 9,
          pointerType: 'touch',
          clientX: p.x,
          clientY: p.y,
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
        })
      );
    // Throw backwards, away from every goolah: open ground keeps the goolah
    // rolling long enough to watch the camera follow it.
    const from = { x: 195, y: 330 };
    const to = { x: 195, y: 660 };
    fire('pointerdown', 9, from);
    for (let i = 1; i <= 8; i += 1) {
      const t = i / 8;
      fire('pointermove', 9, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
    const g = window.__gb.game;
    const aimed = { x: g.aim.dir.x, z: g.aim.dir.z };
    const power = g.aim.power;
    fire('pointerup', 9, to);
    const launchPhase = g.phase;
    const vel = g.thrownBall ? { x: g.thrownBall.body.vel.x, z: g.thrownBall.body.vel.z } : null;
    const speed = vel ? Math.hypot(vel.x, vel.z) : 0;

    // The follow is measured with the game's own rig update in snap mode: it puts
    // the orbit target exactly where the follow logic wants it for this frame, so
    // the result does not depend on the headless frame rate. Sampling happens
    // during the flight because the turn advances the moment the goolah settles.
    const anchorFor = (z) => 1.1 + (z - 1.1) * 0.45;
    const sample = () => {
      if (!g.thrownBall) return null;
      const p = g.thrownBall.body.pos;
      g.updateCamera(0.016, true);
      return { ballZ: p.z, targetZ: g.camRig.target.z, phase: g.phase };
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const s0 = sample();
    // The headless renderer is far slower than a phone GPU, so wait for the
    // goolah to actually travel instead of a fixed delay: the follow must track
    // it once it moves, whatever the frame rate happens to be.
    let s1 = s0;
    for (let i = 0; i < 60 && s1 && s0 && Math.abs(s1.ballZ - s0.ballZ) < 0.9; i += 1) {
      await wait(50);
      s1 = sample();
    }

    return {
      phase: launchPhase,
      power,
      aimed,
      vel,
      speed,
      alignment: vel && speed > 0 ? (vel.x * aimed.x + vel.z * aimed.z) / speed : 0,
      follow: {
        s0,
        s1,
        anchor0: s0 ? anchorFor(s0.ballZ) : null,
        anchor1: s1 ? anchorFor(s1.ballZ) : null,
      },
    };
  });
  check('releasing the drag launches the goolah', thrown.phase === 'flying', `phase=${thrown.phase}`);
  check('the drag distance sets the power', thrown.power > 0.2 && thrown.power <= 1, `power=${thrown.power}`);
  check(
    'the goolah travels exactly along the aimed direction',
    Math.abs(thrown.alignment) > 0.99,
    `dot(vel, aim)=${thrown.alignment.toFixed(4)}`
  );

  /* ------------------------------------------- the camera follows play --- */
  // The target orbits a point blended from the field centre and the goolah whose
  // turn it is, which keeps the active goolah and the mats both in frame.
  const expectedZ = 1.1 + (before.ball.z - 1.1) * 0.45;
  check(
    'the camera orbits between the field centre and the goolah in play',
    Math.abs(before.target.z - expectedZ) < 0.2,
    `target z ${before.target.z.toFixed(2)} vs expected ${expectedZ.toFixed(2)} for ball z ${before.ball.z.toFixed(2)}`
  );
  check(
    'the camera target follows the thrown goolah',
    !!thrown.follow.s0 &&
      !!thrown.follow.s1 &&
      Math.abs(thrown.follow.s0.targetZ - thrown.follow.anchor0) < 0.03 &&
      Math.abs(thrown.follow.s1.targetZ - thrown.follow.anchor1) < 0.03,
    JSON.stringify(thrown.follow)
  );
  check(
    'the camera keeps following while the goolah travels',
    !!thrown.follow.s0 &&
      !!thrown.follow.s1 &&
      Math.abs(thrown.follow.s1.ballZ - thrown.follow.s0.ballZ) > 0.8 &&
      Math.abs(thrown.follow.s1.targetZ - thrown.follow.s0.targetZ) > 0.3,
    JSON.stringify(thrown.follow)
  );

  check('no runtime console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  console.log(
    JSON.stringify(
      {
        rig: limits,
        orbit: { yaw: orbited.yaw, pitch: raised.pitch, zoomOut: zoomedOut.dist, zoomIn: zoomedIn.dist },
        aim: { backward: back.angle, sideways: sideways.angle, arrowDelta: back.arrowMatches },
        throw: { power: thrown.power, alignment: thrown.alignment, speed: thrown.speed },
        follow: { ...thrown.follow, anchor: before.target, expectedZ },
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
  server.kill('SIGTERM');
}

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log('\nAll camera and aiming checks passed.');
