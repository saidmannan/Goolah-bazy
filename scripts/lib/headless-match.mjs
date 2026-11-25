// Headless Goolah Bazy match harness.
//
// Runs a whole match with no browser: the same config, the same physics
// integrator and the same rules engine the game uses, driven by the AI module.
// The Phase 3 tests use it to measure how the three difficulties actually
// perform and to prove that every AI action is one a human could have taken.
//
// Nothing here is a second rules implementation: the harness only turns a throw
// into a collision report (exactly the shape game.js builds) and hands it to
// RulesEngine.
import { CONFIG, defenderPosition, isPlayablePoint, throwPosition } from '../../src/config.js';
import {
  createBody,
  resolveBallCollision,
  stepBallMotion,
  throwVelocity,
} from '../../src/physics.js';
import { RulesEngine, RULES, ballKey, rakhPosition } from '../../src/rules.js';
import {
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  createAI,
  matSurface,
  seatKey,
} from '../../src/ai.js';

const SURFACE = matSurface(CONFIG);
const STEP = 1 / 120;
const MAX_SHOT_TIME = 16;

/** Which mat (if any) a stopped goolah is sitting in — same test as game.js. */
export function matAt(x, z) {
  for (let i = 0; i < CONFIG.matZ.length; i += 1) {
    if (Math.hypot(x - CONFIG.matX, z - CONFIG.matZ[i]) <= CONFIG.matRadius * 0.75) return i;
  }
  return -1;
}

export function ballAt(balls, teamIndex, playerIndex) {
  return balls[teamIndex * RULES.playersPerTeam + playerIndex];
}

export function createBalls() {
  const balls = [];
  for (let teamIndex = 0; teamIndex < RULES.teamCount; teamIndex += 1) {
    for (let playerIndex = 0; playerIndex < RULES.playersPerTeam; playerIndex += 1) {
      const pos = throwPosition(playerIndex);
      balls.push({
        teamIndex,
        playerIndex,
        key: ballKey(teamIndex, playerIndex),
        state: 'home',
        matIndex: -1,
        body: createBody(pos.x, pos.y, pos.z, CONFIG.ballRadius),
      });
    }
  }
  return balls;
}

/** Round start: throwing team on the shared line, defenders behind mats 1 and 3. */
export function placeBalls(balls, throwingTeam) {
  for (const ball of balls) {
    const pos = ball.teamIndex === throwingTeam
      ? throwPosition(ball.playerIndex)
      : defenderPosition(ball.playerIndex);
    ball.body.pos.set(pos.x, pos.y, pos.z);
    ball.body.vel.set(0, 0, 0);
    ball.body.resting = true;
    ball.state = 'home';
    ball.matIndex = -1;
  }
}

/** The plain-data view the AI module consumes. */
export function ballData(balls) {
  return balls.map((ball) => ({
    teamIndex: ball.teamIndex,
    playerIndex: ball.playerIndex,
    state: ball.state,
    matIndex: ball.matIndex,
    x: ball.body.pos.x,
    y: ball.body.pos.y,
    z: ball.body.pos.z,
  }));
}

/** A stopped goolah settles into a mat if it finished inside one. */
export function settle(balls) {
  for (const ball of balls) {
    // Rule 9: a goolah that stopped somewhere unplayable comes back to the
    // nearest playable spot on a straight line toward the field. Without this
    // the harness let goolahs roll away forever and every later shot was taken
    // from off the field.
    const spot = rakhPosition(
      { x: ball.body.pos.x, z: ball.body.pos.z },
      isPlayablePoint,
      { toward: { x: CONFIG.matX, z: 0 }, step: 0.1, maxDistance: 26 }
    );
    if (spot.applied) {
      ball.body.pos.set(spot.x, CONFIG.ballRadius, spot.z);
      ball.body.vel.set(0, 0, 0);
      ball.body.resting = true;
    }
    const mat = matAt(ball.body.pos.x, ball.body.pos.z);
    if (mat >= 0) {
      ball.state = 'mat';
      ball.matIndex = mat;
      ball.body.pos.y = CONFIG.ballRadius - CONFIG.matDepth + 0.001;
    } else {
      ball.state = 'settled';
      ball.matIndex = -1;
    }
  }
}

/**
 * Throw one goolah and roll everything else out with the real integrator.
 * Records which goolahs the moving ball touched (rule 7/8 chains included).
 */
