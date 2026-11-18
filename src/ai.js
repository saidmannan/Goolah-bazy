// AI opponent for Goolah Bazy (Phase 3).
//
// The AI is a player, not an authority. It produces exactly the inputs a human
// produces — an aim angle inside CONFIG.maxAimAngle, a power in 0..1, and the two
// rule choices a human is offered (Mat-per, final-mat target) — and then goes
// through the same throwBall() -> physics -> rules.resolveThrow() path. It never
// writes scores, mats or turn state, so an illegal move is not representable:
// every opponent comes from RulesEngine.availableTargets() and every mat from the
// engine's open mats.
//
// Aiming reuses the shipped physics instead of a second model: the power needed
// for a distance comes from a range table built with simulateShot(), and each
// candidate throw is rolled out with that same integrator before it is chosen.
//
// Difficulty is aim precision plus how far ahead the player looks. All three
// levels use the same rules, physics and legal actions; only the aim/power error
// and the number of candidates considered differ. The hit rates quoted in the
// docs are measured by scripts/test-ai.mjs from real simulated play, not stored
// here as a claim.
import { simulateShot } from './physics.js';
import { CONFIG } from './config.js';
import { ballKey } from './rules.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const DIFFICULTIES = {
  beginner: {
    id: 'beginner',
    label: 'Beginner',
    aimSigma: 0.14, // radians of aim error
    powerSigma: 0.18, // power error, 0..1 scale
    picks: 3, // chooses among its three best ideas
    rollout: false, // no look-ahead: aims at what looks good
    refine: 0,
  },
  intermediate: {
    id: 'intermediate',
    label: 'Intermediate',
    aimSigma: 0.055,
    powerSigma: 0.075,
    picks: 2,
    rollout: true,
    refine: 3,
  },
  professional: {
    id: 'professional',
    label: 'Professional',
    aimSigma: 0.01,
    powerSigma: 0.015,
    picks: 1,
    rollout: true,
    refine: 5,
  },
};

export const DIFFICULTY_ORDER = ['beginner', 'intermediate', 'professional'];
export const DEFAULT_DIFFICULTY = 'intermediate';

/** Default line-up: the human as Zananda player 1, AI in the other three seats. */
export const DEFAULT_SEATS = { '0:0': 'ai', '0:1': 'ai', '1:0': 'human', '1:1': 'ai' };

export const seatKey = (teamIndex, playerIndex) => `${teamIndex}:${playerIndex}`;

export const normalizeSeats = (seats = {}) => {
  const out = { ...DEFAULT_SEATS };
  for (const key of Object.keys(out)) {
    if (seats[key] === 'human' || seats[key] === 'ai') out[key] = seats[key];
  }
  return out;
};

/* ---------------------------------------------------------------- random --- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGauss(rng) {
  let spare = null;
  return function gauss() {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

/* --------------------------------------------------------------- physics --- */

/**
 * Ground height with the four 5 cm mat dishes, identical to the field the game
 * renders (game.surfaceHeightAt). Kept here so the AI can predict a shot without
 * touching the scene graph.
 */
export function matSurface(cfg = CONFIG) {
  return (x, z) => {
    let height = 0;
    for (let i = 0; i < cfg.matZ.length; i += 1) {
      const dx = x - cfg.matX;
      const dz = z - cfg.matZ[i];
      const distance = Math.hypot(dx, dz);
      if (distance >= cfg.matRadius) continue;
      const t = 1 - distance / cfg.matRadius;
      const dip = -cfg.matDepth * (t * t * (3 - 2 * t));
      if (dip < height) height = dip;
    }
    return height;
  };
}

const rangeCache = new Map();

/**
 * How far a throw carries, measured with the game's own integrator. Sampled once
 * per configuration and reused, so aiming costs a table lookup instead of a
 * fresh simulation per shot.
 */
export function rangeTable(cfg = CONFIG) {
  const key = [
    cfg.throwLineZ,
    cfg.ballRadius,
    cfg.minSpeed,
    cfg.maxSpeed,
    cfg.minLift,
    cfg.maxLift,
    cfg.rollFriction,
    cfg.gravity,
  ].join('|');
  const cached = rangeCache.get(key);
  if (cached) return cached;

  const surface = matSurface(cfg);
  const rows = [];
  for (let i = 0; i <= 20; i += 1) {
    const power = i / 20;
    const shot = simulateShot(
      { x: 0, y: cfg.ballRadius, z: cfg.throwLineZ },
      { x: 0, y: 0, z: 1 },
      power,
      cfg,
      { step: 1 / 60, maxTime: 14, surface }
    );
    rows.push({ power, distance: shot.along });
  }
  rangeCache.set(key, rows);
  return rows;
}

