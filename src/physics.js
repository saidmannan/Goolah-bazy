// Shared ball physics for the goolahs.
//
// A goolah is a heavy cast-metal ball (4.5 kg, 56 cm). It is simulated as a
// rigid sphere with:
//
//   * linear motion under gravity, air drag and rolling resistance;
//   * an angular velocity that is coupled to the ground, so the ball *rolls*
//     and its visible rotation comes from the simulation, never from an
//     animation curve;
//   * contact impulses with tangential friction at the contact patch;
//   * swept (continuous) collision detection, so a fast ball can never tunnel
//     through another one, and every reported contact is a real physical
//     contact.
//
// One integrator is used by every caller so they cannot drift apart:
//   * the live simulation in game.js (stepBalls)
//   * the aim preview and the AI (simulateShot)
//   * the headless physics tests
import * as THREE from 'three';

const _n = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _dp = new THREE.Vector3();
const _da = new THREE.Vector3();
const _db = new THREE.Vector3();
const _r = new THREE.Vector3();
const _imp = new THREE.Vector3();
const _spin = new THREE.Vector3();
const _gn = new THREE.Vector3();
const _dq = new THREE.Quaternion();

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * A simulated goolah. `radius` and the optional config decide mass and inertia
 * (a solid sphere: I = 2/5 m r²).
 */
