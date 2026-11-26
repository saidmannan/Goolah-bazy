import * as THREE from 'three';
import { CONFIG, TEAMS } from './config.js';

/* -------------------------------------------------------------------------
   Goolah Bazy — the playing field
   -------------------------------------------------------------------------
   Visual identity: a packed-earth court cut out of the Afghan plain in late
   afternoon light. The court is a lighter, swept strip of beaten earth; the
   plain around it sits slightly lower and grows dry grass and stones; low
   earthen berms mark the edge of play.

   The four mats are real holes in the court surface, each filled with a
   modelled shallow dish (lathe-turned profile: recessed floor, curved inner
   wall, raised rim, collar that the dirt overhangs). Nothing is a painted
   circle or a glowing disc, and because the hole is cut in the ground the dish
   reads correctly from every camera angle, including from below the rim.

   Everything is procedural — canvas textures and primitives — so the whole
   environment costs no downloads and stays cheap enough for a phone.
------------------------------------------------------------------------- */

const COURT = {
  // The court reaches past the playable strip so a goolah can always be seen
  // resting on ground rather than hanging over an edge.
  halfWidth: CONFIG.playArea.halfWidth + 1.9,
  minZ: CONFIG.playArea.minZ - 2.2,
  maxZ: CONFIG.playArea.maxZ + 2.2,
  drop: 0.16, // the plain around the court sits this far below it
};

