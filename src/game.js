import * as THREE from 'three';
import { CONFIG, TEAMS, homePosition, isPlayablePoint, startPosition, throwPosition } from './config.js';
import { rakhPosition } from './rules.js';
import { createBody, setRollingSpin, simulateShot, stepBalls, throwVelocity } from './physics.js';
import { matHollowIndex, surfaceHeight } from './terrain.js';
import { createGoolah } from './models.js';
import {
  RulesEngine,
  RULES,
  ballKey,
  matPointsFor,
  throwingTeamForRound,
} from './rules.js';
import {
  DEFAULT_DIFFICULTY,
  DEFAULT_SEATS,
  DIFFICULTY_ORDER,
  createAI,
  normalizeSeats,
  seatKey,
} from './ai.js';

const UP = new THREE.Vector3(0, 1, 0);
// Every throw travels down the line of mats, away from the shared throw line.
const FORWARD = new THREE.Vector3(0, 0, 1);

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/* ------------------------------------------------------- piece textures --- */

let _ironTextures = null;

/**
 * Cast-iron surface for the goolahs, used as both roughness and bump so the
 * specular highlight breaks up over the pitting instead of running across a
 * perfectly smooth chrome ball.
 */
function castIronTextures() {
  if (_ironTextures) return _ironTextures;

  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e6e6e6';
  ctx.fillRect(0, 0, size, size);

  // Pitting. Darker pixels are smoother, so they read as polished dents.
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 0.6 + Math.random() * 3.2;
    const v = Math.round(88 + Math.random() * 112);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
    ctx.fill();
  }

  // Shallow hammer dents.
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 6 + Math.random() * 16;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(118,118,118,0.45)');
    g.addColorStop(1, 'rgba(230,230,230,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Left as linear data textures: they carry roughness and relief, not colour.
  const roughness = new THREE.CanvasTexture(canvas);
  roughness.wrapS = roughness.wrapT = THREE.RepeatWrapping;
  roughness.repeat.set(2, 1);
  const bump = new THREE.CanvasTexture(canvas);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.repeat.set(2, 1);

  _ironTextures = { roughness, bump };
  return _ironTextures;
}

let _contactShadowTexture = null;

/** Soft blob used as the goolah's contact shadow on the dirt. */
function contactShadowTexture() {
  if (_contactShadowTexture) return _contactShadowTexture;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 3, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.38, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  _contactShadowTexture = new THREE.CanvasTexture(canvas);
  return _contactShadowTexture;
}

export class Game {
  constructor({ scene, camera, renderer, world, ui }) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.world = world;
    this.ui = ui;

    this.mats = Array.isArray(world.mats) ? world.mats : [];
    this.balls = [];
    this.effects = [];
    this.time = 0;

    // The agreed traditional rules live in src/rules.js. The game only reports
    // what happened on the field and shows what the engine decides.
    this.rules = new RulesEngine({ round: 1 });
    this.phase = 'intro'; // intro | ready | aiming | flying | matper | roundEnd | gameover
    this.round = 1;
    this.active = { teamIndex: this.rules.state.throwingTeam, playerIndex: 0 };
    this.settleTimer = 0;
    this.turnLock = 0;
    this.inputEnabled = false;
    // Collisions recorded for the throw currently in flight.
    this.thrownBall = null;
    this.throwHits = null;

    // Phase 3: who plays each seat. The engine, the physics and the HUD do not
    // care whether a throw came from a human or the AI — both go through
    // throwBall(), so the AI cannot make a move a human could not make.
    this.seats = { ...DEFAULT_SEATS };
    this.difficulty = DEFAULT_DIFFICULTY;
    this.aiSeats = new Map();
    this.aiSeed = 1;
    this.aiTimer = 0;
    this.autoTimer = 0;

