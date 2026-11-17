import * as THREE from 'three';
import { CONFIG, TEAMS } from './config.js';

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
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

    this.holes = world.holes;
    this.balls = [];
    this.effects = [];
    this.time = 0;

    this.scores = [0, 0];
    this.phase = 'intro'; // intro | ready | aiming | flying | roundEnd | gameover
    this.round = 1;
    this.roundStartIndex = 0;
    this.turnSeq = 0; // throws taken this round (0..3)
    this.turnIndex = 0;
    this.settleTimer = 0;
    this.turnLock = 0;
    this.inputEnabled = false;

    this.aim = { dir: new THREE.Vector3(0, 0, -1), power: 0, angle: 0 };
    this.pointer = null;
    this.camLook = new THREE.Vector3(0, 0.2, 1.6);
    this.camera.position.set(0, 10.4, 19.6);

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

    this.resetRound({ start: false });
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

        const spot = this.throwSpot(teamIndex, playerIndex);
        group.position.copy(spot);
        this.scene.add(group);

        this.balls.push({
          group,
          mesh,
          teamIndex,
          playerIndex,
          state: 'held', // held | live | sinking | hole
          vel: new THREE.Vector3(),
          sink: { from: new THREE.Vector3(), to: new THREE.Vector3(), t: 0 },
        });
      }
    });
  }

  throwSpot(teamIndex, playerIndex) {
    const sign = teamIndex === 0 ? 1 : -1;
    return new THREE.Vector3(
      CONFIG.throwX[playerIndex] * (teamIndex === 0 ? 1 : -1),
      CONFIG.ballRadius,
      CONFIG.throwZ * sign
    );
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
      new THREE.MeshBasicMaterial({ color: TEAMS[0].color, transparent: true, opacity: 0.7, depthWrite: false })
    );
    this.aimRing.rotation.x = -Math.PI / 2;
    this.aimRing.position.y = 0.025;
    this.aimRing.visible = false;
    this.scene.add(this.aimRing);

    // Dotted flight preview.
    const dotGeo = new THREE.SphereGeometry(0.075, 8, 6);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xfff3d0, transparent: true, opacity: 0.9, depthWrite: false });
    this.dots = new THREE.InstancedMesh(dotGeo, dotMat, 26);
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dots.visible = false;
    this.dots.frustumCulled = false;
    this.scene.add(this.dots);
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
    return this.turnIndex % 2;
  }

  get activePlayerIndex() {
    return Math.floor(this.turnIndex / 2) % 2;
  }

  get activeBall() {
    return this.balls[this.activeTeamIndex * CONFIG.playerCount + this.activePlayerIndex];
  }

  fieldAxis() {
    return this.activeTeamIndex === 0 ? _a.set(0, 0, -1) : _a.set(0, 0, 1);
  }

  startRound() {
    this.balls.forEach((ball) => {
      ball.state = 'held';
      ball.vel.set(0, 0, 0);
      ball.group.visible = true;
      ball.group.scale.setScalar(1);
      ball.group.position.copy(this.throwSpot(ball.teamIndex, ball.playerIndex));
      ball.mesh.quaternion.identity();
    });
    this.effects.forEach((fx) => {
      fx.mesh.visible = false;
    });
    this.turnSeq = 0;
    this.roundStartIndex = (this.round - 1) % 2;
    this.turnIndex = this.roundStartIndex;
    this.settleTimer = 0;
    this.startTurn();
  }

  startTurn() {
    const team = TEAMS[this.activeTeamIndex];
    const ball = this.activeBall;
    ball.group.position.copy(this.throwSpot(ball.teamIndex, ball.playerIndex));

    this.phase = 'ready';
    this.turnLock = 0.55;
    this.aim.power = 0;
    this.ui.setPower(0);
    this.ui.setTurn(this.activeTeamIndex, this.activePlayerIndex);
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
      this.marker.visible = false;
      this.aimRing.visible = false;
      this.aimGroup.visible = false;
      this.dots.visible = false;
      this.ui.showRoundEnd(this.round);
      return;
    }
    this.turnIndex += 1;
    this.startTurn();
  }

  nextRound() {
    this.round += 1;
    this.ui.hideRoundEnd();
    this.startRound();
  }

  /* -------------------------------------------------------------- throw --- */

  throwBall(power) {
    const ball = this.activeBall;
    const dir = this.aim.dir;
    const speed = CONFIG.minSpeed + power * (CONFIG.maxSpeed - CONFIG.minSpeed);
    const lift = CONFIG.minLift + power * (CONFIG.maxLift - CONFIG.minLift);

    ball.vel.set(dir.x * speed, lift, dir.z * speed);
    ball.state = 'live';
    this.phase = 'flying';
    this.settleTimer = 0;
    this.aim.power = 0;
    this.ui.setPower(0);
    this.ui.setTurnHint('In the air…');
    this.aimGroup.visible = false;
    this.dots.visible = false;
    this.aimRing.visible = false;
    this.marker.visible = false;
    this.aimRing.visible = false;
    this.spawnDust(ball.group.position, 0.5, 0.35);
  }

  /* ------------------------------------------------------------ physics --- */

  update(dt) {
    this.time += dt;
    if (this.turnLock > 0) this.turnLock -= dt;

    this.stepPhysics(dt);
    this.updateSinking(dt);
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
      for (const ball of this.balls) this.stepBall(ball, h);
      this.resolveCollisions();
      this.checkHoles();
    }
  }

  stepBall(ball, h) {
    if (ball.state !== 'live') return;
    const R = CONFIG.ballRadius;

    ball.vel.y -= CONFIG.gravity * h;
    ball.vel.multiplyScalar(Math.max(0, 1 - CONFIG.airDrag * h));
    ball.group.position.addScaledVector(ball.vel, h);

    if (ball.group.position.y <= R) {
      ball.group.position.y = R;
      if (ball.vel.y < 0) {
        const impact = -ball.vel.y;
        ball.vel.y = impact > 1.4 ? impact * CONFIG.restitution : 0;
        ball.vel.x *= CONFIG.bounceFriction;
        ball.vel.z *= CONFIG.bounceFriction;
        if (impact > 2.2) this.spawnDust(ball.group.position, 0.6, 0.3);
      }
      const speed = Math.hypot(ball.vel.x, ball.vel.z);
      if (speed > 0.0001) {
        const f = Math.max(0, speed - CONFIG.rollFriction * h) / speed;
        ball.vel.x *= f;
        ball.vel.z *= f;
      }
    }

    // Rolling spin.
    const speed = Math.hypot(ball.vel.x, ball.vel.z);
    if (speed > 0.02 && ball.group.position.y <= R + 0.02) {
      _b.set(ball.vel.z, 0, -ball.vel.x).normalize();
      _q.setFromAxisAngle(_b, (speed * h) / R);
      ball.mesh.quaternion.premultiply(_q);
    }

    // Keep play near the field.
    if (Math.abs(ball.group.position.x) > 32 || Math.abs(ball.group.position.z) > 36) {
      ball.vel.set(0, 0, 0);
    }
    if (ball.vel.lengthSq() < 0.0005 && ball.group.position.y <= R + 0.01) {
      ball.vel.set(0, 0, 0);
    }
  }

  resolveCollisions() {
    const R = CONFIG.ballRadius;
    const minDist = R * 2;
    for (let i = 0; i < this.balls.length; i++) {
      const a = this.balls[i];
      if (a.state === 'held' || a.state === 'hole' || a.state === 'sinking') continue;
      for (let j = i + 1; j < this.balls.length; j++) {
        const b = this.balls[j];
        if (b.state === 'held' || b.state === 'hole' || b.state === 'sinking') continue;

        _c.subVectors(b.group.position, a.group.position);
        const dist = _c.length();
        if (dist === 0 || dist >= minDist) continue;

        _c.multiplyScalar(1 / dist);
        const overlap = minDist - dist;
        a.group.position.addScaledVector(_c, -overlap * 0.5);
        b.group.position.addScaledVector(_c, overlap * 0.5);

        const rel = _b.subVectors(b.vel, a.vel).dot(_c);
        if (rel > 0) continue;
        const impulse = -(1 + 0.8) * rel * 0.5;
        a.vel.addScaledVector(_c, -impulse);
        b.vel.addScaledVector(_c, impulse);
      }
    }
  }

  checkHoles() {
    const R = CONFIG.ballRadius;
    for (const ball of this.balls) {
      if (ball.state !== 'live') continue;
      if (ball.group.position.y > R + 0.09) continue;
      const speed = Math.hypot(ball.vel.x, ball.vel.z);
      if (speed > CONFIG.captureSpeed) continue;
      for (const hole of this.holes) {
        const dx = ball.group.position.x - hole.x;
        const dz = ball.group.position.z - hole.z;
        if (Math.hypot(dx, dz) < CONFIG.captureRadius) {
          this.sinkBall(ball, hole);
          break;
        }
      }
    }
  }

  sinkBall(ball, hole) {
    ball.state = 'sinking';
    ball.sink.from.copy(ball.group.position);
    ball.sink.to.set(hole.x, -0.6, hole.z);
    ball.sink.t = 0;
    ball.vel.set(0, 0, 0);
    this.spawnDust(ball.group.position, 0.9, 0.5);

    const team = TEAMS[ball.teamIndex];
    this.ui.toast(`Goolah in the hole! · ${team.name}`, team.css);
    this.ui.pulseScoreButton(ball.teamIndex);
  }

  updateSinking(dt) {
    for (const ball of this.balls) {
      if (ball.state !== 'sinking') continue;
      ball.sink.t += dt / 0.45;
      const t = clamp(ball.sink.t, 0, 1);
      ball.group.position.lerpVectors(ball.sink.from, ball.sink.to, easeOut(t));
      if (t >= 1) {
        ball.state = 'hole';
        ball.group.visible = false;
      }
    }
  }

  allSettled() {
    const R = CONFIG.ballRadius;
    return this.balls.every((ball) => {
      if (ball.state === 'held' || ball.state === 'hole' || ball.state === 'sinking') return true;
      const speed = Math.hypot(ball.vel.x, ball.vel.z);
      return speed < 0.18 && Math.abs(ball.vel.y) < 0.4 && ball.group.position.y <= R + 0.02;
    });
  }

  /* --------------------------------------------------------------- input --- */

  cameraBasis() {
    this.camera.getWorldDirection(_c);
    _c.y = 0;
    if (_c.lengthSq() < 1e-6) _c.set(0, 0, -1);
    _c.normalize();
    return _c;
  }

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
    this.ui.setPower(0);
    this.ui.setTurnHint('Drag to aim, release to throw');
    this.aimGroup.visible = true;
    this.dots.visible = true;
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
    if (mag < 6) return;
    this.pointer.moved = true;

    const forward = this.cameraBasis().clone();
    const right = new THREE.Vector3().crossVectors(forward, UP).normalize();

    _b.set(0, 0, 0).addScaledVector(right, dx).addScaledVector(forward, -dy);
    if (_b.lengthSq() < 1e-6) return;
    _b.normalize();

    const axis = this.fieldAxis().clone();
    const side = new THREE.Vector3().crossVectors(axis, UP).normalize();
    if (_b.dot(axis) <= 0.05) return; // ignore backwards swipes

    const rawAngle = Math.atan2(_b.dot(side), _b.dot(axis));
    const angle = clamp(rawAngle, -CONFIG.maxAimAngle, CONFIG.maxAimAngle);
    this.aim.angle = angle;
    this.aim.dir.copy(axis).multiplyScalar(Math.cos(angle)).addScaledVector(side, Math.sin(angle)).normalize();

    const screen = Math.min(window.innerWidth, window.innerHeight);
    this.aim.power = clamp(mag / (screen * 0.34), 0.06, 1);
    this.ui.setPower(this.aim.power);
    this.updateAimVisuals();
  }

  _onUp(event) {
    if (!this.pointer || (event.pointerId !== undefined && event.pointerId !== this.pointer.id)) return;
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
        this.ui.setTurnHint('Swipe up to throw');
        this.aimGroup.visible = false;
        this.dots.visible = false;
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
    const pos = ball.group.position;
    this.aimGroup.position.set(pos.x, 0.055, pos.z);
    this.aimGroup.rotation.y = Math.atan2(this.aim.dir.x, this.aim.dir.z);
    const length = 1.3 + this.aim.power * 4.4;
    this.aimShaft.scale.z = length;
    this.aimTip.position.z = length;

    this.aimRing.position.set(pos.x, 0.025, pos.z);

    // Flight preview.
    const speed = CONFIG.minSpeed + this.aim.power * (CONFIG.maxSpeed - CONFIG.minSpeed);
    const lift = CONFIG.minLift + this.aim.power * (CONFIG.maxLift - CONFIG.minLift);
    const p = pos.clone();
    const v = new THREE.Vector3(this.aim.dir.x * speed, lift, this.aim.dir.z * speed);
    const step = 0.055;
    const R = CONFIG.ballRadius;
    for (let i = 0; i < 26; i++) {
      v.y -= CONFIG.gravity * step;
      p.addScaledVector(v, step);
      if (p.y < R) {
        p.y = R;
        if (v.y < 0) v.y = -v.y * CONFIG.restitution;
        v.x *= 0.86;
        v.z *= 0.86;
      }
      const s = 1 - i / 34;
      _m.makeScale(s, s, s);
      _m.setPosition(p.x, p.y, p.z);
      this.dots.setMatrixAt(i, _m);
    }
    this.dots.instanceMatrix.needsUpdate = true;
  }

  /* -------------------------------------------------------------- visuals --- */

  updateMarker() {
    if (!this.marker.visible) return;
    const ball = this.activeBall;
    const bob = Math.sin(this.time * 3.4) * 0.09;
    this.marker.position.set(ball.group.position.x, ball.group.position.y + bob, ball.group.position.z);
    this.marker.rotation.y = this.time * 0.9;
  }

  updateCamera(dt, snap = false) {
    const sign = this.activeTeamIndex === 0 ? 1 : -1;
    const portrait = (this.camera.aspect || 1) < 1;

    const goalPos = _a.set(0, portrait ? 10.4 : 8.8, (portrait ? 19.6 : 17.2) * sign);
    const goalLook = _b.set(0, 0.2, 1.6 * sign);

    if (this.phase === 'flying' || this.phase === 'aiming') {
      goalLook.lerp(this.activeBall.group.position, 0.4);
      goalLook.y = Math.max(goalLook.y, 0.25);
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
    this.ui.showHint('Swipe up to throw your goolah');
  }

  addScore(teamIndex, delta) {
    if (this.phase === 'intro' || this.phase === 'gameover') return;
    this.scores[teamIndex] = clamp(this.scores[teamIndex] + delta, 0, CONFIG.targetScore);
    this.ui.setScores(this.scores, CONFIG.targetScore);

    if (this.scores[teamIndex] >= CONFIG.targetScore) {
      this.phase = 'gameover';
      this.inputEnabled = false;
      this.aimGroup.visible = false;
      this.dots.visible = false;
      this.marker.visible = false;
      this.aimRing.visible = false;
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
}
