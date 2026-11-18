// Automated checks for the agreed traditional Goolah Bazy rules (sections 1-10).
// Pure node: imports the engine only, no browser and no Three.js.
//
//   node scripts/test-phase2-rules.mjs

import {
  RulesEngine,
  RULES,
  matPointsFor,
  throwingTeamForRound,
  turnOrderFor,
  rakhPosition,
  ballKey,
} from '../src/rules.js';

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Throw nothing useful: no collisions, no mat. */
function miss(engine) {
  const r = engine.resolveThrow({ collisions: [], ownMatIndex: -1 });
  engine.afterThrow(r);
  return r;
}

function shoot(engine, shot) {
  const r = engine.resolveThrow(shot);
  engine.afterThrow(r);
  return r;
}

/* ---------------------------------------------------------------- §1 teams -- */
{
  eq('§1 Zananda throws first', new RulesEngine().state.throwingTeam, 1);
  eq('§1 Shananda defends first', new RulesEngine().state.defendingTeam, 0);

  eq('§1 four players', turnOrderFor({ throwingTeam: 1, defendingTeam: 0 }).length, 4);
  eq('§1 two teams of two', RULES.playersPerTeam * RULES.teamCount, 4);
  eq('§1 four mats', RULES.matCount, 4);
  eq('§1 target is 21', RULES.targetScore, 21);

  eq('§1 roles swap in round 2', throwingTeamForRound(2), 0);
  eq('§1 roles swap back in round 3', throwingTeamForRound(3), 1);
}

/* ------------------------------------------------------------ §2 turn order -- */
{
  const order = turnOrderFor({ throwingTeam: 1, defendingTeam: 0 });
  eq('§2 slot 1 is throwing P1', `${order[0].teamIndex}:${order[0].playerIndex}`, '1:0');
  eq('§2 slot 2 is throwing P2', `${order[1].teamIndex}:${order[1].playerIndex}`, '1:1');
  eq('§2 slot 3 is defending P1', `${order[2].teamIndex}:${order[2].playerIndex}`, '0:0');
  eq('§2 slot 4 is defending P2', `${order[3].teamIndex}:${order[3].playerIndex}`, '0:1');

  const e = new RulesEngine();
  eq('§2 the round opens with the throwing team', `${e.state.turn.teamIndex}:${e.state.turn.playerIndex}`, '1:0');
  miss(e);
  eq('§2 throwing P2 follows', `${e.state.turn.teamIndex}:${e.state.turn.playerIndex}`, '1:1');
  miss(e);
  eq('§2 defending P1 follows both throwers', `${e.state.turn.teamIndex}:${e.state.turn.playerIndex}`, '0:0');
  miss(e);
  eq('§2 defending P2 is last', `${e.state.turn.teamIndex}:${e.state.turn.playerIndex}`, '0:1');
  miss(e);
  eq('§2 round closes after the fourth player', e.state.roundOver, true);

  // A new round restores the order and swaps the roles.
  const e2 = new RulesEngine();
  e2.startRound(2);
  eq('§2 round 2 throwing team swaps', e2.state.throwingTeam, 0);
  eq('§2 round 2 order restarts', `${e2.state.turn.teamIndex}:${e2.state.turn.playerIndex}`, '0:0');
}