    this.aim = { dir: new THREE.Vector3(0, 0, 1), power: 0, angle: 0 };
    // The single finger that owns the aim in progress, or null.
    this.pointer = null;
    // Every pointer down anywhere on the page right now, keyed by pointerId.
    // One finger aims; two or more orbit and zoom the camera.
    this.pointers = new Map();
    this.camGesture = null;
    // Set the moment a second finger touches the page, and cleared only once the
    // last finger lifts. While it is set the gesture can never aim or throw,
    // even after the extra fingers are gone.
    this.gestureMulti = false;
    // Free orbit rig around the goolah in play. yaw is the horizontal direction
    // the camera looks in (0 = straight down the line of mats), pitch is its
    // elevation above the ground and dist the radius it orbits at.
    this.camRig = {
      yaw: CONFIG.camera.yaw,
      pitch: CONFIG.camera.pitch,
      dist: CONFIG.camera.dist,
      target: new THREE.Vector3(0, 0.4, 1.1),
    };
    this.camLook = this.camRig.target.clone();
    this.camera.position.set(0, 9.4, -14.6);

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onCancel = this._onCancel.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onWheel = this._onWheel.bind(this);
  }

  /* ------------------------------------------------------------- setup --- */

  init() {
    this.buildBalls();
    this.buildAimHelpers();
    this.buildMarker();
    this.bindUI();

    const canvas = this.renderer.domElement;
    // Pointer Events are the only input path: no touchstart/touchend handler
    // runs game logic, so iOS Safari cannot read the same finger twice.
    // They are bound to the window rather than to the canvas because a finger
    // that lands beside the field is still a finger — it has to count towards
    // the gesture. Otherwise a two-finger camera move that starts half on the
    // HUD looks like a one-finger aim, and lifting it throws the goolah.
    window.addEventListener('pointerdown', this._onDown, { passive: true });
    window.addEventListener('pointermove', this._onMove, { passive: true });
    window.addEventListener('pointerup', this._onUp, { passive: true });
    window.addEventListener('pointercancel', this._onCancel, { passive: true });
    // iOS drops pointerup when the app loses focus, so clear the tracking on
    // blur: a stale id must never wedge the next gesture.
    window.addEventListener('blur', this._onBlur, { passive: true });
    // No pointerleave handler on purpose: a leave event can fire mid-drag on
    // iOS and would silently cancel a valid aim.
    // Trackpad and mouse wheel zoom the orbit on desktop.
    canvas.addEventListener('wheel', this._onWheel, { passive: false });

    // Round 1: the throwing team stands on the shared line, the defending team
    // waits behind mats 1 and 3 (rule 2).
    this.placeStartingPositions();

    this.updateCamera(0, true);
    this.renderState();
  }

  buildBalls() {
    // A goolah is a heavy cast-steel ball: a dense sphere with a broken-up
    // specular, a raised team band turned into the metal, two cast pips on the
    // poles so its roll is visible, and a soft contact shadow on the dirt.
    const shadowTex = contactShadowTexture();
    const shadowGeo = new THREE.PlaneGeometry(
      CONFIG.ballRadius * 5.2,
      CONFIG.ballRadius * 5.2
    );

    TEAMS.forEach((team, teamIndex) => {
      for (let playerIndex = 0; playerIndex < CONFIG.playerCount; playerIndex++) {
        // The visible goolah comes from models.js: a cast steel ball with a
        // machined seam, a team inlay in the seam and cast pips at the poles.
        //
        //   group -> positioned by the simulation
        //     spin  -> rotated by the simulation quaternion
        //       piece -> the actual cast ball
        //     shadow -> stays flat on the dirt, so it must not spin
        const piece = createGoolah(team, CONFIG.ballRadius);
        const group = new THREE.Group();
        const spin = new THREE.Group();
        spin.add(piece.group);
        group.add(spin);
        const mesh = spin;

        const shadow = new THREE.Mesh(
          shadowGeo,
          new THREE.MeshBasicMaterial({
            map: shadowTex,
            color: 0x150c05,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
          })
        );
        shadow.rotation.x = -Math.PI / 2;
        shadow.renderOrder = 1;
        group.add(shadow);

        const home = homePosition(teamIndex, playerIndex);
        // Seat the goolah on the actual ground, not on a y = 0 plane.
        home.y = surfaceHeight(home.x, home.z) + CONFIG.ballRadius;
        group.position.copy(home);
        this.scene.add(group);

        this.balls.push({
          group,
          mesh,
          shadow,
          teamIndex,
          playerIndex,
          // home | staged | live | settled | mat
          state: 'home',
          matIndex: -1,
          body: createBody(home.x, home.y, home.z, CONFIG.ballRadius, CONFIG),
        });
      }
    });
  }

  ballFor(teamIndex, playerIndex) {
    return this.balls[teamIndex * CONFIG.playerCount + playerIndex];
  }

  placeAtHome(ball) {
    ball.state = 'home';
    ball.matIndex = -1;
    ball.body.vel.set(0, 0, 0);
    ball.body.resting = true;
    ball.body.pos.copy(homePosition(ball.teamIndex, ball.playerIndex));
    ball.group.visible = true;
    ball.group.position.copy(ball.body.pos);
  }

  /** Put a goolah on the shared throw line, ready to be thrown. */
  stageOnLine(ball) {
    ball.state = 'staged';
    ball.matIndex = -1;
    ball.body.vel.set(0, 0, 0);
    ball.body.resting = true;
    ball.body.pos.copy(throwPosition(ball.playerIndex));
    ball.group.position.copy(ball.body.pos);
  }

  buildAimHelpers() {
    this.aimGroup = new THREE.Group();
    this.aimGroup.visible = false;

    this.aimMat = new THREE.MeshBasicMaterial({
      color: TEAMS[0].color,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });

    const shaftGeo = new THREE.BoxGeometry(0.11, 0.015, 1).translate(0, 0, 0.5);
    this.aimShaft = new THREE.Mesh(shaftGeo, this.aimMat);
    this.aimGroup.add(this.aimShaft);

    const tipGeo = new THREE.ConeGeometry(0.2, 0.42, 14).rotateX(Math.PI / 2).translate(0, 0, 0.2);
    this.aimTip = new THREE.Mesh(tipGeo, this.aimMat);
    this.aimGroup.add(this.aimTip);

    this.aimGroup.position.y = 0.05;
    this.scene.add(this.aimGroup);

    // Ring around the goolah being aimed.
    this.aimRing = new THREE.Mesh(
      new THREE.RingGeometry(CONFIG.ballRadius * 1.25, CONFIG.ballRadius * 1.62, 32),
      new THREE.MeshBasicMaterial({
        color: TEAMS[0].color,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      })
    );
    this.aimRing.rotation.x = -Math.PI / 2;
    this.aimRing.position.y = 0.025;
    this.aimRing.visible = false;
    this.scene.add(this.aimRing);

    // Power gauge on the ground around the goolah: a dim track showing the full
    // range and a bright arc that fills as power is pulled, running green ->
    // amber -> red. The arc is one full ring with its draw range cut back, so
    // changing the power costs no geometry work and no extra draw call.
    this.powerSegments = 64;
    const arcGeo = () =>
      new THREE.RingGeometry(
        CONFIG.ballRadius * 1.72,
        CONFIG.ballRadius * 2.2,
        this.powerSegments,
        1
      );

    this.powerTrack = new THREE.Mesh(
      arcGeo(),
      new THREE.MeshBasicMaterial({
        color: 0x2a1b0d,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      })
    );
    this.powerTrack.rotation.x = -Math.PI / 2;
    this.powerTrack.position.y = 0.028;
    this.powerTrack.visible = false;
    this.powerTrack.frustumCulled = false;
    this.scene.add(this.powerTrack);

    this.powerArc = new THREE.Mesh(
      arcGeo(),
      new THREE.MeshBasicMaterial({
        color: 0x7fd45a,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      })
    );
    this.powerArc.rotation.x = -Math.PI / 2;
    this.powerArc.position.y = 0.031;
    this.powerArc.visible = false;
    this.powerArc.frustumCulled = false;
    this.scene.add(this.powerArc);

    // Dotted flight preview, sampled from the same integrator the game uses.
    const dotGeo = new THREE.SphereGeometry(0.072, 8, 6);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    this.dots = new THREE.InstancedMesh(dotGeo, dotMat, 40);
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Fixed brightness ramp along the path, so the preview reads as a direction
    // of travel rather than a line of identical beads.
    const dotColor = new THREE.Color();
    for (let i = 0; i < this.dots.count; i++) {
      const t = i / (this.dots.count - 1);
      dotColor.setHSL(0.115, 0.62, 0.94 - t * 0.34);
      this.dots.setColorAt(i, dotColor);
    }
    if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
    this.dots.visible = false;
    this.dots.frustumCulled = false;
    this.scene.add(this.dots);

    // Where the preview says the goolah will stop.
    this.restRing = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.28, 24),
      new THREE.MeshBasicMaterial({
        color: 0xfff3d0,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      })
    );
    this.restRing.rotation.x = -Math.PI / 2;
    this.restRing.position.y = 0.02;
    this.restRing.visible = false;
    this.scene.add(this.restRing);
  }

  buildMarker() {
    this.marker = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.2, 0.42, 16),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: TEAMS[0].color,
        emissiveIntensity: 0.9,
        roughness: 0.4,
        metalness: 0.1,
      })
    );
    cone.rotation.x = Math.PI;
    cone.position.y = 1.05;
    this.marker.add(cone);
    this.markerCone = cone;
    this.marker.visible = false;
    this.scene.add(this.marker);
  }

  /* --------------------------------------------------------------- turn --- */

  get activeTeamIndex() {
    return this.active.teamIndex;
  }

  get activePlayerIndex() {
    return this.active.playerIndex;
  }

  get activeBall() {
    return this.ballFor(this.active.teamIndex, this.active.playerIndex);
  }

  startRound() {
    this.rules.startRound(this.round);
    this.round = this.rules.state.round;
    this.effects.forEach((fx) => {
      fx.mesh.visible = false;
      fx.active = false;
    });
    this.placeStartingPositions();
    this.beginTurn();
  }

  /** Rule 1/2: at the start of a round all four goolahs return to their spots. */
  placeStartingPositions() {
    const s = this.rules.state;
    for (const ball of this.balls) {
      const role = ball.teamIndex === s.throwingTeam ? 'throw' : 'defend';
      const pos = startPosition(role, ball.playerIndex);
      pos.y = surfaceHeight(pos.x, pos.z) + CONFIG.ballRadius;
      ball.state = role === 'throw' ? 'staged' : 'home';
      ball.matIndex = -1;
      ball.body.vel.set(0, 0, 0);
      ball.body.resting = true;
      ball.body.pos.copy(pos);
      ball.group.position.copy(pos);
      ball.group.visible = true;
    }
  }

  /**
   * Present the turn the engine decided on. The goolah is not moved: a fresh
   * turn starts from the round's starting spot, and an extra chance is thrown
   * from wherever the goolah stopped (rule 5).
   */
  beginTurn() {
    const turn = this.rules.state.turn;
    this.active = { teamIndex: turn.teamIndex, playerIndex: turn.playerIndex };
    const team = TEAMS[turn.teamIndex];

    this.phase = 'ready';
    this.turnLock = 0.45;
    this.aim.power = 0;
    this.aim.angle = 0;
    this.aim.dir.copy(FORWARD);
    this.ui.setPower(0);
    this.colorAimHelpers(team.color);
    this.aimRing.visible = true;
    this.marker.visible = true;
    this.markerCone.material.emissive.setHex(team.color);
    this.renderState();
    this.ui.setTurnHint(this.turnHintFor());

    // Rule 5: a held Mat-per goolah waits for its player's next turn.
    if (turn.pendingMatPer) this.offerMatPer(turn.pendingMatPer);

    // An AI seat gets a short beat before it plays, so its turn is watchable.
    if (this.isAI(turn.teamIndex, turn.playerIndex)) {
      this.aiTimer = this.prefersReducedMotion() ? 0.2 : 0.9;
      if (!turn.pendingMatPer) this.ui.setTurnHint(`${team.name} · AI is aiming…`);
    }
  }

  turnHintFor() {
    const turn = this.rules.state.turn;
    if (turn.finalOpportunity) return 'Final mat — one throw at one opponent';
    const targets = this.rules.availableTargets();
    if (!targets.length) return 'Both opponents locked — aim for an open mat';
    if (turn.chances > 1) return `${turn.chances} chances left · drag to aim`;
    return 'Drag to aim · release to throw';
  }

  /** Push the engine state into the HUD without changing the phase. */
  renderState() {
    const s = this.rules.state;
    this.round = s.round;
    this.ui.setScores(s.scores, RULES.targetScore);
    this.ui.setMats(s.captured, s.mats, RULES.matCount);
    this.ui.setMatPer(s.matPer);
    this.ui.setTurn(s.turn.teamIndex, s.turn.playerIndex, s.turn.chances, {
      throwingTeam: s.throwingTeam,
      finalOpportunity: s.turn.finalOpportunity,
      matPerHeld: Boolean(s.matPer[s.turn.teamIndex][s.turn.playerIndex]),
    });
    this.syncMatStates();
  }

  /**
   * Push each mat's state onto the field itself, so the dish shows whether it is
   * still open, holding a goolah, or closed for the round without the player
   * having to read the HUD.
   */
  syncMatStates() {
    const s = this.rules.state;
    for (const mat of this.mats) {
      if (!mat || typeof mat.setState !== 'function') continue;
      const occupied = this.balls.some(
        (ball) => ball.state === 'mat' && ball.matIndex === mat.index
      );
      const completed = Boolean(s.mats[mat.index] && s.mats[mat.index].completed);
      mat.setState(completed ? 'closed' : occupied ? 'occupied' : 'open');
    }
  }

  endRound() {
    this.phase = 'roundEnd';
    this.hideAimHelpers();
    const s = this.rules.state;
    this.ui.showRoundEnd({
      round: s.round,
      captured: [...s.captured],
      matPoints: [matPointsFor(s.captured[0]), matPointsFor(s.captured[1])],
      scores: [...s.scores],
      nextThrowingTeam: throwingTeamForRound(s.round + 1),
    });
    // A match with no human in it plays on by itself.
    if (this.allAI()) this.autoTimer = this.prefersReducedMotion() ? 0.6 : 1.9;
  }

  endMatch() {
    this.phase = 'gameover';
    this.inputEnabled = false;
    this.hideAimHelpers();
    const s = this.rules.state;
    this.ui.showWin(s.winner === null ? null : TEAMS[s.winner], s.scores, s.round);
  }

  nextRound() {
    this.ui.hideRoundEnd();
    this.round = this.rules.state.round + 1;
    this.startRound();
  }

  hideAimHelpers() {
    this.aimGroup.visible = false;
    this.dots.visible = false;
    this.restRing.visible = false;
    this.aimRing.visible = false;
    this.powerTrack.visible = false;
    this.powerArc.visible = false;
    this.marker.visible = false;
  }

  /* ------------------------------------------------------------ ai seats --- */

  isAI(teamIndex, playerIndex) {
    return this.seats[seatKey(teamIndex, playerIndex)] === 'ai';
  }

  isAIActive() {
    return this.isAI(this.active.teamIndex, this.active.playerIndex);
  }

  allAI() {
    return this.balls.every((ball) => this.isAI(ball.teamIndex, ball.playerIndex));
  }

  /** One AI per seat, seeded once per match so a seat keeps its own habits. */
  aiFor(teamIndex, playerIndex) {
    const key = seatKey(teamIndex, playerIndex);
    let ai = this.aiSeats.get(key);
    if (!ai) {
      ai = createAI({
        difficulty: this.difficulty,
        seed: this.aiSeed + teamIndex * 7 + playerIndex * 13,
      });
      this.aiSeats.set(key, ai);
    }
    return ai;
  }

  /** The field as plain data, the same shape the AI tests feed it. */
  ballData() {
    return this.balls.map((ball) => ({
      teamIndex: ball.teamIndex,
      playerIndex: ball.playerIndex,
      state: ball.state,
      matIndex: ball.matIndex,
      x: ball.body.pos.x,
      y: ball.body.pos.y,
      z: ball.body.pos.z,
    }));
  }

  prefersReducedMotion() {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /** Let the AI seat look at the field, then play — same phase gates as a human. */
  updateAI(dt) {
    if (!this.inputEnabled || this.ui.overlayOpen) return;
    if (!this.isAIActive()) return;

    if (this.phase === 'matper') {
      this.aiTimer -= dt;
      if (this.aiTimer <= 0) this.runAIMatPer();
      return;
    }

    if (this.phase === 'ready' && this.turnLock <= 0) {
      this.aiTimer -= dt;
      if (this.aiTimer <= 0) this.runAIThrow();
    }
  }

  runAIThrow() {
    if (this.phase !== 'ready' || !this.rules.canThrow()) return;
    const ai = this.aiFor(this.active.teamIndex, this.active.playerIndex);
    const action = ai.chooseThrow(this.rules, this.ballData(), CONFIG);

    if (!action || action.pass) {
      // No legal target at all: hand the turn on through the engine, never by hand.
      this.rules.endTurn();
      this.beginTurn();
      return;
    }

    // Rule 6: record which single opponent the final throw is aimed at.
    if (this.rules.state.turn.finalOpportunity && action.target && action.target.kind === 'ball') {
      this.rules.chooseFinalTarget(action.target.teamIndex, action.target.playerIndex);
    }

    this.aim.angle = action.angle;
    this.aim.dir.set(Math.sin(action.angle), 0, Math.cos(action.angle));
    this.aim.dir.y = 0;
    this.aim.dir.normalize();
    this.aim.power = action.power;
    this.ui.setPower(action.power);
    this.throwBall(action.power);
  }

  runAIMatPer() {
    if (this.phase !== 'matper') return;
    const ai = this.aiFor(this.active.teamIndex, this.active.playerIndex);
    const choice = ai.chooseMatPer(this.rules, this.ballData(), CONFIG);
    this.chooseMatPer(Boolean(choice && choice.hold));
  }

  updateAutoAdvance(dt) {
    if (this.autoTimer <= 0) return;
    this.autoTimer -= dt;
    if (this.autoTimer > 0) return;
    if (this.phase === 'roundEnd' && this.allAI()) this.nextRound();
  }

  /**
   * Seat changes only happen by restarting the match (the agreed rule), so this
   * throws the current match away and reopens the setup panel.
   */
  openSetup() {
    this.resetGame();
    this.inputEnabled = false;
    this.phase = 'intro';
    this.hideAimHelpers();
    this.ui.showStart();
  }

  /* -------------------------------------------------------------- throw --- */

  throwBall(power) {
    if (!this.rules.canThrow()) return;
    const ball = this.activeBall;
    ball.body.vel.copy(throwVelocity(this.aim.dir, power, CONFIG));
    // Released rolling: the spin matches the launch speed, and the friction in
    // the integrator takes over from there.
    setRollingSpin(ball.body);
    ball.body.resting = false;
    ball.state = 'live';

    // Everything this throw touches is scored once, when it all comes to rest.
    this.thrownBall = ball;
    this.throwHits = new Map();

    this.phase = 'flying';
    this.settleTimer = 0;
    this.aim.power = 0;
    this.ui.setPower(0);
    this.ui.setTurnHint('Rolling…');
    this.hideAimHelpers();
    // Release: two dust rings of different sizes, so the goolah looks like it
    // left the hand rather than simply appearing in motion.
    this.spawnDust(ball.body.pos, 1.7, 0.4);
    this.spawnDust(ball.body.pos, 0.85, 0.72);
  }

  /* ------------------------------------------------------------ physics --- */

  /**
   * The surface the simulation runs on: the natural terrain with the four mat
   * dishes cut into it. terrain.js owns that shape, so the ground mesh drawn in
   * world.js, the dish modelled in models.js and this surface are one thing.
   */
  surfaceHeightAt = (x, z) => surfaceHeight(x, z);

  update(dt) {
    this.time += dt;
    if (this.turnLock > 0) this.turnLock -= dt;

    this.stepPhysics(dt);
    this.updateCamera(dt);
    // Mat number tokens turn to face the camera, so the field stays readable
    // from whatever orbit angle the player has chosen.
    this.world?.update?.(dt, this.camera);
    this.updateMarker();
    this.updateEffects(dt);
    this.updateAI(dt);
    this.updateAutoAdvance(dt);

    if (this.phase === 'flying') {
      if (this.allSettled()) {
        this.settleTimer += dt;
        if (this.settleTimer > 0.55) this.finishThrow();
      } else {
        this.settleTimer = 0;
      }
    }
  }

  /**
   * Advance the goolahs.
   *
   * Every goolah goes to the shared integrator — not only the one in play —
   * because a defender waiting behind its mat and a goolah resting in a dish both
   * have to be *struck*. A parked goolah is asleep and only wakes when a genuine
   * contact gives it velocity, so nothing drifts on its own.
   */
  stepPhysics(dt) {
    const byBody = new Map();
    for (const ball of this.balls) byBody.set(ball.body, ball);

    stepBalls(
      this.balls.map((ball) => ball.body),
      dt,
      CONFIG,
      this.surfaceHeightAt,
      (contact) => {
        // This contact *is* the physical event the scoring reads, so a Tir can
        // never be awarded for two goolahs merely standing near each other, and
        // one strike can never be reported twice.
        const a = byBody.get(contact.a);
        const b = byBody.get(contact.b);
        if (!a || !b) return;
        if (contact.impactSpeed > 1.2) {
          _a.copy(contact.point);
          this.spawnDust(_a, 0.5 + Math.min(0.8, contact.impactSpeed * 0.07), 0.32);
        }
        this.wakeBall(a);
        this.wakeBall(b);
        this.noteHit(a, b);
      },
      (body, impact) => {
        // Landing dust: the ground takes the weight of the metal.
        const ball = byBody.get(body);
        if (ball) this.spawnDust(body.pos, 0.4 + Math.min(0.5, impact * 0.05), 0.26);
      }
    );

    for (const ball of this.balls) {
      if (ball.state === 'live' && ball.body.resting) this.settleBall(ball);
    }

    this.syncVisuals(dt);
  }

  /**
   * A goolah that was struck is in motion now, so the physics has to carry it: a
   * defender rolls, and a goolah resting in a mat can be knocked out of it
   * (rule 5, case B) or into another mat (rule 8).
   */
  wakeBall(ball) {
    if (ball.state === 'live') return;
    ball.state = 'live';
    ball.matIndex = -1;
    ball.body.resting = false;
  }

  /**
   * Record that the throw in flight touched a goolah. Only the first contact
   * with each goolah counts (rule 8), and the goolah's exact position at that
   * moment is kept so a teammate can be put back (rule 7).
   */
  noteHit(a, b) {
    if (!this.throwHits || !this.thrownBall) return;
    const thrown = this.thrownBall;
    const tracked = (ball) => ball === thrown || this.throwHits.has(ballKey(ball.teamIndex, ball.playerIndex));

    let target = null;
    if (a === thrown) target = b;
    else if (b === thrown) target = a;
    else if (tracked(a)) target = b;
    else if (tracked(b)) target = a;
    if (!target || target === thrown) return;

    const key = ballKey(target.teamIndex, target.playerIndex);
    if (this.throwHits.has(key)) return;
    this.throwHits.set(key, {
      teamIndex: target.teamIndex,
      playerIndex: target.playerIndex,
      previous: target.body.pos.clone(),
    });
  }

  /** A goolah has stopped: record it in a mat if it settled in one. */
  settleBall(ball) {
    const mat = this.matUnder(ball.body.pos);
    if (mat) {
      ball.state = 'mat';
      ball.matIndex = mat.index;
      ball.body.pos.y = surfaceHeight(ball.body.pos.x, ball.body.pos.z) + CONFIG.ballRadius;
      ball.group.position.copy(ball.body.pos);
      return;
    }
    ball.state = 'settled';
    ball.matIndex = -1;
  }

  matUnder(position) {
    const index = matHollowIndex(position.x, position.z);
    return index >= 0 ? this.mats[index] : null;
  }

  syncVisuals(dt) {
    const R = CONFIG.ballRadius;
    for (const ball of this.balls) {
      ball.group.position.copy(ball.body.pos);

      // The orientation is the simulation's own: physics.js integrates angular
      // velocity, so the goolah rolls, spins off a strike and settles exactly as
      // the dynamics dictate. Nothing is animated on top of it.
      ball.mesh.quaternion.copy(ball.body.quat);

      // Contact shadow: it stays on the dirt while the goolah is off the ground
      // and spreads and fades as the gap opens. This is what gives the ball its
      // weight when it is thrown.
      if (ball.shadow) {
        const ground = this.surfaceHeightAt(ball.body.pos.x, ball.body.pos.z);
        const lift = Math.max(0, ball.body.pos.y - R - ground);
        const closeness = clamp(1 - lift / 1.3, 0, 1);
        ball.shadow.position.y = ground - ball.body.pos.y + 0.012;
        ball.shadow.scale.setScalar(0.82 + (1 - closeness) * 0.6);
        ball.shadow.material.opacity = 0.14 + closeness * 0.58;
        ball.shadow.visible = closeness > 0.02;
      }
    }

    // While aiming, the goolah is drawn wound back from the line in proportion
    // to the power pulled; the release snaps it forward, which reads as the
    // throw itself without needing a character model.
    const aiming = this.activeBall;
    if (this.phase === 'aiming' && aiming) {
      const pull = this.aim.power * R * 0.95;
      aiming.group.position.set(
        aiming.body.pos.x - this.aim.dir.x * pull,
        aiming.body.pos.y,
        aiming.body.pos.z - this.aim.dir.z * pull
      );
    }
  }

  allSettled() {
    return this.balls.every((ball) => ball.state !== 'live');
  }

  /* --------------------------------------------------------------- input --- */

  /** True when a pointer landed on the 3D field rather than on the HUD. */
  isFieldTarget(target) {
    const canvas = this.renderer.domElement;
    return target === canvas || (Boolean(target) && canvas.contains(target));
  }

  /**
   * One finger aims and throws. Two or more fingers orbit and zoom. The two
   * never mix: the moment a second finger lands the aim in progress is dropped
   * without a throw and the whole gesture is marked multi-touch. That mark
   * survives until the last finger lifts, so no pointer-up belonging to the
   * gesture can throw — not the aiming finger's, not the camera finger's, and
   * not the last one to leave the screen.
   */
  _onDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const onCanvas = this.isFieldTarget(event.target);
    this.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      onCanvas,
    });

    // A second finger anywhere on the page turns this into a camera gesture and
    // poisons it for good.
    if (this.pointers.size > 1) {
      this.gestureMulti = true;
      this._cancelAim();
      this._beginCameraGesture();
      return;
    }

    // Only a fresh, single-finger press on the field may start an aim.
    if (!onCanvas || !this.canAim()) return;
    this.pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    this.phase = 'aiming';
    this.aim.power = 0;
    this.aim.angle = 0;
    this.aim.dir.copy(this.cameraAxis());
    this.ui.setPower(0);
    this.ui.setTurnHint('Drag to aim, release to throw');
    this.aimGroup.visible = true;
    this.dots.visible = true;
    this.updateAimVisuals();
  }

  _onMove(event) {
    const tracked = this.pointers.get(event.pointerId);
    if (!tracked) return;
    tracked.x = event.clientX;
    tracked.y = event.clientY;

    // Two or more fingers: orbit and pinch-zoom. Never aim, never throw.
    if (this.pointers.size > 1) {
      this.gestureMulti = true;
      this._updateCameraGesture();
      return;
    }
    // A gesture that ever had a second finger can never aim, even now that only
    // one finger is left down.
    if (this.gestureMulti) return;
    if (!this.pointer || event.pointerId !== this.pointer.id) return;

    const dx = event.clientX - this.pointer.startX;
    const dy = event.clientY - this.pointer.startY;
    const mag = Math.hypot(dx, dy);
    if (mag < CONFIG.minDragPx) return;
    this.pointer.moved = true;

    // Screen space -> field space, measured from where the camera is looking.
    // Dragging up throws away from the viewer, down throws toward them, and a
    // sideways drag throws sideways: the whole circle is available, with no
    // forward restriction and no maximum angle.
    const axis = this.cameraAxis();
    const side = _b.crossVectors(axis, UP).normalize();

    const angle = Math.atan2(dx, -dy);
    this.aim.angle = angle;
    this.aim.dir.copy(axis).multiplyScalar(Math.cos(angle)).addScaledVector(side, Math.sin(angle));
    this.aim.dir.y = 0;
    this.aim.dir.normalize();

    // Drag distance is the power.
    const screen = Math.min(window.innerWidth, window.innerHeight);
    this.aim.power = clamp(mag / (screen * CONFIG.powerDragFraction), 0.06, 1);
    this.ui.setPower(this.aim.power);
    this.updateAimVisuals();
  }

  _onUp(event) {
    this.pointers.delete(event.pointerId);

    const wasMulti = this.gestureMulti;
    const isAimPointer = Boolean(this.pointer) && event.pointerId === this.pointer.id;

    // Lifting one of two fingers ends the camera gesture, not the turn.
    if (this.camGesture) {
      if (this.pointers.size > 1) this._beginCameraGesture();
      else this.camGesture = null;
    }
    // The last finger is up: this gesture is over, and only a fresh one may aim.
    if (this.pointers.size === 0) this.gestureMulti = false;

    // A throw needs the aiming pointer itself, a gesture that never went
    // multi-touch, and no other finger still down. Every other pointer-up —
    // including the aiming finger's when a camera finger came and went — is
    // swallowed here, so it can never launch a goolah.
    if (!isAimPointer || wasMulti || this.pointers.size > 0) {
      if (isAimPointer) this._cancelAim();
      return;
    }

    const power = this.aim.power;
    const moved = this.pointer.moved;
    this.pointer = null;

    if (this.phase === 'aiming') {
      if (moved && power > 0.06) {
        this.throwBall(power);
      } else {
        this._resetAimState();
      }
    }
  }

  /** The browser cancelled a pointer (system gesture, app switch): drop the aim. */
  _onCancel(event) {
    this.pointers.delete(event.pointerId);
    if (this.camGesture) {
      if (this.pointers.size > 1) this._beginCameraGesture();
      else this.camGesture = null;
    }
    if (this.pointers.size === 0) this.gestureMulti = false;
    this._cancelAim();
  }

  /** The page lost focus, so any pointerup still owed to us will never arrive. */
  _onBlur() {
    this.pointers.clear();
    this.gestureMulti = false;
    this.camGesture = null;
    this._cancelAim();
  }

  /** Abandon the aim in progress: no throw, no leftover helpers. */
  _cancelAim() {
    this.pointer = null;
    this._resetAimState();
  }

  /** Back to a resting turn: no power, no helpers, no throw. */
  _resetAimState() {
    if (this.phase !== 'aiming') return;
    this.phase = 'ready';
    this.aim.power = 0;
    this.ui.setPower(0);
    this.ui.setTurnHint('Drag to aim · release to throw');
    this.aimGroup.visible = false;
    this.dots.visible = false;
    this.restRing.visible = false;
  }

  /* ------------------------------------------------------ camera gestures --- */

  /** The fingers that landed on the field itself are the ones that orbit. */
  fieldPointers() {
    const points = [];
    for (const pointer of this.pointers.values()) {
      if (pointer.onCanvas) points.push(pointer);
    }
    return points;
  }

  /** Remember the fingers and the rig when a two-finger gesture starts. */
  _beginCameraGesture() {
    const points = this.fieldPointers();
    if (points.length < 2) {
      this.camGesture = null;
      return;
    }
    const [a, b] = points;
    this.camGesture = {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      spread: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      yaw: this.camRig.yaw,
      pitch: this.camRig.pitch,
      dist: this.camRig.dist,
    };
  }

  _updateCameraGesture() {
    if (!this.camGesture) {
      this._beginCameraGesture();
      return;
    }
    const points = this.fieldPointers();
    if (points.length < 2) return;
    const [a, b] = points;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const spread = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const cfg = CONFIG.camera;

    // Both axes move the view the way the fingers move, always measured from
    // this gesture's own starting point, so the mapping is identical from every
    // viewing angle:
    //   * dragging right turns the camera to the right. yaw is the horizontal
    //     direction the camera looks in, and turning right means turning away
    //     from +X while the rig sits at yaw 0, so yaw falls as the drag grows.
    //   * dragging up tilts the view up, which lowers the camera towards the
    //     field; dragging down lifts it for a top-down view.
    // Horizontal drag moves only yaw and vertical drag only pitch.
    this.camRig.yaw = this.camGesture.yaw - (cx - this.camGesture.cx) * cfg.orbitSpeed;
    this.camRig.pitch = clamp(
      this.camGesture.pitch + (cy - this.camGesture.cy) * cfg.pitchSpeed,
      cfg.minPitch,
      cfg.maxPitch
    );
    // Pinching in pulls the camera closer, pinching out pushes it away.
    const ratio = this.camGesture.spread / spread;
    this.camRig.dist = clamp(
      this.camGesture.dist * Math.pow(ratio, cfg.zoomExp),
      cfg.minDist,
      cfg.maxDist
    );
  }

  _onWheel(event) {
    event.preventDefault();
    const cfg = CONFIG.camera;
    this.camRig.dist = clamp(
      this.camRig.dist * Math.exp(event.deltaY * cfg.wheelSpeed),
      cfg.minDist,
      cfg.maxDist
    );
  }

  /**
   * The horizontal direction the camera looks in, on the ground plane. Aiming
   * is measured from this, so "up the screen" always throws away from the
   * viewer wherever the camera has been orbited to.
   */
  cameraAxis() {
    const axis = _a.set(Math.sin(this.camRig.yaw), 0, Math.cos(this.camRig.yaw));
    if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);
    return axis.normalize();
  }

  canAim() {
    return (
      this.phase === 'ready' &&
      this.inputEnabled &&
      this.turnLock <= 0 &&
      !this.ui.overlayOpen &&
      !this.isAIActive() && // the AI seat plays itself
      this.rules.canThrow()
    );
  }

  colorAimHelpers(color) {
    this.aimMat.color.setHex(color);
    this.aimRing.material.color.setHex(color);
  }

  updateAimVisuals() {
    const ball = this.activeBall;
    const pos = ball.body.pos;

    this.aimGroup.position.set(pos.x, 0.055, pos.z);
    this.aimGroup.rotation.y = Math.atan2(this.aim.dir.x, this.aim.dir.z);
    const length = 1.2 + this.aim.power * 3.6;
    this.aimShaft.scale.z = length;
    this.aimTip.position.z = length;

    this.aimRing.position.set(pos.x, 0.025, pos.z);

    // Power gauge: the arc grows from the goolah and shifts from green through
    // amber to red, so the top of the range is unmistakable.
    const power = clamp(this.aim.power, 0, 1);
    this.powerTrack.position.set(pos.x, 0.028, pos.z);
    this.powerTrack.visible = true;
    const lit = Math.round(this.powerSegments * power);
    this.powerArc.geometry.setDrawRange(0, lit * 6);
    this.powerArc.position.set(pos.x, 0.031, pos.z);
    this.powerArc.visible = lit > 0;
    const hue = 0.3 * (1 - power);
    this.powerArc.material.color.setHSL(hue, 0.84, 0.52);
    this.aimMat.color.setHSL(hue, 0.85, 0.58);

    // Preview the shot with the same integrator the game runs, so the dotted
    // path and the resting ring show where this throw will actually stop.
    const shot = simulateShot(pos, this.aim.dir, this.aim.power, CONFIG, {
      step: 1 / 90,
      sampleEvery: 0.055,
      maxSamples: this.dots.count,
      surface: this.surfaceHeightAt,
    });

    for (let i = 0; i < this.dots.count; i++) {
      const sample = shot.samples[i];
      if (!sample) {
        _m.makeScale(0, 0, 0);
        _m.setPosition(0, -10, 0);
        this.dots.setMatrixAt(i, _m);
        continue;
      }
      const s = 1 - i / (this.dots.count + 8);
      _m.makeScale(s, s, s);
      _m.setPosition(sample.x, Math.max(sample.y, 0.07), sample.z);
      this.dots.setMatrixAt(i, _m);
    }
    this.dots.instanceMatrix.needsUpdate = true;

    this.restRing.position.set(shot.rest.x, 0.02, shot.rest.z);
    this.restRing.visible = true;
    this.lastPreview = shot;
  }

  /* -------------------------------------------------------------- visuals --- */

  updateMarker() {
    if (!this.marker.visible) return;
    const ball = this.activeBall;
    const bob = Math.sin(this.time * 3.4) * 0.09;
    this.marker.position.set(
      ball.body.pos.x,
      ball.body.pos.y + bob,
      ball.body.pos.z
    );
    this.marker.rotation.y = this.time * 0.9;
  }

  /**
   * The orbit camera. The player owns yaw, pitch and distance; the game only
   * decides what the camera orbits around: a blend of the field centre and the
   * goolah in play, so the mats stay in frame while a throw is followed.
   */
  updateCamera(dt, snap = false) {
    const cfg = CONFIG.camera;
    const rig = this.camRig;

    // The goolah whose turn it is, or the one rolling after a throw.
    const followed = this.phase === 'flying' && this.thrownBall ? this.thrownBall : this.activeBall;
    const goalTarget = _a.set(0, 0.4, 1.1);
    if (followed) {
      const p = followed.body.pos;
      goalTarget.x += p.x * cfg.ballBlendX;
      goalTarget.z += (p.z - 1.1) * cfg.ballBlendZ;
      goalTarget.y += Math.max(0, p.y - CONFIG.ballRadius) * 0.5;
    }

    const followK = snap ? 1 : 1 - Math.exp(-cfg.follow * Math.max(dt, 0.001));
    rig.target.lerp(goalTarget, followK);

    // Where the rig says the camera belongs: on a sphere around that target.
    const cosPitch = Math.cos(rig.pitch);
    const goalPos = _b.set(
      rig.target.x - Math.sin(rig.yaw) * cosPitch * rig.dist,
      rig.target.y + Math.sin(rig.pitch) * rig.dist,
      rig.target.z - Math.cos(rig.yaw) * cosPitch * rig.dist
    );
    // The orbit must never drop through the dirt.
    goalPos.y = Math.max(goalPos.y, 0.85);

    const settleK = snap ? 1 : 1 - Math.exp(-cfg.settle * Math.max(dt, 0.001));
    this.camera.position.lerp(goalPos, settleK);
    this.camLook.lerp(rig.target, settleK);
    this.camera.lookAt(this.camLook);
  }

  spawnDust(position, scale = 1, life = 0.5) {
    let fx = this.effects.find((e) => !e.active);
    if (!fx) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.18, 0.3, 20),
        new THREE.MeshBasicMaterial({
          color: 0xd9b98c,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      mesh.rotation.x = -Math.PI / 2;
      this.scene.add(mesh);
      fx = { mesh, t: 0, life, scale, active: false };
      this.effects.push(fx);
    }
    fx.active = true;
    fx.t = 0;
    fx.life = life;
    fx.scale = scale;
    fx.mesh.visible = true;
    fx.mesh.position.set(position.x, 0.04, position.z);
    fx.mesh.scale.setScalar(0.5);
  }

  updateEffects(dt) {
    for (const fx of this.effects) {
      if (!fx.active) continue;
      fx.t += dt;
      const t = clamp(fx.t / fx.life, 0, 1);
      fx.mesh.scale.setScalar(0.5 + t * 2.6 * fx.scale);
      fx.mesh.material.opacity = 0.65 * (1 - t);
      if (t >= 1) {
        fx.active = false;
        fx.mesh.visible = false;
      }
    }
  }

  /* ------------------------------------------------------------------ ui --- */

  bindUI() {
    document.getElementById('playBtn').addEventListener('click', () => this.begin());
    document.getElementById('rulesBtn').addEventListener('click', () => this.ui.openRules());
    document.getElementById('closeRules').addEventListener('click', () => this.ui.closeRules());
    document.getElementById('resetBtn').addEventListener('click', () => this.resetGame());
    const setupBtn = document.getElementById('setupBtn');
    if (setupBtn) setupBtn.addEventListener('click', () => this.openSetup());
    document.getElementById('nextRoundBtn').addEventListener('click', () => this.nextRound());
    document.getElementById('playAgainBtn').addEventListener('click', () => {
      this.ui.hideWin();
      this.resetGame();
    });
    document.getElementById('matPerHold').addEventListener('click', () => this.chooseMatPer(true));
    document.getElementById('matPerThrow').addEventListener('click', () => this.chooseMatPer(false));
  }

  begin() {
    // The line-up and difficulty chosen in the setup panel apply to this match.
    const setup = this.ui.setup || {};
    this.seats = normalizeSeats(setup.seats);
    this.difficulty = DIFFICULTY_ORDER.includes(setup.difficulty)
      ? setup.difficulty
      : DEFAULT_DIFFICULTY;
    this.aiSeats.clear();
    this.aiSeed = Math.floor(Math.random() * 1e9) + 1;
    this.ui.setSeatRoles(this.seats);

    this.ui.hideStart();
    this.phase = 'ready';
    this.inputEnabled = true;
    this.startRound();
    this.ui.showHint(
      this.isAIActive()
        ? `${TEAMS[this.activeTeamIndex].name} throws first · AI to play`
        : `${TEAMS[this.activeTeamIndex].name} throws first — drag to aim`
    );
  }

  /* ------------------------------------------------------------- scoring --- */

  /** Describe the settled throw for the rules engine. */
  buildShotReport() {
    const s = this.rules.state;
    const thrown = this.thrownBall;
    const collisions = [];

    if (thrown && this.throwHits) {
      for (const hit of this.throwHits.values()) {
        const ball = this.ballFor(hit.teamIndex, hit.playerIndex);
        const sameTeam = hit.teamIndex === thrown.teamIndex;
        const held = s.matPer[hit.teamIndex][hit.playerIndex];
        const inMat = ball.state === 'mat' ? ball.matIndex : -1;
        collisions.push({
          kind: sameTeam ? 'teammate' : 'opponent',
          teamIndex: hit.teamIndex,
          playerIndex: hit.playerIndex,
          previous: hit.previous,
          matPer: Boolean(held),
          matIndex: held ? held.matIndex : -1,
          // Rule 5: did the Mat-per goolah leave its hollow?
          knockedOutOfMat: Boolean(held) && inMat !== held.matIndex,
          // Rule 8: an opponent goolah pushed into an open mat.
          enteredMat: !sameTeam && inMat >= 0 && (!held || inMat !== held.matIndex) ? inMat : -1,
        });
      }
    }

    const ownMatIndex = thrown && thrown.state === 'mat' ? thrown.matIndex : -1;
    return { collisions, ownMatIndex };
  }

  /**
   * Rule 9: Rakh. A goolah that stopped somewhere unplayable is placed at the
   * nearest playable spot on a straight line back toward the field. Ordinary
   * obstacles that leave it playable are not Rakh, so only genuinely
   * unreachable positions are moved.
   */
  applyRakh() {
    let moved = false;
    for (const ball of this.balls) {
      const pos = ball.body.pos;
      if (isPlayablePoint(pos.x, pos.z)) continue;
      const spot = rakhPosition(
        { x: pos.x, z: pos.z },
        isPlayablePoint,
        { toward: { x: CONFIG.matX, z: 0 }, step: 0.1, maxDistance: 26 }
      );
      pos.set(spot.x, CONFIG.ballRadius, spot.z);
      ball.body.vel.set(0, 0, 0);
      ball.body.resting = true;
      ball.group.position.copy(pos);
      let matIndex = -1;
      for (let i = 0; i < CONFIG.matZ.length; i += 1) {
        const d = Math.hypot(spot.x - CONFIG.matX, spot.z - CONFIG.matZ[i]);
        if (d <= CONFIG.matRadius * 0.75) { matIndex = i; break; }
      }
      ball.state = matIndex >= 0 ? 'mat' : 'settled';
      ball.matIndex = matIndex;
      moved = true;
    }
    if (moved) this.ui.showHint('Rakh — goolah returned to the nearest playable spot');
    return moved;
  }

  finishThrow() {
    // Rule 9 runs before scoring, so the throw is judged from the position the
    // goolah is actually played from.
    this.applyRakh();
    const result = this.rules.resolveThrow(this.buildShotReport());
    this.applyResult(result);
  }

  applyResult(result) {
    const s = this.rules.state;

    // Rule 7: a hit teammate's goolah goes back to exactly where it was.
    for (const restore of result.restore) {
      const ball = this.ballFor(restore.teamIndex, restore.playerIndex);
      if (!restore.position) continue;
      ball.body.pos.set(restore.position.x, restore.position.y, restore.position.z);
      ball.body.vel.set(0, 0, 0);
      ball.body.resting = true;
      ball.group.position.copy(ball.body.pos);
      const mat = this.matUnder(ball.body.pos);
      ball.state = mat ? 'mat' : 'settled';
      ball.matIndex = mat ? mat.index : -1;
    }

    this.renderState();
    this.announce(result);

    // Rule 5: offer Mat-per unless the round is already being closed out by
    // the final-mat opportunity (rule 6).
    const wantsMatPer = result.matPerOffers.length > 0 && !result.finalMat;
    if (wantsMatPer) {
      this.thrownBall = null;
      this.throwHits = null;
      this.offerMatPer(s.turn.pendingMatPer);
      return;
    }

    this.rules.afterThrow(result);
    this.thrownBall = null;
    this.throwHits = null;

    if (s.matchOver) {
      this.endMatch();
      return;
    }
    if (s.roundOver) {
      this.endRound();
      return;
    }
    this.beginTurn();
  }

  announce(result) {
    const turnTeam = TEAMS[this.rules.state.turn.teamIndex];
    if (result.awards.length) {
      const award = result.awards[result.awards.length - 1];
      const text =
        {
          tir: 'Tir! +1 point · one extra throw',
          'matper-hold': 'Mat-per held · +3 points',
          'matper-knockout': 'Mat-per knocked out · +7 points',
        }[award.type] || `+${award.points} points`;
      this.ui.toast(text, TEAMS[award.teamIndex].css);
      return;
    }
    if (result.captures.length) {
      const capture = result.captures[result.captures.length - 1];
      this.ui.toast(
        `Mat ${capture.matIndex + 1} captured for ${TEAMS[capture.teamIndex].name}`,
        TEAMS[capture.teamIndex].css
      );
      return;
    }
    if (result.restore.length) {
      this.ui.toast('Own teammate hit · goolah put back, no point', turnTeam.css);
      return;
    }
    this.ui.toast('No Tir, no Mat · turn passes', turnTeam.css);
  }

  /* ------------------------------------------------------------ mat-per --- */

  offerMatPer(offer) {
    this.phase = 'matper';
    this.hideAimHelpers();
    const turn = this.rules.state.turn;
    this.ui.showMatPerChoice(offer.matIndex + 1, TEAMS[turn.teamIndex].name);
    if (this.isAI(turn.teamIndex, turn.playerIndex)) {
      this.aiTimer = this.prefersReducedMotion() ? 0.2 : 0.9;
    }
  }

  chooseMatPer(hold) {
    this.ui.hideMatPerChoice();
    const team = this.rules.state.turn.teamIndex;
    const out = this.rules.chooseMatPer(hold);
    if (!out) {
      this.beginTurn();
      return;
    }
    if (hold) {
      this.ui.toast(
        `Held in mat ${out.matIndex + 1} · chance kept for the next turn`,
        TEAMS[team].css
      );
    }
    const s = this.rules.state;
    if (s.matchOver) {
      this.endMatch();
      return;
    }
    if (s.roundOver) {
      this.endRound();
      return;
    }
    this.beginTurn();
  }

  resetGame() {
    this.rules = new RulesEngine({ round: 1 });
    this.round = 1;
    this.thrownBall = null;
    this.throwHits = null;
    this.aiSeats.clear();
    this.aiSeed = Math.floor(Math.random() * 1e9) + 1;
    this.aiTimer = 0;
    this.autoTimer = 0;
    this.ui.hideRoundEnd();
    this.ui.hideWin();
    this.ui.hideMatPerChoice();
    this.inputEnabled = true;
    this.startRound();
  }

  /** Snapshot used by the automated checks. */
  state() {
    const rules = this.rules.describe();
    return {
      phase: this.phase,
      round: this.round,
      seats: { ...this.seats },
      difficulty: this.difficulty,
      aiActive: this.isAIActive(),
      turn: { teamIndex: this.active.teamIndex, playerIndex: this.active.playerIndex },
      scores: [...this.rules.state.scores],
      rules,
      throwLineZ: CONFIG.throwLineZ,
      matDepth: CONFIG.matDepth,
      matRadius: CONFIG.matRadius,
      mats: this.mats.map((m) => ({
        index: m.index,
        teamIndex: m.teamIndex,
        x: m.position.x,
        z: m.position.z,
      })),
      balls: this.balls.map((b) => ({
        teamIndex: b.teamIndex,
        playerIndex: b.playerIndex,
        state: b.state,
        matIndex: b.matIndex,
        x: Number(b.body.pos.x.toFixed(3)),
        y: Number(b.body.pos.y.toFixed(3)),
        z: Number(b.body.pos.z.toFixed(3)),
      })),
    };
  }
}
