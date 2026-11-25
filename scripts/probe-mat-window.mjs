// Diagnostic probe (not a test): is a mat physically makeable, and how wide is
// the power window that actually settles a goolah inside the dish?
//
//   node scripts/probe-mat-window.mjs
import { CONFIG, defenderPosition, throwPosition } from '../src/config.js';
import { simulateShot } from '../src/physics.js';
import { matSurface, distanceForPower } from '../src/ai.js';

const surface = matSurface(CONFIG);
const inDish = (x, z, i) =>
  Math.hypot(x - CONFIG.matX, z - CONFIG.matZ[i]) <= CONFIG.matRadius * 0.75;

function scan(label, start) {
  const rows = [];
  const N = 400;
  for (let k = 0; k <= N; k += 1) {
    const power = k / N;
    const dir = { x: 0, y: 0, z: 1 };
    // Aim straight down the line, then aim at each mat centre within the clamp.
    const shot = simulateShot(start, dir, power, CONFIG, { surface });
    rows.push({ power, rest: shot.rest, dist: shot.along, resting: shot.resting });
  }
  console.log(`\n${label}  start (${start.x.toFixed(2)}, ${start.z.toFixed(2)})`);
  for (let i = 0; i < CONFIG.matZ.length; i += 1) {
    const hits = rows.filter((r) => inDish(r.rest.x, r.rest.z, i));
    const best = rows.reduce(
      (acc, r) => {
        const err = Math.hypot(r.rest.x - CONFIG.matX, r.rest.z - CONFIG.matZ[i]);
        return err < acc.err ? { err, power: r.power, rest: r.rest } : acc;
      },
      { err: Infinity, power: 0, rest: null }
    );
    const width = hits.length ? hits[hits.length - 1].power - hits[0].power : 0;
    console.log(
      `  mat ${i + 1} z=${CONFIG.matZ[i]}  landings=${hits.length}/${N + 1}`
      + `  window=${width.toFixed(4)} power`
      + `  bestErr=${best.err.toFixed(3)} m at power ${best.power.toFixed(3)}`
      + `  (rest z ${best.rest.z.toFixed(2)}, x ${best.rest.x.toFixed(2)})`
    );
  }
  console.log(
    `  range: p0=${distanceForPower(0, CONFIG).toFixed(2)}m`
    + ` p.25=${distanceForPower(0.25, CONFIG).toFixed(2)}m`
    + ` p.5=${distanceForPower(0.5, CONFIG).toFixed(2)}m`
    + ` p1=${distanceForPower(1, CONFIG).toFixed(2)}m`
  );
}

console.log('CONFIG', {
  matZ: CONFIG.matZ,
  matX: CONFIG.matX,
  matRadius: CONFIG.matRadius,
  matDepth: CONFIG.matDepth,
  throwLineZ: CONFIG.throwLineZ,
  ballRadius: CONFIG.ballRadius,
  minSpeed: CONFIG.minSpeed,
  maxSpeed: CONFIG.maxSpeed,
  rollFriction: CONFIG.rollFriction,
  sleepSpeed: CONFIG.sleepSpeed,
});

scan('throw line P1', throwPosition(0));
scan('throw line P2', throwPosition(1));
scan('defender P1', defenderPosition(0));
scan('defender P2', defenderPosition(1));