/* --------------------------------------------------------- §3 extra chances -- */
{
  const e = new RulesEngine();
  eq('§3 a turn starts with one chance', e.state.turn.chances, 1);

  miss(e);
  eq('§3 no Tir and no Mat ends the turn', `${e.state.turn.teamIndex}:${e.state.turn.playerIndex}`, '1:1');

  const t = new RulesEngine();
  const r = shoot(t, { collisions: [{ kind: 'opponent', teamIndex: 0, playerIndex: 0 }], ownMatIndex: -1 });
  eq('§3 a Tir grants an extra chance', r.extraChance, true);
  eq('§3 a Tir scores one point', t.state.scores[1], 1);
  eq('§3 the Tir shooter keeps the field', `${t.state.turn.teamIndex}:${t.state.turn.playerIndex}`, '1:0');
  eq('§3 the extra chance is usable', t.state.turn.chances, 1);
  eq('§3 canThrow after a Tir', t.canThrow(), true);

  const m = new RulesEngine();
  const rm = shoot(m, { collisions: [], ownMatIndex: 0 });
  eq('§3 a Mat grants an extra chance', rm.extraChance, true);
  eq('§3 the Mat shooter keeps the field', `${m.state.turn.teamIndex}:${m.state.turn.playerIndex}`, '1:0');

  // Both opponents in one throw: still one Tir and one extra chance.
  const b = new RulesEngine();
  const rb = shoot(b, {
    collisions: [
      { kind: 'opponent', teamIndex: 0, playerIndex: 0 },
      { kind: 'opponent', teamIndex: 0, playerIndex: 1 },
    ],
    ownMatIndex: -1,
  });
  eq('§3 two opponents hit still score one point', b.state.scores[1], 1);
  eq('§3 two opponents hit still grant one extra chance', rb.awards.length, 1);
  eq('§3 both opponents hit is one Tir', rb.awards.filter((a) => a.type === 'tir').length, 1);

  // Tir and Mat in the same throw: one extra chance, not two.
  const tm = new RulesEngine();
  const rtm = shoot(tm, {
    collisions: [{ kind: 'opponent', teamIndex: 0, playerIndex: 0 }],
    ownMatIndex: 1,
  });
  eq('§3 Tir + Mat scores the Tir point', tm.state.scores[1], 1);
  eq('§3 Tir + Mat grants one extra chance', rtm.extraChance, true);
  eq('§3 Tir + Mat keeps the same player', `${tm.state.turn.teamIndex}:${tm.state.turn.playerIndex}`, '1:0');
}

/* --------------------------------------------- §3 target lockout after a Tir -- */
{
  const e = new RulesEngine();
  eq('§3 both opponents start available', e.availableTargets().length, 2);

  shoot(e, { collisions: [{ kind: 'opponent', teamIndex: 0, playerIndex: 0 }], ownMatIndex: -1 });
  const keys = e.availableTargets().map((t) => t.key);
  check('§3 the Tir target is locked out', !keys.includes(ballKey(0, 0)), `targets ${JSON.stringify(keys)}`);
  check('§3 the other opponent stays available', keys.includes(ballKey(0, 1)));

  // Completing a Mat in between releases the lock.
  const e2 = new RulesEngine();
  shoot(e2, { collisions: [{ kind: 'opponent', teamIndex: 0, playerIndex: 0 }], ownMatIndex: -1 });
  eq('§3 locked before the Mat', e2.availableTargets().length, 1);
  shoot(e2, { collisions: [], ownMatIndex: 0 });
  eq('§3 a Mat releases the lockout', e2.availableTargets().length, 2);

  // A fresh round releases it as well (the turn has come around again).
  const e3 = new RulesEngine();
  shoot(e3, { collisions: [{ kind: 'opponent', teamIndex: 0, playerIndex: 0 }], ownMatIndex: -1 });
  e3.startRound(2);
  eq('§3 a new round releases the lockout', e3.availableTargets().length, 2);
}