export function runShot(balls, shooter, angle, power) {
  for (const ball of balls) {
    ball.body.vel.set(0, 0, 0);
    ball.body.resting = true;
  }
  const dir = { x: Math.sin(angle), y: 0, z: Math.cos(angle) };
  shooter.body.vel.copy(throwVelocity(dir, power, CONFIG));
  shooter.body.resting = false;

  const hits = new Map();
  const inPlay = new Set([shooter.key]);
  let elapsed = 0;

  while (elapsed < MAX_SHOT_TIME) {
    for (const ball of balls) {
      if (!ball.body.resting) stepBallMotion(ball.body, STEP, CONFIG, SURFACE);
    }

    for (let i = 0; i < balls.length; i += 1) {
      for (let j = i + 1; j < balls.length; j += 1) {
        const a = balls[i];
        const b = balls[j];
        const aActive = inPlay.has(a.key);
        const bActive = inPlay.has(b.key);
        if (!aActive && !bActive) continue;

        const prevA = { x: a.body.pos.x, y: a.body.pos.y, z: a.body.pos.z };
        const prevB = { x: b.body.pos.x, y: b.body.pos.y, z: b.body.pos.z };
        const { hit } = resolveBallCollision(a.body, b.body, CONFIG);
        if (!hit) continue;

        // The goolah already in play is the one that caused the contact; a ball
        // set moving by that contact can hit another in turn.
        if (aActive && !bActive) {
          inPlay.add(b.key);
          hits.set(b.key, { teamIndex: b.teamIndex, playerIndex: b.playerIndex, previous: prevB });
        } else if (bActive && !aActive) {
          inPlay.add(a.key);
          hits.set(a.key, { teamIndex: a.teamIndex, playerIndex: a.playerIndex, previous: prevA });
        }
      }
    }

    elapsed += STEP;
    if (balls.every((ball) => ball.body.resting)) break;
  }

  return { hits, elapsed };
}

/** Same collision report game.buildShotReport() produces. */
export function shotReport(engine, shooter, hits, balls) {
  const s = engine.state;
  const collisions = [];

  for (const hit of hits.values()) {
    const ball = ballAt(balls, hit.teamIndex, hit.playerIndex);
    const sameTeam = hit.teamIndex === shooter.teamIndex;
    const held = s.matPer[hit.teamIndex][hit.playerIndex];
    const inMat = ball.state === 'mat' ? ball.matIndex : -1;
    collisions.push({
      kind: sameTeam ? 'teammate' : 'opponent',
      teamIndex: hit.teamIndex,
      playerIndex: hit.playerIndex,
      previous: hit.previous,
      matPer: Boolean(held),
      matIndex: held ? held.matIndex : -1,
      knockedOutOfMat: Boolean(held) && inMat !== held.matIndex,
      enteredMat: !sameTeam && inMat >= 0 && (!held || inMat !== held.matIndex) ? inMat : -1,
    });
  }

  const ownMatIndex = shooter.state === 'mat' ? shooter.matIndex : -1;
  return { collisions, ownMatIndex };
}

/**
 * Play a match with the AI in every seat.
 *
 * seatPlan maps "team:player" to a difficulty id; anything else falls back to
 * the default difficulty. Returns the statistics the tests assert on.
 */
