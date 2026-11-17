// Shared ball physics for the goolahs.
//
// One integrator is used by three callers so they can never drift apart:
//   * the live simulation in game.js
//   * the aim preview (dotted flight path + predicted resting spot)
//   * scripts/test-phase1.mjs, which runs headless in Node
//
// The goolahs are heavy metal balls on packed dirt: a low dead bounce, a lot of
// retained speed off the ground, constant rolling resistance, and near-elastic
// steel-on-steel collisions.
import * as THREE from 'three';

const _n = new THREE.Vector3();
const _rel = new THREE.Vector3();

export function createBody(x, y, z, radius) {
  return {
    pos: new THREE.Vector3(x, y, z),
    vel: new THREE.Vector3(),
    radius,
    resting: false,
  };
}

export function horizontalSpeed(vel) {
  return Math.hypot(vel.x, vel.z);
}

/** Power + aim direction -> launch velocity. Shared by the game, preview and test. */
export function throwVelocity(dir, power, cfg, out = new THREE.Vector3()) {
  const p = Math.min(1, Math.max(0, power));
  const speed = cfg.minSpeed + p * (cfg.maxSpeed - cfg.minSpeed);
  const lift = cfg.minLift + p * (cfg.maxLift - cfg.minLift);
  return out.set(dir.x * speed, lift, dir.z * speed);
}

/**
 * Advance one ball by h seconds.
 * Returns { impact, grounded }: impact is the vertical speed absorbed by the
 * ground this step (used for dust and sound), 0 when nothing touched down.
 */
export function stepBallMotion(body, h, cfg) {
  const R = body.radius;
  const p = body.pos;
  const v = body.vel;
  let impact = 0;

  v.y -= cfg.gravity * h;
  const drag = Math.max(0, 1 - cfg.airDrag * h);
  v.x *= drag;
  v.z *= drag;

  p.addScaledVector(v, h);

  const grounded = p.y <= R;
  if (grounded) {
    p.y = R;

    if (v.y < 0) {
      impact = -v.y;
      // Metal on dirt: barely rebounds, but keeps its forward speed.
      v.y = impact > cfg.bounceThreshold ? impact * cfg.groundRestitution : 0;
      v.x *= cfg.bounceFriction;
      v.z *= cfg.bounceFriction;
    }

    // Rolling resistance: constant deceleration while it is on the ground.
    const speed = horizontalSpeed(v);
    if (speed > 1e-5) {
      const k = Math.max(0, speed - cfg.rollFriction * h) / speed;
      v.x *= k;
      v.z *= k;
    }

    if (horizontalSpeed(v) < cfg.sleepSpeed && Math.abs(v.y) < 0.25) {
      v.set(0, 0, 0);
      body.resting = true;
    }
  } else {
    body.resting = false;
  }

  return { impact, grounded };
}

/**
 * Resolve a collision between two equal-mass goolahs.
 * Returns { hit, impactSpeed }: impactSpeed is the closing speed before the
 * impulse, 0 when they were not actually touching.
 */
export function resolveBallCollision(a, b, cfg) {
  _n.subVectors(b.pos, a.pos);
  const dist = _n.length();
  const minDist = a.radius + b.radius;
  if (dist >= minDist) return { hit: false, impactSpeed: 0 };

  if (dist < 1e-6) {
    _n.set(1, 0, 0);
  } else {
    _n.multiplyScalar(1 / dist);
  }

  // Push them apart so they never overlap, then exchange momentum.
  const overlap = minDist - Math.max(dist, 1e-6);
  a.pos.addScaledVector(_n, -overlap * 0.5);
  b.pos.addScaledVector(_n, overlap * 0.5);
  a.resting = false;
  b.resting = false;

  _rel.subVectors(b.vel, a.vel);
  const closing = _rel.dot(_n);
  if (closing >= 0) return { hit: true, impactSpeed: 0 };

  const impulse = -(1 + cfg.ballRestitution) * closing * 0.5;
  a.vel.addScaledVector(_n, -impulse);
  b.vel.addScaledVector(_n, impulse);

  return { hit: true, impactSpeed: Math.abs(closing) };
}

/**
 * Throw a goolah from `start` along `dir` at `power` and integrate until it
 * comes to rest. Used for the aim preview and for the headless physics test.
 */
export function simulateShot(start, dir, power, cfg, options = {}) {
  const h = options.step ?? 1 / 120;
  const maxTime = options.maxTime ?? 10;
  const sampleEvery = options.sampleEvery ?? 0;
  const maxSamples = options.maxSamples ?? 0;

  const body = createBody(start.x, start.y, start.z, cfg.ballRadius);
  body.vel.copy(throwVelocity(dir, power, cfg));

  const samples = [];
  let elapsed = 0;
  let nextSample = 0;
  let airborneTime = 0;

  while (elapsed < maxTime) {
    const wasAirborne = body.pos.y > cfg.ballRadius + 1e-4;
    stepBallMotion(body, h, cfg);
    elapsed += h;
    if (wasAirborne) airborneTime = elapsed;

    if (maxSamples && samples.length < maxSamples && elapsed >= nextSample) {
      samples.push(body.pos.clone());
      nextSample += sampleEvery || h;
    }

    if (body.resting) break;
  }

  const dx = body.pos.x - start.x;
  const dz = body.pos.z - start.z;

  return {
    rest: body.pos.clone(),
    // Horizontal distance travelled, and how far along the aim direction.
    distance: Math.hypot(dx, dz),
    along: dir.x * dx + dir.z * dz,
    airborneTime,
    time: elapsed,
    samples,
    velocity: body.vel.clone(),
    resting: body.resting,
  };
}
