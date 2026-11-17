// Temporary tuning sweep: finds physics constants where
//   power 0   stops short of mat 1 (z < -3.9)
//   power 1   carries beyond mat 4  (z > 4.7)
//   power 0.5 lands among the middle mats
import * as THREE from 'three';
import { CONFIG, throwPosition } from '../src/config.js';
import { simulateShot } from '../src/physics.js';

const FORWARD = new THREE.Vector3(0, 0, 1);
const start = throwPosition(0);

const rows = [];
for (const rollFriction of [10, 11, 12, 13, 14]) {
  for (const maxSpeed of [14, 15, 16, 17]) {
    for (const maxLift of [3.6, 4.2, 4.8]) {
      const cfg = { ...CONFIG, rollFriction, maxSpeed, maxLift };
      const z = [0, 0.5, 1].map((p) => simulateShot(start, FORWARD, p, cfg, { maxTime: 25 }).rest.z);
      const ok = z[0] < -3.9 && z[2] > 4.7 && z[2] < 8.2 && z[1] > -3.9 && z[1] < 4.9;
      rows.push({ rollFriction, maxSpeed, maxLift, soft: +z[0].toFixed(2), mid: +z[1].toFixed(2), full: +z[2].toFixed(2), ok });
    }
  }
}

const good = rows.filter((r) => r.ok);
console.log('passing combinations:', good.length, 'of', rows.length);
for (const r of good.slice(0, 12)) console.log(JSON.stringify(r));
if (!good.length) {
  console.log('\nclosest attempts:');
  for (const r of rows.slice(0, 10)) console.log(JSON.stringify(r));
}