const PALETTE = {
  haze: 0xdcc094,
  sun: 0xffeac6,
  skyTop: 0x2b6cc4,
  skyMid: 0x9fcaf0,
  skyLow: 0xf7dcae,
  lime: 0xf2e7cd,
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const rand = (min, max) => min + Math.random() * (max - min);

/* ------------------------------------------------------------------ sky --- */

function createSky(sunDir) {
  const geometry = new THREE.SphereGeometry(240, 32, 20);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(PALETTE.skyTop) },
      midColor: { value: new THREE.Color(PALETTE.skyMid) },
      lowColor: { value: new THREE.Color(PALETTE.skyLow) },
      sunDir: { value: sunDir.clone().normalize() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 midColor;
      uniform vec3 lowColor;
      uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(lowColor, midColor, smoothstep(0.46, 0.68, h));
        col = mix(col, topColor, smoothstep(0.66, 0.99, h));
        float sd = max(dot(d, normalize(sunDir)), 0.0);
        // A tight sun disc plus a wide, dusty bloom around it.
        col += vec3(1.0, 0.94, 0.80) * pow(sd, 320.0) * 1.6;
        col += vec3(1.0, 0.86, 0.64) * pow(sd, 10.0) * 0.20;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(geometry, material);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  return sky;
}

/** A small equirectangular sky used only as the reflection probe for metal. */
function environmentCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#2c6cc0');
  grad.addColorStop(0.42, '#a6cdef');
  grad.addColorStop(0.5, '#f7dcae');
  grad.addColorStop(0.56, '#b9834f');
  grad.addColorStop(1, '#5d3a1e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);

  // Warm sun blob: gives the steel a bright specular to travel across.
  const sun = ctx.createRadialGradient(140, 86, 0, 140, 86, 78);
  sun.addColorStop(0, 'rgba(255,255,246,1)');
  sun.addColorStop(0.22, 'rgba(255,240,205,0.9)');
  sun.addColorStop(1, 'rgba(255,220,150,0)');
  ctx.fillStyle = sun;
  ctx.beginPath();
  ctx.arc(140, 86, 78, 0, Math.PI * 2);
  ctx.fill();

  // A soft dark band at the horizon so the balls pick up a ground reflection.
  const band = ctx.createLinearGradient(0, 120, 0, 168);
  band.addColorStop(0, 'rgba(120,78,42,0)');
  band.addColorStop(0.5, 'rgba(120,78,42,0.55)');
  band.addColorStop(1, 'rgba(120,78,42,0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, 120, 512, 48);
  return canvas;
}

function createEnvironment(scene, renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const texture = new THREE.CanvasTexture(environmentCanvas());
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  const env = pmrem.fromEquirectangular(texture).texture;
  scene.environment = env;
  texture.dispose();
  pmrem.dispose();
  return env;
}

/* --------------------------------------------------------------- lights --- */

function createLights(scene) {
  // Sky bounce from above, warm bounce off the dirt from below: this is what
  // stops the shadowed side of a goolah from going flat black.
  const hemi = new THREE.HemisphereLight(0xc2ddff, 0x8a5a33, 0.95);
  hemi.position.set(0, 30, 0);
  scene.add(hemi);

  // Low, warm key light. A shallow angle is what makes the rim of every mat
  // cast a readable shadow and gives the field its late-afternoon mood.
  const sun = new THREE.DirectionalLight(PALETTE.sun, 2.55);
  sun.position.set(15, 17, 11);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 78;
  sun.shadow.camera.left = -19;
  sun.shadow.camera.right = 19;
  sun.shadow.camera.top = 24;
  sun.shadow.camera.bottom = -24;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.028;
  sun.shadow.radius = 2.2;
  scene.add(sun);
  scene.add(sun.target);
  sun.target.position.set(0, 0, 1);

  // Cool fill from the opposite side keeps the shadow side legible.
  const fill = new THREE.DirectionalLight(0xa9c8f0, 0.42);
  fill.position.set(-16, 9, -12);
  scene.add(fill);

  // Warm bounce low from behind the far mats for a little separation.
  const rim = new THREE.DirectionalLight(0xffb87a, 0.38);
  rim.position.set(-8, 4, 20);
  scene.add(rim);

  return sun;
}

/* -------------------------------------------------------------- textures --- */

/**
 * Dry, beaten earth. One canvas drives both colour and bump, so the grain and
 * the relief line up instead of fighting each other.
 */
function dirtCanvas({ size = 1024, base = ['#8f5f37', '#7d5029', '#6b4322'], wear = 0.3 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, base[0]);
  grad.addColorStop(0.5, base[1]);
  grad.addColorStop(1, base[2]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Broad tonal patches: sun-bleached areas and damper, darker soil.
  for (let i = 0; i < 300; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 22 + Math.random() * (size * 0.14);
    const light = Math.random() > 0.45;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, light ? `rgba(190,146,98,${0.30 * wear})` : `rgba(80,50,27,${0.28 * wear})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fine grain.
  const grain = Math.round(size * 13);
  for (let i = 0; i < grain; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const s = Math.random() * 1.9 + 0.3;
    const v = Math.random();
    ctx.fillStyle =
      v > 0.55 ? 'rgba(203,163,116,0.26)' : v > 0.2 ? 'rgba(88,57,31,0.24)' : 'rgba(56,35,18,0.28)';
    ctx.fillRect(x, y, s, s);
  }

  // Clods and grit.
  for (let i = 0; i < Math.round(size * 0.85); i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 0.8 + Math.random() * 2.8;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.6 + Math.random() * 0.5), Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(212,175,131,0.46)' : 'rgba(66,41,22,0.42)';
    ctx.fill();
  }

  // Dried cracks.
  ctx.lineCap = 'round';
  for (let i = 0; i < Math.round(size * 0.07); i++) {
    let x = Math.random() * size;
    let y = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 3 + Math.floor(Math.random() * 6);
    for (let s = 0; s < segs; s++) {
      x += (Math.random() - 0.5) * (size * 0.06);
      y += (Math.random() - 0.5) * (size * 0.06);
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(52,32,16,${0.09 + Math.random() * 0.15})`;
    ctx.lineWidth = 0.7 + Math.random() * 1.4;
    ctx.stroke();
  }

  return canvas;
}

/** The swept playing strip: finer, paler, with faint drag marks down the line. */
function courtCanvas(size = 1024) {
  const canvas = dirtCanvas({
    size,
    base: ['#c39a6b', '#b78d5f', '#a97f52'],
    wear: 0.22,
  });
  const ctx = canvas.getContext('2d');

  // Long, soft scuffs along the throwing direction.
  ctx.lineCap = 'round';
  for (let i = 0; i < 150; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 40 + Math.random() * 260;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + (Math.random() - 0.5) * 18, y + len * 0.5, x + (Math.random() - 0.5) * 26, y + len);
    ctx.strokeStyle =
      Math.random() > 0.5 ? 'rgba(226,199,160,0.10)' : 'rgba(126,92,58,0.10)';
    ctx.lineWidth = 1 + Math.random() * 4;
    ctx.stroke();
  }

  // A lighter, well-walked band down the middle where everyone stands.
  const band = ctx.createLinearGradient(0, 0, size, 0);
  band.addColorStop(0, 'rgba(233,208,170,0)');
  band.addColorStop(0.5, 'rgba(233,208,170,0.16)');
  band.addColorStop(1, 'rgba(233,208,170,0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, size, size);

  return canvas;
}

function canvasTexture(canvas, repeatX = 1, repeatY = 1, renderer = null) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (renderer) {
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }
  return texture;
}

/* ---------------------------------------------------------------- ground --- */

/**
 * The court: a rectangle with a real circular hole cut at each mat. The holes
 * are what let the dishes sit *in* the ground instead of floating on it.
 *
 * ShapeGeometry works in XY and its UVs are the shape coordinates, so after the
 * mesh is laid flat the UVs are world XZ — the dirt texture therefore tiles in
 * metres with no manual UV work.
 */
function createCourt(renderer) {
  const w = COURT.halfWidth;
  const shape = new THREE.Shape();
  // Shape Y maps to world -Z after rotateX(-90deg), so build it mirrored and the
  // court lands exactly on the configured Z range.
  shape.moveTo(-w, -COURT.minZ);
  shape.lineTo(w, -COURT.minZ);
  shape.lineTo(w, -COURT.maxZ);
  shape.lineTo(-w, -COURT.maxZ);
  shape.closePath();

  for (const z of CONFIG.matZ) {
    const hole = new THREE.Path();
    hole.absarc(CONFIG.matX, -z, CONFIG.matRadius * 1.26, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }

  const geometry = new THREE.ShapeGeometry(shape, 30);
  geometry.rotateX(-Math.PI / 2);

  const map = canvasTexture(courtCanvas(), 1 / 5, 1 / 5, renderer);
  const bump = new THREE.CanvasTexture(courtCanvas(512));
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.repeat.set(1 / 5, 1 / 5);

  const material = new THREE.MeshStandardMaterial({
    map,
    bumpMap: bump,
    bumpScale: 0.5,
    roughness: 0.97,
    metalness: 0.02,
    color: 0xffffff,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = 0;
  mesh.receiveShadow = true;
  return mesh;
}

/** The plain around the court, sitting slightly lower so the court reads raised. */
function createPlain(renderer) {
  const map = canvasTexture(dirtCanvas(), 1 / 9, 1 / 9, renderer);
  const bump = new THREE.CanvasTexture(dirtCanvas(512));
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.repeat.set(1 / 9, 1 / 9);

  const material = new THREE.MeshStandardMaterial({
    map,
    bumpMap: bump,
    bumpScale: 0.6,
    roughness: 1,
    metalness: 0,
    color: 0xcfb189,
  });

  const plain = new THREE.Mesh(new THREE.PlaneGeometry(170, 170, 1, 1), material);
  plain.rotation.x = -Math.PI / 2;
  plain.position.y = -COURT.drop;
  plain.receiveShadow = true;
  return plain;
}

/** Low packed-earth berms along the four edges of the court. */
function createBerms() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0xa9784a,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });

  const width = COURT.halfWidth * 2;
  const length = COURT.maxZ - COURT.minZ;
  const midZ = (COURT.maxZ + COURT.minZ) / 2;

  const longEdge = new THREE.CapsuleGeometry(0.17, length, 3, 10);
  longEdge.rotateX(Math.PI / 2);
  for (const side of [-1, 1]) {
    const berm = new THREE.Mesh(longEdge, material);
    berm.position.set(side * (COURT.halfWidth + 0.05), -0.06, midZ);
    berm.scale.set(1.35, 0.72, 1);
    berm.castShadow = true;
    berm.receiveShadow = true;
    group.add(berm);
  }

  const shortEdge = new THREE.CapsuleGeometry(0.17, width, 3, 10);
  shortEdge.rotateZ(Math.PI / 2);
  for (const z of [COURT.minZ - 0.05, COURT.maxZ + 0.05]) {
    const berm = new THREE.Mesh(shortEdge, material);
    berm.position.set(0, -0.06, z);
    berm.scale.set(1, 0.72, 1.35);
    berm.castShadow = true;
    berm.receiveShadow = true;
    group.add(berm);
  }

  return group;
}

/** The shared throwing line, painted on the court with worn edges. */
function createThrowLine() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  // A lime-washed stripe with a dry brush edge.
  ctx.fillStyle = 'rgba(244,233,209,0.92)';
  ctx.fillRect(0, size * 0.42, size, size * 0.16);
  for (let i = 0; i < 220; i++) {
    const x = Math.random() * size;
    const y = size * 0.4 + Math.random() * size * 0.2;
    const r = 1 + Math.random() * 4;
    ctx.globalAlpha = 0.1 + Math.random() * 0.25;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = Math.random() > 0.5 ? '#f4e9d1' : '#8a6136';
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const width = CONFIG.throwLineHalfWidth * 2;
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(width, 0.5),
    new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      roughness: 1,
      metalness: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    })
  );
  line.rotation.x = -Math.PI / 2;
  line.position.set(0, 0.006, CONFIG.throwLineZ);
  line.receiveShadow = false;

  const group = new THREE.Group();
  group.add(line);

  // Short end ticks so the line reads as a starting line at a glance.
  const tickMat = new THREE.MeshStandardMaterial({
    color: PALETTE.lime,
    roughness: 1,
    metalness: 0,
    transparent: true,
    opacity: 0.85,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  for (const side of [-1, 1]) {
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.62), tickMat);
    tick.rotation.x = -Math.PI / 2;
    tick.position.set(side * CONFIG.throwLineHalfWidth, 0.006, CONFIG.throwLineZ + 0.3);
    group.add(tick);
  }

  return group;
}

