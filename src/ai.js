// AI opponent for Goolah Bazy (Phase 3).
//
// The AI is a player, not an authority. It produces exactly the inputs a human
// produces — a horizontal aim angle, a power in 0..1, and the two
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
import { CONFIG, isPlayablePoint } from './config.js';
import { ballKey } from './rules.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Normalise an angle to (-PI, PI]. Full-direction aiming needs this: clamping
 * a shot back into a forward cone is what made the AI miss its intended target. */
const wrapAngle = (a) => {
  const turn = Math.PI * 2;
  return (((a + Math.PI) % turn) + turn) % turn - Math.PI;
};

export const DIFFICULTIES = {
  beginner: {
    id: 'beginner',
    label: 'Beginner',
    aimSigma: 0.13, // radians of aim error
    powerSigma: 0.10, // power error, 0..1 scale
    picks: 3, // chooses among its three best ideas
    rollout: false, // no look-ahead: aims at what looks good
    refine: 0,
    refuseFutile: false, // attempts a mat even when it can see it will miss
  },
  intermediate: {
    id: 'intermediate',
    label: 'Intermediate',
    aimSigma: 0.05,
    powerSigma: 0.035,
    picks: 2,
    rollout: true,
    refine: 4,
    refuseFutile: true,
  },
  professional: {
    id: 'professional',
    label: 'Professional',
    aimSigma: 0.009,
    powerSigma: 0.007,
    picks: 1,
    rollout: true,
    refine: 6,
    refuseFutile: true,
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
 * The surface the game actually simulates on. terrain.js owns the ground shape
 * (natural relief plus the four dish profiles), so the AI predicts a shot on the
 * very same surface the ball will roll over.
 */
export function matSurface() {
  return surfaceHeight;
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
  for (let i = 0; i <= 40; i += 1) {
    const power = i / 40;
    const shot = simulateShot(
      { x: 0, y: cfg.ballRadius, z: cfg.throwLineZ },
      { x: 0, y: 0, z: 1 },
      power,
      cfg,
      { step: 1 / 120, maxTime: 14, surface }
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

/** Distance a throw carries at this power, interpolated from the range table. */
export function distanceForPower(power, cfg = CONFIG) {
  const rows = rangeTable(cfg);
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (power <= first.power) return first.distance;
  if (power >= last.power) return last.distance;
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1];
    const b = rows[i];
    if (power <= b.power) {
      const span = Math.max(1e-6, b.power - a.power);
      return a.distance + ((power - a.power) / span) * (b.distance - a.distance);
    }
  }
  return last.distance;
}

/**
 * Metres of roll gained per unit of power near this power. A mat needs the ball
 * to stop inside a 0.63 m dish, so this slope is what decides whether a given
 * player can realistically sink one: the higher the slope, the tighter the
 * power window and the more an imprecise player should avoid mat attempts.
 */
export function distanceSlope(power, cfg = CONFIG) {
  const eps = 0.05;
  const lo = Math.max(0, power - eps);
  const hi = Math.min(1, power + eps);
  const span = Math.max(1e-6, hi - lo);
  return Math.max(0.5, (distanceForPower(hi, cfg) - distanceForPower(lo, cfg)) / span);
}

function matAt(x, z, cfg) {
  for (let i = 0; i < cfg.matZ.length; i += 1) {
    if (Math.hypot(x - cfg.matX, z - cfg.matZ[i]) <= cfg.matRadius * 0.75) return i;
  }
  return -1;
}

/**
 * Is another goolah standing on the straight line from shooter to (x, z)?
 *
 * The goolahs collide, so a ball on the line deflects the shot: a mat behind
 * one is not makeable, and a "prediction" that ignores this is a fantasy. The
 * threshold matches the collision distance used by the integrator.
 */
function lineBlocked(shooter, x, z, balls, cfg) {
  const target = { x, z };
  for (const ball of balls) {
    if (ball.teamIndex === shooter.teamIndex && ball.playerIndex === shooter.playerIndex) continue;
    const point = closestOnPath(shooter, target, ball);
    const lateral = Math.hypot(ball.x - point.x, ball.z - point.z);
    if (lateral <= cfg.ballRadius * 2 + 0.02) return true;
  }
  return false;
}

/** Closest point on the straight ground path start -> rest, as a fraction t. */function closestOnPath(start, rest, point) {
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
    // Full-direction aiming. The player can now throw anywhere horizontally, so
    // the AI aims straight at its target instead of into a forward cone; a
    // capped angle used to leave the shot off-line and unable to touch it.
    const angle = Math.atan2(dx, dz);
    const along = dist;
    // A Tir needs to still be rolling on contact; a Mat needs to stop in it.
    const overshoot = candidate.type === 'mat' ? 0 : 0.75;
    const power = clamp(powerForDistance(along + overshoot, cfg), 0.08, 1);
    const maxRange = distanceForPower(1, cfg);
    return { angle, power, along, lateral: 0, reachable: along <= maxRange + 0.5 };
  }

  /** Roll a candidate throw out with the game's own integrator. */
  function predict(shooter, angle, power, balls, cfg) {
    const dir = { x: Math.sin(angle), y: 0, z: Math.cos(angle) };
    const shot = simulateShot(
      { x: shooter.x, y: cfg.ballRadius, z: shooter.z },
      dir,
      power,
      cfg,
      { step: 1 / 120, maxTime: 14, surface }
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
      offField: !isPlayablePoint(rest.x, rest.z),
    };
  }

  /**
   * Nudge the power so a mat attempt actually settles in the hollow.
   *
   * The stopping distance is monotonic in power, so a short bisection on the
   * signed landing error lands on the dish instead of on a coarse +/-0.02 grid,
   * which is far too wide when the dish is only 0.63 m across. The base aim is
   * kept if the bisection does not improve on it.
   */
  function refineMatPower(shooter, candidate, aim, cfg) {
    const steps = profile.refine;
    if (!steps) return aim;
    const dir = { x: Math.sin(aim.angle), y: 0, z: Math.cos(aim.angle) };
    const target = Math.hypot(candidate.x - shooter.x, candidate.z - shooter.z);
    const landingError = (power) => {
      const shot = simulateShot(
        { x: shooter.x, y: cfg.ballRadius, z: shooter.z },
        dir,
        power,
        cfg,
        { step: 1 / 120, maxTime: 14, surface }
      );
      return Math.hypot(shot.rest.x - shooter.x, shot.rest.z - shooter.z) - target;
    };

    let bestPower = aim.power;
    let bestError = Math.abs(landingError(aim.power));
    let lo = 0.06;
    let hi = 1;
    for (let i = 0; i < steps; i += 1) {
      const mid = (lo + hi) / 2;
      const error = landingError(mid);
      if (Math.abs(error) < bestError) {
        bestError = Math.abs(error);
        bestPower = mid;
      }
      if (error > 0) hi = mid;
      else lo = mid;
    }
    return { ...aim, power: bestPower };
  }

  /** P(|error| <= tol) for a normal error of the given sigma. */
  function withinTolerance(tol, sigma) {
    if (!(sigma > 1e-6)) return 1;
    const z = Math.max(0, tol) / (sigma * Math.SQRT2);
    const t = 1 / (1 + 0.3275911 * z);
    const erf =
      1 -
      (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
        + 0.254829592) *
        t *
        Math.exp(-z * z);
    return clamp(erf, 0, 1);
  }

  /**
   * How likely this player is to actually execute the planned shot.
   *
   * A Tir only has to be passed through, so power precision barely matters; a
   * Mat has to stop inside the dish, where the same power error costs far more
   * metres than the dish is wide. This is why a weak player should not keep
   * attempting mats, and why the three levels end up playing differently.
   */
  function reliability(candidate, aim, shooter, cfg) {
    const distance = Math.hypot(candidate.x - shooter.x, candidate.z - shooter.z);
    const angleTol = candidate.type === 'mat' ? cfg.matRadius * 0.75 : cfg.ballRadius;
    const lateralSigma = Math.tan(profile.aimSigma) * Math.max(0.6, distance);
    const slope = distanceSlope(aim.power, cfg);
    const powerTol = candidate.type === 'mat'
      ? cfg.matRadius * 0.75
      : Math.max(1.2, distance * 0.35);
    return withinTolerance(angleTol, lateralSigma) * withinTolerance(powerTol, slope * profile.powerSigma);
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
        // A goolah sitting on the line deflects the shot, so a blocked mat is
        // not really makeable — the AI must see the obstruction, not the
        // unobstructed fantasy line.
        blocked: lineBlocked(shooter, cfg.matX, cfg.matZ[mat.index], balls, cfg),
        target: { kind: 'mat', matIndex: mat.index },
      });
    }
    return out;
  }

  /* ------------------------------------------------------------- value -- */

  function valueOf(candidate, aim, prediction, engine, shooter, cfg) {
    const state = engine.state;
    const team = state.turn.teamIndex;
    const openMats = state.mats.filter((mat) => !mat.completed).length;
    let value = 0;

    if (candidate.type === 'tir') {
      // A Mat-per goolah is worth 3 or 7 points, a normal Tir 1 point plus a chance.
      value += candidate.matPer ? 5.5 : 2.4;
    } else {
      // First two mats of the round score nothing, further ones score a point,
      // and every capture earns another chance (rule 4). Closing the last mats
      // also ends the round, so they are worth chasing as they thin out.
      value += state.captured[team] >= 2 ? 3.0 : 1.5;
      value += 1.2;
      value += (4 - openMats) * 0.35;
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
      } else if (candidate.blocked || prediction.contacts.length > 0) {
        // Something stands between the shooter and the dish. predict() reports
        // selfMat from the unobstructed path, but a ball that strikes another
        // goolah is deflected before it arrives, so this mat is not makeable.
        value -= 3.5;
      } else if (prediction.selfMat === candidate.matIndex) {
        value += 2.0;
      } else {
        value -= 1.5;
      }
      if (prediction.teammateHit) value -= 1.5; // rule 7: no point, no chance
      if (prediction.offField) value -= 2.5; // would need Rakh
      if (prediction.selfMat >= 0 && candidate.type === 'tir') value += 1.5;
    }

    // Expected value: a plan this player cannot execute is worth much less.
    const floor = candidate.type === 'mat' ? 0.12 : 0.05;
    value *= Math.max(floor, reliability(candidate, aim, shooter, cfg));
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

  /**
   * The power that really stops inside the dish. predict() is the same oracle
   * the value function trusts, so a mat is never thrown with a power that the
   * simulation already knows misses.
   */
  function solveMatPower(shooter, candidate, aim, balls, cfg) {
    const lands = (power) => predict(shooter, aim.angle, power, balls, cfg).selfMat === candidate.matIndex;
    if (lands(aim.power)) return aim;

    // A dish only accepts a few hundredths of a power unit, which a fixed grid
    // steps straight over: that is why mat attempts almost never converted.
    // The stopping distance grows monotonically with power, so bisect on the
    // signed along-track landing error and land in the middle of the dish.
    const dir = { x: Math.sin(aim.angle), y: 0, z: Math.cos(aim.angle) };
    const alongOf = (rest) => (rest.x - shooter.x) * dir.x + (rest.z - shooter.z) * dir.z;
    const target = (candidate.x - shooter.x) * dir.x + (candidate.z - shooter.z) * dir.z;
    const error = (power) => alongOf(predict(shooter, aim.angle, power, balls, cfg).rest) - target;

    let lo = 0.02;
    let hi = 1;
    let best = aim.power;
    let bestError = Math.abs(error(aim.power));
    for (let i = 0; i < 12; i += 1) {
      const mid = (lo + hi) / 2;
      const e = error(mid);
      if (Math.abs(e) < bestError) {
        bestError = Math.abs(e);
        best = mid;
      }
      if (e > 0) hi = mid;
      else lo = mid;
    }
    const solved = { ...aim, power: best };
    return lands(best) ? solved : aim;
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
        value: valueOf(candidate, aim, prediction, engine, shooter, cfg),
      };
    });
    scored.sort((a, b) => b.value - a.value);

    // Nothing reachable: this goolah finished somewhere from which the aim
    // clamp cannot even point at a mat (for example past the last mat). Heaving
    // at full power only throws the goolah further away, so tap it instead and
    // keep it on the field.
    const reachable = scored.filter((entry) => entry.aim.reachable);
    if (reachable.length === 0) {
      const fallback = scored[0];
      const power = clamp(Math.min(fallback.aim.power, 0.22), 0.06, 1);
      return {
        type: 'throw',
        angle: fallback.aim.angle,
        power,
        intended: {
          kind: 'nudge',
          key: fallback.candidate.key,
          angle: fallback.aim.angle,
          power,
          value: fallback.value,
        },
        target: fallback.candidate.target,
      };
    }

    const pool = reachable.slice(0, Math.max(1, profile.picks));


    // Judgement. A stronger player does not take a shot it can already see will
    // fail: when the best idea is a mat whose line is obstructed or whose
    // prediction misses the dish, switch to the best legal Tir instead of
    // burning the chance. This is skill expressed through the same physics the
    // shot will use, not a hand-tuned hit percentage.
    if (profile.refuseFutile) {
      const best = pool[0];
      // The power is solved after the pick, so a prediction that merely lands
      // short of the dish does not make the mat futile; an obstructed line does.
      const futileMat = best.candidate.type === 'mat'
        && (best.candidate.blocked
          || Boolean(best.prediction && best.prediction.contacts.length > 0));
      if (futileMat) {
        const tir = reachable.find((entry) => entry.candidate.type === 'tir');
        if (tir) pool.splice(0, pool.length, tir);
      }
    }
    const pick = weightedPick(pool);
    // Execute a mat with a power predict() has verified stops inside the dish.
    // Solving it separately from the predicted shot is what made mats miss.
    const aim =
      pick.candidate.type === 'mat'
        ? solveMatPower(shooter, pick.candidate, pick.aim, balls, cfg)
        : pick.aim;

    // Execution error: this is what separates the three levels.
    const angle = wrapAngle(aim.angle + gauss() * profile.aimSigma);
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
