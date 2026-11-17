// Headless Phase 1 checks for Goolah Bazy.
//
// Verifies the field layout, goolah placement, throwing physics, heavy-ball
// collisions and turn order against the same modules the game runs, so a
// regression shows up without a browser.
//
//   node scripts/test-phase1.mjs
import * as THREE from 'three';
import {
  CONFIG,
  MAT_COUNT,
  matCenter,
  matIndexFor,
  homePosition,
  throwPosition,
} from '../src/config.js';
import {
  createBody,
  resolveBallCollision,
  simulateShot,
  stepBallMotion,
} from '../src/physics.js';
import { roundTurns } from '../src/turn.js';

const failures = [];
let passed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const FORWARD = new THREE.Vector3(0, 0, 1);

function aim(angle) {
  return new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle)).normalize();
}

// The dish profile the mats use: 5 cm deep at the centre, flat outside the
// radius. Mirrors the surface the game hands to the physics step.
function surfaceAt(x, z) {
  let y = 0;
  for (let i = 0; i < MAT_COUNT; i += 1) {
    const d = Math.hypot(x - CONFIG.matX, z - CONFIG.matZ[i]);
    if (d < CONFIG.matRadius) {
      const t = 1 - (d / CONFIG.matRadius) ** 2;
      y = Math.min(y, -CONFIG.matDepth * t);
    }
  }
  return y;
}

/* ---------------------------------------------------------------- layout --- */

check('there are four mats', MAT_COUNT === 4, `MAT_COUNT=${MAT_COUNT}`);
check(
  'all mats share one x',
  CONFIG.matZ.every((_, i) => near(matCenter(i).x, CONFIG.matX)),
  CONFIG.matZ.map((_, i) => matCenter(i).x).join(',')
);
check(
  'mats sit in one straight line, evenly spaced',
  CONFIG.matZ.every((z, i) => i === 0 || near(z - CONFIG.matZ[i - 1], 2.6)),
  CONFIG.matZ.join(',')
);
check(
  'mats are ordered near to far from the throw line',
  CONFIG.matZ.every((z, i) => i === 0 || z > CONFIG.matZ[i - 1]),
  CONFIG.matZ.join(',')
);
check('mats are shallow, 5 cm deep', near(CONFIG.matDepth, 0.05), `${CONFIG.matDepth}`);
check(
  'a goolah is wider than a mat is deep, so it cannot drop through',
  CONFIG.ballRadius * 2 > CONFIG.matDepth,
  `diameter=${(CONFIG.ballRadius * 2).toFixed(3)}`
);

/* ------------------------------------------------------------- ownership --- */

check(
  'mats 1 and 3 belong to Shananda, 2 and 4 to the opponents',
  CONFIG.matOwner.join(',') === '0,1,0,1',
  CONFIG.matOwner.join(',')
);
check('team 0 player 1 owns mat 1', matIndexFor(0, 0) === 0, `${matIndexFor(0, 0)}`);
check('team 0 player 2 owns mat 3', matIndexFor(0, 1) === 2, `${matIndexFor(0, 1)}`);
check('team 1 player 1 owns mat 2', matIndexFor(1, 0) === 1, `${matIndexFor(1, 0)}`);
check('team 1 player 2 owns mat 4', matIndexFor(1, 1) === 3, `${matIndexFor(1, 1)}`);

for (const team of [0, 1]) {
  for (const player of [0, 1]) {
    const home = homePosition(team, player);
    const own = matCenter(matIndexFor(team, player));
    check(
      `goolah T${team}P${player + 1} waits beside its own mat`,
      near(home.z, own.z) && Math.abs(home.x - own.x) >= CONFIG.matRadius,
      `home=${home.x.toFixed(2)},${home.z.toFixed(2)} mat=${own.x.toFixed(2)},${own.z.toFixed(2)}`
    );
  }
}

