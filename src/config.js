// Shared game configuration. Rule-driven values are isolated here so the
// official rule set can be wired in without touching the renderer or the scene.
//
// Phase 1 field geometry
// ----------------------
// Four mats in one straight line down the field. Mat 1 is the nearest to the
// throwers and mat 4 the farthest; throws always travel toward +Z.
//
//   mat 1      mat 2      mat 3      mat 4
//   (team 0)   (team 1)   (team 0)   (team 1)
//     o----------o----------o----------o---->  throw direction
//  ^
//  shared throw line (both players of the throwing team)
//
// Mats 1 and 3 belong to team 0 (Shānanda), mats 2 and 4 to the opposing team,
// and each goolah rests beside the mat its team owns until that team throws.
import * as THREE from 'three';

export const CONFIG = {
  targetScore: 21,

  /* ------------------------------------------------------------- the mats --- */
  matX: 0,
  matZ: [-3.9, -1.3, 1.3, 3.9],
  matRadius: 0.42,
  // A shallow dish in the dirt, not a deep pit: 5 cm down.
  matDepth: 0.05,
  // Which team owns which mat, in mat order 1..4.
  matOwner: [0, 1, 0, 1],

  /* ------------------------------------------------------------ the line --- */
  // Both players of the throwing team throw from this one line behind mat 1.
  throwLineZ: -5.9,
  throwLineHalfWidth: 1.75,
  throwX: [-0.55, 0.55],

  // Each goolah waits beside the mat its team owns.
  homeOffsetX: 0.78,

  /* --------------------------------------------------------- the goolahs --- */
  ballRadius: 0.28,

  /* ------------------------------------------------------------ physics ---- */
  gravity: 20,
  airDrag: 0.06,
  // Heavy metal on packed dirt: a low, dead bounce.
  groundRestitution: 0.32,
  bounceThreshold: 1.2,
  // ...but a heavy ball keeps most of its speed coming off the ground.
  bounceFriction: 0.88,
  // Rolling resistance in m/s². Tuned by sweep (scripts/tune-throw.mjs) so a
  // full-power throw carries ~1.4 m past mat 4 while the softest throw stops
  // short of mat 1.
  rollFriction: 12,
  // Steel against steel.
  ballRestitution: 0.92,
  sleepSpeed: 0.16,

  /* ------------------------------------------------------------- throws ---- */
  minSpeed: 4.5,
  maxSpeed: 17,
  minLift: 1.3,
  maxLift: 4.8,
  maxAimAngle: 0.35,
  // Below this drag distance the gesture counts as a tap, not a throw.
  minDragPx: 8,
  // Fraction of the smaller viewport edge that maps to full power.
  powerDragFraction: 0.34,

  /* --------------------------------------------------------------- mats ---- */
  // A goolah has to be rolling gently to settle into a mat.
  captureSpeed: 2.6,

  /* -------------------------------------------------------------- teams ---- */
  playerCount: 2,
  throwsPerRound: 4,
};

export const TEAMS = [
  { id: 'blue', name: 'Shānanda', color: 0x3d8bff, css: '#3d8bff', cssClass: 'blue' },
  { id: 'orange', name: 'Orange', color: 0xff8a3d, css: '#ff8a3d', cssClass: 'orange' },
];

export const MAT_COUNT = CONFIG.matZ.length;

/** Centre of a mat on the ground plane (0-based index). */
export function matCenter(index) {
  return new THREE.Vector3(CONFIG.matX, 0, CONFIG.matZ[index]);
}

/** The mat a team's goolah belongs beside: mats 1+3 for team 0, mats 2+4 for team 1. */
export function matIndexFor(teamIndex, playerIndex) {
  return teamIndex + playerIndex * 2;
}

/** Resting spot of a goolah before its team's turn: beside its own mat. */
export function homePosition(teamIndex, playerIndex) {
  const index = matIndexFor(teamIndex, playerIndex);
  const side = teamIndex === 0 ? 1 : -1;
  return new THREE.Vector3(
    CONFIG.matX + side * CONFIG.homeOffsetX,
    CONFIG.ballRadius,
    CONFIG.matZ[index]
  );
}

/** Throwing spot on the shared line. Both players of a team use this same line. */
export function throwPosition(playerIndex) {
  return new THREE.Vector3(CONFIG.throwX[playerIndex], CONFIG.ballRadius, CONFIG.throwLineZ);
}