export function createBody(x, y, z, radius, cfg = null) {
  const mass = cfg?.ballMass ?? 4.5;
  const inertia = 0.4 * mass * radius * radius;
  return {
    pos: new THREE.Vector3(x, y, z),
    prevPos: new THREE.Vector3(x, y, z),
    vel: new THREE.Vector3(),
    angVel: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    radius,
    mass,
    inertia,
    invMass: 1 / mass,
    invInertia: 1 / inertia,
    // Last surface normal touched, kept so contacts have a sane default.
    normal: new THREE.Vector3(0, 1, 0),
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

/** Give a body the spin of a ball already rolling at its current velocity. */
export function setRollingSpin(body) {
  const v = body.vel;
  return body.angVel.set(v.z, 0, -v.x).multiplyScalar(1 / body.radius);
}

/** Surface normal from the ground height function (central differences). */
function groundNormal(surface, x, z, out) {
  if (!surface) return out.set(0, 1, 0);
  const e = 0.05;
  const hL = surface(x - e, z);
  const hR = surface(x + e, z);
  const hD = surface(x, z - e);
  const hU = surface(x, z + e);
  return out.set(hL - hR, 2 * e, hD - hU).normalize();
}

/**
 * Advance one goolah by h seconds.
 *
 * `surface(x, z)` returns the ground height at a point, so the shallow mat
 * dishes — floor, inner wall and raised rim — are part of the simulation, not
 * just artwork. Returns { impact, grounded, slip }.
 */
export function stepBallMotion(body, h, cfg, surface) {
  const R = body.radius;
  const p = body.pos;
  const v = body.vel;
  const w = body.angVel;
  let impact = 0;
  let slip = 0;

  body.prevPos.copy(p);

  // Gravity, then a little air drag.
  v.y -= cfg.gravity * h;
  const drag = Math.max(0, 1 - cfg.airDrag * h);
  v.x *= drag;
  v.z *= drag;

  p.addScaledVector(v, h);

  const groundY = surface ? surface(p.x, p.z) : 0;
  const floor = groundY + R;
  const grounded = p.y <= floor + 1e-4;

  if (grounded) {
    p.y = floor;
    const n = groundNormal(surface, p.x, p.z, _gn);
    const vn = v.dot(n);

    if (vn < 0) {
      impact = -vn;
      if (impact > cfg.bounceThreshold) {
        // A genuine impact: landing after a throw, or a hop off the mat rim.
        // Packed dirt absorbs most of the normal speed; the rest rebounds.
        v.addScaledVector(n, -(1 + cfg.groundRestitution) * vn);
        // ...and the strike scrubs some forward speed as well.
        _tan.copy(v).addScaledVector(n, -v.dot(n)).multiplyScalar(clamp01(cfg.impactFriction) * 0.45);
        v.sub(_tan);
      } else {
        // Contact, not an impact: drop the normal component only. The ball keeps
        // rolling instead of hopping.
        v.addScaledVector(n, -vn);
      }
    }

    // Rolling resistance: constant deceleration along the surface, so a goolah
    // always bleeds speed and comes to a stop.
    const speed = horizontalSpeed(v);
    if (speed > 1e-6) {
      const k = Math.max(0, speed - cfg.rollFriction * h) / speed;
      v.x *= k;
      v.z *= k;
    }

    // Rolling constraint: a sphere rolling without slipping turns at
    // w = (n × v) / R. Blending towards it models the short slide a struck ball
    // makes before its spin catches up with its travel.
    _spin.crossVectors(n, v).multiplyScalar(1 / R);
    slip = _rel.subVectors(w, _spin).length();
    w.lerp(_spin, Math.min(1, (cfg.spinGrip ?? 18) * h));

    if (horizontalSpeed(v) < cfg.sleepSpeed && Math.abs(v.y) < 0.08) {
      v.set(0, 0, 0);
      w.multiplyScalar(0.6);
      body.resting = true;
    } else {
      body.resting = false;
    }
  } else {
    body.resting = false;
    // Free flight: the ball keeps the spin it left the ground with.
    w.multiplyScalar(Math.max(0, 1 - 0.4 * h));
  }

  // Orientation follows the angular velocity: q += 0.5 h (w,0) q.
  _dq.set(w.x * 0.5 * h, w.y * 0.5 * h, w.z * 0.5 * h, 0).multiply(body.quat);
  body.quat.set(
    body.quat.x + _dq.x,
    body.quat.y + _dq.y,
    body.quat.z + _dq.z,
    body.quat.w + _dq.w,
  ).normalize();

  return { impact, grounded, slip };
}

/**
 * Swept contact test between two goolahs over the step they just took.
 *
 * Finds the time of impact from the relative displacement, rewinds both bodies
 * to it, separates them along the contact normal and applies a normal impulse
 * plus a tangential friction impulse. `contact` is only true when the pair was
 * genuinely striking: two balls merely near each other, or resting against each
 * other, can never score.
 */
export function sweptContact(a, b, cfg) {
  const R = a.radius + b.radius;

  _da.subVectors(a.pos, a.prevPos);
  _db.subVectors(b.pos, b.prevPos);
  _p0.subVectors(b.prevPos, a.prevPos);
  _dp.subVectors(_db, _da);

  let t = -1;
  const c0 = _p0.lengthSq() - R * R;
  if (c0 <= 0) {
    t = 0; // already touching when the step began
  } else {
    const aa = _dp.lengthSq();
    if (aa > 1e-12) {
      const bb = 2 * _p0.dot(_dp);
      const disc = bb * bb - 4 * aa * c0;
      if (disc >= 0) {
        const root = (-bb - Math.sqrt(disc)) / (2 * aa);
        if (root >= 0 && root <= 1) t = root;
      }
    }
  }
  if (t < 0) return null;

  // Rewind both goolahs to the moment of contact.
  if (t > 0) {
    a.pos.copy(a.prevPos).addScaledVector(_da, t);
    b.pos.copy(b.prevPos).addScaledVector(_db, t);
  }

  _n.subVectors(b.pos, a.pos);
  const dist = _n.length();
  if (dist > 1e-6) _n.multiplyScalar(1 / dist);
  else _n.set(1, 0, 0);

  // Separate the pair so they can never end up inside one another.
  const penetration = R - dist;
  if (penetration > 0) {
    const inv = a.invMass + b.invMass;
    const k = cfg.contactCorrection ?? 1;
    a.pos.addScaledVector(_n, -penetration * (a.invMass / inv) * k);
    b.pos.addScaledVector(_n, penetration * (b.invMass / inv) * k);
  }

  _rel.subVectors(b.vel, a.vel);
  const closing = _rel.dot(_n); // negative while they approach

  const result = {
    a,
    b,
    normal: _n.clone(),
    point: a.pos.clone().addScaledVector(_n, a.radius),
    time: t,
    impactSpeed: Math.max(0, -closing),
    contact: false,
  };

  if (closing >= -(cfg.minContactSpeed ?? 0.25)) {
    // Touching but not striking: no impulse, no score.
    return result;
  }

  const jn = (-(1 + cfg.ballRestitution) * closing) / (a.invMass + b.invMass);
  a.vel.addScaledVector(_n, -jn * a.invMass);
  b.vel.addScaledVector(_n, jn * b.invMass);

  // Tangential friction at the contact patch. This is what makes the struck
  // goolah spin and roll away instead of sliding, and what makes the striker
  // deflect.
  _tan.copy(_rel).addScaledVector(_n, -closing);
  const tanSpeed = _tan.length();
  if (tanSpeed > 1e-5) {
    _tan.multiplyScalar(1 / tanSpeed);
    const jt = Math.min((cfg.ballFriction ?? 0.3) * jn, tanSpeed / (a.invMass + b.invMass));
    a.vel.addScaledVector(_tan, jt * a.invMass);
    b.vel.addScaledVector(_tan, -jt * b.invMass);
    // Δω = I⁻¹ (r × J), with the contact at ±R along the normal.
    _imp.copy(_tan).multiplyScalar(jt);
    _r.copy(_n).multiplyScalar(a.radius);
    a.angVel.addScaledVector(_tmp.crossVectors(_r, _imp), a.invInertia);
    _imp.copy(_tan).multiplyScalar(-jt);
    _r.copy(_n).multiplyScalar(-b.radius);
    b.angVel.addScaledVector(_tmp.crossVectors(_r, _imp), b.invInertia);
  }

  a.resting = false;
  b.resting = false;
  result.contact = true;
  return result;
}

/**
 * Resolve one contact between two goolahs at their current positions.
 * Kept as a single-shot helper for callers that are not stepping a world.
 * Returns { hit, impactSpeed, normal, point }.
 */
export function resolveBallCollision(a, b, cfg) {
  a.prevPos.copy(a.pos);
  b.prevPos.copy(b.pos);
  const res = sweptContact(a, b, cfg);
  if (!res) return { hit: false, impactSpeed: 0 };
  return {
    hit: res.contact,
    impactSpeed: res.impactSpeed,
    normal: res.normal,
    point: res.point,
  };
}

/**
 * Advance every goolah of a world by dt.
 *
 * The step is split so no ball moves further than `maxSubstepTravel` in one
 * substep: at 17 m/s a 1/60 s frame becomes several substeps and a collision
 * cannot be skipped. Contacts are applied as they happen, but reported once per
 * pair per call (the strongest impact), so a single strike can never produce
 * duplicate scoring events.
 */
export function stepBalls(balls, dt, cfg, surface, onContact, onImpact) {
  let maxSpeed = 0;
  for (const b of balls) {
    const s = b.vel.length();
    if (s > maxSpeed) maxSpeed = s;
  }
  const travel = Math.max(1e-4, cfg.maxSubstepTravel ?? 0.09);
  let steps = Math.ceil((maxSpeed * dt) / travel);
  steps = Math.min(Math.max(steps, 1), cfg.maxSubsteps ?? 60);
  const h = dt / steps;
  const best = new Map();

  for (let s = 0; s < steps; s += 1) {
    for (const b of balls) {
      if (b.resting) {
        b.prevPos.copy(b.pos);
        continue;
      }
      const res = stepBallMotion(b, h, cfg, surface);
      if (onImpact && res.impact > cfg.bounceThreshold) onImpact(b, res.impact);
    }
    for (let i = 0; i < balls.length; i += 1) {
      for (let j = i + 1; j < balls.length; j += 1) {
        const res = sweptContact(balls[i], balls[j], cfg);
        if (!res || !res.contact) continue;
        const key = i * 1000 + j;
        const prev = best.get(key);
        if (!prev || res.impactSpeed > prev.impactSpeed) best.set(key, res);
      }
    }
  }

  const contacts = [...best.values()];
  if (onContact) for (const c of contacts) onContact(c);
  return contacts;
}

/**
 * Throw a goolah from `start` along `dir` at `power` and integrate until it
 * comes to rest. Used for the aim preview, the AI and the headless tests.
 */
export function simulateShot(start, dir, power, cfg, options = {}) {
  const h = options.step ?? 1 / 120;
  const maxTime = options.maxTime ?? 10;
  const sampleEvery = options.sampleEvery ?? 0;
  const maxSamples = options.maxSamples ?? 0;
  const surface = options.surface;

  const body = createBody(start.x, start.y, start.z, cfg.ballRadius, cfg);
  body.vel.copy(throwVelocity(dir, power, cfg));
  setRollingSpin(body);

  const samples = [];
  let elapsed = 0;
  let nextSample = 0;
  let airborneTime = 0;
  let bounces = 0;
  let rolled = 0;

  while (elapsed < maxTime) {
    const groundY = surface ? surface(body.pos.x, body.pos.z) : 0;
    const wasAirborne = body.pos.y > groundY + cfg.ballRadius + 1e-3;
    const res = stepBallMotion(body, h, cfg, surface);
    if (res.impact > cfg.bounceThreshold) bounces += 1;
    // |ω| h is the angle rolled this step, so this is the total rotation.
    rolled += body.angVel.length() * h;
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
    bounces,
    // Total angle turned during the shot, in radians and revolutions.
    rolled,
    rotations: rolled / (2 * Math.PI),
  };
}