/* ------------------------------------------------------------------ mats --- */

/**
 * The turned profile of one dish, as (radius, height) pairs.
 *
 * Reading outward: recessed floor at -depth, a floor that lifts gently into a
 * curved inner wall, a raised rim crest just above the court, then a collar that
 * drops away under the dirt. The collar deliberately runs past the hole radius
 * (1.26R) so the cut edge of the court overhangs it and there is no seam.
 */
function dishProfile(R, D) {
  return [
    [0.0, -D],
    [0.26 * R, -D * 0.998],
    [0.52 * R, -D * 0.985],
    [0.70 * R, -D * 0.93],
    [0.81 * R, -D * 0.70],
    [0.89 * R, -D * 0.42],
    [0.95 * R, -D * 0.16],
    [0.99 * R, 0.016],
    [1.045 * R, 0.004],
    [1.12 * R, -0.024],
    [1.26 * R, -0.042],
    [1.46 * R, -0.1],
  ].map(([x, y]) => new THREE.Vector2(x, y));
}

function matFloorCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, '#150d06');
  grad.addColorStop(0.55, '#2b1b0d');
  grad.addColorStop(0.88, '#4d3319');
  grad.addColorStop(1, '#6b4726');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);

  // Grit in the bottom of the hollow.
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * 128;
    const y = Math.random() * 128;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(150,116,74,0.35)' : 'rgba(30,18,8,0.4)';
    ctx.fillRect(x, y, 1 + Math.random() * 1.6, 1 + Math.random() * 1.6);
  }
  return canvas;
}