/** Power that makes a goolah travel `distance` metres and stop there. */
export function powerForDistance(distance, cfg = CONFIG) {
  const rows = rangeTable(cfg);
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!(distance > first.distance)) return first.power;
  if (distance >= last.distance) return last.power;
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1];
    const b = rows[i];
    if (distance <= b.distance) {
      const span = Math.max(1e-6, b.distance - a.distance);
      return a.power + ((distance - a.distance) / span) * (b.power - a.power);
    }
  }
  return last.power;
}

function matAt(x, z, cfg) {
  for (let i = 0; i < cfg.matZ.length; i += 1) {
    if (Math.hypot(x - cfg.matX, z - cfg.matZ[i]) <= cfg.matRadius * 0.75) return i;
  }
  return -1;
}

/** Closest point on the straight ground path start -> rest, as a fraction t. */
function closestOnPath(start, rest, point) {
  const dx = rest.x - start.x;
  const dz = rest.z - start.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-6) return { x: start.x, z: start.z, t: 0 };
  let t = ((point.x - start.x) * dx + (point.z - start.z) * dz) / len2;
  t = clamp(t, 0, 1);
  return { x: start.x + dx * t, z: start.z + dz * t, t };
}

/* ------------------------------------------------------------------- ai --- */

export function createAI({ difficulty = DEFAULT_DIFFICULTY, seed = 1 } = {}) {
  const profile = DIFFICULTIES[difficulty] || DIFFICULTIES[DEFAULT_DIFFICULTY];
  const rng = mulberry32(seed);
  const gauss = makeGauss(rng);
  const surface = matSurface(CONFIG);

  /* ------------------------------------------------------------ aiming -- */

  /** Angle and power that send this goolah at a point. */
  function solveAim(shooter, candidate, cfg) {
    const dx = candidate.x - shooter.x;
    const dz = candidate.z - shooter.z;
    const dist = Math.hypot(dx, dz);
    const raw = Math.atan2(dx, dz);
    const angle = clamp(raw, -cfg.maxAimAngle, cfg.maxAimAngle);
    // How far off the straight line the target ends up once the angle is capped.
    const lateral = Math.abs(Math.sin(raw - angle)) * dist;
    const along = dx * Math.sin(angle) + dz * Math.cos(angle);
    // A Tir needs to still be rolling on contact; a Mat needs to stop in it.
    const overshoot = candidate.type === 'mat' ? 0 : 0.75;
    const power = clamp(powerForDistance(along + overshoot, cfg), 0.08, 1);
    return { angle, power, along, lateral, reachable: lateral <= 0.45 };
  }

  /** Roll a candidate throw out with the game's own integrator. */
  function predict(shooter, angle, power, balls, cfg) {
    const dir = { x: Math.sin(angle), y: 0, z: Math.cos(angle) };
    const shot = simulateShot(
      { x: shooter.x, y: cfg.ballRadius, z: shooter.z },
      dir,
      power,
      cfg,
      { step: 1 / 60, maxTime: 14, surface }
    );
    const rest = shot.rest;
    const total = Math.hypot(rest.x - shooter.x, rest.z - shooter.z);

    const contacts = [];
    let teammateHit = false;
    for (const ball of balls) {
      if (ball.teamIndex === shooter.teamIndex && ball.playerIndex === shooter.playerIndex) {
        continue;
      }
      const point = closestOnPath(shooter, rest, ball);
      const lateral = Math.hypot(ball.x - point.x, ball.z - point.z);
      if (lateral > cfg.ballRadius * 2) continue;
      const remaining = total - point.t * total;
      // Rolling deceleration is constant, so the speed left at contact is known.
      const speed = Math.min(
        cfg.maxSpeed,
        Math.sqrt(2 * cfg.rollFriction * Math.max(0, remaining))
      );
      contacts.push({
        key: ballKey(ball.teamIndex, ball.playerIndex),
        teamIndex: ball.teamIndex,
        lateral,
        speed,
        remaining,
      });
      if (ball.teamIndex === shooter.teamIndex) teammateHit = true;
    }

    return {
      rest,
      total,
      contacts,
      selfMat: matAt(rest.x, rest.z, cfg),
      teammateHit,
      offField: Math.abs(rest.x) > 6.5 || rest.z > 12 || rest.z < -8.5,
    };
  }

  /** Nudge the power so a mat attempt actually settles in the hollow. */
  function refineMatPower(shooter, candidate, aim, cfg) {
    const steps = profile.refine;
    if (!steps) return aim;
    let best = { ...aim };
    let bestGap = Infinity;
    for (let i = 0; i < steps; i += 1) {
      const delta = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * 0.02 * Math.ceil(i / 2);
      const power = clamp(aim.power + delta, 0.08, 1);
      const shot = simulateShot(
        { x: shooter.x, y: cfg.ballRadius, z: shooter.z },
        { x: Math.sin(aim.angle), y: 0, z: Math.cos(aim.angle) },
        power,
        cfg,
        { step: 1 / 60, maxTime: 14, surface }
      );
      const gap = Math.hypot(shot.rest.x - candidate.x, shot.rest.z - candidate.z);
      if (gap < bestGap) {
        bestGap = gap;
        best = { ...aim, power };
      }
    }
    return best;
  }

  /* -------------------------------------------------------- candidates -- */

  function ballCandidate(target, balls) {
    const ball = balls.find(
      (b) => b.teamIndex === target.teamIndex && b.playerIndex === target.playerIndex
    );
    if (!ball) return null;
    return {
      type: 'tir',
      key: target.key,
      matPer: Boolean(target.matPer),
      x: ball.x,
      z: ball.z,
      target: { kind: 'ball', teamIndex: target.teamIndex, playerIndex: target.playerIndex },
    };
  }

  function candidatesFor(engine, balls, cfg, shooter) {
    const state = engine.state;
    const turn = state.turn;
    const opponents = engine.availableTargets();

    // Rule 6: after the final mat this player may hit one opponent only, so the
    // single chosen opponent is the whole candidate list.
    if (turn.finalOpportunity) {
      const chosen = pickFinalTarget(engine, balls, shooter);
      if (!chosen) return [];
      const match = opponents.find(
        (o) => o.teamIndex === chosen.teamIndex && o.playerIndex === chosen.playerIndex
      );
      const candidate = match ? ballCandidate(match, balls) : null;
      return candidate ? [candidate] : [];
    }

    const out = [];
    for (const target of opponents) {
      const candidate = ballCandidate(target, balls);
      if (candidate) out.push(candidate);
    }
    // Any open mat is a legal target; the mat's own number never matters (rule 4).
    for (const mat of state.mats) {
      if (mat.completed) continue;
      out.push({
        type: 'mat',
        key: `mat:${mat.index}`,
        matIndex: mat.index,
        matPer: false,
        x: cfg.matX,
        z: cfg.matZ[mat.index],
        target: { kind: 'mat', matIndex: mat.index },
      });
    }
    return out;
  }

  /* ------------------------------------------------------------- value -- */

  function valueOf(candidate, aim, prediction, engine) {
    const state = engine.state;
    const team = state.turn.teamIndex;
    let value = 0;

    if (candidate.type === 'tir') {
      // A Mat-per goolah is worth 3 or 7 points, a normal Tir 1 point plus a chance.
      value += candidate.matPer ? 5.5 : 2.4;
    } else {
      // First two mats of the round score nothing, further ones score a point,
      // and every capture earns another chance (rule 4).
      value += state.captured[team] >= 2 ? 3.0 : 1.5;
      value += 1.2;
    }

    if (!aim.reachable) value -= 4;

    if (prediction) {
      const contact = prediction.contacts.find((c) => c.key === candidate.key);
      if (candidate.type === 'tir') {
        if (contact) {
          value += 1.0;
          if (candidate.matPer && contact.speed > 3) value += 1.0;
        } else {
          value -= 2.5; // blocked, short, or aimed at where the goolah is not
        }
      } else if (prediction.selfMat === candidate.matIndex) {
        value += 2.0;
      } else {
        value -= 1.5;
      }
      if (prediction.teammateHit) value -= 1.5; // rule 7: no point, no chance
      if (prediction.offField) value -= 2.5; // would need Rakh
      if (prediction.selfMat >= 0 && candidate.type === 'tir') value += 1.5;
    }

    return value;
  }

  function weightedPick(pool) {
    if (pool.length === 1) return pool[0];
    const weights = pool.map((_, index) => Math.pow(0.55, index));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = rng() * total;
    for (let i = 0; i < pool.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  /* ------------------------------------------------------------ choices -- */

  /** Rule 6: which opponent the one final throw is aimed at. */
  function pickFinalTarget(engine, balls, shooter) {
    const opponents = engine.availableTargets();
    if (!opponents.length) return null;
    if (profile.id === 'beginner') {
      return opponents[Math.floor(rng() * opponents.length)];
    }
    const scored = opponents
      .map((target) => {
        const ball = balls.find(
          (b) => b.teamIndex === target.teamIndex && b.playerIndex === target.playerIndex
        );
        if (!ball) return null;
        const distance = Math.hypot(ball.x - shooter.x, ball.z - shooter.z);
        // A held Mat-per goolah is the 7-point prize; otherwise the closer
        // opponent is the safer final hit.
        return { target, value: (target.matPer ? 8 : 1) - distance * 0.05 };
      })
      .filter(Boolean)
      .sort((a, b) => b.value - a.value);
    return scored.length ? scored[0].target : opponents[0];
  }

  function chooseThrow(engine, balls, cfg = CONFIG) {
    if (!engine.canThrow()) return { pass: true };
    const turn = engine.state.turn;
    const shooter = balls.find(
      (b) => b.teamIndex === turn.teamIndex && b.playerIndex === turn.playerIndex
    );
    if (!shooter) return { pass: true };

    const candidates = candidatesFor(engine, balls, cfg, shooter);
    if (!candidates.length) {
      // Nothing legal to aim at: throw straight down the line so the turn can end.
      return {
        type: 'throw',
        angle: 0,
        power: 0.55,
        intended: { kind: 'straight', angle: 0, power: 0.55 },
        target: null,
      };
    }

    const scored = candidates.map((candidate) => {
      const aim = solveAim(shooter, candidate, cfg);
      const prediction = profile.rollout
        ? predict(shooter, aim.angle, aim.power, balls, cfg)
        : null;
      return {
        candidate,
        aim,
        prediction,
        value: valueOf(candidate, aim, prediction, engine),
      };
    });
    scored.sort((a, b) => b.value - a.value);

    const pool = scored.slice(0, Math.max(1, profile.picks));
    const pick = weightedPick(pool);
    const aim =
      pick.candidate.type === 'mat'
        ? refineMatPower(shooter, pick.candidate, pick.aim, cfg)
        : pick.aim;

    // Execution error: this is what separates the three levels.
    const angle = clamp(aim.angle + gauss() * profile.aimSigma, -cfg.maxAimAngle, cfg.maxAimAngle);
    const power = clamp(aim.power + gauss() * profile.powerSigma, 0.06, 1);

    return {
      type: 'throw',
      angle,
      power,
      intended: {
        kind: pick.candidate.type,
        key: pick.candidate.key,
        angle: aim.angle,
        power: aim.power,
        value: pick.value,
      },
      target: pick.candidate.target,
    };
  }

  /**
   * Rule 5: hold the goolah in the mat, or lift it out and throw now.
   * Throwing now is normally stronger — the chance is used immediately instead
   * of being banked while an opponent can strike the held goolah for 3 or 7.
   */
  function chooseMatPer(engine) {
    const turn = engine.state.turn;
    if (!turn || !turn.pendingMatPer) return { hold: false };
    const holdChance = { beginner: 0.5, intermediate: 0.25, professional: 0.08 }[profile.id] ?? 0.25;
    return { hold: rng() < holdChance };
  }

  function chooseFinalTarget(engine, balls) {
    const turn = engine.state.turn;
    const shooter = balls.find(
      (b) => b.teamIndex === turn.teamIndex && b.playerIndex === turn.playerIndex
    ) || { x: 0, z: CONFIG.throwLineZ, teamIndex: turn.teamIndex, playerIndex: turn.playerIndex };
    const target = pickFinalTarget(engine, balls, shooter);
    return target ? { teamIndex: target.teamIndex, playerIndex: target.playerIndex } : null;
  }

  return {
    difficulty: profile.id,
    label: profile.label,
    profile,
    chooseThrow,
    chooseMatPer,
    chooseFinalTarget,
    nextRandom: rng,
  };
}
