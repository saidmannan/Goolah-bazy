// Shared game configuration. Rule-driven values are intentionally isolated here so the
// official rule set can be wired in without touching the renderer or the scene.
export const CONFIG = {
  targetScore: 21,

  // Four holes ("mats") in one straight line down the middle of the field.
  holeZ: [-3.9, -1.3, 1.3, 3.9],
  holeX: 0,
  holeRadius: 0.4,

  // Throwing spots: two teams at opposite ends of the line of holes.
  throwZ: 11,
  throwX: [-0.95, 0.95],

  ballRadius: 0.28,
  gravity: 22,
  restitution: 0.34,
  bounceFriction: 0.8,
  rollFriction: 6.2,
  airDrag: 0.08,
  captureRadius: 0.3,
  captureSpeed: 4.6,

  minSpeed: 3.2,
  maxSpeed: 12.5,
  minLift: 1.0,
  maxLift: 4.2,
  maxAimAngle: 0.5,

  playerCount: 2,
  throwsPerRound: 4,
};

export const TEAMS = [
  { id: 'blue', name: 'Blue', color: 0x3d8bff, css: '#3d8bff', cssClass: 'blue' },
  { id: 'orange', name: 'Orange', color: 0xff8a3d, css: '#ff8a3d', cssClass: 'orange' },
];
