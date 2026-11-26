// Diagnostic probe: is a mat actually landable by the game's own integrator?
//
//   node scripts/probe-mat-window.mjs
//
// For a shooter on the throwing line it sweeps the whole power range and reports
// which powers settle the goolah inside each dish. If no power lands in a dish,
// no AI (or human) can ever complete that mat, which is what the AI difficulty
// ladder collapses on.

import { CONFIG } from '../src/config.js';
import { simulateShot } from '../src/physics.js';
import { matSurface, powerForDistance } from '../src/ai.js';

const surface = matSurface(CONFIG);
const CAPTURE = CONFIG.matRadius * 0.75;

function matAt(x, z) {
  for (let i = 0; i < CONFIG.matZ.length; i += 1) {
    if (Math.hypot(x - CONFIG.matX, z - CONFIG.matZ[i]) <= CAPTURE) return i;
  }
  return -1;
}

function scan(shooter, label) {
  const dir = { x: 0, y: 0, z: 1 };
  const windows = CONFIG.matZ.map(() => ({ lo: null, hi: null, count: 0 }));
  const STEPS = 800;
  for (let i = 0; i <= STEPS; i += 1) {
    const power = i / STEPS;
    const shot = simulateShot(
      { x: shooter.x, y: CONFIG.ballRadius, z: shooter.z },
      dir,
      power,
      CONFIG,
      { step: 1 / 120, maxTime: 16, surface }
    );
    const index = matAt(shot.rest.x, shot.rest.z);
    if (index < 0) continue;
    const w = windows[index];
    w.lo = w.lo === null ? power : Math.min(w.lo, power);
    w.hi = power;
    w.count += 1;
  }

  console.log(`\n${label}  shooter z=${shooter.z.toFixed(2)}`);
  CONFIG.matZ.forEach((z, index) => {
    const w = windows[index];
    const distance = z - shooter.z;
    const predicted = powerForDistance(Math.max(0.01, distance), CONFIG);
    if (w.count === 0) {
      console.log(`  mat ${index + 1} (z=${z}) distance ${distance.toFixed(2)}m : UNLANDABLE`);
      return;
    }
    const width = w.hi - w.lo;
    console.log(
      `  mat ${index + 1} (z=${z}) distance ${distance.toFixed(2)}m : power `
      + `${w.lo.toFixed(3)}..${w.hi.toFixed(3)} (width ${width.toFixed(3)}, `
      + `${w.count} samples) · powerForDistance=${predicted.toFixed(3)}`
    );
  });
}

console.log(`capture radius ${CAPTURE.toFixed(3)} m · matRadius ${CONFIG.matRadius}`);
console.log(`maxAimAngle ${CONFIG.maxAimAngle} · maxSpeed ${CONFIG.maxSpeed} · rollFriction ${CONFIG.rollFriction}`);

scan({ x: 0, z: CONFIG.throwLineZ }, 'from the throwing line');
scan({ x: 0, z: CONFIG.matZ[0] - 1.2 }, 'from behind mat 1');
scan({ x: 1.2, z: 0.2 }, 'from mid-field');
