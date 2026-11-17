import * as THREE from 'three';
import './styles.css';
import { buildWorld } from './world.js';
import { Game } from './game.js';
import { UI } from './ui.js';

const canvas = document.getElementById('scene');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: window.devicePixelRatio < 2,
  powerPreference: 'high-performance',
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(56, 1, 0.1, 400);

const ui = new UI();
const world = buildWorld(scene, renderer);
const game = new Game({ scene, camera, renderer, world, ui });
try {
  game.init();
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

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
let decorQueued = false;
const clock = new THREE.Clock();

// Cosmetic props (grass, pebbles, rocks, mountains, clouds) are built after the
// field is on screen: phones paint the playable scene much sooner this way.
function queueDecor() {
  if (decorQueued || typeof world.buildDecor !== 'function') return;
  decorQueued = true;
  const run = () => {
    try {
      world.buildDecor();
    } catch (error) {
      console.warn('[goolah-bazy] decoration failed', error);
    }
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 1500 });
  else setTimeout(run, 120);
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  game.update(dt);
  renderer.render(scene, camera);

  if (firstFrame) {
    firstFrame = false;
    ui.hideLoader();
    queueDecor();
  }
});

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  ui.toast('Graphics context lost — reload the page');
});

window.addEventListener('error', (event) => {
  console.error('[goolah-bazy]', event.message);
});
