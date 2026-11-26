// Regression tests for the repeated-scoring bug in src/rules.js.
//
// The bug: a player could hit the same opposing goolah over and over, collect a
// point and a fresh extra chance every time. The rule is that within one
// scoring sequence each opposing goolah can be scored against once, and the
// lock only clears when that player completes a mat.
//
// Pure node: imports the engine only, no browser and no Three.js.
//
//   node scripts/test-scoring-eligibility.mjs

import {
  RulesEngine,
  RULES,
  ballKey,
  matPointsFor,
  throwingTeamForRound,
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
  check(
    name,
    actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

/** An opposing goolah (team 0) as the game reports it after a collision. */
function opp(playerIndex, extra = {}) {
  return { kind: 'opponent', teamIndex: 0, playerIndex, ...extra };
}

/** Resolve a throw and advance the turn, exactly as src/game.js does. */
function shoot(engine, shot) {
  const r = engine.resolveThrow(shot);
  engine.afterThrow(r);
  return r;
}

const who = (e) => `${e.state.turn.teamIndex}:${e.state.turn.playerIndex}`;

/* -------------------------------------------------------------------------
   1. The first valid hit against an opposing goolah scores correctly.
   ---------------------------------------------------------------------- */
{
  const e = new RulesEngine();
  const before = e.state.scores[1];
  const r = shoot(e, { collisions: [opp(playerIndex0())], ownMatIndex: -1 });

  eq('1 first valid Tir scores exactly one point', r.points, RULES.tirPoints);
  eq('1 the point goes to the throwing team', e.state.scores[1], before + 1);
  eq('1 the other team is untouched', e.state.scores[0], 0);
  eq('1 a valid Tir grants an extra chance', r.extraChance, true);
  eq('1 the thrower keeps the turn', who(e), '1:0');
  check(
    '1 the goolah is now recorded as scored against',
    e.state.locked[1][0].includes(ballKey(0, 0)),
    JSON.stringify(e.state.locked[1][0])
  );
}

/* -------------------------------------------------------------------------
   2 and 3. Repeating the hit on that same goolah scores nothing and grants
   no further extra chance.
   ---------------------------------------------------------------------- */
{
  const e = new RulesEngine();
  shoot(e, { collisions: [opp(0)], ownMatIndex: -1 });
  const scoreAfterFirst = e.state.scores[1];

  const repeat = shoot(e, { collisions: [opp(0)], ownMatIndex: -1 });

  eq('2 a repeated hit on the same goolah scores nothing', repeat.points, 0);
  eq('2 the score is unchanged', e.state.scores[1], scoreAfterFirst);
  eq('3 a repeated hit grants no extra chance', repeat.extraChance, false);
  eq('3 no Tir award is recorded', repeat.awards.length, 0);
  check('3 the goolah is reported as ineligible', repeat.ineligible.includes(ballKey(0, 0)));

  // Without an extra chance the sequence ends and the next player is up, so a
  // player cannot farm one goolah indefinitely.
  eq('3 the turn passes to the next player', who(e), '1:1');

  // And a third hit by that player is still worth nothing (fresh engine, so we
  // reach them through a mat-free sequence).
  const e2 = new RulesEngine();
  shoot(e2, { collisions: [opp(0)], ownMatIndex: -1 });
  shoot(e2, { collisions: [opp(0)], ownMatIndex: -1 });
  shoot(e2, { collisions: [opp(0)], ownMatIndex: -1 });
  eq('2 three hits in one sequence still pay one point', e2.state.scores[1], 1);
}

/* -------------------------------------------------------------------------
   3b. A single throw that reports the same goolah more than once must not
   double-score or double-grant.
   ---------------------------------------------------------------------- */
{
  const e = new RulesEngine();
  const r = shoot(e, { collisions: [opp(0), opp(0), opp(0)], ownMatIndex: -1 });
  eq('3b duplicate contact reports in one throw pay one point', r.points, 1);
  eq('3b duplicate contact reports grant one chance', r.extraChance, true);
  eq('3b the score moves once', e.state.scores[1], 1);
}

/* -------------------------------------------------------------------------
   4. A new score against that goolah becomes possible only after the
   required mat action — and nothing weaker than a completed mat clears it.
   ---------------------------------------------------------------------- */
{
  // 4a: the lock survives a miss, the ball stopping, and the turn continuing.
  const e = new RulesEngine();
  shoot(e, { collisions: [opp(0)], ownMatIndex: -1 });
  // An extra chance that hits nothing: still the same player, still locked.
  const idle = shoot(e, { collisions: [], ownMatIndex: -1 });
  eq('4a an unproductive extra chance does not clear the lock', idle.points, 0);
  eq('4a the lock is still in place', e.state.locked[1][0].includes(ballKey(0, 0)), true);

  // 4b: a completed mat by that player clears it, and the same goolah scores again.
  const e2 = new RulesEngine();
  eq('4b first hit scores', shoot(e2, { collisions: [opp(0)], ownMatIndex: -1 }).points, 1);
  const capture = shoot(e2, { collisions: [], ownMatIndex: 0 });
  eq('4b the mat is completed', e2.state.mats[0].completed, true);
  eq('4b the capturing player keeps the turn', who(e2), '1:0');
  check(
    '4b completing a mat clears the lock',
    !e2.state.locked[1][0].includes(ballKey(0, 0)),
    JSON.stringify(e2.state.locked[1][0])
  );
  eq(
    '4b the same goolah scores again after the mat action',
    shoot(e2, { collisions: [opp(0)], ownMatIndex: -1 }).points,
    1
  );
  eq('4b and the second Tir pays one point, not two', e2.state.scores[1], 2);
  check('4b the mat awarded no points of its own', capture.points === 0);
}

/* -------------------------------------------------------------------------
   5. The other opposing goolah has its own independent eligibility.
   ---------------------------------------------------------------------- */
{
  const e = new RulesEngine();
  eq('5 the first opponent scores', shoot(e, { collisions: [opp(0)], ownMatIndex: -1 }).points, 1);
  eq(
    '5 the second opponent still scores while the first is locked',
    shoot(e, { collisions: [opp(1)], ownMatIndex: -1 }).points,
    1
  );
  eq('5 both goolahs are now locked', e.state.locked[1][0].length, 2);
  eq(
    '5 the first opponent is still locked afterwards',
    shoot(e, { collisions: [opp(0)], ownMatIndex: -1 }).points,
    0
  );
  eq('5 two Tir points in total', e.state.scores[1], 2);
}

/* -------------------------------------------------------------------------
   6. Mat-per scoring cannot be duplicated.
   ---------------------------------------------------------------------- */
{
  const e = new RulesEngine();
  // Round 2 puts team 0 on the throwing line, so team 0 can hold a Mat-per.
  e.startRound(2);
  eq('6 round 2 is thrown by team 0', e.state.throwingTeam, 0);

  const cap = e.resolveThrow({ collisions: [], ownMatIndex: 0 });
  eq('6 the mat is captured', cap.captures.length, 1);
  check('6 Mat-per is offered', cap.matPerOffers.length === 1);
  eq('6 the player accepts Mat-per', e.chooseMatPer(true), true);
  check('6 Mat-per status is recorded', Boolean(e.state.matPer[0][0]));
  e.afterThrow(cap);

  // Play on until the opposing team is on the line.
  let guard = 0;
  while (e.state.turn.teamIndex !== 1 && guard < 12) {
    shoot(e, { collisions: [], ownMatIndex: -1 });
    guard += 1;
  }
  eq('6 the opposing team is throwing', e.state.turn.teamIndex, 1);
  check('6 the Mat-per goolah is still held', Boolean(e.state.matPer[0][0]));

  const heldHit = { ...opp(0, { matPer: true, matIndex: 0 }) };
  const first = shoot(e, { collisions: [heldHit], ownMatIndex: -1 });
  eq('6 hitting a Mat-per goolah that stays in the hollow pays 3', first.points, 3);
  eq(
    '6 the normal Tir point is not added on top',
    first.awards.some((a) => a.type === 'tir'),
    false
  );
  eq('6 a Mat-per hit grants an extra chance', first.extraChance, true);

  const second = shoot(e, { collisions: [heldHit], ownMatIndex: -1 });
  eq('6 a second hit on the same Mat-per goolah pays nothing', second.points, 0);
  eq('6 and grants no extra chance', second.extraChance, false);
  eq('6 the Mat-per award was paid once', e.state.scores[1], 3);

  // The 7-point knockout award is also single-shot.
  const e2 = new RulesEngine();
  e2.startRound(2);
  const cap2 = e2.resolveThrow({ collisions: [], ownMatIndex: 1 });
  e2.chooseMatPer(true);
  e2.afterThrow(cap2);
  let g2 = 0;
  while (e2.state.turn.teamIndex !== 1 && g2 < 12) {
    shoot(e2, { collisions: [], ownMatIndex: -1 });
    g2 += 1;
  }
  const knock = { ...opp(0, { matPer: true, matIndex: 1, knockedOutOfMat: true }) };
  const k1 = shoot(e2, { collisions: [knock], ownMatIndex: -1 });
  eq('6 knocking a Mat-per goolah out pays 7', k1.points, 7);
  const k2 = shoot(e2, { collisions: [knock], ownMatIndex: -1 });
  eq('6 a repeat knockout hit pays nothing', k2.points, 0);
  eq('6 the knockout award was paid once', e2.state.scores[1], 7);
}

/* -------------------------------------------------------------------------
   7. Existing round and match rules still work.
   ---------------------------------------------------------------------- */
{
  eq('7 one mat is inside the free quota', matPointsFor(1), 0);
  eq('7 two mats are inside the free quota', matPointsFor(2), 0);
  eq('7 three mats pay one point', matPointsFor(3), 1);
  eq('7 four mats pay two points', matPointsFor(4), 2);
  eq('7 the target is still 21', RULES.targetScore, 21);
  eq('7 four mats per round', RULES.matCount, 4);
  check('7 roles swap between rounds', throwingTeamForRound(1) !== throwingTeamForRound(2));
  eq('7 round 1 is thrown by Zananda', throwingTeamForRound(1), 1);

  // A teammate collision still scores nothing, grants nothing, and restores the
  // teammate's goolah — while a valid opponent hit in the same throw counts.
  const e = new RulesEngine();
  const r = shoot(e, {
    collisions: [
      { kind: 'teammate', teamIndex: 1, playerIndex: 1, previous: { x: 1, y: 0.28, z: -2 } },
      opp(0),
    ],
    ownMatIndex: -1,
  });
  eq('7 a teammate collision scores nothing on its own', r.points, 1);
  eq('7 the teammate goolah is restored', r.restore.length, 1);
  eq('7 the teammate goolah returns to its previous position', r.restore[0].position.z, -2);
  eq('7 the valid opponent Tir still grants one chance', r.extraChance, true);

  // The two free mats still apply per team per round.
  const e2 = new RulesEngine();
  e2.startRound(2);
  const capA = shoot(e2, { collisions: [], ownMatIndex: 0 });
  const capB = shoot(e2, { collisions: [], ownMatIndex: 1 });
  eq('7 the first two mats captured pay nothing', capA.points + capB.points, 0);
  eq('7 both mats are completed', e2.state.mats.filter((m) => m.completed).length, 2);
}

/* --------------------------------------------------------------- report -- */

function playerIndex0() {
  return 0;
}

if (failures.length) {
  console.error(`✗ ${failures.length} failing check(s) of ${passed + failures.length}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`✓ scoring eligibility: ${passed} checks passed`);