export function playMatch(options = {}) {
  const {
    seatPlan = {},
    seed = 1,
    maxThrows = 800,
    maxRounds = 12,
  } = options;

  const engine = new RulesEngine({ round: 1 });
  const balls = createBalls();
  placeBalls(balls, engine.state.throwingTeam);

  const brains = new Map();
  const brainFor = (teamIndex, playerIndex) => {
    const key = seatKey(teamIndex, playerIndex);
    if (!brains.has(key)) {
      const wanted = seatPlan[key];
      const difficulty = DIFFICULTIES[wanted] ? wanted : DEFAULT_DIFFICULTY;
      brains.set(key, createAI({ difficulty, seed: seed + teamIndex * 977 + playerIndex * 131 }));
    }
    return brains.get(key);
  };

  const stats = {
    throws: 0,
    rounds: 1,
    illegal: [],
    turnLog: [],
    passes: 0,
    execution: { tir: [0, 0], mat: [0, 0] },
    pointsByTeam: [0, 0],
    scores: [0, 0],
    winner: -1,
    matchOver: false,
    matPer: { offers: 0, hold: 0, play: 0 },
    finalThrows: 0,
    throwsBySeat: new Map(),
  };

  const syncScores = () => {
    const now = engine.state.scores;
    for (let t = 0; t < RULES.teamCount; t += 1) {
      const delta = now[t] - stats.scores[t];
      if (delta > 0) stats.pointsByTeam[t] += delta;
      stats.scores[t] = now[t];
    }
  };

  let lastSeat = null;
  let guard = 0;

  while (!engine.state.matchOver && stats.throws < maxThrows && guard < maxThrows * 6) {
    guard += 1;
    const s = engine.state;

    if (s.roundOver) {
      if (s.round >= maxRounds) break;
      engine.startRound(s.round + 1);
      placeBalls(balls, engine.state.throwingTeam);
      lastSeat = null;
      continue;
    }

    if (!engine.canThrow()) {
      engine.endTurn();
      continue;
    }

    const turn = s.turn;
    const seat = seatKey(turn.teamIndex, turn.playerIndex);
    if (seat !== lastSeat) {
      stats.turnLog.push({ round: s.round, seat });
      lastSeat = seat;
    }

    const shooter = ballAt(balls, turn.teamIndex, turn.playerIndex);
    const brain = brainFor(turn.teamIndex, turn.playerIndex);

    // The AI is a player, not an authority: choosing must not touch the rules.
    const snapshot = JSON.stringify(engine.state);
    const action = brain.chooseThrow(engine, ballData(balls), CONFIG);
    if (JSON.stringify(engine.state) !== snapshot) {
      stats.illegal.push(`chooseThrow changed engine state at ${seat}`);
    }
    if (!action) {
      stats.illegal.push(`no decision at ${seat}`);
      engine.endTurn();
      continue;
    }
    if (action.pass) {
      stats.passes += 1;
      engine.endTurn();
      continue;
    }

    if (!Number.isFinite(action.angle) || Math.abs(action.angle) > CONFIG.maxAimAngle + 1e-9) {
      stats.illegal.push(`angle out of range at ${seat}: ${action.angle}`);
    }
    if (!Number.isFinite(action.power) || action.power < 0 || action.power > 1) {
      stats.illegal.push(`power out of range at ${seat}: ${action.power}`);
    }

    const legalTargets = engine.availableTargets();
    const target = action.target || {};
    if (target.kind === 'ball') {
      const key = ballKey(target.teamIndex, target.playerIndex);
      if (!legalTargets.some((t) => t.key === key)) {
        stats.illegal.push(`illegal target ${key} at ${seat}`);
      }
      if (turn.finalOpportunity) {
        stats.finalThrows += 1;
        if (!s.finalMat) {
          stats.illegal.push('final throw without a final mat');
        } else {
          engine.chooseFinalTarget(target.teamIndex, target.playerIndex);
        }
      }
    } else if (target.kind === 'mat') {
      const mat = s.mats[target.matIndex];
      if (!mat || mat.completed) stats.illegal.push(`illegal mat target at ${seat}`);
    } else {
      stats.illegal.push(`throw without a target at ${seat}`);
    }

    const { hits } = runShot(balls, shooter, action.angle, action.power);
    settle(balls);
    const report = shotReport(engine, shooter, hits, balls);
    const result = engine.resolveThrow(report);

    stats.throws += 1;
    stats.throwsBySeat.set(seat, (stats.throwsBySeat.get(seat) || 0) + 1);

    if (target.kind === 'ball') {
      stats.execution.tir[0] += 1;
      if (hits.has(ballKey(target.teamIndex, target.playerIndex))) stats.execution.tir[1] += 1;
    } else if (target.kind === 'mat') {
      stats.execution.mat[0] += 1;
      if (report.ownMatIndex === target.matIndex) stats.execution.mat[1] += 1;
    }

    // Rule 7: a hit teammate's goolah goes back to exactly where it was.
    for (const restore of result.restore || []) {
      if (!restore.position) continue;
      const ball = ballAt(balls, restore.teamIndex, restore.playerIndex);
      ball.body.pos.set(restore.position.x, restore.position.y, restore.position.z);
      ball.body.vel.set(0, 0, 0);
      ball.body.resting = true;
      const mat = matAt(ball.body.pos.x, ball.body.pos.z);
      ball.state = mat >= 0 ? 'mat' : 'settled';
      ball.matIndex = mat;
    }

    syncScores();

    // Rule 5: a Mat-per offer pauses the turn for a decision.
    const offers = result.matPerOffers || [];
    if (offers.length > 0 && !result.finalMat) {
      stats.matPer.offers += 1;
      const choice = brain.chooseMatPer(engine);
      const hold = Boolean(choice && choice.hold);
      if (hold) stats.matPer.hold += 1;
      else stats.matPer.play += 1;
      const outcome = engine.chooseMatPer(hold);
      if (!outcome) engine.endTurn();
      syncScores();
      continue;
    }

    engine.afterThrow(result);
    syncScores();
  }

  stats.scores = [...engine.state.scores];
  stats.matchOver = engine.state.matchOver;
  stats.rounds = engine.state.round;
  stats.winner = stats.scores[0] === stats.scores[1]
    ? -1
    : (stats.scores[0] > stats.scores[1] ? 0 : 1);
  return stats;
}

/** Attempts and hits for one difficulty, combined. */
export function executionRate(stats) {
  const attempts = stats.execution.tir[0] + stats.execution.mat[0];
  const hits = stats.execution.tir[1] + stats.execution.mat[1];
  return attempts ? hits / attempts : 0;
}
