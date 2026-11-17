import * as THREE from 'three';
import { CONFIG, TEAMS, homePosition, throwPosition } from './config.js';
import {
  createBody,
  stepBallMotion,
  resolveBallCollision,
  simulateShot,
  throwVelocity,
} from './physics.js';
import { turnAt } from './turn.js';

const UP = new THREE.Vector3(0, 1, 0);
// Every throw travels down the line of mats, away from the shared throw line.
const FORWARD = new THREE.Vector3(0, 0, 1);

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

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

    this.scores = [0, 0];
    this.phase = 'intro'; // intro | ready | aiming | flying | roundEnd | gameover
    this.round = 1;
    this.roundStartTeam = 0;
    this.turnSeq = 0;
    this.active = { teamIndex: 0, playerIndex: 0 };
    this.settleTimer = 0;
    this.turnLock = 0;
    this.inputEnabled = false;

    this.aim = { dir: new THREE.Vector3(0, 0, 1), power: 0, angle: 0 };
    this.pointer = null;
    this.camLook = new THREE.Vector3(0, 0.35, 1.1);
    this.camera.position.set(0, 9.4, -14.6);

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
  }

  /* ------------------------------------------------------------- setup --- */

  init() {
    this.buildBalls();
    this.buildAimHelpers();
    this.buildMarker();
    this.bindUI();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    canvas.addEventListener('pointerleave', this._onUp);

    // Before the first throw, the goolahs wait beside the mats they belong to.
    this.balls.forEach((ball) => this.placeAtHome(ball));

    this.updateCamera(0, true);
    this.ui.setScores(this.scores, CONFIG.targetScore);
  }

  buildBalls() {
    const ballGeo = new THREE.SphereGeometry(CONFIG.ballRadius, 28, 20);
    const bandGeo = new THREE.TorusGeometry(CONFIG.ballRadius * 1.004, 0.027, 8, 32);

    TEAMS.forEach((team, teamIndex) => {
      for (let playerIndex = 0; playerIndex < CONFIG.playerCount; playerIndex++) {
        const group = new THREE.Group();

        const material = new THREE.MeshStandardMaterial({
          color: 0xc6ccd6,
          metalness: 1.0,
          roughness: 0.22,
          envMapIntensity: 1.45,
        });
        const mesh = new THREE.Mesh(ballGeo, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);

        const band = new THREE.Mesh(
          bandGeo,
          new THREE.MeshStandardMaterial({
            color: team.color,
            metalness: 0.5,
            roughness: 0.34,
            emissive: new THREE.Color(team.color).multiplyScalar(0.4),
          })
        );
        band.rotation.x = Math.PI / 2;
        group.add(band);

        const home = homePosition(teamIndex, playerIndex);
        group.position.copy(home);
        this.scene.add(group);

        this.balls.push({
          group,
          mesh,
          teamIndex,
          playerIndex,
          // home | staged | live | settled | mat
          state: 'home',
          matIndex: -1,
          body: createBody(home.x, home.y, home.z, CONFIG.ballRadius),
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

    // Dotted flight preview, sampled from the same integrator the game uses.
    const dotGeo = new THREE.SphereGeometry(0.075, 8, 6);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xfff3d0,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.dots = new THREE.InstancedMesh(dotGeo, dotMat, 26);
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
    // The team that throws first alternates every round.
    this.roundStartTeam = (this.round - 1) % 2;
    this.turnSeq = 0;
    this.balls.forEach((ball) => this.placeAtHome(ball));
    this.effects.forEach((fx) => {
      fx.mesh.visible = false;
      fx.active = false;
    });
    this.startTurn();
  }

  startTurn() {
    const turn = turnAt(this.turnSeq, this.roundStartTeam, CONFIG.playerCount);
    this.active = { teamIndex: turn.teamIndex, playerIndex: turn.playerIndex };
    const team = TEAMS[turn.teamIndex];

    // Both players of the throwing team throw from the same starting line, so
    // when their block begins both of that team's goolahs are staged on it.
    if (turn.throwInBlock === 0) {
      for (let p = 0; p < CONFIG.playerCount; p++) {
        const mate = this.ballFor(turn.teamIndex, p);
        if (mate.state === 'home') this.stageOnLine(mate);
      }
    }

    const ball = this.activeBall;
    if (ball.state !== 'staged') this.stageOnLine(ball);

    this.phase = 'ready';
    this.turnLock = 0.5;
    this.aim.power = 0;
    this.aim.angle = 0;
    this.aim.dir.copy(FORWARD);
    this.ui.setPower(0);
    this.ui.setTurn(turn.teamIndex, turn.playerIndex);
    this.ui.setScores(this.scores, CONFIG.targetScore);
    this.colorAimHelpers(team.color);
    this.aimRing.visible = true;
    this.marker.visible = true;
    this.markerCone.material.emissive.setHex(team.color);
  }

  endTurn() {
    this.turnSeq += 1;
    if (this.turnSeq >= CONFIG.throwsPerRound) {
      this.phase = 'roundEnd';
      this.hideAimHelpers();
      this.ui.showRoundEnd(this.round);
      return;
    }
    this.startTurn();
  }

  nextRound() {
    this.round += 1;
    this.ui.hideRoundEnd();
    this.startRound();
  }

  hideAimHelpers() {
    this.aimGroup.visible = false;
    this.dots.visible = false;
    this.restRing.visible = false;
    this.aimRing.visible = false;
    this.marker.visible = false;
  }

  /* -------------------------------------------------------------- throw --- */

  throwBall(power) {
    const ball = this.activeBall;
    ball.body.vel.copy(throwVelocity(this.aim.dir, power, CONFIG));
    ball.body.resting = false;
    ball.state = 'live';

    this.phase = 'flying';
    this.settleTimer = 0;
    this.aim.power = 0;
    this.ui.setPower(0);
    this.ui.setTurnHint('Rolling…');
    this.hideAimHelpers();
    this.spawnDust(ball.body.pos, 0.5, 0.35);
  }

  /* ------------------------------------------------------------ physics --- */

  /**
   * Ground height at a point: flat dirt, dipping into each mat dish. This makes
   * the 5 cm depressions part of the physics instead of decoration.
   */
  surfaceHeightAt = (x, z) => {
    let height = 0;
    for (const mat of this.mats) {
      const dx = x - mat.position.x;
      const dz = z - mat.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance >= CONFIG.matRadius) continue;
      const t = 1 - distance / CONFIG.matRadius;
      const dip = -CONFIG.matDepth * (t * t * (3 - 2 * t));
      if (dip < height) height = dip;
    }
    return height;
  };

  inPlay(ball) {
    return ball.state === 'live' || ball.state === 'settled' || ball.state === 'mat';
  }

  update(dt) {
    this.time += dt;
    if (this.turnLock > 0) this.turnLock -= dt;

    this.stepPhysics(dt);
    this.updateCamera(dt);
    this.updateMarker();
    this.updateEffects(dt);

    if (this.phase === 'flying') {
      if (this.allSettled()) {
        this.settleTimer += dt;
        if (this.settleTimer > 0.55) this.endTurn();
      } else {
        this.settleTimer = 0;
      }
    }
  }

  stepPhysics(dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;

    for (let i = 0; i < steps; i++) {
      for (const ball of this.balls) {
        if (ball.state !== 'live') continue;
        const { impact } = stepBallMotion(ball.body, h, CONFIG, this.surfaceHeightAt);
        if (impact > 2.2) this.spawnDust(ball.body.pos, 0.6, 0.3);
        if (ball.body.resting) this.settleBall(ball);
      }
      this.resolveCollisions();
    }

    this.syncVisuals(dt);
  }

  resolveCollisions() {
    for (let i = 0; i < this.balls.length; i++) {
      const a = this.balls[i];
      if (!this.inPlay(a)) continue;
      for (let j = i + 1; j < this.balls.length; j++) {
        const b = this.balls[j];
        if (!this.inPlay(b)) continue;
        const { hit, impactSpeed } = resolveBallCollision(a.body, b.body, CONFIG);
        if (hit && impactSpeed > 1.6) {
          _a.copy(a.body.pos).lerp(b.body.pos, 0.5);
          this.spawnDust(_a, 0.7, 0.3);
        }
      }
    }
  }

  /** A goolah has stopped: record it in a mat if it settled in one. */
  settleBall(ball) {
    const mat = this.matUnder(ball.body.pos);
    if (mat) {
      ball.state = 'mat';
      ball.matIndex = mat.index;
      ball.body.pos.y = CONFIG.ballRadius - CONFIG.matDepth + 0.001;
      ball.group.position.copy(ball.body.pos);
      const team = TEAMS[ball.teamIndex];
      const owner = TEAMS[mat.teamIndex];
      this.ui.toast(
        `Goolah ${ball.playerIndex + 1} (${team.name}) rests in mat ${mat.index + 1} · ${owner.name}'s mat`,
        team.css
      );
      // Scoring stays manual, so only point the scorekeeper at the right team.
      this.ui.pulseScoreButton(mat.teamIndex);
      return;
    }
    ball.state = 'settled';
  }

  matUnder(position) {
    for (const mat of this.mats) {
      const dx = position.x - mat.position.x;
      const dz = position.z - mat.position.z;
      if (Math.hypot(dx, dz) <= CONFIG.matRadius * 0.75) return mat;
    }
    return null;
  }

  syncVisuals(dt) {
    const R = CONFIG.ballRadius;
    for (const ball of this.balls) {
      ball.group.position.copy(ball.body.pos);

      const speed = Math.hypot(ball.body.vel.x, ball.body.vel.z);
      if (speed > 0.02 && ball.body.pos.y <= R + 0.06) {
        // Rolling spin: axis is perpendicular to travel, so the ball appears to
        // roll rather than slide.
        _b.set(-ball.body.vel.z, 0, ball.body.vel.x).normalize();
        _q.setFromAxisAngle(_b, (speed * dt) / R);
        ball.mesh.quaternion.premultiply(_q);
      }
    }
  }

  allSettled() {
    return this.balls.every((ball) => ball.state !== 'live');
  }

  /* --------------------------------------------------------------- input --- */

  _onDown(event) {
    if (!this.canAim()) return;
    this.pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    this.phase = 'aiming';
    this.aim.power = 0;
    this.aim.angle = 0;
    this.aim.dir.copy(FORWARD);
    this.ui.setPower(0);
    this.ui.setTurnHint('Drag to aim, release to throw');
    this.aimGroup.visible = true;
    this.dots.visible = true;
    this.updateAimVisuals();
    try {
      this.renderer.domElement.setPointerCapture(event.pointerId);
    } catch (err) {
      /* pointer capture is optional */
    }
  }

  _onMove(event) {
    if (!this.pointer || event.pointerId !== this.pointer.id) return;

    const dx = event.clientX - this.pointer.startX;
    const dy = event.clientY - this.pointer.startY;
    const mag = Math.hypot(dx, dy);
    if (mag < CONFIG.minDragPx) return;
    this.pointer.moved = true;

    // Screen space -> field space. A drag up the screen throws down the line of
    // mats; a sideways drag aims left or right.
    const axis = FORWARD;
    const side = _b.crossVectors(axis, UP).normalize();

    const along = -dy;
    if (along <= 0.05) return; // ignore backwards drags

    const rawAngle = Math.atan2(dx, along);
    const angle = clamp(rawAngle, -CONFIG.maxAimAngle, CONFIG.maxAimAngle);
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
    if (!this.pointer || (event.pointerId !== undefined && event.pointerId !== this.pointer.id)) {
      return;
    }
    const power = this.aim.power;
    const moved = this.pointer.moved;
    this.pointer = null;

    if (this.phase === 'aiming') {
      if (moved && power > 0.06) {
        this.throwBall(power);
      } else {
        this.phase = 'ready';
        this.aim.power = 0;
        this.ui.setPower(0);
        this.ui.setTurnHint('Drag to aim · release to throw');
        this.aimGroup.visible = false;
        this.dots.visible = false;
        this.restRing.visible = false;
      }
    }
    try {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    } catch (err) {
      /* ignore */
    }
  }

  canAim() {
    return this.phase === 'ready' && this.inputEnabled && this.turnLock <= 0 && !this.ui.overlayOpen;
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

  updateCamera(dt, snap = false) {
    const portrait = (this.camera.aspect || 1) < 1;
    const busy = this.phase === 'flying' || this.phase === 'aiming';

    // The camera always sits behind the shared throw line looking down the
    // line of mats, because both teams throw from that same line.
    const goalPos = _a.set(0, portrait ? 9.4 : 7.2, portrait ? -14.6 : -13.2);
    const goalLook = _b.set(0, 0.35, 1.1);

    if (busy) {
      const ball = this.activeBall.body.pos;
      goalLook.lerp(ball, 0.35);
      goalLook.y = Math.max(goalLook.y, 0.3);
    }

    const k = snap ? 1 : 1 - Math.exp(-4.5 * Math.max(dt, 0.001));
    this.camera.position.lerp(goalPos, k);
    this.camLook.lerp(goalLook, k);
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
    this.ui.onScore = (teamIndex, delta) => this.addScore(teamIndex, delta);

    document.getElementById('playBtn').addEventListener('click', () => this.begin());
    document.getElementById('rulesBtn').addEventListener('click', () => this.ui.openRules());
    document.getElementById('closeRules').addEventListener('click', () => this.ui.closeRules());
    document.getElementById('resetBtn').addEventListener('click', () => this.resetGame());
    document.getElementById('nextRoundBtn').addEventListener('click', () => this.nextRound());
    document.getElementById('playAgainBtn').addEventListener('click', () => {
      this.ui.hideWin();
      this.resetGame();
    });
  }

  begin() {
    this.ui.hideStart();
    this.phase = 'ready';
    this.inputEnabled = true;
    this.startRound();
    this.ui.showHint(`${TEAMS[this.activeTeamIndex].name} throws first — drag to aim`);
  }

  addScore(teamIndex, delta) {
    if (this.phase === 'intro' || this.phase === 'gameover') return;
    this.scores[teamIndex] = clamp(this.scores[teamIndex] + delta, 0, CONFIG.targetScore);
    this.ui.setScores(this.scores, CONFIG.targetScore);

    if (this.scores[teamIndex] >= CONFIG.targetScore) {
      this.phase = 'gameover';
      this.inputEnabled = false;
      this.hideAimHelpers();
      this.ui.showWin(TEAMS[teamIndex]);
    }
  }

  resetGame() {
    this.scores = [0, 0];
    this.round = 1;
    this.ui.setScores(this.scores, CONFIG.targetScore);
    this.ui.hideRoundEnd();
    this.inputEnabled = true;
    this.phase = 'ready';
    this.startRound();
  }

  /** Snapshot used by the automated checks. */
  state() {
    return {
      phase: this.phase,
      round: this.round,
      turnSeq: this.turnSeq,
      turn: { teamIndex: this.active.teamIndex, playerIndex: this.active.playerIndex },
      roundStartTeam: this.roundStartTeam,
      scores: [...this.scores],
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
