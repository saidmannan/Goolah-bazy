// The shape of the ground.
//
// One module is the single source of truth for the surface, so the rendered
// ground, the modelled mat dishes and the simulated surface can never disagree:
//
//   * world.js      displaces the terrain mesh with terrainHeight()
//   * models.js     lathes the mat dish from dishProfile()
//   * physics.js    samples surfaceHeight() and surfaceNormal() every substep
//
// Everything here is deterministic (hash noise, no Math.random), which is what
// lets the AI and the headless tests predict the same surface the game runs.
import * as THREE from 'three';
import { CONFIG } from './config.js';

/** Relief of the natural ground. Metres. */
export const TERRAIN = {
  // Broad, gentle undulation of the plain.
  broad: 0.085,
  // Mid-scale lumps and hollows.
  mid: 0.022,
  // Clods, grit and small stones.
  fine: 0.007,
  // The swept court is packed much flatter than the plain around it, so play
  // stays fair while the ground still reads as worked earth.
  courtScale: 0.2,
  // The plain sits slightly below the court.
  plainDrop: 0.09,
  // Distance over which the court blends down into the plain.
  ramp: 2.6,
};

/** Mat shape, in metres / multiples of matRadius. */
export const MAT = {
  // Rim crest above the local ground. The ball has to climb this to get in.
  rim: 0.032,
  // The court mesh is cut at this radius (multiples of matRadius).
  holeRadius: 1.2,
  // The dish mesh is buried out to here, so the cut edge is always covered.
  skirtRadius: 1.45,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (t) => t * t * (3 - 2 * t);

/* ----------------------------------------------------------------- noise --- */

function hash2(ix, iz) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647 - 1;
}

/** Smooth value noise in [-1, 1]. Deterministic for a given point. */
export function valueNoise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = smooth(fx);
  const v = smooth(fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/* ------------------------------------------------------------- the court --- */

/** The swept strip: a little wider than the playable area. */
export function courtBounds() {
  return {
    halfWidth: CONFIG.playArea.halfWidth + 1.2,
    minZ: CONFIG.playArea.minZ - 1.2,
    maxZ: CONFIG.playArea.maxZ + 1.2,
  };
}

export function isOnCourt(x, z) {
  const b = courtBounds();
  return Math.abs(x) <= b.halfWidth && z >= b.minZ && z <= b.maxZ;
}

/**
 * Natural dirt: compacted earth with a broad fall, mid-scale lumps and fine
 * clods. Inside the court the relief is scaled right down so a goolah is never
 * steered by a bump, but the surface is still not a plane.
 */
export function terrainHeight(x, z) {
  let h = TERRAIN.broad * valueNoise(x * 0.11 + 4.2, z * 0.11 - 2.7);
  h += TERRAIN.mid * valueNoise(x * 0.37 - 9.1, z * 0.37 + 6.3);
  h += TERRAIN.fine * valueNoise(x * 1.45 + 1.7, z * 1.45 - 4.4);

  const b = courtBounds();
  const outside = Math.max(Math.abs(x) - b.halfWidth, b.minZ - z, z - b.maxZ);
  if (outside <= 0) return h * TERRAIN.courtScale;

  // Ease the court down into the plain instead of stepping off an edge.
  const t = smooth(clamp(outside / TERRAIN.ramp, 0, 1));
  const scale = TERRAIN.courtScale + (1 - TERRAIN.courtScale) * t;
  return h * scale - TERRAIN.plainDrop * t;
}

/* --------------------------------------------------------------- the mats --- */

/**
 * Turned profile of one dish, centre outwards, as [radius, height] pairs.
 *
 * Reading outward: a flat recessed floor, an inner wall that lifts out of the
 * hollow, a rounded raised rim crest, then a shoulder that falls back to ground
 * level. This is both the lathe profile of the visible dish and the collision
 * surface, so the ball rides exactly the rim you can see.
 */
export function dishProfile(R = CONFIG.matRadius, D = CONFIG.matDepth) {
  const H = MAT.rim;
  return [
    [0.0 * R, -D],
    [0.5 * R, -D],
    [0.62 * R, -0.96 * D],
    [0.72 * R, -0.8 * D],
    [0.8 * R, -0.52 * D],
    [0.86 * R, -0.18 * D],
    [0.9 * R, 0.19 * H],
    [0.94 * R, 0.69 * H],
    [0.98 * R, 0.94 * H],
    [1.0 * R, 1.0 * H],
    [1.03 * R, 0.94 * H],
    [1.07 * R, 0.75 * H],
    [1.12 * R, 0.38 * H],
    [1.18 * R, 0.09 * H],
    [1.22 * R, 0.0],
  ];
}

/** The visible dish plus the skirt that is buried under the court mesh. */
export function dishMeshProfile(R = CONFIG.matRadius, D = CONFIG.matDepth) {
  return [
    ...dishProfile(R, D),
    [1.3 * R, -0.012],
    [MAT.skirtRadius * R, -0.03],
  ];
}

/** Height of a mat above its own base ground, by distance from the centre. */
export function matRelief(distance, R = CONFIG.matRadius, D = CONFIG.matDepth) {
  const profile = dishProfile(R, D);
  const outer = profile[profile.length - 1][0];
  if (distance >= outer) return 0;
  for (let i = 1; i < profile.length; i += 1) {
    const [r1, y1] = profile[i];
    if (distance <= r1) {
      const [r0, y0] = profile[i - 1];
      const span = r1 - r0;
      const t = span > 1e-9 ? (distance - r0) / span : 1;
      return y0 + (y1 - y0) * t;
    }
  }
  return 0;
}

/** Base ground height under a mat (the dish is modelled on top of this). */
const _baseCache = [];
export function matBaseHeight(index) {
  if (_baseCache[index] === undefined) {
    _baseCache[index] = terrainHeight(CONFIG.matX, CONFIG.matZ[index]);
  }
  return _baseCache[index];
}

/**
 * The surface the physics runs on: natural terrain, with each dish's rim and
 * hollow blended into it at the collar.
 */
export function surfaceHeight(x, z) {
  const base = terrainHeight(x, z);
  const R = CONFIG.matRadius;
  const outer = 1.22 * R;
  for (let i = 0; i < CONFIG.matZ.length; i += 1) {
    const dx = x - CONFIG.matX;
    const dz = z - CONFIG.matZ[i];
    if (Math.abs(dx) >= outer || Math.abs(dz) >= outer) continue;
    const d = Math.hypot(dx, dz);
    if (d >= outer) continue;
    const baseAtMat = matBaseHeight(i);
    const relief = matRelief(d, R);
    // 1 well inside the dish, easing to 0 at the outer shoulder.
    const t = 1 - smooth(clamp((d - outer * 0.9) / (outer * 0.1), 0, 1));
    return base + (baseAtMat - base + relief) * t;
  }
  return base;
}

/** Unit normal of the surface at a point. */
export function surfaceNormal(x, z, out = new THREE.Vector3()) {
  const e = 0.035;
  const hL = surfaceHeight(x - e, z);
  const hR = surfaceHeight(x + e, z);
  const hD = surfaceHeight(x, z - e);
  const hU = surfaceHeight(x, z + e);
  return out.set(hL - hR, 2 * e, hD - hU).normalize();
}

/** Is this point inside a mat's hollow (where a resting goolah is captured)? */
export function matHollowIndex(x, z, factor = 0.75) {
  const R = CONFIG.matRadius * factor;
  for (let i = 0; i < CONFIG.matZ.length; i += 1) {
    if (Math.hypot(x - CONFIG.matX, z - CONFIG.matZ[i]) <= R) return i;
  }
  return -1;
}
