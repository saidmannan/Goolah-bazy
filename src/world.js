import * as THREE from 'three';
import { CONFIG } from './config.js';

/* ------------------------------------------------------------------ sky --- */

function createSky() {
  const geometry = new THREE.SphereGeometry(220, 32, 20);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x3f7fd8) },
      midColor: { value: new THREE.Color(0xa9d4f5) },
      bottomColor: { value: new THREE.Color(0xffe0ad) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vDir = normalize(world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 midColor;
      uniform vec3 bottomColor;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(bottomColor, midColor, smoothstep(0.42, 0.62, h));
        col = mix(col, topColor, smoothstep(0.6, 0.95, h));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(geometry, material);
  sky.renderOrder = -1;
  return sky;
}

function skyCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#2f6bc4');
  grad.addColorStop(0.45, '#a8d2f2');
  grad.addColorStop(0.52, '#ffe4b8');
  grad.addColorStop(0.6, '#c58b52');
  grad.addColorStop(1, '#6a4222');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);

  // A warm sun blob so the metal has something bright to reflect.
  const sun = ctx.createRadialGradient(150, 92, 0, 150, 92, 70);
  sun.addColorStop(0, 'rgba(255,255,240,1)');
  sun.addColorStop(0.25, 'rgba(255,238,196,0.85)');
  sun.addColorStop(1, 'rgba(255,220,150,0)');
  ctx.fillStyle = sun;
  ctx.beginPath();
  ctx.arc(150, 92, 70, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

function createEnvironment(scene, renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const texture = new THREE.CanvasTexture(skyCanvas());
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
  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x8a5a34, 1.15);
  hemi.position.set(0, 30, 0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff0cf, 2.4);
  sun.position.set(13, 20, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 70;
  sun.shadow.camera.left = -18;
  sun.shadow.camera.right = 18;
  sun.shadow.camera.top = 22;
  sun.shadow.camera.bottom = -22;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  const rim = new THREE.DirectionalLight(0xffc48a, 0.55);
  rim.position.set(-14, 8, -16);
  scene.add(rim);

  return sun;
}

/* ---------------------------------------------------------------- ground --- */

function makeDirtTexture(size = 1024) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  const base = ctx.createLinearGradient(0, 0, size, size);
  base.addColorStop(0, '#9c6b40');
  base.addColorStop(0.5, '#8a5b33');
  base.addColorStop(1, '#79502c');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Broad tonal patches - dry, dusty earth.
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 24 + Math.random() * 130;
    const light = Math.random() > 0.45;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, light ? 'rgba(186,140,92,0.34)' : 'rgba(88,55,30,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fine grain.
  for (let i = 0; i < 14000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const s = Math.random() * 1.8 + 0.3;
    const v = Math.random();
    ctx.fillStyle =
      v > 0.55 ? 'rgba(196,156,110,0.28)' : v > 0.2 ? 'rgba(92,60,34,0.26)' : 'rgba(60,38,20,0.3)';
    ctx.fillRect(x, y, s, s);
  }

  // Pebbles and clods.
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 0.8 + Math.random() * 2.6;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.6 + Math.random() * 0.5), Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(205,168,124,0.5)' : 'rgba(70,44,24,0.45)';
    ctx.fill();
  }

  // Dried cracks.
  ctx.lineCap = 'round';
  for (let i = 0; i < 70; i++) {
    let x = Math.random() * size;
    let y = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 3 + Math.floor(Math.random() * 6);
    for (let s = 0; s < segs; s++) {
      x += (Math.random() - 0.5) * 60;
      y += (Math.random() - 0.5) * 60;
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(58,36,18,${0.1 + Math.random() * 0.16})`;
    ctx.lineWidth = 0.7 + Math.random() * 1.4;
    ctx.stroke();
  }

  return canvas;
}

function createGround(scene, renderer) {
  const canvas = makeDirtTexture();
  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(10, 10);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const bump = new THREE.CanvasTexture(canvas);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.repeat.set(10, 10);

  const material = new THREE.MeshStandardMaterial({
    map,
    bumpMap: bump,
    bumpScale: 0.55,
    roughness: 0.98,
    metalness: 0.02,
    color: 0xffffff,
  });

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(140, 140, 1, 1), material);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // The packed playing lane: a lighter, smoother strip where the game happens.
  const laneCanvas = makeDirtTexture(512);
  const laneMap = new THREE.CanvasTexture(laneCanvas);
  laneMap.wrapS = laneMap.wrapT = THREE.RepeatWrapping;
  laneMap.repeat.set(2, 6);
  laneMap.colorSpace = THREE.SRGBColorSpace;
  laneMap.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(9.5, 30),
    new THREE.MeshStandardMaterial({
      map: laneMap,
      bumpMap: laneMap,
      bumpScale: 0.3,
      color: 0xd9b78d,
      roughness: 0.95,
      transparent: true,
      opacity: 0.92,
    })
  );
  lane.rotation.x = -Math.PI / 2;
  lane.position.y = 0.004;
  lane.receiveShadow = true;
  scene.add(lane);

  // Throw lines at both ends.
  const lineMat = new THREE.MeshBasicMaterial({
    color: 0xf3e2c2,
    transparent: true,
    opacity: 0.42,
  });
  for (const z of [CONFIG.throwZ, -CONFIG.throwZ]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 0.16), lineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.012, z);
    scene.add(line);
  }

  return { ground, lane };
}

/* ----------------------------------------------------------------- holes --- */

function holeCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, '#0a0603');
  grad.addColorStop(0.55, '#1c1108');
  grad.addColorStop(0.86, '#402a16');
  grad.addColorStop(1, '#6b4726');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  return canvas;
}

function createHoles(scene) {
  const holes = [];
  const holeTex = new THREE.CanvasTexture(holeCanvas());
  holeTex.colorSpace = THREE.SRGBColorSpace;

  const rimMat = new THREE.MeshStandardMaterial({ color: 0x6d4826, roughness: 0.95, metalness: 0 });
  const moundMat = new THREE.MeshStandardMaterial({ color: 0x8a5f38, roughness: 1, metalness: 0 });
  const innerMat = new THREE.MeshBasicMaterial({ map: holeTex, transparent: false });

  for (const z of CONFIG.holeZ) {
    const group = new THREE.Group();
    group.position.set(CONFIG.holeX, 0, z);

    const inner = new THREE.Mesh(new THREE.CircleGeometry(CONFIG.holeRadius, 28), innerMat);
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.014;
    group.add(inner);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(CONFIG.holeRadius * 0.98, 0.055, 8, 30),
      rimMat
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.035;
    rim.castShadow = false;
    rim.receiveShadow = true;
    group.add(rim);

    const mound = new THREE.Mesh(
      new THREE.TorusGeometry(CONFIG.holeRadius * 1.22, 0.085, 6, 26),
      moundMat
    );
    mound.rotation.x = -Math.PI / 2;
    mound.position.y = 0.03;
    mound.scale.y = 0.45;
    mound.receiveShadow = true;
    group.add(mound);

    scene.add(group);
    holes.push(new THREE.Vector3(CONFIG.holeX, 0, z));
  }

  return holes;
}

/* ----------------------------------------------------------------- props --- */

function scatterPebbles(scene) {
  const rand = (min, max) => min + Math.random() * (max - min);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  // Pebbles across the whole field.
  const pebbleGeo = new THREE.IcosahedronGeometry(0.11, 0);
  const pebbleMat = new THREE.MeshStandardMaterial({
    color: 0xb49a7c,
    roughness: 0.9,
    flatShading: true,
  });
  const pebbles = new THREE.InstancedMesh(pebbleGeo, pebbleMat, 170);
  for (let i = 0; i < 170; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * 30;
    dummy.position.set(Math.cos(angle) * radius, 0.03, Math.sin(angle) * radius);
    dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    const s = rand(0.4, 1.5);
    dummy.scale.set(s, s * 0.7, s);
    dummy.updateMatrix();
    pebbles.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.09, rand(0.12, 0.28), rand(0.42, 0.68));
    pebbles.setColorAt(i, color);
  }
  pebbles.instanceMatrix.needsUpdate = true;
  scene.add(pebbles);

}

function scatterGrass(scene) {
  const rand = (min, max) => min + Math.random() * (max - min);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  // Dry grass tufts around the field, denser further out.
  const tuftGeo = new THREE.ConeGeometry(0.1, 0.62, 4, 1);
  tuftGeo.translate(0, 0.31, 0);
  const tuftMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    flatShading: true,
  });
  const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, 420);
  for (let i = 0; i < 420; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = rand(7.5, 34);
    dummy.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius * 1.15);
    dummy.rotation.set(rand(-0.18, 0.18), Math.random() * Math.PI, rand(-0.18, 0.18));
    const s = rand(0.6, 1.9);
    dummy.scale.set(s, s * rand(0.7, 1.6), s);
    dummy.updateMatrix();
    tufts.setMatrixAt(i, dummy.matrix);
    color.setHSL(rand(0.16, 0.26), rand(0.25, 0.5), rand(0.24, 0.42));
    tufts.setColorAt(i, color);
  }
  tufts.instanceMatrix.needsUpdate = true;
  scene.add(tufts);

}

function scatterRocks(scene) {
  const rand = (min, max) => min + Math.random() * (max - min);

  // A few boulders for depth.
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x9a8265,
    roughness: 0.92,
    flatShading: true,
  });
  for (let i = 0; i < 12; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = rand(13, 30);
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(rand(0.5, 1.5), 0), rockMat);
    rock.position.set(Math.cos(angle) * radius, rand(0.1, 0.35), Math.sin(angle) * radius);
    rock.rotation.set(Math.random(), Math.random(), Math.random());
    rock.scale.y = rand(0.5, 0.9);
    rock.castShadow = true;
    rock.receiveShadow = true;
    scene.add(rock);
  }
}

function backdropMountains(scene) {
  // Hazy mountains far behind the field.
  const mountainMat = new THREE.MeshStandardMaterial({
    color: 0x9aa7c4,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2 + Math.random() * 0.2;
    const radius = 78 + Math.random() * 26;
    const height = 16 + Math.random() * 26;
    const mountain = new THREE.Mesh(
      new THREE.ConeGeometry(height * (0.55 + Math.random() * 0.4), height, 5, 1),
      mountainMat
    );
    mountain.position.set(Math.cos(angle) * radius, height / 2 - 2, Math.sin(angle) * radius);
    mountain.rotation.y = Math.random() * Math.PI;
    scene.add(mountain);
  }

}

function backdropClouds(scene) {
  // Cartoon clouds.
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    emissive: 0xdfe9ff,
    emissiveIntensity: 0.22,
    flatShading: true,
  });
  for (let i = 0; i < 7; i++) {
    const cloud = new THREE.Group();
    const puffs = 3 + Math.floor(Math.random() * 3);
    for (let p = 0; p < puffs; p++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(2 + Math.random() * 2.2, 8, 6), cloudMat);
      puff.position.set(p * 2.6 - puffs * 1.2, Math.random() * 1.1, Math.random() * 1.6);
      puff.scale.y = 0.62;
      cloud.add(puff);
    }
    const angle = (i / 7) * Math.PI * 2 + Math.random() * 0.6;
    const radius = 62 + Math.random() * 40;
    cloud.position.set(Math.cos(angle) * radius, 26 + Math.random() * 16, Math.sin(angle) * radius);
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

  scene.fog = new THREE.Fog(0xe4c69b, 55, 165);

  time('sky', () => scene.add(createSky()));
  time('environment', () => createEnvironment(scene, renderer));
  const sun = time('lights', () => createLights(scene));
  const ground = time('ground', () => createGround(scene, renderer));
  const holes = time('holes', () => createHoles(scene));

  // Decoration is added one step at a time by main.js, after the playable
  // field is on screen, so no single long task blocks the first paint.
  const decorSteps = [
    () => scatterPebbles(scene),
    () => scatterGrass(scene),
    () => scatterRocks(scene),
    () => backdropMountains(scene),
    () => backdropClouds(scene),
  ];

  return { sun, holes, ground, decorSteps, timings };
}