/* ------------------------------------------------- §4 mat points and quotas -- */
{
  eq('§4 one mat scores nothing', matPointsFor(1), 0);
  eq('§4 two mats score nothing', matPointsFor(2), 0);
  eq('§4 three mats score one point', matPointsFor(3), 1);
  eq('§4 four mats score two points', matPointsFor(4), 2);

  const e = new RulesEngine();
  shoot(e, { collisions: [], ownMatIndex: 0 });
  eq('§4 first capture scores nothing', e.state.scores[1], 0);
  eq('§4 first capture counted', e.state.captured[1], 1);
  e.chooseMatPer(false);

  shoot(e, { collisions: [], ownMatIndex: 1 });
  eq('§4 second capture still scores nothing', e.state.scores[1], 0);
  e.chooseMatPer(false);

  shoot(e, { collisions: [], ownMatIndex: 2 });
  eq('§4 third capture scores one point', e.state.scores[1], 1);
  e.chooseMatPer(false);

  // Mat numbers do not matter, only the count: Shananda capturing three of
  // any numbering scores one point.
  const n = new RulesEngine();
  shoot(n, { collisions: [], ownMatIndex: 3 });
  n.chooseMatPer(false);
  shoot(n, { collisions: [], ownMatIndex: 0 });
  n.chooseMatPer(false);
  shoot(n, { collisions: [], ownMatIndex: 2 });
  eq('§4 mat numbering is irrelevant', n.state.scores[1], 1);

  // A completed mat cannot be captured twice.
  const once = new RulesEngine();
  shoot(once, { collisions: [], ownMatIndex: 0 });
  once.chooseMatPer(false);
  const again = once.resolveThrow({ collisions: [], ownMatIndex: 0 });
  eq('§4 a completed mat cannot be reused', again.captures.length, 0);
  eq('§4 the second visit adds no capture', once.state.captured[1], 1);
}

/* -------------------------------------------------------- §5 Mat-per (hold) -- */
{
  const e = new RulesEngine();
  const r = shoot(e, { collisions: [], ownMatIndex: 0 });
  eq('§5 capturing offers Mat-per', r.matPerOffers.length, 1);
  eq('§5 the offer names the mat', r.matPerOffers[0].matIndex, 0);
  eq('§5 the goolah is counted for the team quota', e.state.captured[1], 1);

  const held = e.chooseMatPer(true);
  eq('§5 holding keeps the goolah in the mat', held.held, true);
  eq('§5 holding ends the turn', `${e.state.turn.teamIndex}:${e.state.turn.playerIndex}`, '1:1');
  check('§5 Mat-per status is recorded', Boolean(e.state.matPer[1][0]));
  eq('§5 the held mat is marked', e.state.mats[0].matPer.playerIndex, 0);

  // On the holder's next turn the chance is still waiting.
  e.startRound(1);
  eq('§5 the held chance is offered next turn', e.state.turn.pendingMatPer ? 1 : 0, 1);
  eq('§5 the holder may hold again', e.state.turn.pendingMatPer.matIndex, 0);

  // Holding again preserves Mat-per and postpones the chance.
  const again = e.chooseMatPer(true);
  eq('§5 holding again postpones the chance', again.held, true);
  check('§5 Mat-per survives a second hold', Boolean(e.state.matPer[1][0]));

  // Leaving the mat keeps the chance for a normal throw.
  const e2 = new RulesEngine();
  shoot(e2, { collisions: [], ownMatIndex: 2 });
  const leave = e2.chooseMatPer(false);
  eq('§5 leaving the mat keeps the chance', e2.state.turn.chances, 1);
  eq('§5 leaving clears Mat-per', leave.held, false);
  eq('§5 leaving ends Mat-per status', e2.state.matPer[1][0], null);
  eq('§5 the same player throws', `${e2.state.turn.teamIndex}:${e2.state.turn.playerIndex}`, '1:0');

  // A Mat-per player may only target the two opponents.
  const targets = e2.availableTargets();
  check(
    '§5 Mat-per targets are only opponents',
    targets.every((t) => t.teamIndex === 0),
    JSON.stringify(targets)
  );
}

