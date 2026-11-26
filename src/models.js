// The game pieces: cast-metal goolahs and turned earth mats.
//
// Both are modelled here, once, so the live game renders exactly these meshes.
// The mat dish is lathed from the same profile terrain.js uses for collision,
// so the rim you can see is the rim the goolah has to climb.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { MAT, dishMeshProfile } from './terrain.js';

/* ------------------------------------------------------- shared textures --- */

let _brushed = null;

/**
 * Cast and machined steel. Used as roughness *and* bump so the highlight breaks
 * up over pitting instead of running across perfectly smooth chrome.
 */
function brushedSteel() {
  if (_brushed) return _brushed;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#7d7d7d';
  g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 1100; i += 1) {
    const x = Math.random() * 256;
    const y = Math.random() * 128;
    const len = 2 + Math.random() * 24;
    const v = 96 + Math.random() * 100;
    g.strokeStyle = `rgba(${v},${v},${v},0.34)`;
    g.lineWidth = 0.6 + Math.random() * 1.3;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y + len);
    g.stroke();
  }
  for (let i = 0; i < 600; i += 1) {
    const r = 0.4 + Math.random() * 1.7;
    g.fillStyle = `rgba(48,48,48,${0.2 + Math.random() * 0.45})`;
    g.beginPath();
    g.arc(Math.random() * 256, Math.random() * 128, r, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  _brushed = tex;
  return tex;
}

let _clay = null;

/** Baked clay with grit, for the turned dish. */
function bakedClay() {
  if (_clay) return _clay;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#b9926c';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 5200; i += 1) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 0.5 + Math.random() * 2.6;
    const dark = Math.random() < 0.55;
    const v = dark ? 90 + Math.random() * 50 : 150 + Math.random() * 70;
    g.fillStyle = `rgba(${v},${Math.round(v * 0.82)},${Math.round(v * 0.62)},${0.12 + Math.random() * 0.3})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // Fine gravel flecks.
  for (let i = 0; i < 900; i += 1) {
    const v = 120 + Math.random() * 90;
    g.fillStyle = `rgba(${v},${v},${v},${0.25 + Math.random() * 0.35})`;
    g.fillRect(Math.random() * size, Math.random() * size, 1.4, 1.4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  _clay = tex;
  return tex;
}

/* --------------------------------------------------------------- goolahs --- */

/**
 * A goolah: a heavy cast steel ball with a machined seam, a team inlay in the
 * seam and cast pips at the poles.
 *
 * The whole group is rotated by the simulation quaternion, so the seam and pips
 * make the roll readable — the rotation is the physics rotation, not an
 * animation.
 */
export function createGoolah(team, radius = CONFIG.ballRadius) {
  const group = new THREE.Group();
  const steelTex = brushedSteel();

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 64, 48),
    new THREE.MeshStandardMaterial({
      color: 0xd9dfe8,
      metalness: 1,
      roughness: 0.26,
      roughnessMap: steelTex,
      bumpMap: steelTex,
      bumpScale: 0.0045,
      envMapIntensity: 1.9,
    }),
  );
  ball.castShadow = true;
  ball.receiveShadow = true;
  group.add(ball);

  // Machined seam: a dark groove around the equator.
  const seam = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.997, radius * 0.042, 8, 64),
    new THREE.MeshStandardMaterial({ color: 0x39424f, metalness: 0.95, roughness: 0.42 }),
  );
  seam.rotation.x = Math.PI / 2;
  group.add(seam);

  // Team inlay sitting in the seam.
  const inlay = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.999, radius * 0.016, 6, 64),
    new THREE.MeshStandardMaterial({
      color: team.color,
      metalness: 0.7,
      roughness: 0.3,
      emissive: team.color,
      emissiveIntensity: 0.3,
    }),
  );
  inlay.rotation.x = Math.PI / 2;
  group.add(inlay);

  // Cast pips at the poles.
  const pipGeo = new THREE.SphereGeometry(radius * 0.11, 16, 12);
  const pipMat = new THREE.MeshStandardMaterial({
    color: 0xc2cad5,
    metalness: 1,
    roughness: 0.34,
  });
  for (const sign of [1, -1]) {
    const pip = new THREE.Mesh(pipGeo, pipMat);
    pip.position.y = sign * radius * 0.955;
    group.add(pip);
  }

  return { group, ball, seam, inlay };
}

/* ------------------------------------------------------------------ mats --- */

/**
 * A mat: a shallow turned dish with a raised rim, a recessed centre and a
 * team-coloured inlay on the crest.
 *
 * The lathe profile comes from terrain.js, which is also what the physics
 * samples, so the goolah climbs and drops into exactly the shape that is drawn.
 */
export function createMatDish(team, radius = CONFIG.matRadius, depth = CONFIG.matDepth) {
  const group = new THREE.Group();
  const clay = bakedClay();

  const profile = dishMeshProfile(radius, depth).map(([r, y]) => new THREE.Vector2(r, y));
  const dish = new THREE.Mesh(
    new THREE.LatheGeometry(profile, 84),
    new THREE.MeshStandardMaterial({
      map: clay,
      color: 0xc49a71,
      roughness: 0.96,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }),
  );
  dish.castShadow = true;
  dish.receiveShadow = true;
  group.add(dish);

  // The recessed floor, darker so the hollow reads from any camera angle.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.6, 48),
    new THREE.MeshStandardMaterial({ map: clay, color: 0x7d5836, roughness: 0.98 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -depth + 0.005;
  floor.receiveShadow = true;
  group.add(floor);

  // Team inlay on the rim crest. Its top sits exactly at the collision crest.
  const inlay = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 1.0, 0.011, 8, 72),
    new THREE.MeshStandardMaterial({
      color: team.color,
      metalness: 0.55,
      roughness: 0.35,
      emissive: team.color,
      emissiveIntensity: 0.4,
    }),
  );
  inlay.rotation.x = -Math.PI / 2;
  inlay.position.y = MAT.rim - 0.011;
  group.add(inlay);

  return { group, dish, floor, inlay };
}
