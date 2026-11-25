import { CONFIG } from '../src/config.js';
import { simulateShot } from '../src/physics.js';
import { matSurface, powerForDistance, createAI } from '../src/ai.js';
import { createBalls, placeBalls, runShot, matAt, ballAt, ballData } from './lib/headless-match.mjs';
import { RulesEngine } from '../src/rules.js';

const surface = matSurface(CONFIG);
const dirOf = (a) => ({ x: Math.sin(a), y: 0, z: Math.cos(a) });
const predict = (sx, sz, angle, power) => simulateShot(
  { x: sx, y: CONFIG.ballRadius, z: sz }, dirOf(angle), power, CONFIG,
  { step: 1 / 60, maxTime: 14, surface }
).rest;

function probe(label, team, player, matIndex) {
  const balls = createBalls();
  placeBalls(balls, team);
  const shooter = ballAt(balls, team, player);
  const sx = shooter.body.pos.x; const sz = shooter.body.pos.z;
  const dx = CONFIG.matX - sx; const dz = CONFIG.matZ[matIndex] - sz;
  const dist = Math.hypot(dx, dz);
  let angle = Math.atan2(dx, dz);
  angle = Math.max(-CONFIG.maxAimAngle, Math.min(CONFIG.maxAimAngle, angle));
  const base = powerForDistance(dist, CONFIG);
  let lo = 0.02, hi = 1, best = base, bestErr = Infinity;
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    const r = predict(sx, sz, angle, mid);
    const e = Math.hypot(r.x - sx, r.z - sz) - dist;
    if (Math.abs(e) < bestErr) { bestErr = Math.abs(e); best = mid; }
    if (e > 0) hi = mid; else lo = mid;
  }
  const pr = predict(sx, sz, angle, best);
  runShot(balls, shooter, angle, best);
  const ar = shooter.body.pos;
  console.log(`${label} mat${matIndex + 1} dist=${dist.toFixed(2)} angle=${angle.toFixed(3)} base=${base.toFixed(3)} refined=${best.toFixed(3)}`);
  console.log(`   predicted (${pr.x.toFixed(3)},${pr.z.toFixed(3)}) mat=${matAt(pr.x, pr.z)} | actual (${ar.x.toFixed(3)},${ar.z.toFixed(3)}) mat=${matAt(ar.x, ar.z)} | delta=${Math.hypot(ar.x - pr.x, ar.z - pr.z).toFixed(3)}`);
}

const engine = new RulesEngine({ round: 1 });
console.log('throwingTeam', engine.state.throwingTeam, 'captureSpeed', CONFIG.captureSpeed);
probe('throwlineP1', engine.state.throwingTeam, 0, 0);
probe('throwlineP1', engine.state.throwingTeam, 0, 1);
probe('defenderP1', 1 - engine.state.throwingTeam, 0, 2);
probe('defenderP2', 1 - engine.state.throwingTeam, 1, 3);

// What does the AI itself decide, and does that shot land?
const balls = createBalls();
placeBalls(balls, engine.state.throwingTeam);
const ai = createAI({ difficulty: 'professional', seed: 3 });
const d = ai.chooseThrow(engine, ballData(balls), CONFIG);
console.log('\nAI decision:', JSON.stringify(d));
if (d && d.type === 'throw') {
  const shooter = ballAt(balls, engine.state.turn.teamIndex, engine.state.turn.playerIndex);
  runShot(balls, shooter, d.angle, d.power);
  const ar = shooter.body.pos;
  console.log(`   executed -> rest (${ar.x.toFixed(3)},${ar.z.toFixed(3)}) mat=${matAt(ar.x, ar.z)} intended=${JSON.stringify(d.intended)}`);
}