/* -------------------------------------------- §5 Mat-per hit: 3 and 7 points -- */
{
  // Case A: the goolah stays in the hollow -> exactly 3 points.
  const a = new RulesEngine();
  shoot(a, { collisions: [], ownMatIndex: 0 });
  a.chooseMatPer(true);
  miss(a); // team 1 P2
  // now team 0 P1 attacks the Mat-per goolah
  eq('§5 case A: defender on the field', `${a.state.turn.teamIndex}:${a.state.turn.playerIndex}`, '0:0');
  const ra = a.resolveThrow({
    collisions: [{ kind: 'opponent', teamIndex: 1, playerIndex: 0, matPer: true, matIndex: 0, knockedOutOfMat: false }],
    ownMatIndex: -1,
  });
  a.afterThrow(ra);
  eq('§5 case A scores exactly 3', ra.points, 3);
  eq('§5 case A adds no normal Tir point', ra.awards.filter((x) => x.type === 'tir').length, 0);
  eq('§5 case A total score', a.state.scores[0], 3);
  check('§5 case A Mat-per continues', Boolean(a.state.matPer[1][0]));
  eq('§5 case A the mat stays completed', a.state.mats[0].completed, true);
  eq('§5 case A grants one extra chance', a.state.turn.chances, 1);
  eq('§5 case A the attacker keeps the field', `${a.state.turn.teamIndex}:${a.state.turn.playerIndex}`, '0:0');

  // Case B: the goolah is knocked out -> exactly 7 points.
  const b = new RulesEngine();
  shoot(b, { collisions: [], ownMatIndex: 1 });
  b.chooseMatPer(true);
  miss(b);
  const rb = b.resolveThrow({
    collisions: [{ kind: 'opponent', teamIndex: 1, playerIndex: 0, matPer: true, matIndex: 1, knockedOutOfMat: true }],
    ownMatIndex: -1,
  });
  b.afterThrow(rb);
  eq('§5 case B scores exactly 7', rb.points, 7);
  eq('§5 case B adds no normal Tir point', rb.awards.filter((x) => x.type === 'tir').length, 0);
  eq('§5 case B total score', b.state.scores[0], 7);
  eq('§5 case B ends Mat-per', b.state.matPer[1][0], null);
  eq('§5 case B the mat stays completed', b.state.mats[1].completed, true);
  eq('§5 case B grants one extra chance', b.state.turn.chances, 1);

  // The 3 and 7 awards ignore the two-mat quota.
  const q = new RulesEngine();
  shoot(q, { collisions: [], ownMatIndex: 0 });
  q.chooseMatPer(true);
  miss(q);
  const rq = q.resolveThrow({
    collisions: [{ kind: 'opponent', teamIndex: 1, playerIndex: 0, matPer: true, matIndex: 0, knockedOutOfMat: true }],
    ownMatIndex: -1,
  });
  q.afterThrow(rq);
  eq('§5 the 7-point award ignores the quota', q.state.scores[0], 7);
  eq('§5 the quota is untouched by the award', q.state.captured[0], 0);

  // A secondary collision with the same Mat-per goolah does not score twice.
  const d = new RulesEngine();
  shoot(d, { collisions: [], ownMatIndex: 0 });
  d.chooseMatPer(true);
  miss(d);
  const rd = d.resolveThrow({
    collisions: [
      { kind: 'opponent', teamIndex: 1, playerIndex: 0, matPer: true, matIndex: 0, knockedOutOfMat: false },
      { kind: 'opponent', teamIndex: 1, playerIndex: 0, matPer: true, matIndex: 0, knockedOutOfMat: false },
    ],
    ownMatIndex: -1,
  });
  eq('§8 a repeated Mat-per collision scores once', rd.points, 3);

  // A Mat-per player who leaves the mat and hits an opponent gets the normal Tir.
  const n = new RulesEngine();
  shoot(n, { collisions: [], ownMatIndex: 0 });
  n.chooseMatPer(false);
  const rn = n.resolveThrow({ collisions: [{ kind: 'opponent', teamIndex: 0, playerIndex: 1 }], ownMatIndex: -1 });
  n.afterThrow(rn);
  eq('§5 leaving Mat-per gives an ordinary Tir', rn.points, 1);
  eq('§5 the ordinary Tir scores for the holder', n.state.scores[1], 1);
}

