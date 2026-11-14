import * as THREE from 'three';
import { Perlin2D, mulberry32 } from './noise.js';
import { wrapAngle } from './util.js';

// World layout -------------------------------------------------------------
export const HEIGHT_EXTENT = 64; // metres covered by the macro height texture (centred on origin)
export const HEIGHT_RES = 1024; // texels per side (6.25 cm)
const FREEBOARD = 0.78; // snow surface height above sea level (m)
const FLOE_RADIUS = 23; // mean radius of the main floe (m)
export const WIND_ANGLE = 0.55; // prevailing wind direction (radians, world XZ)
export const WALK_RADIUS = 19.5; // the chick may walk this far from the origin (inside the floe)

const perlin = new Perlin2D(7);
const perlinB = new Perlin2D(31);

// Floe outline: periodic sum of harmonics so the coastline is irregular but closed.
const harmonics = (() => {
  const rnd = mulberry32(99);
  const h = [];
  for (let k = 2; k <= 28; k++) {
    h.push({ k, a: (0.085 / Math.pow(k, 0.85)) * (0.5 + rnd()), p: rnd() * Math.PI * 2 });
  }
  return h;
})();

/** Direction (radians) of the bay cut into the floe: where the adults go to sea. */
export const BAY_ANGLE = 2.35;

export function floeRadius(theta) {
  let r = 1;
  for (const { k, a, p } of harmonics) r += a * Math.cos(k * theta + p);
  // a bay cut into one side gives the floe a more natural, broken silhouette
  const bay = Math.exp(-Math.pow(wrapAngle(theta - BAY_ANGLE) / 0.22, 2)) * 0.16;
  return FLOE_RADIUS * (r - bay);
}


/** Approximate signed distance to the floe coastline (positive inside). */
export function floeSdf(x, z) {
  const r = Math.hypot(x, z);
  const th = Math.atan2(z, x);
  return floeRadius(th) - r;
}

function rawHeight(x, z) {
  const ca = Math.cos(WIND_ANGLE), sa = Math.sin(WIND_ANGLE);
  const u = x * ca + z * sa; // along wind
  const v = -x * sa + z * ca; // across wind

  let h = FREEBOARD;
  // broad undulation of the snow pack
  h += 0.16 * perlin.fbm(x / 15, z / 15, 4);
  // drifts elongated along the wind
  const drift = perlin.fbm(u / 10 + 3.1, v / 3.2 - 1.7, 4);
  h += 0.14 * Math.pow(Math.max(0, drift), 1.4);
  // sastrugi: sharp wind-carved ridges
  h += 0.055 * perlinB.ridged(u / 4.5, v / 1.1, 4) * (0.6 + 0.4 * perlin.noise(x / 6, z / 6));
  // snow-buried pressure ridge crossing part of the floe
  const rx = x - 4, rz = z + 11;
  const ridgeD = Math.abs(rz * 0.94 + rx * 0.34 + 1.6 * Math.sin(rx * 0.21));
  const ridgeMask = Math.exp(-Math.pow(ridgeD / 1.6, 2)) * (1 - THREE.MathUtils.smoothstep(Math.abs(rx), 4, 11));
  h += ridgeMask * (0.45 + 0.35 * perlinB.ridged(x / 1.8, z / 1.8, 3));
  // a few soft hummocks
  h += 0.25 * Math.pow(Math.max(0, perlinB.fbm(x / 7 + 11, z / 7 - 5, 3)), 2);

  // rounded cornice falling off at the coast
  const sdf = floeSdf(x, z);
  if (sdf < 1.8) {
    const t = Math.max(0, 1 - Math.max(sdf, 0) / 1.8);
    h -= 0.2 * t * t;
  }
  return h;
}

