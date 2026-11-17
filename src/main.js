import * as THREE from 'three';
import './styles.css';
import { buildWorld } from './world.js';
import { Game } from './game.js';
import { UI } from './ui.js';

const canvas = document.getElementById('scene');

const DEBUG = new URLSearchParams(window.location.search).has('debug');
const bootStart = performance.now();
const mark = (label) => {
  if (DEBUG) console.info(`[goolah-bazy] ${label} ${Math.round(performance.now() - bootStart)}ms`);
};

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: window.devicePixelRatio < 2,
  powerPreference: 'high-performance',
  alpha: false,
});

// Software renderers (headless checkers, very weak devices) cannot afford the
// full profile: they get a lighter scene so the page stays responsive instead
// of saturating the main thread with long frames.
function detectGpuTier(rendererInstance) {
  try {
    const gl = rendererInstance.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '') : '';
    return { low: /swiftshader|llvmpipe|software|basic render/i.test(name), name };
  } catch (error) {
    return { low: false, name: '' };
  }
}

const gpu = detectGpuTier(renderer);
const LOW_END = gpu.low;
// Software rasterizers pay per pixel, so they render at half resolution.
const MAX_PIXEL_RATIO = LOW_END ? 0.5 : 2;
const FRAME_INTERVAL = LOW_END ? 1000 / 30 : 0;
// Between throws nothing moves, so draw only a few frames per second instead of
// a full loop. That keeps the main thread free on phones and low-power GPUs.
const IDLE_INTERVAL = LOW_END ? 500 : 150;

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = !LOW_END;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(56, 1, 0.1, 400);

const ui = new UI();
mark(`renderer gpu=${gpu.name || 'unknown'} low=${LOW_END}`);
const world = buildWorld(scene, renderer);
mark(`world ${JSON.stringify(world.timings)}`);
const game = new Game({ scene, camera, renderer, world, ui });
try {
  game.init();
  mark('game');
} catch (error) {
  // Never leave the loading veil covering the screen if setup fails.
  console.error('[goolah-bazy] init failed', error);
  ui.hideLoader();
  ui.toast('Could not prepare the field — please reload');
}

// Opt-in handle for automated checks and manual debugging.
if (new URLSearchParams(window.location.search).has('debug')) {
  window.__gb = { game, ui, world, renderer, scene, camera };
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const aspect = width / height;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.setSize(width, height, false);
  camera.aspect = aspect;
  camera.fov = aspect < 1 ? 60 : 50;
  camera.updateProjectionMatrix();

  if (world.sun) {
    // Keep the shadow frustum useful on tall phone screens.
    world.sun.shadow.camera.top = 24;
    world.sun.shadow.camera.bottom = -24;
    world.sun.shadow.camera.updateProjectionMatrix();
  }
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 220));
window.visualViewport?.addEventListener('resize', resize);
resize();

// Prevent iOS double-tap zoom / rubber-band scrolling over the field.
document.addEventListener('gesturestart', (event) => event.preventDefault());
document.addEventListener(
  'touchmove',
  (event) => {
    if (event.touches.length > 1) event.preventDefault();
  },
  { passive: false }
);

let firstFrame = true;
let lastFrameTime = 0;
const clock = new THREE.Clock();

// Cosmetic props (pebbles, grass, rocks, mountains, clouds) are added one small
// step at a time after the field is on screen. Chunking keeps the main thread
// responsive, so phones paint and respond immediately instead of freezing.
function queueDecor() {
  const steps = Array.isArray(world.decorSteps) ? world.decorSteps.slice() : [];
  const runNext = () => {
    const step = steps.shift();
    if (!step) return;
    try {
      step();
    } catch (error) {
      console.warn('[goolah-bazy] decoration failed', error);
    }
    if (steps.length) setTimeout(runNext, LOW_END ? 240 : 90);
  };
  setTimeout(runNext, 140);
}

let activeUntil = 0;

function holdAwake(ms = 1400) {
  activeUntil = Math.max(activeUntil, performance.now() + ms);
}

const onInput = () => holdAwake();
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'keydown']) {
  window.addEventListener(type, onInput, { passive: true });
}
// A throw keeps rolling for a while after the finger lifts.
window.addEventListener('pointerup', () => holdAwake(3000), { passive: true });

// Continuous frames are only needed while something is actually happening.
function isBusy() {
  if (firstFrame) return true;
  if (performance.now() < activeUntil) return true;
  if (typeof game.turnLock === 'number' && game.turnLock > 0) return true;
  return Boolean(game.phase && game.phase !== 'ready');
}

renderer.setAnimationLoop((time) => {
  // The simulation always advances; only the draw call is rate limited.
  const dt = Math.min(clock.getDelta(), 0.05);
  game.update(dt);

  const interval = isBusy() ? FRAME_INTERVAL : IDLE_INTERVAL;
  if (interval && time - lastFrameTime < interval) return;
  lastFrameTime = time;

  renderer.render(scene, camera);

  if (firstFrame) {
    firstFrame = false;
    ui.hideLoader();
    mark('first-frame');
    queueDecor();
    // Keep full-rate frames while the scenery steps are still being built.
    holdAwake(LOW_END ? 4000 : 2200);
  }
});

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  ui.toast('Graphics context lost — reload the page');
});

window.addEventListener('error', (event) => {
  console.error('[goolah-bazy]', event.message);
});