const homes = [homePosition(0, 0), homePosition(0, 1), homePosition(1, 0), homePosition(1, 1)];
check(
  'the four goolahs rest in four different spots',
  new Set(homes.map((h) => `${h.x.toFixed(2)}:${h.z.toFixed(2)}`)).size === 4
);

/* ---------------------------------------------------------- the throw line - */

const throw0 = throwPosition(0);
const throw1 = throwPosition(1);
check(
  'both players throw from the same line',
  near(throw0.z, throw1.z) && near(throw0.z, CONFIG.throwLineZ),
  `${throw0.z} vs ${throw1.z}`
);
check(
  'the line is behind mat 1',
  CONFIG.throwLineZ < CONFIG.matZ[0],
  `line=${CONFIG.throwLineZ} mat1=${CONFIG.matZ[0]}`
);
check(
  'the two players stand apart on the line',
  Math.abs(throw0.x - throw1.x) > 0.5,
  `${throw0.x} vs ${throw1.x}`
);

/* --------------------------------------------------------------- throwing -- */

const full = simulateShot(throw0, FORWARD, 1, CONFIG, { maxTime: 20 });
const soft = simulateShot(throw0, FORWARD, 0, CONFIG, { maxTime: 20 });

check(
  'a full-power throw rolls beyond mat 4',
  full.rest.z > CONFIG.matZ[3] + 0.8,
  `rested at z=${full.rest.z.toFixed(2)}, mat 4 is ${CONFIG.matZ[3]}`
);
check(
  'a full-power throw stays on the field',
  full.rest.z < CONFIG.matZ[3] + 5,
  `rested at z=${full.rest.z.toFixed(2)}`
);
check(
  'the softest throw stops short of mat 1',
  soft.rest.z < CONFIG.matZ[0],
  `rested at z=${soft.rest.z.toFixed(2)}, mat 1 is ${CONFIG.matZ[0]}`
);
check('a thrown goolah comes to rest', full.resting === true && soft.resting === true);
check(
  'the goolah stays on the ground plane',
  near(full.rest.y, CONFIG.ballRadius, 0.06),
  `y=${full.rest.y.toFixed(3)}`
);

// Power must be a monotonic control, otherwise the bar lies to the player.
const powers = [0, 0.25, 0.5, 0.75, 1];
const ranges = powers.map((p) => simulateShot(throw0, FORWARD, p, CONFIG, { maxTime: 20 }).rest.z);
check(
  'more power always means a longer throw',
  ranges.every((z, i) => i === 0 || z > ranges[i - 1]),
  ranges.map((z) => z.toFixed(2)).join(' < ')
);

// A medium throw should be able to reach the middle of the line of mats, which
// is what makes aiming at a specific mat possible.
const mid = simulateShot(throw0, FORWARD, 0.5, CONFIG, { maxTime: 20 }).rest.z;
check(
  'half power reaches the middle mats',
  mid > CONFIG.matZ[0] && mid < CONFIG.matZ[3] + 1,
  `half power rested at z=${mid.toFixed(2)}`
);

// Direction: dragging across the line must steer the throw.
const left = simulateShot(throw0, aim(-0.2), 0.7, CONFIG, { maxTime: 20 });
const right = simulateShot(throw0, aim(0.2), 0.7, CONFIG, { maxTime: 20 });
check(
  'aiming left steers the throw left',
  left.rest.x < -0.4,
  `x=${left.rest.x.toFixed(2)}`
);
check(
  'aiming right steers the throw right',
  right.rest.x > 0.4,
  `x=${right.rest.x.toFixed(2)}`
);

/* ---------------------------------------------------------------- the dish - */

const flat = createBody(0, CONFIG.ballRadius, 20, CONFIG.ballRadius);
for (let i = 0; i < 600 && !flat.resting; i += 1) stepBallMotion(flat, 1 / 120, CONFIG);
check(
  'on flat ground a goolah rests at its own radius',
  near(flat.pos.y, CONFIG.ballRadius, 1e-3),
  `y=${flat.pos.y.toFixed(4)}`
);