function matLabelCanvas(number, cssColor) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);

  // Clay token with a painted rim in the owning team's colour.
  ctx.beginPath();
  ctx.arc(64, 64, 58, 0, Math.PI * 2);
  ctx.fillStyle = '#3a2513';
  ctx.fill();
  ctx.lineWidth = 9;
  ctx.strokeStyle = cssColor;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(64, 64, 45, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(12, 7, 3, 0.72)';
  ctx.fill();

  ctx.fillStyle = '#fff7e6';
  ctx.font = 'bold 66px "Trebuchet MS", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), 64, 70);
  return canvas;
}

/**
 * Four modelled dishes in a line. Each mat reports its own state so the field
 * itself shows whether it is open, holding a goolah, or closed for the round.
 */
function createMats(scene, renderer) {
  const mats = [];
  const R = CONFIG.matRadius;
  const D = CONFIG.matDepth;

  const floorTex = new THREE.CanvasTexture(matFloorCanvas());
  floorTex.colorSpace = THREE.SRGBColorSpace;

  // One lathe profile is shared by all four dishes.
  const dishGeo = new THREE.LatheGeometry(dishProfile(R, D), 56);
  const floorGeo = new THREE.CircleGeometry(0.62 * R, 28).rotateX(-Math.PI / 2);
  const capGeo = new THREE.CylinderGeometry(0.56 * R, 0.6 * R, 0.05, 28);

  const dishMat = new THREE.MeshStandardMaterial({
    color: 0x6d4826,
    roughness: 0.96,
    metalness: 0.02,
    side: THREE.DoubleSide,
    flatShading: false,
  });
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 1,
    metalness: 0,
  });
  const capMat = new THREE.MeshStandardMaterial({
    color: 0x9d8a6c,
    roughness: 0.85,
    metalness: 0.08,
    flatShading: true,
  });

  for (let index = 0; index < CONFIG.matZ.length; index++) {
    const z = CONFIG.matZ[index];
    const teamIndex = CONFIG.matOwner[index];
    const team = TEAMS[teamIndex];

    const group = new THREE.Group();
    group.position.set(CONFIG.matX, 0, z);

    // The dish itself, sunk into the hole cut in the court.
    const dish = new THREE.Mesh(dishGeo, dishMat);
    dish.receiveShadow = true;
    dish.castShadow = true;
    group.add(dish);

    // Cap under the floor so the hollow is never see-through from a low angle.
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = -D + 0.002;
    floor.receiveShadow = true;
    group.add(floor);

    // Metal inlay on the rim: the team's colour, and the main state cue.
    const inlay = new THREE.Mesh(
      new THREE.TorusGeometry(R * 0.965, 0.026, 8, 44),
      new THREE.MeshStandardMaterial({
        color: team.color,
        metalness: 0.72,
        roughness: 0.34,
        emissive: new THREE.Color(team.color),
        emissiveIntensity: 0.18,
      })
    );
    inlay.rotation.x = -Math.PI / 2;
    inlay.position.y = 0.016;
    inlay.castShadow = false;
    group.add(inlay);

    // Stone lid that appears when the mat is closed for the round.
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = -D + 0.028;
    cap.visible = false;
    cap.castShadow = true;
    cap.receiveShadow = true;
    group.add(cap);

    // Four clay studs around the rim, so the mat reads as built, not painted.
    const studGeo = new THREE.SphereGeometry(0.036, 8, 6);
    for (let s = 0; s < 4; s++) {
      const angle = (s / 4) * Math.PI * 2 + Math.PI / 4;
      const stud = new THREE.Mesh(studGeo, capMat);
      stud.position.set(Math.cos(angle) * R * 1.13, 0.004, Math.sin(angle) * R * 1.13);
      stud.castShadow = true;
      group.add(stud);
    }

    scene.add(group);

    // Number token beside the mat, billboarded towards the camera each frame so
    // it stays readable from any orbit angle.
    const labelTex = new THREE.CanvasTexture(matLabelCanvas(index + 1, team.css));
    labelTex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.4),
      new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthWrite: false })
    );
    label.position.set(CONFIG.matX + R + 0.66, 0.32, z);
    scene.add(label);

    const mat = {
      index,
      teamIndex,
      position: new THREE.Vector3(CONFIG.matX, 0, z),
      group,
      label,
      state: 'open',
      /** open | occupied | closed */
      setState(next) {
        if (this.state === next) return;
        this.state = next;
        const closed = next === 'closed';
        const occupied = next === 'occupied';
        cap.visible = closed;
        inlay.material.emissiveIntensity = closed ? 0.04 : occupied ? 0.62 : 0.18;
        inlay.material.color.setHex(closed ? 0x8d7a5c : team.color);
        inlay.material.metalness = closed ? 0.5 : 0.72;
        label.material.opacity = closed ? 0.42 : 1;
        label.material.transparent = true;
      },
    };

    mats.push(mat);
  }

  return mats;
}