// Build the macro height + distance field -----------------------------------
export function buildHeightfield() {
  const N = HEIGHT_RES;
  const data = new Float32Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    const z = ((j + 0.5) / N - 0.5) * HEIGHT_EXTENT;
    for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N - 0.5) * HEIGHT_EXTENT;
      const idx = (j * N + i) * 4;
      data[idx] = rawHeight(x, z);
      data[idx + 1] = floeSdf(x, z);
      data[idx + 2] = 0;
      data[idx + 3] = 1;
    }
  }
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
  const tex = new THREE.DataTexture(half, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;

  function sample(x, z, channel = 0) {
    const fx = (x / HEIGHT_EXTENT + 0.5) * N - 0.5;
    const fz = (z / HEIGHT_EXTENT + 0.5) * N - 0.5;
    const i0 = Math.max(0, Math.min(N - 2, Math.floor(fx)));
    const j0 = Math.max(0, Math.min(N - 2, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i0)), tz = Math.min(1, Math.max(0, fz - j0));
    const a = data[(j0 * N + i0) * 4 + channel];
    const b = data[(j0 * N + i0 + 1) * 4 + channel];
    const c = data[((j0 + 1) * N + i0) * 4 + channel];
    const d = data[((j0 + 1) * N + i0 + 1) * 4 + channel];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  return {
    texture: tex,
    heightAt: (x, z) => sample(x, z, 0),
    sdfAt: (x, z) => sample(x, z, 1),
    normalAt(x, z, out = new THREE.Vector3()) {
      const e = 0.08;
      const hx = sample(x + e, z) - sample(x - e, z);
      const hz = sample(x, z + e) - sample(x, z - e);
      return out.set(-hx, 2 * e, -hz).normalize();
    },
  };
}

// Tileable micro-detail normal texture --------------------------------------
// RG: snow grain normal (xz), BA: wind-ripple normal (xz).
export function buildDetailTexture(renderer) {
  const N = 512;
  const grainP = new Perlin2D(5);
  const rippleP = new Perlin2D(17);
  const g = new Float32Array(N * N);
  const r = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = i / N, v = j / N;
      // fine grain: high-frequency, slightly clumpy
      let gv = grainP.fbm(u * 16, v * 16, 5, 2.0, 0.55, 16);
      gv += 0.35 * Math.abs(grainP.noise(u * 64, v * 64, 64));
      g[j * N + i] = gv;
      // wind ripples: asymmetric waves warped by noise (tile in both axes)
      const warp = rippleP.fbm(u * 4, v * 4, 3, 2, 0.5, 4) * 1.6;
      const phase = (v * 9 + warp) * Math.PI * 2;
      const s = Math.sin(phase);
      const wave = Math.pow(0.5 + 0.5 * s, 2.2); // sharp crests, flat troughs
      r[j * N + i] = wave * (0.6 + 0.4 * rippleP.noise(u * 8, v * 8, 8)) + 0.15 * rippleP.fbm(u * 24, v * 24, 3, 2, 0.5, 24);
    }
  }
  const out = new Uint8Array(N * N * 4);
  const enc = (arr, i, j, strength) => {
    const L = arr[j * N + ((i - 1 + N) % N)], R = arr[j * N + ((i + 1) % N)];
    const D = arr[((j - 1 + N) % N) * N + i], U = arr[((j + 1) % N) * N + i];
    let nx = (L - R) * strength, nz = (D - U) * strength, ny = 1;
    const l = Math.hypot(nx, ny, nz);
    return [nx / l, nz / l];
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 4;
      const [gx, gz] = enc(g, i, j, 9);
      const [rx, rz] = enc(r, i, j, 5);
      out[k] = (gx * 0.5 + 0.5) * 255;
      out[k + 1] = (gz * 0.5 + 0.5) * 255;
      out[k + 2] = (rx * 0.5 + 0.5) * 255;
      out[k + 3] = (rz * 0.5 + 0.5) * 255;
    }
  }
  const tex = new THREE.DataTexture(out, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Ice cliff around the floe ---------------------------------------------------
export function buildFloeCliff(heightfield) {
  const M = 1100;
  const rnd = new Perlin2D(77);
  // profile rows: [radial inset (m, + = inward), height mode, value]
  const rows = [
    { inset: 0.35, y: (h) => h - 0.06, snow: 1 },
    { inset: 0.0, y: (h) => h - 0.004, snow: 1 },
    { inset: -0.06, y: (h) => h - 0.12, snow: 1 },
    { inset: -0.02, y: (h) => h - 0.3, snow: 0.8 },
    { inset: 0.05, y: () => 0.32, snow: 0.3 },
    { inset: 0.32, y: () => 0.08, snow: 0.0 }, // wave-cut notch
    { inset: 0.12, y: () => -0.15, snow: 0.0 },
    { inset: -0.35, y: () => -1.2, snow: 0.0 },
    { inset: -0.9, y: () => -3.2, snow: 0.0 },
  ];
  const pos = [], col = [], idx = [];
  for (let m = 0; m <= M; m++) {
    const th = (m / M) * Math.PI * 2;
    const R = floeRadius(th);
    const cx = Math.cos(th), cz = Math.sin(th);
    const hEdge = heightfield.heightAt(cx * R, cz * R);
    rows.forEach((row, ri) => {
      const jag = ri >= 2 ? rnd.fbm(th * 40, ri * 0.7, 3) * 0.18 : 0;
      const rr = R - row.inset + jag;
      const y = row.y(hEdge) + (ri >= 3 ? rnd.noise(th * 60, ri) * 0.05 : 0);
      pos.push(cx * rr, y, cz * rr);
      const s = row.snow;
      const ice = [0.55 + 0.1 * rnd.noise(th * 25, 3), 0.78, 0.9];
      col.push(
        ice[0] * (1 - s) + 0.95 * s,
        ice[1] * (1 - s) + 0.96 * s,
        ice[2] * (1 - s) + 0.98 * s,
      );
    });
  }
  const R = rows.length;
  for (let m = 0; m < M; m++) {
    for (let r = 0; r < R - 1; r++) {
      const a = m * R + r, b = (m + 1) * R + r, c = a + 1, d = b + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.32,
    metalness: 0,
    clearcoat: 0.4,
    clearcoatRoughness: 0.25,
    sheen: 0.4,
    sheenColor: new THREE.Color(0.55, 0.8, 1.0),
    side: THREE.DoubleSide,
  });
  // cheap sub-surface glow: thin ice lets blue light through near the waterline
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `// light carried through the ice: scales with what actually lights the scene
       outgoingLight += vec3(0.1, 0.5, 0.7) * (1.0 - vColor.r) * 0.5 * reflectedLight.indirectDiffuse;
       #include <opaque_fragment>`,
    );
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}