/* ------------------------------------------------------------ §6 final mat -- */
{
  const e = new RulesEngine();
  shoot(e, { collisions: [], ownMatIndex: 0 });
  e.chooseMatPer(false);
  shoot(e, { collisions: [], ownMatIndex: 1 });
  e.chooseMatPer(false);
  shoot(e, { collisions: [], ownMatIndex: 2 });
  e.chooseMatPer(false);
  const last = shoot(e, { collisions: [], ownMatIndex: 3 });

  check('§6 the fourth mat is flagged', Boolean(last.finalMat));
  eq('§6 the round is not over yet', e.state.roundOver, false);
  eq('§6 the completing player gets the last throw', `${e.state.turn.teamIndex}:${e.state.turn.playerIndex}`, '1:0');
  eq('§6 the last throw is flagged', e.state.turn.finalOpportunity, true);
  eq('§6 the last throw has one chance', e.state.turn.chances, 1);
  eq('§6 Mat-per is not offered on the final mat', e.state.turn.pendingMatPer, null);
  eq('§6 no held status is left behind', e.state.matPer[1][0], null);

  const final = e.resolveThrow({
    collisions: [
      { kind: 'opponent', teamIndex: 0, playerIndex: 0 },
      { kind: 'opponent', teamIndex: 0, playerIndex: 1 },
    ],
    ownMatIndex: -1,
  });
  e.afterThrow(final);
  eq('§6 the final throw scores one Tir only', final.points, 1);
  eq('§6 the final throw ends the round', e.state.roundOver, true);
  eq('§6 the final throw cannot be repeated', e.canThrow(), false);

  // The teammate's unused chance is lost with the round.
  const t = new RulesEngine();
  t.startRound(1);
  t.state.turnIndex = 3; // defending P2 is on the field, throwing P2 never played
  t.state.finalMat = { teamIndex: 0, playerIndex: 1, matIndex: 3, used: false, targetsRemaining: 1 };
  t.state.mats.forEach((m) => {
    m.completed = true;
  });
  t.afterThrow({ extraChance: false });
  eq('§6 the round closes after the final opportunity', t.state.roundOver, true);
}

/* ------------------------------------------------ §7 teammate collisions -- */
{
  const e = new RulesEngine();
  const previous = { x: 1.1, y: 0.06, z: 2.2 };
  const r = shoot(e, {
    collisions: [{ kind: 'teammate', teamIndex: 1, playerIndex: 1, previous }],
    ownMatIndex: -1,
  });
  eq('§7 a teammate hit scores nothing', e.state.scores[1], 0);
  eq('§7 a teammate hit grants no extra chance', r.extraChance, false);
  eq('§7 the teammate is restored', r.restore.length, 1);
  eq('§7 the restore position is exact', r.restore[0].position.z, 2.2);
  eq('§7 the turn passes', `${e.state.turn.teamIndex}:${e.state.turn.playerIndex}`, '1:1');

  // Teammate then opponent: the opponent Tir still counts.
  const o = new RulesEngine();
  const ro = shoot(o, {
    collisions: [
      { kind: 'teammate', teamIndex: 1, playerIndex: 1, previous },
      { kind: 'opponent', teamIndex: 0, playerIndex: 0 },
    ],
    ownMatIndex: -1,
  });
  eq('§7 teammate then opponent scores the Tir', o.state.scores[1], 1);
  eq('§7 teammate then opponent grants the chance', ro.extraChance, true);
  eq('§7 teammate still restored', ro.restore.length, 1);

  // Opponent then teammate: the Tir counts as well.
  const o2 = new RulesEngine();
  const ro2 = shoot(o2, {
    collisions: [
      { kind: 'opponent', teamIndex: 0, playerIndex: 1 },
      { kind: 'teammate', teamIndex: 1, playerIndex: 1, previous },
    ],
    ownMatIndex: -1,
  });
  eq('§7 order does not matter for the Tir', o2.state.scores[1], 1);
  eq('§7 order does not matter for the restore', ro2.restore.length, 1);
}