/* ----------------------------------------------------------------- props --- */

function scatterPebbles(scene) {
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  const geo = new THREE.IcosahedronGeometry(0.1, 0);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xb49a7c,
    roughness: 0.92,
    flatShading: true,
  });
  const count = 190;
  const pebbles = new THREE.InstancedMesh(geo, mat, count);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * 32;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    // Keep the swept court clear of debris.
    const onCourt =
      Math.abs(x) < COURT.halfWidth - 0.3 && z > COURT.minZ + 0.3 && z < COURT.maxZ - 0.3;
    dummy.position.set(x, onCourt ? 0.012 : -COURT.drop + 0.03, z);
    dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    const s = rand(0.35, 1.35) * (onCourt ? 0.6 : 1);
    dummy.scale.set(s, s * 0.7, s);
    dummy.updateMatrix();
    pebbles.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.09, rand(0.12, 0.28), rand(0.42, 0.68));
    pebbles.setColorAt(i, color);
  }
  pebbles.instanceMatrix.needsUpdate = true;
  pebbles.castShadow = false;
  pebbles.receiveShadow = true;
  scene.add(pebbles);
}

function scatterGrass(scene) {
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  const geo = new THREE.ConeGeometry(0.1, 0.62, 4, 1);
  geo.translate(0, 0.31, 0);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    flatShading: true,
  });
  const count = 460;
  const tufts = new THREE.InstancedMesh(geo, mat, count);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    // Only outside the court, so nothing grows through the playing surface.
    const radius = rand(COURT.halfWidth + 0.7, 36);
    dummy.position.set(
      Math.cos(angle) * radius,
      -COURT.drop,
      Math.sin(angle) * radius * 1.15
    );
    dummy.rotation.set(rand(-0.18, 0.18), Math.random() * Math.PI, rand(-0.18, 0.18));
    const s = rand(0.6, 1.9);
    dummy.scale.set(s, s * rand(0.7, 1.6), s);
    dummy.updateMatrix();
    tufts.setMatrixAt(i, dummy.matrix);
    color.setHSL(rand(0.16, 0.26), rand(0.25, 0.5), rand(0.24, 0.42));
    tufts.setColorAt(i, color);
  }
  tufts.instanceMatrix.needsUpdate = true;
  tufts.receiveShadow = true;
  scene.add(tufts);
}

