// Regression cover for the two mobile input bugs found on a real iPhone:
//
//   BUG 1 — the two-finger orbit turned the wrong way horizontally, and the
//           horizontal and vertical axes disagreed about which way "follow the
//           fingers" means.
//   BUG 2 — a two-finger camera gesture could still throw the goolah, because a
//           pointer-up belonging to the camera gesture (or an aiming finger that
//           had already been joined by a second finger) was treated as a throw.
//
// Everything here drives the page through Chromium's real touch pipeline
// (Input.dispatchTouchEvent), so iOS's touch -> pointer translation is exercised
// rather than a synthetic PointerEvent that skips it. The assertions read the
// live game object, so they test the shipped handlers, not a copy of them.
//
// Rotation is checked against the camera's own horizontal axis: at yaw 0 the
// camera looks down +Z, so its screen-right is -X. "Drag right turns the view
// right" therefore means the new gaze has a positive dot product with that
// screen-right vector — a check that stays correct at every viewing angle
// instead of only at yaw 0.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/appjet/browser/node_modules/playwright');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CHECK_PORT || 3112);
const BASE = `http://127.0.0.1:${PORT}`;
const failures = [];
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
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
  const serverUp = await waitForServer(`${BASE}/api/health`);
  check('server starts', serverUp);
  if (!serverUp) throw new Error('local server did not become ready');

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
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(`${BASE}/?debug=1`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => document.getElementById('loader')?.classList.contains('hidden'),
    undefined,
    { timeout: 45000 }
  );
  await page.waitForFunction(() => Boolean(window.__gb?.game?.state), undefined, { timeout: 45000 });
  await page.click('#playBtn');
  await page.waitForFunction(
    () => {
      const g = window.__gb?.game;
      return Boolean(g) && g.phase === 'ready' && typeof g.canAim === 'function' && g.canAim();
    },
    undefined,
    { timeout: 45000 }
  );

  // ---------------------------------------------------------------- helpers --
  const cdp = await page.context().newCDPSession(page);

  const touch = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({
        x: Math.round(p.x),
        y: Math.round(p.y),
        id: p.id,
        radiusX: 6,
        radiusY: 6,
        force: 1,
      })),
    });

  // A tiny finger manager, so every gesture is released exactly as intended.
  let active = [];
  const down = async (id, x, y) => {
    active = [...active, { id, x, y }];
    await touch('touchStart', active);
  };
  const move = async (id, x, y) => {
    active = active.map((p) => (p.id === id ? { ...p, x, y } : p));
    await touch('touchMove', active);
  };
  const up = async (id) => {
    active = active.filter((p) => p.id !== id);
    await touch('touchEnd', active);
  };
  const upAll = async () => {
    active = [];
    await touch('touchEnd', []);
  };

  // Synthetic pointer events for the one case real touches cannot express: a
  // finger landing beside the field (the HUD swallows pointer events there).
  const synthetic = (type, id, x, y, selector) =>
    page.evaluate(
      ({ type, id, x, y, selector }) => {
        const el = document.querySelector(selector);
        el.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: 'touch',
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
          })
        );
      },
      { type, id, x, y, selector }
    );

  const snap = () =>
    page.evaluate(() => {
      const g = window.__gb.game;
      const st = g.rules?.state ?? {};
      const ball = g.activeBall?.body?.pos;
      return {
        phase: g.phase,
        ball: ball ? { x: ball.x, z: ball.z } : null,
        scores: Array.isArray(st.scores) ? st.scores.slice() : [],
        pointers: g.pointers.size,
        power: g.aim.power,
        multi: g.gestureMulti,
        yaw: g.camRig.yaw,
        pitch: g.camRig.pitch,
      };
    });

  const setRig = (yaw, pitch) =>
    page.evaluate(
      ({ yaw, pitch }) => {
        const g = window.__gb.game;
        g.camRig.yaw = yaw;
        if (typeof pitch === 'number') g.camRig.pitch = pitch;
      },
      { yaw, pitch }
    );

  const sameBall = (a, b) =>
    Boolean(a && b) && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9;

  const waitReady = () =>
    page.waitForFunction(
      () => {
        const g = window.__gb?.game;
        return Boolean(g) && g.phase === 'ready' && typeof g.canAim === 'function' && g.canAim();
      },
      undefined,
      { timeout: 45000 }
    );

  const noLeaks = async (label) => {
    const s = await snap();
    check(`${label}: no pointer ids left behind`, s.pointers === 0, `pointers=${s.pointers}`);
    check(`${label}: gesture is fresh again`, s.multi === false, `multi=${s.multi}`);
    return s;
  };

  // Two fingers drag by (dx, dy) from a fixed pair of start points.
  const twoFingerDrag = async (dx, dy, { steps = 6, ax = 120, ay = 520, bx = 250, by = 520 } = {}) => {
    await down(1, ax, ay);
    await down(2, bx, by);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      await move(1, ax + dx * t, ay + dy * t);
      await move(2, bx + dx * t, by + dy * t);
    }
    return snap();
  };

  // ------------------------------------------------- BUG 1: orbit direction --
  // 150 px * 0.008 rad/px = 1.2 rad of yaw, comfortably past the threshold.
  const DRAG = 150;
  const YAW_STEP = DRAG * 0.008;

  for (const pass of [1, 2, 3]) {
    for (const yaw0 of [0, 1.2, -2.1, 3.0]) {
      // Dragging right must turn the view right, from any starting angle.
      await setRig(yaw0, 0.52);
      const right = await twoFingerDrag(DRAG, 0);
      await upAll();

      const screenRight = { x: -Math.cos(yaw0), z: Math.sin(yaw0) };
      const gaze = { x: Math.sin(right.yaw), z: Math.cos(right.yaw) };
      const turnDot = gaze.x * screenRight.x + gaze.z * screenRight.z;

      check(
        `pass ${pass} yaw ${yaw0}: dragging right turns the view right`,
        turnDot > 0.2,
        `dot=${turnDot.toFixed(3)}, yaw ${yaw0} -> ${right.yaw.toFixed(3)}`
      );
      check(
        `pass ${pass} yaw ${yaw0}: dragging right lowers yaw by the drag amount`,
        Math.abs(right.yaw - (yaw0 - YAW_STEP)) < 1e-6,
        `expected ${(yaw0 - YAW_STEP).toFixed(3)}, got ${right.yaw.toFixed(3)}`
      );
      check(
        `pass ${pass} yaw ${yaw0}: a horizontal drag leaves pitch untouched`,
        Math.abs(right.pitch - 0.52) < 1e-9,
        `pitch=${right.pitch}`
      );
      await noLeaks(`pass ${pass} yaw ${yaw0} right drag`);

      // Dragging left must turn the view left, by the same amount.
      await setRig(yaw0, 0.52);
      const left = await twoFingerDrag(-DRAG, 0);
      await upAll();

      const gazeLeft = { x: Math.sin(left.yaw), z: Math.cos(left.yaw) };
      const turnDotLeft = gazeLeft.x * screenRight.x + gazeLeft.z * screenRight.z;

      check(
        `pass ${pass} yaw ${yaw0}: dragging left turns the view left`,
        turnDotLeft < -0.2,
        `dot=${turnDotLeft.toFixed(3)}, yaw ${yaw0} -> ${left.yaw.toFixed(3)}`
      );
      check(
        `pass ${pass} yaw ${yaw0}: dragging left raises yaw by the drag amount`,
        Math.abs(left.yaw - (yaw0 + YAW_STEP)) < 1e-6,
        `expected ${(yaw0 + YAW_STEP).toFixed(3)}, got ${left.yaw.toFixed(3)}`
      );
      await noLeaks(`pass ${pass} yaw ${yaw0} left drag`);
    }
  }

  // Vertical drag owns pitch only, and tilts the view the way the fingers move.
  for (const pass of [1, 2, 3]) {
    await setRig(0.4, 0.5);
    const downDrag = await twoFingerDrag(0, 100);
    await upAll();
    check(
      `pass ${pass}: dragging down lifts the camera (pitch up)`,
      downDrag.pitch > 0.5 + 0.3,
      `pitch 0.5 -> ${downDrag.pitch.toFixed(3)}`
    );
    check(
      `pass ${pass}: a vertical drag leaves yaw untouched`,
      Math.abs(downDrag.yaw - 0.4) < 1e-9,
      `yaw=${downDrag.yaw}`
    );
    await noLeaks(`pass ${pass} drag down`);

    await setRig(0.4, 0.9);
    const upDrag = await twoFingerDrag(0, -100);
    await upAll();
    check(
      `pass ${pass}: dragging up lowers the camera (pitch down)`,
      upDrag.pitch < 0.9 - 0.3,
      `pitch 0.9 -> ${upDrag.pitch.toFixed(3)}`
    );
    await noLeaks(`pass ${pass} drag up`);
  }

  // Pitch stays inside the rig's limits however far the fingers travel.
  await setRig(0, 1.0);
  const tooFar = await twoFingerDrag(0, 600, { steps: 8 });
  await upAll();
  check('pitch is clamped at the top-down limit', tooFar.pitch <= 1.36 + 1e-9, `pitch=${tooFar.pitch}`);
  await setRig(0, 0.5);
  const tooNear = await twoFingerDrag(0, -600, { steps: 8 });
  await upAll();
  check('pitch is clamped at the eye-level limit', tooNear.pitch >= 0.14 - 1e-9, `pitch=${tooNear.pitch}`);

  // ------------------------------- BUG 2: a camera gesture never throws ------
  await waitReady();

  // Repeated two-finger drags must never score or move a goolah.
  for (let i = 0; i < 5; i += 1) {
    const before = await snap();
    const during = await twoFingerDrag(i % 2 === 0 ? 140 : -140, 40);
    const after = await upAll();
    const settled = await snap();

    check(
      `camera drag ${i + 1}: no aim starts`,
      during.phase === 'ready' && during.power === 0,
      `phase=${during.phase}, power=${during.power}`
    );
    check(
      `camera drag ${i + 1}: the goolah never moves`,
      sameBall(before.ball, settled.ball),
      `${JSON.stringify(before.ball)} -> ${JSON.stringify(settled.ball)}`
    );
    check(
      `camera drag ${i + 1}: no score changes`,
      before.scores.join() === settled.scores.join(),
      `${before.scores} -> ${settled.scores}`
    );
    check(
      `camera drag ${i + 1}: still the same player's turn`,
      settled.phase === 'ready',
      `phase=${settled.phase}`
    );
    await noLeaks(`camera drag ${i + 1}`);
  }

  // The dangerous ordering: aim with one finger, a second finger joins, then the
  // aiming finger lifts FIRST. Without the poisoned gesture that pointer-up is a
  // throw.
  {
    const before = await snap();
    await down(1, 195, 500);
    await move(1, 195, 430);
    await move(1, 195, 380);
    const aiming = await snap();
    check('one finger starts aiming', aiming.phase === 'aiming' && aiming.power > 0, `power=${aiming.power}`);

    await down(2, 300, 600);
    const cancelled = await snap();
    check(
      'a second finger cancels the aim immediately',
      cancelled.phase === 'ready' && cancelled.power === 0,
      `phase=${cancelled.phase}, power=${cancelled.power}`
    );
    check('the gesture is marked multi-touch', cancelled.multi === true, `multi=${cancelled.multi}`);

    await up(1); // aiming finger lifts first
    const afterAimUp = await snap();
    check(
      "the aiming finger's pointer-up cannot throw",
      afterAimUp.phase === 'ready' && sameBall(before.ball, afterAimUp.ball),
      `phase=${afterAimUp.phase}`
    );

    await up(2);
    const end = await noLeaks('aim + second finger (aim finger first)');
    check(
      'no throw and no score after the gesture ends',
      sameBall(before.ball, end.ball) && before.scores.join() === end.scores.join(),
      `scores ${before.scores} -> ${end.scores}`
    );
  }

  // The other ordering: the camera finger lifts first, so the aiming finger is
  // the LAST pointer to leave the screen — the case that used to throw.
  {
    const before = await snap();
    await down(1, 195, 500);
    await move(1, 195, 430);
    await move(1, 195, 380);
    await down(2, 300, 600);
    await move(2, 330, 600);

    await up(2); // camera finger lifts first
    const mid = await snap();
    check(
      'the camera finger lifting does not throw',
      mid.phase === 'ready' && sameBall(before.ball, mid.ball),
      `phase=${mid.phase}`
    );

    await up(1); // aiming finger is now the last pointer up
    const end = await noLeaks('camera finger first, aiming finger last');
    check(
      'the last pointer-up of a multi-touch gesture never throws',
      end.phase === 'ready' &&
        sameBall(before.ball, end.ball) &&
        before.scores.join() === end.scores.join(),
      `phase=${end.phase}, scores ${before.scores} -> ${end.scores}`
    );
  }

  // A finger left over from a camera gesture cannot inherit the aim.
  {
    await down(1, 195, 500);
    await down(2, 300, 600);
    await up(2);
    await move(1, 195, 380);
    await move(1, 195, 340);
    const leftover = await snap();
    check(
      'a single finger left over from a camera gesture cannot aim',
      leftover.phase === 'ready' && leftover.power === 0,
      `phase=${leftover.phase}, power=${leftover.power}`
    );
    await up(1);
    await noLeaks('leftover finger');
  }

  // Three fingers are a camera gesture too.
  {
    const before = await snap();
    await down(1, 120, 520);
    await down(2, 240, 520);
    await down(3, 300, 620);
    for (let i = 1; i <= 4; i += 1) {
      await move(1, 120 + 20 * i, 520);
      await move(3, 300 - 15 * i, 620);
    }
    const during = await snap();
    await up(3);
    await up(2);
    await up(1);
    const end = await noLeaks('three fingers');
    check(
      'a three-finger gesture never aims or throws',
      during.phase === 'ready' && end.phase === 'ready' && sameBall(before.ball, end.ball),
      `phase=${during.phase}/${end.phase}`
    );
  }

  // A second finger that lands beside the field still counts towards the gesture.
  {
    const before = await snap();
    await down(1, 195, 500);
    await move(1, 195, 430);
    await move(1, 195, 380);
    await synthetic('pointerdown', 91, 20, 40, '.hud');
    const cancelled = await snap();
    check(
      'a second finger beside the field cancels the aim',
      cancelled.phase === 'ready' && cancelled.power === 0 && cancelled.multi === true,
      `phase=${cancelled.phase}, multi=${cancelled.multi}`
    );
    await up(1);
    await synthetic('pointerup', 91, 20, 40, '.hud');
    const end = await noLeaks('second finger beside the field');
    check(
      'a gesture that touched the HUD never throws',
      end.phase === 'ready' && sameBall(before.ball, end.ball),
      `phase=${end.phase}`
    );
  }

  // Finally: after all those camera gestures, a fresh single finger still works.
  {
    await waitReady();
    const before = await snap();
    await down(1, 195, 560);
    for (let i = 1; i <= 6; i += 1) await move(1, 195, 560 - 20 * i);
    const aiming = await snap();
    check(
      'a fresh single finger still aims after camera gestures',
      aiming.phase === 'aiming' && aiming.power > 0,
      `phase=${aiming.phase}, power=${aiming.power}`
    );
    check(
      'aiming a fresh gesture does not move the goolah by itself',
      sameBall(before.ball, aiming.ball),
      `${JSON.stringify(before.ball)} -> ${JSON.stringify(aiming.ball)}`
    );

    await up(1);
    await page.waitForFunction(
      () => window.__gb.game.phase !== 'aiming',
      undefined,
      { timeout: 8000 }
    );
    const thrown = await snap();
    check(
      'a fresh single-finger release still throws',
      thrown.phase === 'flying' || !sameBall(before.ball, thrown.ball),
      `phase=${thrown.phase}`
    );
    await noLeaks('fresh single-finger throw');
  }

  check('no console or page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  if (failures.length) {
    console.error(`${failures.length} of ${checks} touch-regression checks failed:\n`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`All ${checks} touch-regression checks passed.`);
    console.log(
      'Covered: orbit direction at 4 yaw angles x 3 passes x both directions, pitch axis and clamping, ' +
        '5 repeated camera drags that never throw, both pointer-up orderings of a mixed gesture, ' +
        'leftover and three-finger gestures, a second finger beside the field, and a fresh throw afterwards.'
    );
  }
} catch (err) {
  console.error(`touch regression run failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}
