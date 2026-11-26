// Physics regression suite for the goolahs.
//
// Everything here runs the real integrator (src/physics.js) on the real surface
// (src/terrain.js). Nothing is asserted about materials or colours: these checks
// prove that the *simulation* behaves like heavy metal on dirt, because that is
// what the scoring and the visuals both read.
//
//   node scripts/test-physics-rolling.mjs
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { MAT, matHollowIndex, surfaceHeight, terrainHeight } from '../src/terrain.js';
import {
  createBody,
  setRollingSpin,
  simulateShot,
  stepBalls,
  stepBallMotion,
} from '../src/physics.js';

const R = CONFIG.ballRadius;
const MAT_R = CONFIG.matRadius;

let checks = 0;
const failures = [];

function ok(cond, label, detail = '') {
  checks += 1;
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function near(actual, expected, tol, label) {
  ok(Math.abs(actual - expected) <= tol, label, `${actual.toFixed(4)} vs ${expected.toFixed(4)} ±${tol}`);
}

function greater(actual, limit, label) {
  ok(actual > limit, label, `${actual.toFixed(4)} !> ${limit}`);
}

function less(actual, limit, label) {
  ok(actual < limit, label, `${actual.toFixed(4)} !< ${limit}`);
}

/** Flat test surface, for checks that must not depend on terrain relief. */
const flat = () => 0;

const startX = CONFIG.matX;
const startZ = CONFIG.throwLineZ;
const groundStart = () => surfaceHeight(startX, startZ);
const seat = (x, z, surface = surfaceHeight) =>
  surface(x, z) + R + 0.001;

/* =========================================================================
   1. A rolling goolah turns, and its turn comes from its travel
   ========================================================================= */

{
  const shot = simulateShot(
    { x: startX, y: seat(startX, startZ), z: startZ },
    { x: 0, y: 0, z: 1 },
    0.55,
    CONFIG,
    { step: 1 / 120, maxTime: 16, surface: surfaceHeight }
  );

  greater(shot.rotations, 1, 'a thrown goolah visibly rotates as it travels');
  greater(shot.distance, 1, 'a thrown goolah covers ground');
  ok(shot.resting, 'a thrown goolah comes to rest');

  // Rolling, not sliding: on a flat surface the angular speed must converge to
  // v / R with the spin axis square to the direction of travel.
  // Sampled at 0.3 s: a 6 m/s goolah is still rolling at ~3.3 m/s (rolling
  // resistance of 9 m/s² stops it after 0.67 s), so the constraint is measured
  // while it is genuinely rolling rather than after it has come to rest.
  const ROLL_STEPS = 72;
  const body = createBody(0, R + 0.0005, 0, R, CONFIG);
  body.vel.set(0, 0, 6);
  for (let i = 0; i < ROLL_STEPS; i += 1) stepBallMotion(body, 1 / 240, CONFIG, flat);

  const speed = Math.hypot(body.vel.x, body.vel.z);
  const spin = body.angVel.length();
  near(spin, speed / R, speed / R * 0.06, 'rolling constraint: |ω| = v / R');
  const axisDot = (body.angVel.x * body.vel.x + body.angVel.z * body.vel.z) / (spin * speed);
  near(axisDot, 0, 0.02, 'spin axis is perpendicular to travel');

  // Rolling in +z means the top of the ball moves forward: ωx = v_z / R.
  greater(body.angVel.x, 0, 'roll direction matches travel (+z rolls about +x)');

  const angle = 2 * Math.acos(Math.min(1, Math.abs(body.quat.w)));
  greater(angle, 0.5, 'orientation quaternion advanced by the roll');

  // Orientation is integrated from ω, never animated separately: two identical
  // rolls must produce the same quaternion.
  const twin = createBody(0, R + 0.0005, 0, R, CONFIG);
  twin.vel.set(0, 0, 6);
  for (let i = 0; i < ROLL_STEPS; i += 1) stepBallMotion(twin, 1 / 240, CONFIG, flat);
  near(twin.quat.angleTo(body.quat), 0, 1e-9, 'orientation is deterministic from the dynamics');
}

/* =========================================================================
   2. Rolling resistance: a goolah always slows down and stops
   ========================================================================= */

{
  const body = createBody(0, R + 0.0005, 0, R, CONFIG);
  body.vel.set(0, 0, 11);
  setRollingSpin(body);

  let previous = Math.hypot(body.vel.x, body.vel.z);
  let monotone = true;
  let travelled = 0;
  let steps = 0;
  const last = new THREE.Vector3().copy(body.pos);

  for (; steps < 2400 && !body.resting; steps += 1) {
    stepBallMotion(body, 1 / 120, CONFIG, flat);
    const speed = Math.hypot(body.vel.x, body.vel.z);
    if (speed > previous + 1e-9) monotone = false;
    previous = speed;
    travelled += Math.hypot(body.pos.x - last.x, body.pos.z - last.z);
    last.copy(body.pos);
  }

  ok(monotone, 'a rolling goolah never gains speed on its own');
  ok(body.resting, 'a rolling goolah comes to a full stop');
  greater(travelled, 2, 'a struck goolah keeps rolling a real distance');
  less(travelled, 40, 'a goolah does not roll forever');
  near(body.vel.length(), 0, 1e-9, 'stopped goolah has zero velocity');

  // Friction is what stops it: with friction removed it would travel further.
  const slick = { ...CONFIG, rollFriction: 0.5 };
  const slickBody = createBody(0, R + 0.0005, 0, R, slick);
  slickBody.vel.set(0, 0, 11);
  setRollingSpin(slickBody);
  for (let i = 0; i < 1200 && !slickBody.resting; i += 1) {
    stepBallMotion(slickBody, 1 / 120, slick, flat);
  }
  greater(
    Math.hypot(slickBody.pos.x, slickBody.pos.z),
    travelled,
    'lower friction carries the goolah further (resistance is doing the work)'
  );
}

/* =========================================================================
   3. A collision moves the goolah that was struck
   ========================================================================= */

function runStrike({ gap = 2.2, speed = 9, lateral = 0, frames = 240 } = {}) {
  const striker = createBody(0, R + 0.0005, 0, R, CONFIG);
  striker.vel.set(0, 0, speed);
  setRollingSpin(striker);

  const target = createBody(lateral, R + 0.0005, gap, R, CONFIG);
  target.resting = true;

  const startTarget = target.pos.clone();
  const startStrikerSpeed = Math.hypot(striker.vel.x, striker.vel.z);
  const contacts = [];
  let targetMaxSpeed = 0;
  let minDistance = Infinity;
  let strikerSpeedAtHit = null;

  for (let i = 0; i < frames; i += 1) {
    stepBalls([striker, target], 1 / 60, CONFIG, flat, (c) => {
      contacts.push(c);
      if (strikerSpeedAtHit === null) strikerSpeedAtHit = Math.hypot(striker.vel.x, striker.vel.z);
    });
    targetMaxSpeed = Math.max(targetMaxSpeed, target.vel.length());
    minDistance = Math.min(minDistance, striker.pos.distanceTo(target.pos));
  }

  return {
    striker,
    target,
    contacts,
    targetMaxSpeed,
    minDistance,
    startTarget,
    startStrikerSpeed,
    strikerSpeedAtHit,
  };
}

{
  const strike = runStrike();

  ok(strike.contacts.length > 0, 'a strike is detected');
  greater(
    strike.target.pos.distanceTo(strike.startTarget),
    0.15,
    'the struck goolah is physically displaced'
  );
  greater(strike.targetMaxSpeed, 2.5, 'the struck goolah takes real momentum');
  greater(
    strike.striker.pos.z,
    0,
    'the striking goolah keeps travelling after the hit'
  );
  less(
    Math.hypot(strike.striker.vel.x, strike.striker.vel.z),
    strike.startStrikerSpeed,
    'the striking goolah gives up speed to the one it hit'
  );
  greater(
    strike.strikerSpeedAtHit ?? strike.startStrikerSpeed,
    0,
    'contact is reported while the striker is still moving'
  );

  // The struck goolah is knocked forward, not sideways: momentum follows the
  // contact normal rather than teleporting it anywhere.
  greater(strike.target.pos.z - strike.startTarget.z, 0.1, 'the struck goolah is pushed along the impact');
  less(Math.abs(strike.target.pos.x - strike.startTarget.x), 0.12, 'the struck goolah is not flung sideways');

  // A resting goolah is asleep until it is struck.
  const parked = createBody(0, R + 0.0005, 6, R, CONFIG);
  parked.resting = true;
  for (let i = 0; i < 120; i += 1) stepBallMotion(parked, 1 / 60, CONFIG, flat);
  near(parked.pos.z, 6, 1e-9, 'a parked goolah does not drift on its own');
}

/* =========================================================================
   4. No tunnelling at full power, in either direction
   ========================================================================= */

{
  const strike = runStrike({ gap: 1.2, speed: 17, frames: 90 });
  ok(
    strike.minDistance >= 2 * R - 0.02,
    'two goolahs never overlap or pass through each other',
    `min centre distance ${strike.minDistance.toFixed(4)} vs 2R=${(2 * R).toFixed(4)}`
  );
  greater(
    strike.striker.pos.distanceTo(strike.target.pos),
    2 * R - 0.02,
    'the pair is separated after a full-power head-on strike'
  );

  // Head-on: both moving at full speed towards each other.
  const a = createBody(0, R + 0.0005, 0, R, CONFIG);
  const b = createBody(0, R + 0.0005, 1.6, R, CONFIG);
  a.vel.set(0, 0, 17);
  b.vel.set(0, 0, -17);
  let minDistance = Infinity;
  let overlapped = false;
  for (let i = 0; i < 120; i += 1) {
    stepBalls([a, b], 1 / 60, CONFIG, flat);
    const d = a.pos.distanceTo(b.pos);
    minDistance = Math.min(minDistance, d);
    if (d < 2 * R - 0.02) overlapped = true;
  }
  ok(!overlapped, 'no tunnelling in a 34 m/s closing collision');
  ok(minDistance >= 2 * R - 0.02, 'head-on pair stays separated', minDistance.toFixed(4));

  // A grazing near-miss at full speed must not be reported as a strike.
  const miss = runStrike({ gap: 2.0, speed: 17, lateral: 2 * R + 0.25, frames: 60 });
  ok(miss.contacts.length === 0, 'goolahs that pass close but never touch do not collide');
}

/* =========================================================================
   5. The scored contact is the physical contact
   ========================================================================= */

{
  const strike = runStrike();
  ok(strike.contacts.length === 1, 'one strike reports exactly one contact event', `${strike.contacts.length}`);
  const c = strike.contacts[0];
  greater(c.impactSpeed, 1, 'the contact carries a real impact speed');
  ok(c.a && c.b, 'the contact names both goolahs');

  // The contact point lies on the surface of the striker, on the line between
  // the two centres: it is a genuine touching point, not a proximity test.
  // Judged at the recorded moment of impact: the goolahs have rolled on since,
  // so their live positions say nothing about the contact.
  const centreGap = c.aPos.distanceTo(c.bPos);
  ok(
    Math.abs(centreGap - 2 * R) < 0.06,
    'contact happens at the moment the surfaces touch',
    `centres ${centreGap.toFixed(4)} apart, 2R=${(2 * R).toFixed(4)}`
  );
  const toPoint = c.point.distanceTo(c.aPos);
  near(toPoint, R, 0.05, 'contact point sits on the goolah surface');

  // Duplicate contacts cannot accumulate: many substeps in one frame still give
  // one event for the pair.
  const fast = runStrike({ gap: 1.0, speed: 17, frames: 30 });
  less(fast.contacts.length, 2, 'a fast strike does not report duplicate contacts');
}

/* =========================================================================
   6. The mat rim is solid: the goolah climbs it, and a grazing shot deflects
   ========================================================================= */

{
  // Geometry first: a recessed centre with a raised rim around it.
  const centre = surfaceHeight(CONFIG.matX, CONFIG.matZ[0]);
  const base = terrainHeight(CONFIG.matX, CONFIG.matZ[0]);
  less(centre, base - CONFIG.matDepth * 0.8, 'the mat centre is recessed below the ground');
  near(base - centre, CONFIG.matDepth, CONFIG.matDepth * 0.35, 'the hollow is about 5 cm deep');

  let rimCrest = -Infinity;
  for (let i = 0; i < 48; i += 1) {
    const angle = (i / 48) * Math.PI * 2;
    for (const f of [0.96, 1.0, 1.04]) {
      const x = CONFIG.matX + Math.cos(angle) * MAT_R * f;
      const z = CONFIG.matZ[0] + Math.sin(angle) * MAT_R * f;
      rimCrest = Math.max(rimCrest, surfaceHeight(x, z) - terrainHeight(x, z));
    }
  }
  greater(rimCrest, MAT.rim * 0.5, 'the mat has a raised rim above the surrounding ground');
  greater(MAT.rim, 0.01, 'the rim is a physical height, not a painted ring');

  // A ball rolled straight across a dish must rise over the rim: its height above
  // the plain exceeds what flat ground would give.
  const body = createBody(CONFIG.matX - 0.02, seat(CONFIG.matX - 0.02, CONFIG.matZ[0] - 2.6), CONFIG.matZ[0] - 2.6, R, CONFIG);
  body.vel.set(0, 0, 7);
  setRollingSpin(body);
  let climbed = 0;
  let enteredHollow = false;
  for (let i = 0; i < 900 && !body.resting; i += 1) {
    stepBallMotion(body, 1 / 240, CONFIG, surfaceHeight);
    const relief = body.pos.y - R - terrainHeight(body.pos.x, body.pos.z);
    climbed = Math.max(climbed, relief);
    if (matHollowIndex(body.pos.x, body.pos.z) === 0 && body.pos.y < terrainHeight(CONFIG.matX, CONFIG.matZ[0]) + R) {
      enteredHollow = true;
    }
  }
  greater(climbed, MAT.rim * 0.35, 'a rolling goolah climbs the mat rim');
  ok(enteredHollow, 'a goolah rolling across a dish drops into the hollow');

  // A grazing shot along the rim is deflected instead of passing straight on.
  const gx = CONFIG.matX + MAT_R * 0.99;
  const gz = CONFIG.matZ[0];
  const start = { x: gx, y: seat(gx, gz - 2.8), z: gz - 2.8 };
  const shot = simulateShot(start, { x: 0, y: 0, z: 1 }, 0.62, CONFIG, {
    step: 1 / 240,
    maxTime: 16,
    surface: surfaceHeight,
  });
  const lateralDrift = Math.abs(shot.rest.x - gx);
  greater(lateralDrift, 0.02, 'the rim deflects a goolah that strikes it off-centre');
  less(lateralDrift, 1.5, 'the deflection is a nudge, not a teleport');

  // The rim costs speed: crossing the dish is slower than the same shot on plain
  // ground would be. Compare against the identical throw with the dishes removed.
  const plain = (x, z) => terrainHeight(x, z);
  const overMat = simulateShot(start, { x: 0, y: 0, z: 1 }, 0.62, CONFIG, {
    step: 1 / 240,
    maxTime: 16,
    surface: surfaceHeight,
  });
  const overPlain = simulateShot(start, { x: 0, y: 0, z: 1 }, 0.62, CONFIG, {
    step: 1 / 240,
    maxTime: 16,
    surface: plain,
  });
  greater(
    Math.abs(overMat.distance - overPlain.distance),
    0.02,
    'the dish changes the outcome physically (it is not decoration)'
  );
}

/* =========================================================================
   7. A goolah can be put into the hollow, and it rests in it
   ========================================================================= */

{
  const targetX = CONFIG.matX;
  const targetZ = CONFIG.matZ[1];
  const start = { x: targetX, y: seat(targetX, startZ), z: startZ };
  const dir = new THREE.Vector3(targetX - start.x, 0, targetZ - start.z).normalize();

  // Find a power that actually drops it in — the field is uneven, so the solver
  // searches rather than assuming.
  let landed = null;
  // The whole legal power range: a gentle throw is the way a goolah is dropped
  // into a near dish, so the sweep must reach the soft end of the range.
  for (let power = 0; power <= 1; power += 0.005) {
    const shot = simulateShot(start, dir, power, CONFIG, {
      step: 1 / 240,
      maxTime: 18,
      surface: surfaceHeight,
    });
    if (matHollowIndex(shot.rest.x, shot.rest.z) === 1) {
      landed = shot;
      break;
    }
  }

  ok(landed, 'a goolah can be rolled into an open mat');
  if (landed) {
    const hollowFloor = surfaceHeight(landed.rest.x, landed.rest.z);
    near(landed.rest.y, hollowFloor + R, 0.02, 'the goolah rests on the hollow floor');
    less(
      landed.rest.y,
      terrainHeight(CONFIG.matX, targetZ) + R,
      'a captured goolah sits below the level of the surrounding ground'
    );
    ok(landed.resting, 'a goolah that has dropped in comes to rest');

    // It cannot be resting on the rim: it must be inside the dish, below the crest.
    const crest = surfaceHeight(CONFIG.matX + MAT_R, targetZ);
    less(landed.rest.y, crest + R, 'the captured goolah is below the rim crest');
  }
}

/* =========================================================================
   8. The ground is real terrain: uneven enough to matter, fair enough to play
   ========================================================================= */

{
  const heights = [];
  for (let x = -6; x <= 6; x += 0.5) {
    for (let z = CONFIG.matZ[0] - 3; z <= CONFIG.matZ[3] + 3; z += 0.5) {
      heights.push(terrainHeight(x, z));
    }
  }
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
  const sd = Math.sqrt(heights.reduce((a, b) => a + (b - mean) ** 2, 0) / heights.length);

  greater(max - min, 0.01, 'the playing ground is not a flat plane');
  less(max - min, 0.5, 'terrain variation stays playable');
  greater(sd, 0.002, 'the ground has continuous relief, not a single bump');
  less(sd, 0.15, 'relief is subtle enough to keep the game fair');

  // The relief is smooth: neighbouring samples never jump.
  let maxStep = 0;
  for (let x = -6; x < 6; x += 0.25) {
    maxStep = Math.max(maxStep, Math.abs(terrainHeight(x, 0) - terrainHeight(x + 0.25, 0)));
  }
  less(maxStep, 0.12, 'the surface is continuous (no cliffs in the playable area)');

  // Terrain irregularities nudge a rolling goolah: a dead-straight shot drifts,
  // but only slightly.
  const shot = simulateShot(
    { x: startX, y: seat(startX, startZ), z: startZ },
    { x: 0, y: 0, z: 1 },
    0.7,
    CONFIG,
    { step: 1 / 240, maxTime: 18, surface: surfaceHeight }
  );
  const drift = Math.abs(shot.rest.x - startX);
  greater(drift, 0.001, 'surface irregularities influence a rolling goolah');
  less(drift, 0.6, 'the influence is subtle, not random steering');

  // Same shot twice: the terrain is deterministic, so the result is repeatable.
  const again = simulateShot(
    { x: startX, y: seat(startX, startZ), z: startZ },
    { x: 0, y: 0, z: 1 },
    0.7,
    CONFIG,
    { step: 1 / 240, maxTime: 18, surface: surfaceHeight }
  );
  near(again.rest.distanceTo(shot.rest), 0, 1e-9, 'the field is deterministic');
}

/* ========================================================================= */

if (failures.length) {
  console.error(`\nphysics: ${failures.length} failed of ${checks} checks\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log(`physics: ${checks} checks passed`);