function scatterRocks(scene) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x9a8265,
    roughness: 0.94,
    flatShading: true,
  });
  for (let i = 0; i < 14; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = rand(COURT.halfWidth + 3, 32);
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(rand(0.5, 1.5), 0), mat);
    rock.position.set(
      Math.cos(angle) * radius,
      rand(0.05, 0.3) - COURT.drop,
      Math.sin(angle) * radius
    );
    rock.rotation.set(Math.random(), Math.random(), Math.random());
    rock.scale.y = rand(0.5, 0.9);
    rock.castShadow = true;
    rock.receiveShadow = true;
    scene.add(rock);
  }
}

function backdropMountains(scene) {
  // Hazy ridges: the haze colour keeps them from competing with the court.
  const mat = new THREE.MeshStandardMaterial({
    color: 0x9aa8c6,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2 + Math.random() * 0.2;
    const radius = 82 + Math.random() * 28;
    const height = 17 + Math.random() * 28;
    const mountain = new THREE.Mesh(
      new THREE.ConeGeometry(height * (0.55 + Math.random() * 0.4), height, 5, 1),
      mat
    );
    mountain.position.set(
      Math.cos(angle) * radius,
      height / 2 - 3 - COURT.drop,
      Math.sin(angle) * radius
    );
    mountain.rotation.y = Math.random() * Math.PI;
    scene.add(mountain);
  }
}

function backdropClouds(scene) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xfff8ec,
    roughness: 1,
    metalness: 0,
    emissive: 0xe6eefc,
    emissiveIntensity: 0.3,
    flatShading: true,
  });
  for (let i = 0; i < 8; i++) {
    const cloud = new THREE.Group();
    const puffs = 3 + Math.floor(Math.random() * 3);
    for (let p = 0; p < puffs; p++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(2 + Math.random() * 2.2, 8, 6), mat);
      puff.position.set(p * 2.6 - puffs * 1.2, Math.random() * 1.1, Math.random() * 1.6);
      puff.scale.y = 0.62;
      cloud.add(puff);
    }
    const angle = (i / 8) * Math.PI * 2 + Math.random() * 0.6;
    const radius = 66 + Math.random() * 40;
    cloud.position.set(Math.cos(angle) * radius, 27 + Math.random() * 16, Math.sin(angle) * radius);
    cloud.scale.setScalar(1 + Math.random() * 0.7);
    scene.add(cloud);
  }
}

