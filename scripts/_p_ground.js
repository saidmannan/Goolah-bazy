/* ---------------------------------------------------------------- ground --- */

/**
 * The ground is one continuous surface, described by terrain.js and meshed here
 * in two passes:
 *
 *   * the court: a fine grid over the swept strip, with a real circular hole cut
 *     at every mat so each modelled dish sits *in* the earth;
 *   * the plain: a coarse grid for everything beyond, sunk a centimetre under
 *     the court's margin so the two overlap without a seam or a crack.
 *
 * Soil variation rides in the vertex colours (damp patches, dry sweeps, scuffed
 * throwing lanes) and grit rides in the texture, so the field never reads as a
 * flat brown plane even where the relief is nearly zero.
 */
const GROUND = {
  courtCell: 0.11,
  plainCell: 1.5,
  plainSize: 168,
  uvScale: 4.2,
};

function soilColor(x, z, onCourt, out) {
  const damp = valueNoise(x * 0.42 + 11.3, z * 0.42 - 7.9) * 0.5 + 0.5;
  const dry = valueNoise(x * 1.9 - 3.4, z * 1.9 + 5.6) * 0.5 + 0.5;
  const scuff = onCourt ? Math.max(0, valueNoise(x * 0.85 + 21.7, z * 0.34 - 13.2)) * 0.05 : 0;
  const light = (onCourt ? 0.8 : 0.72) + (damp - 0.5) * 0.16 + (dry - 0.5) * 0.06 + scuff;
  return out.setHSL(0.088 + (damp - 0.5) * 0.02, 0.11 + dry * 0.07, light);
}

/**
 * A displaced grid over one rectangle of ground. Quads whose centre fails the
 * skip test are dropped, which is how the mat holes are cut and how the plain
 * steps around the court.
 */
function buildGroundGeometry({ minX, maxX, minZ, maxZ, cell, skip, onCourt }) {
  const nx = Math.max(1, Math.round((maxX - minX) / cell));
  const nz = Math.max(1, Math.round((maxZ - minZ) / cell));
  const dx = (maxX - minX) / nx;
  const dz = (maxZ - minZ) / nz;
  const cols = nx + 1;

  const positions = new Float32Array(cols * (nz + 1) * 3);
  const uvs = new Float32Array(cols * (nz + 1) * 2);
  const colors = new Float32Array(cols * (nz + 1) * 3);
  const color = new THREE.Color();

  let p = 0;
  let u = 0;
  let c = 0;
  for (let j = 0; j <= nz; j++) {
    const z = minZ + j * dz;
    for (let i = 0; i <= nx; i++) {
      const x = minX + i * dx;
      positions[p++] = x;
      positions[p++] = terrainHeight(x, z) - (onCourt ? 0 : COURT.sink);
      positions[p++] = z;
      uvs[u++] = x / GROUND.uvScale;
      uvs[u++] = z / GROUND.uvScale;
      soilColor(x, z, onCourt, color);
      colors[c++] = color.r;
      colors[c++] = color.g;
      colors[c++] = color.b;
    }
  }

  const indices = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (skip && skip(minX + (i + 0.5) * dx, minZ + (j + 0.5) * dz)) continue;
      const a = j * cols + i;
      const b = a + 1;
      const d = a + cols;
      const cc = d + 1;
      indices.push(a, d, b, b, d, cc);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function groundTexture(canvas, renderer, srgb) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
  texture.anisotropy = Math.min(8, maxAniso);
  return texture;
}

function createGround(renderer) {
  const group = new THREE.Group();
  const matHole = MAT.holeRadius * CONFIG.matRadius;

  const courtMat = new THREE.MeshStandardMaterial({
    map: groundTexture(courtCanvas(1024), renderer, true),
    bumpMap: groundTexture(courtCanvas(512), renderer, false),
    bumpScale: 0.4,
    roughness: 0.97,
    metalness: 0.02,
    vertexColors: true,
  });

  const plainMat = new THREE.MeshStandardMaterial({
    map: groundTexture(dirtCanvas(), renderer, true),
    bumpMap: groundTexture(dirtCanvas(512), renderer, false),
    bumpScale: 0.5,
    roughness: 1,
    metalness: 0,
    vertexColors: true,
  });

  // The court: fine grid, real holes at the four mats.
  const court = new THREE.Mesh(
    buildGroundGeometry({
      minX: -COURT.halfWidth,
      maxX: COURT.halfWidth,
      minZ: COURT.minZ,
      maxZ: COURT.maxZ,
      cell: GROUND.courtCell,
      onCourt: true,
      skip: (cx, cz) =>
        CONFIG.matZ.some(
          (mz) => Math.hypot(cx - CONFIG.matX, cz - mz) < matHole
        ),
    }),
    courtMat
  );
  court.receiveShadow = true;
  court.name = 'court';
  group.add(court);

  // The plain: coarse grid that steps around the court and sits under its margin.
  const half = GROUND.plainSize / 2;
  const plain = new THREE.Mesh(
    buildGroundGeometry({
      minX: -half,
      maxX: half,
      minZ: -half,
      maxZ: half,
      cell: GROUND.plainCell,
      onCourt: false,
      skip: (cx, cz) =>
        Math.abs(cx) < COURT.halfWidth && cz > COURT.minZ && cz < COURT.maxZ,
    }),
    plainMat
  );
  plain.receiveShadow = true;
  plain.name = 'plain';
  group.add(plain);

  return { group, court, plain };
}