/* ------------------------------------- §8 opponent knocked into an open mat -- */
{
  const e = new RulesEngine();
  const r = shoot(e, {
    collisions: [{ kind: 'opponent', teamIndex: 0, playerIndex: 0, enteredMat: 2 }],
    ownMatIndex: -1,
  });
  eq('§8 the shooter still scores the Tir', e.state.scores[1], 1);
  eq('§8 the mat goes to the owning team', e.state.mats[2].capturedBy, 0);
  eq('§8 the owning team gains the capture', e.state.captured[0], 1);
  eq('§8 the capture is reported', r.captures.length, 1);
  eq('§8 the shooter gains no capture', e.state.captured[1], 0);
}

/* ------------------------------------------------------------- §9 Rakh ----- */
{
  const playable = (x, z) => Math.abs(x) <= 5 && z >= -1 && z <= 12;

  const onField = rakhPosition({ x: 1, z: 4 }, playable, { toward: { x: 0, z: 0 } });
  eq('§9 a playable stop is left alone', onField.applied, false);
  eq('§9 a playable stop keeps its position', onField.z, 4);

  const inDitch = rakhPosition({ x: 0, z: 20 }, playable, { toward: { x: 0, z: 0 }, step: 0.5 });
  eq('§9 an unplayable stop is moved', inDitch.applied, true);
  eq('§9 moved to the nearest playable spot', Math.round(inDitch.z * 10) / 10, 12);
  check('§9 moved along a straight line toward the field', inDitch.distance > 0);

  const sideways = rakhPosition({ x: 9, z: 6 }, playable, { toward: { x: 0, z: 6 }, step: 0.25 });
  eq('§9 lateral Rakh is handled', sideways.applied, true);
  check('§9 lateral Rakh lands inside the field', Math.abs(sideways.x) <= 5);
}

/* ------------------------------------------- §10 scores, rounds, 21 to win -- */
{
  const e = new RulesEngine();
  shoot(e, { collisions: [{ kind: 'opponent', teamIndex: 0, playerIndex: 0 }], ownMatIndex: -1 });
  eq('§10 a Tir is added immediately', e.state.scores[1], 1);

  e.startRound(2);
  eq('§10 scores carry over between rounds', e.state.scores[1], 1);
  eq('§10 captures reset each round', e.state.captured[1], 0);
  eq('§10 mats reset each round', e.state.mats.filter((m) => m.completed).length, 0);
  eq('§10 roles swap each round', e.state.throwingTeam, 0);

  const w = new RulesEngine();
  w.award(0, 20, 'test');
  eq('§10 20 points is not a win', w.state.matchOver, false);
  w.award(0, 1, 'test');
  eq('§10 21 points ends the match', w.state.matchOver, true);
  eq('§10 the winner is recorded', w.state.winner, 0);
  eq('§10 the winner score is 21', w.state.scores[0], 21);

  const after = w.resolveThrow({ collisions: [], ownMatIndex: -1 });
  w.afterThrow(after);
  eq('§10 no further throws after the win', after.matchOver, true);
  eq('§10 the match stays over', w.canThrow(), false);
}

/* ------------------------------------------------------- scoring via play -- */
{
  // A realistic mini-round: Zananda P1 hits, then captures, then misses.
  const e = new RulesEngine();
  shoot(e, { collisions: [{ kind: 'opponent', teamIndex: 0, playerIndex: 0 }], ownMatIndex: -1 });
  eq('play: Tir point', e.state.scores[1], 1);
  shoot(e, { collisions: [], ownMatIndex: 0 });
  eq('play: first mat is free', e.state.scores[1], 1);
  eq('play: mat captured', e.state.captured[1], 1);
  e.chooseMatPer(false);
  miss(e);
  eq('play: turn passes to the throwing P2', `${e.state.turn.teamIndex}:${e.state.turn.playerIndex}`, '1:1');
  eq('play: total score', e.state.scores[1], 1);
}

/* ------------------------------------------------------------------ report -- */
console.log(`\nGoolah Bazy rules: ${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILED:');
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log('ALL RULE CHECKS PASSED');