/* ----------------------------------------------------------------- build --- */

export function buildWorld(scene, renderer) {
  const timings = {};
  const time = (label, fn) => {
    const started = performance.now();
    const result = fn();
    timings[label] = Math.round(performance.now() - started);
    return result;
  };

  // Warm dust haze, matched to the sky's horizon so the two blend.
  scene.fog = new THREE.Fog(PALETTE.haze, 46, 158);

  const sunDir = new THREE.Vector3(15, 17, 11);
  time('sky', () => scene.add(createSky(sunDir)));
  time('environment', () => createEnvironment(scene, renderer));
  const sun = time('lights', () => createLights(scene));

  const plain = time('plain', () => createPlain(renderer));
  scene.add(plain);

  const court = time('court', () => createCourt(renderer));
  scene.add(court);

  const berms = time('berms', () => createBerms());
  scene.add(berms);

  const throwLine = time('throwLine', () => createThrowLine());
  scene.add(throwLine);

  const mats = time('mats', () => createMats(scene, renderer));

  const labels = mats.map((mat) => mat.label);

  // Decoration is added one step at a time by main.js, after the playable field
  // is on screen, so no single long task blocks the first paint.
  const decorSteps = [
    () => scatterPebbles(scene),
    () => scatterGrass(scene),
    () => scatterRocks(scene),
    () => backdropMountains(scene),
    () => backdropClouds(scene),
  ];

  /** Keep the mat number tokens facing the camera. */
  function update(dt, camera) {
    if (!camera) return;
    for (const label of labels) {
      label.rotation.y = Math.atan2(
        camera.position.x - label.position.x,
        camera.position.z - label.position.z
      );
    }
  }

  return {
    sun,
    mats,
    ground: { court, plain, berms, throwLine },
    decorSteps,
    timings,
    update,
  };
}
