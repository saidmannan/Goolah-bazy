/* ------------------------------------------------------------------ mats --- */

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
 * Four modelled dishes in a line, each sunk into the hole cut for it.
 *
 * The dish geometry comes from models.js and its profile from terrain.js — the
 * same profile the physics samples — so the rim a goolah climbs is exactly the
 * rim drawn on screen. Each mat reports its own state, so the field itself shows
 * whether it is open, holding a goolah, or closed for the round.
 */
function createMats(scene, renderer) {
  const mats = [];
  const R = CONFIG.matRadius;
  const D = CONFIG.matDepth;

  const capGeo = new THREE.CylinderGeometry(0.62 * R, 0.68 * R, 0.055, 30);
  const capMat = new THREE.MeshStandardMaterial({
    color: 0x9a8768,
    roughness: 0.88,
    metalness: 0.06,
    flatShading: true,
  });

  for (let index = 0; index < CONFIG.matZ.length; index++) {
    const z = CONFIG.matZ[index];
    const teamIndex = CONFIG.matOwner[index];
    const team = TEAMS[teamIndex];
    const base = matBaseHeight(index);

    const dish = createMatDish(team, R, D);
    dish.group.position.set(CONFIG.matX, base, z);
    scene.add(dish.group);

    // Stone lid that appears when the mat is closed for the round.
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = -D + 0.035;
    cap.visible = false;
    cap.castShadow = true;
    cap.receiveShadow = true;
    dish.group.add(cap);

    // Number token beside the mat, billboarded towards the camera each frame so
    // it stays readable from any orbit angle.
    const labelTex = new THREE.CanvasTexture(matLabelCanvas(index + 1, team.css));
    labelTex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.4),
      new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthWrite: false })
    );
    label.position.set(CONFIG.matX + R + 0.72, base + 0.34, z);
    scene.add(label);

    const inlayMat = dish.inlay.material;
    const mat = {
      index,
      teamIndex,
      position: new THREE.Vector3(CONFIG.matX, base, z),
      group: dish.group,
      dish,
      label,
      state: 'open',
      /** open | occupied | closed */
      setState(next) {
        if (this.state === next) return;
        this.state = next;
        const closed = next === 'closed';
        const occupied = next === 'occupied';
        cap.visible = closed;
        inlayMat.emissiveIntensity = closed ? 0.05 : occupied ? 0.95 : 0.4;
        inlayMat.color.setHex(closed ? 0x8d7a5c : team.color);
        label.material.transparent = true;
        label.material.opacity = closed ? 0.42 : 1;
      },
    };

    mats.push(mat);
  }

  return mats;
}
