import { CONFIG } from '../src/config.js';
import { simulateShot } from '../src/physics.js';
import { createAI, matSurface } from '../src/ai.js';
import { RulesEngine, ballKey } from '../src/rules.js';
import {
  createBalls, placeBalls, runShot, settle, shotReport, ballData, ballAt, matAt,
} from './lib/headless-match.mjs';

const SURFACE = matSurface(CONFIG);
const predictRest = (sx, sz, angle, power) => simulateShot(
  { x: sx, y: CONFIG.ballRadius, z: sz },
  { x: Math.sin(angle), y: 0, z: Math.cos(angle) },
  power, CONFIG, { step: 1 / 120, maxTime: 16, surface: SURFACE },
).rest;

const engine = new RulesEngine({ round: 1 });
const balls = createBalls();
placeBalls(balls, engine.state.throwingTeam);
const brains = new Map();
const brain = (t, p) => {
  const k = ballKey(t, p);
  if (!brains.has(k)) brains.set(k, createAI({ difficulty: 'professional', seed: 7 + t * 31 + p * 7 }));
  return brains.get(k);
};

let logged = 0;
let throws = 0;
let matAttempts = 0;
let matMade = 0;

while (!engine.state.matchOver && throws < 60) {
  const s = engine.state;
  if (s.roundOver) { engine.startRound(s.round + 1); placeBalls(balls, engine.state.throwingTeam); continue; }
  if (!engine.canThrow()) { engine.endTurn(); continue; }

  const { teamIndex: t, playerIndex: p } = s.turn;
  const shooter = ballAt(balls, t, p);
  const action = brain(t, p).chooseThrow(engine, ballData(balls), CONFIG);
  if (!action || action.pass) { engine.endTurn(); continue; }

  const target = action.target || {};
  const sx = shooter.body.pos.x;
  const sz = shooter.body.pos.z;
  const pr = target.kind === 'mat' ? predictRest(sx, sz, action.angle, action.power) : null;

  const { hits } = runShot(balls, shooter, action.angle, action.power);
  settle(balls);
  const report = shotReport(engine, shooter, hits, balls);

  if (target.kind === 'mat') {
    matAttempts += 1;
    if (report.ownMatIndex === target.matIndex) matMade += 1;
    if (logged < 10) {
      logged += 1;
      const ar = shooter.body.pos;
      const hitList = [...hits.values()].map((h) => `${h.teamIndex}:${h.playerIndex}`).join(',') || 'none';
      const near = balls
        .filter((b) => !(b.teamIndex === t && b.playerIndex === p))
        .map((b) => ({ k: b.key, d: Math.hypot(b.body.pos.x - sx, b.body.pos.z - sz).toFixed(2), x: b.body.pos.x.toFixed(2), z: b.body.pos.z.toFixed(2) }));
      console.log(`mat${target.matIndex + 1} by ${t}:${p} from (${sx.toFixed(2)},${sz.toFixed(2)}) ang=${action.angle.toFixed(3)} pow=${action.power.toFixed(3)}`);
      console.log(`   predicted (${pr.x.toFixed(3)},${pr.z.toFixed(3)}) inDish=${matAt(pr.x, pr.z) >= 0} | actual (${ar.x.toFixed(3)},${ar.z.toFixed(3)}) mat=${matAt(ar.x, ar.z)} | off=${Math.hypot(ar.x - pr.x, ar.z - pr.z).toFixed(3)}`);
      console.log(`   hits=${hitList} others=${JSON.stringify(near)}`);
    }
  }

  throws += 1;
  for (const restore of engine.resolveThrow(report).restore || []) {
    if (!restore.position) continue;
    const b = ballAt(balls, restore.teamIndex, restore.playerIndex);
    b.body.pos.set(restore.position.x, restore.position.y, restore.position.z);
    b.body.vel.set(0, 0, 0); b.body.resting = true;
    const m = matAt(b.body.pos.x, b.body.pos.z);
    b.state = m >= 0 ? 'mat' : 'settled'; b.matIndex = m;
  }
  engine.afterThrow(engine.state.lastResult || {});
}

console.log(`\nmat attempts ${matAttempts} made ${matMade} over ${throws} throws`);