const dish = createBody(CONFIG.matX, CONFIG.ballRadius, CONFIG.matZ[1], CONFIG.ballRadius);
for (let i = 0; i < 600 && !dish.resting; i += 1) {
  stepBallMotion(dish, 1 / 120, CONFIG, surfaceAt);
}
check(
  'inside a mat a goolah sits 5 cm lower',
  near(dish.pos.y, CONFIG.ballRadius - CONFIG.matDepth, 2e-3),
  `y=${dish.pos.y.toFixed(4)} expected ${(CONFIG.ballRadius - CONFIG.matDepth).toFixed(4)}`
);

/* ------------------------------------------------------------- collisions -- */

const striker = createBody(0, CONFIG.ballRadius, 0, CONFIG.ballRadius);
const target = createBody(0, CONFIG.ballRadius, CONFIG.ballRadius * 1.9, CONFIG.ballRadius);
striker.vel.set(0, 0, 6);

const hit = resolveBallCollision(striker, target, CONFIG);
check('a moving goolah collides with a resting one', hit.hit === true);
check('the collision reports an impact speed', hit.impactSpeed > 5, `${hit.impactSpeed.toFixed(2)}`);
check('the striker loses speed', striker.vel.z < 6, `v=${striker.vel.z.toFixed(2)}`);
check('the struck goolah is driven forward', target.vel.z > 1, `v=${target.vel.z.toFixed(2)}`);
check(
  'heavy steel keeps most of the momentum',
  target.vel.z > striker.vel.z,
  `${target.vel.z.toFixed(2)} vs ${striker.vel.z.toFixed(2)}`
);
check(
  'collided goolahs never overlap',
  striker.pos.distanceTo(target.pos) >= CONFIG.ballRadius * 2 - 1e-6,
  `d=${striker.pos.distanceTo(target.pos).toFixed(4)}`
);

const apart = createBody(0, CONFIG.ballRadius, 0, CONFIG.ballRadius);
const far = createBody(0, CONFIG.ballRadius, CONFIG.ballRadius * 4, CONFIG.ballRadius);
check(
  'goolahs that are not touching do not collide',
  resolveBallCollision(apart, far, CONFIG).hit === false
);

/* -------------------------------------------------------------- turn order - */

const round0 = roundTurns(0);
check('a round is four throws', round0.length === 4, `${round0.length}`);
check(
  'both players of one team throw before the opponents',
  round0.map((t) => t.teamIndex).join(',') === '0,0,1,1',
  round0.map((t) => t.teamIndex).join(',')
);
check(
  'each team uses player 1 then player 2',
  round0.map((t) => t.playerIndex).join(',') === '0,1,0,1',
  round0.map((t) => t.playerIndex).join(',')
);

const round1 = roundTurns(1);
check(
  'the starting team alternates between rounds',
  round1.map((t) => t.teamIndex).join(',') === '1,1,0,0',
  round1.map((t) => t.teamIndex).join(',')
);

// Two rounds back to back: the block boundary is where the team changes.
const twoRounds = [...roundTurns(0), ...roundTurns(1)];
check(
  'teams alternate in blocks across rounds',
  twoRounds.map((t) => t.teamIndex).join(',') === '0,0,1,1,1,1,0,0',
  twoRounds.map((t) => t.teamIndex).join(',')
);

/* ----------------------------------------------------------------- report -- */

if (failures.length) {
  console.error(`\nFAILED (${failures.length} of ${passed + failures.length}):`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}

console.log(`Phase 1 checks passed (${passed}).`);
console.log(
  JSON.stringify(
    {
      mats: CONFIG.matZ,
      owners: CONFIG.matOwner,
      throwLineZ: CONFIG.throwLineZ,
      restZ: { soft: +soft.rest.z.toFixed(2), full: +full.rest.z.toFixed(2) },
      powerRange: ranges.map((z) => +z.toFixed(2)),
      turnOrder: round0.map((t) => `T${t.teamIndex}P${t.playerIndex + 1}`),
    },
    null,
    2
  )
);
