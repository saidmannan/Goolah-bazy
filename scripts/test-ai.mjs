// Headless Phase 3 checks: the AI opponent.
//
//   node scripts/test-ai.mjs
//
// The point of this suite is to *measure* the three difficulties rather than
// trust their configured numbers: every throw below goes through the real
// physics integrator and the real rules engine, and the reported hit rates are
// counted from what actually happened on the field.
import { CONFIG } from '../src/config.js';
import { RulesEngine, throwingTeamForRound } from '../src/rules.js';
import {
  DEFAULT_DIFFICULTY,
  DEFAULT_SEATS,
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  createAI,
  normalizeSeats,
  seatKey,
} from '../src/ai.js';
import {
  ballAt,
  ballData,
  createBalls,
  executionRate,
  placeBalls,
  playMatch,
} from './lib/headless-match.mjs';

let checks = 0;
let failures = 0;

function check(name, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

const ALL = ['0:0', '0:1', '1:0', '1:1'];
const seatsFor = (difficulty) => Object.fromEntries(ALL.map((key) => [key, difficulty]));

/* ------------------------------------------------------- seats & setup --- */

console.log('\nSeat configuration');
eq('seat keys are team:player', seatKey(1, 0), '1:0');
eq('default seat for Zananda P1 is the human', DEFAULT_SEATS['1:0'], 'human');
eq('the other three default seats are AI', ALL.filter((k) => DEFAULT_SEATS[k] === 'ai').length, 3);
eq('empty input normalises to the default line-up', JSON.stringify(normalizeSeats({})), JSON.stringify(DEFAULT_SEATS));

const cleaned = normalizeSeats({ '0:0': 'ai', '0:1': 'nonsense', '1:0': 'human', '1:1': 'ai' });
eq('an unknown seat value falls back to human', cleaned['0:1'], 'human');
eq('normalised line-up keeps a full four seats', Object.keys(cleaned).length, 4);
eq('the default difficulty exists', DIFFICULTIES[DEFAULT_DIFFICULTY] !== undefined, true);

console.log('\nDifficulty profiles');
eq('three difficulties are offered', DIFFICULTY_ORDER.length, 3);
check(
  'aim error falls from Beginner to Professional',
  DIFFICULTIES.beginner.aimSigma > DIFFICULTIES.intermediate.aimSigma
    && DIFFICULTIES.intermediate.aimSigma > DIFFICULTIES.professional.aimSigma,
  `${DIFFICULTIES.beginner.aimSigma} / ${DIFFICULTIES.intermediate.aimSigma} / ${DIFFICULTIES.professional.aimSigma}`
);

/* ------------------------------------------- a whole match, all seats AI --- */

console.log('\nFull AI-vs-AI match');
const full = playMatch({ seatPlan: seatsFor('professional'), seed: 2024, maxThrows: 900 });
check('every AI action was legal', full.illegal.length === 0, full.illegal.slice(0, 4).join(' | '));
check('the match reached 21 points', full.matchOver && Math.max(...full.scores) >= 21, `scores ${full.scores.join('-')}`);
check('the winner has at least 21', full.scores[full.winner] >= 21, `scores ${full.scores.join('-')}`);
check('the losing score is below 21', full.scores[1 - full.winner] < 21, `scores ${full.scores.join('-')}`);
check('all four seats played', ALL.every((seat) => (full.throwsBySeat.get(seat) || 0) > 0), JSON.stringify([...full.throwsBySeat]));
check('the match lasted more than one round', full.rounds > 1, `rounds ${full.rounds}`);
check('AI never passed a legal turn', full.passes === 0, `passes ${full.passes}`);

/* ------------------------------------------------------------ turn order --- */

console.log('\nTurn order with AI seats');
const perRound = new Map();
for (const entry of full.turnLog) {
  if (!perRound.has(entry.round)) perRound.set(entry.round, []);
  perRound.get(entry.round).push(entry.seat);
}
let orderChecked = 0;
for (const [round, seats] of perRound) {
  if (seats.length < 4) continue;
  const throwing = throwingTeamForRound(round);
  const expected = [seatKey(throwing, 0), seatKey(throwing, 1), seatKey(1 - throwing, 0), seatKey(1 - throwing, 1)];
  eq(`round ${round} plays thrower P1, thrower P2, defender P1, defender P2`, seats.slice(0, 4).join(','), expected.join(','));
  orderChecked += 1;
}
check('turn order was verified for every completed round', orderChecked === full.rounds, `checked ${orderChecked} of ${full.rounds}`);

/* ---------------------------------------- measured difficulty separation --- */

console.log('\nMeasured performance (self-play, real physics)');
const measured = {};
for (const difficulty of DIFFICULTY_ORDER) {
  const stats = playMatch({ seatPlan: seatsFor(difficulty), seed: 4242, maxThrows: 700 });
  const rate = executionRate(stats);
  const points = stats.pointsByTeam[0] + stats.pointsByTeam[1];
  measured[difficulty] = {
    rate,
    tir: stats.execution.tir,
    mat: stats.execution.mat,
    pointsPerThrow: stats.throws ? points / stats.throws : 0,
    throws: stats.throws,
    illegal: stats.illegal,
  };
  const m = measured[difficulty];
  console.log(
    `  ${difficulty.padEnd(12)} ${m.throws} throws · aimed-shot success ${pct(rate)}`
    + ` · Tir ${m.tir[1]}/${m.tir[0]} · Mat ${m.mat[1]}/${m.mat[0]}`
    + ` · ${m.pointsPerThrow.toFixed(3)} points/throw`
  );
  check(`${difficulty} played a legal match`, m.illegal.length === 0, m.illegal.slice(0, 3).join(' | '));
}

const rBegin = measured.beginner.rate;
const rMid = measured.intermediate.rate;
const rPro = measured.professional.rate;

check('Beginner converts measurably fewer shots than Intermediate', rBegin <= rMid - 0.08, `${pct(rBegin)} vs ${pct(rMid)}`);
check('Intermediate converts measurably fewer shots than Professional', rMid <= rPro - 0.04, `${pct(rMid)} vs ${pct(rPro)}`);
check('Professional is clearly the strongest', rPro >= rBegin + 0.15, `${pct(rPro)} vs ${pct(rBegin)}`);
check('Professional lands most of its intended shots', rPro >= 0.75, pct(rPro));
check(
  'points per throw improve with difficulty',
  measured.professional.pointsPerThrow > measured.beginner.pointsPerThrow,
  `${measured.beginner.pointsPerThrow.toFixed(3)} -> ${measured.professional.pointsPerThrow.toFixed(3)}`
);
check(
  'every difficulty attempted both Tirs and Mats',
  DIFFICULTY_ORDER.every((d) => measured[d].tir[0] > 0 && measured[d].mat[0] > 0),
  DIFFICULTY_ORDER.map((d) => `${d}:${measured[d].tir[0]}/${measured[d].mat[0]}`).join(' ')
);

/* ------------------------------------------------------------ head to head --- */

console.log('\nHead to head');
const h2hA = playMatch({ seatPlan: { '0:0': 'professional', '0:1': 'professional', '1:0': 'beginner', '1:1': 'beginner' }, seed: 7, maxThrows: 900 });
const h2hB = playMatch({ seatPlan: { '0:0': 'beginner', '0:1': 'beginner', '1:0': 'professional', '1:1': 'professional' }, seed: 11, maxThrows: 900 });
const proPoints = h2hA.pointsByTeam[0] + h2hB.pointsByTeam[1];
const begPoints = h2hA.pointsByTeam[1] + h2hB.pointsByTeam[0];
console.log(`  Professional ${proPoints} points · Beginner ${begPoints} points over two matches`);
check('both head-to-head matches were legal', h2hA.illegal.length === 0 && h2hB.illegal.length === 0, [...h2hA.illegal, ...h2hB.illegal].slice(0, 3).join(' | '));
check('Professional outscores Beginner over both matches', proPoints > begPoints, `${proPoints} vs ${begPoints}`);

/* ------------------------------------------------------------- seat matrix --- */

console.log('\nAll 16 human/AI seat combinations');
const MATRIX_THROWS = 12;
let matrixLegal = 0;
let aiSeatsPlayed = 0;
for (let mask = 0; mask < 16; mask += 1) {
  const plan = {};
  ALL.forEach((seat, index) => {
    plan[seat] = mask & (1 << index) ? 'ai' : 'human';
  });
  const stats = playMatch({ seatPlan: plan, seed: 100 + mask, maxThrows: MATRIX_THROWS, maxRounds: 3 });
  const aiSeats = ALL.filter((seat) => plan[seat] === 'ai');
  const legal = stats.illegal.length === 0;
  if (legal) matrixLegal += 1;
  if (aiSeats.every((seat) => (stats.throwsBySeat.get(seat) || 0) > 0)) aiSeatsPlayed += 1;
  if (!legal) console.error(`  FAIL line-up ${ALL.map((s) => `${s}=${plan[s]}`).join(' ')} — ${stats.illegal.slice(0, 2).join(' | ')}`);
}
eq('all 16 line-ups played legally', matrixLegal, 16);
eq('every AI seat actually took a throw in each line-up', aiSeatsPlayed, 16);

/* ------------------------------------------------------- Mat-per decisions --- */

console.log('\nMat-per handling');
const matPerOffers = full.matPer.offers + h2hA.matPer.offers + h2hB.matPer.offers;
check(
  'AI answered every Mat-per offer it was given',
  matPerOffers > 0 && full.matPer.hold + full.matPer.play + h2hA.matPer.hold + h2hA.matPer.play + h2hB.matPer.hold + h2hB.matPer.play >= matPerOffers,
  `offers ${matPerOffers}`
);
console.log(`  offers ${matPerOffers} · held ${full.matPer.hold + h2hA.matPer.hold + h2hB.matPer.hold} · played on ${full.matPer.play + h2hA.matPer.play + h2hB.matPer.play}`);

/* ---------------------------------------------------- decision purity unit --- */

console.log('\nDecision purity');
const engine = new RulesEngine({ round: 1 });
const balls = createBalls();
placeBalls(balls, engine.state.throwingTeam);
const before = JSON.stringify(engine.state);
const ai = createAI({ difficulty: 'professional', seed: 5 });
const decision = ai.chooseThrow(engine, ballData(balls), CONFIG);
check('chooseThrow leaves the engine untouched', JSON.stringify(engine.state) === before);
check('chooseThrow returns a throw with an in-range angle', Math.abs(decision.angle) <= CONFIG.maxAimAngle + 1e-9, `angle ${decision.angle}`);
check('chooseThrow returns a throw with an in-range power', decision.power >= 0 && decision.power <= 1, `power ${decision.power}`);
check(
  'the chosen target is one the rules allow',
  engine.availableTargets().some((t) => t.key === seatKey(decision.target.teamIndex, decision.target.playerIndex)),
  JSON.stringify(decision.target)
);
const shooter = ballAt(balls, engine.state.turn.teamIndex, engine.state.turn.playerIndex);
check('the shooter exists at the active seat', Boolean(shooter), `${engine.state.turn.teamIndex}:${engine.state.turn.playerIndex}`);
const twinA = createAI({ difficulty: 'beginner', seed: 9 });
const twinB = createAI({ difficulty: 'beginner', seed: 9 });
check(
  'two AIs with the same seed make the same first decision',
  JSON.stringify(twinA.chooseThrow(engine, ballData(balls), CONFIG))
    === JSON.stringify(twinB.chooseThrow(engine, ballData(balls), CONFIG))
);

/* ---------------------------------------------------------------- result --- */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} AI check(s) failed`);
  process.exit(1);
}
