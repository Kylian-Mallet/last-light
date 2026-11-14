import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Perlin2D, mulberry32 } from './noise.js';
import { floeSdf } from './terrain.js';

// Sun colour through the atmosphere as a function of elevation (degrees).
export function sunRadiance(elevDeg) {
  const e = Math.max(elevDeg, 0.2) * (Math.PI / 180);
  // relative air mass (Kasten & Young)
  const am = 1 / (Math.sin(e) + 0.50572 * Math.pow(elevDeg + 6.07995, -1.6364));
  const beta = [0.0105, 0.0245, 0.058]; // tuned optical depth per channel (R,G,B), incl. aerosols
  const c = beta.map((b) => Math.exp(-b * am * 1.9));
  const fade = THREE.MathUtils.smoothstep(elevDeg, -1.5, 1.5);
  const s = 1 / Math.max(c[0], 1e-3);
  return new THREE.Color(c[0] * s, c[1] * s, c[2] * s).multiplyScalar(fade * Math.max(c[0], 0.25));
}

// ---------------------------------------------------------------------------------
// A round Earth, exaggerated. The sea surface (and everything floating far out on it)
// drops below the flat plane with distance d from the camera, so the horizon sits a
// little under eye level and bows down toward the frame edges. Profile, with u = d-core:
//   flat inside `core` (the main floe, the colony and the near water stay put),
//   a sphere of radius R out to `knee` (drop u²/2R),
//   then a straight cone carrying on with the same slope (knee/R = 0.026, 1.5°).
// Far out the sea is the flat sea tilted down by the cone angle: the horizon dips by
// ~1.5° and bows toward the frame edges, the bergs keep their waterline on the sea, and
// the far water still spreads over the frame almost like a flat sea seen from
// (h - 0.86 m) above it (the floe itself stands ~0.8 m out of the water). Where the sea
// is seen edge-on (along the horizon) it is calmed to a smooth, filtered mirror, and far
// floes seen edge-on slip behind the horizon, so that line never sparkles.
const SEA_CURVE = { value: new THREE.Vector4() }; // x: 1/2R, y: core, z: knee, w: unused
const SEA_CURVE_SHAPE = { radius: 1150, core: 18, knee: 30, skyDip: 0.9 };
// the sky's horizon band is lowered to meet the dipped sea (fraction skyDip of the dip)
const SKY_DIP = { value: 0 };
function setSeaCurve(shape = {}) {
  Object.assign(SEA_CURVE_SHAPE, shape);
  const { radius, core, knee, skyDip } = SEA_CURVE_SHAPE;
  SEA_CURVE.value.set(radius > 0 ? 1 / (2 * radius) : 0, core, knee, 0);
  SKY_DIP.value = radius > 0 ? (knee / radius) * skyDip : 0;
}
setSeaCurve();

const CURVE_PARS = /* glsl */`
  uniform vec4 uSeaCurve;
  float seaDrop(vec3 w) {
    float u = max(length(w.xz - cameraPosition.xz) - uSeaCurve.y, 0.0);
    float q = min(u, uSeaCurve.z);
    return uSeaCurve.x * (q * q + 2.0 * uSeaCurve.z * max(u - uSeaCurve.z, 0.0));
  }
  // how steeply the curved surface falls away there (the tilt of its local horizontal)
  float seaSlope(vec3 w) {
    float u = max(length(w.xz - cameraPosition.xz) - uSeaCurve.y, 0.0);
    return 2.0 * uSeaCurve.x * min(u, uSeaCurve.z);
  }
`;
// project_vertex with the drop applied in world space (lighting keeps the flat position)
const CURVE_PROJECT = /* glsl */`
  vec4 mvPosition = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
  #endif
  vec4 seaW = modelMatrix * mvPosition;
  seaW.y -= seaDrop(seaW.xyz);
  mvPosition = viewMatrix * seaW;
  gl_Position = projectionMatrix * mvPosition;
`;
// thin floes seen edge-on are sub-pixel slivers that twinkle along the horizon: sink each
// one (as a whole, from its instance centre) below the waterline as its surface turns
// edge-on, so the far pack ice slips behind the horizon like on a round sea
const CURVE_SINK = /* glsl */`
  #ifdef USE_INSTANCING
  {
    vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float cd = max(length(c.xz - cameraPosition.xz), 1.0);
    float graze = (cameraPosition.y + seaDrop(c)) / cd - seaSlope(c);
    seaW.y -= (1.0 - smoothstep(0.0015, 0.005, graze)) * smoothstep(80.0, 160.0, cd) * 1.2;
  }
  #endif
`;
/**
 * Curve a built-in material (MeshStandardMaterial etc., instanced or not) with the sea.
 * sinkEdgeOn: instanced thin slabs drop out of sight where they would be seen edge-on.
 */
function applySeaCurve(material, { sinkEdgeOn = false } = {}) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uSeaCurve = SEA_CURVE;
    const project = sinkEdgeOn ? CURVE_PROJECT.replace('seaW.y -= seaDrop(seaW.xyz);', 'seaW.y -= seaDrop(seaW.xyz);\n' + CURVE_SINK) : CURVE_PROJECT;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + CURVE_PARS)
      .replace('#include <project_vertex>', project);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => (prevKey ? prevKey() : '') + (sinkEdgeOn ? '|seacurve-sink' : '|seacurve');
  material.needsUpdate = true;
  return material;
}

/**
 * The sea as a disc of rings around the floe: dense near the middle (where the camera
 * roams, so the curve is smooth under it), widening geometrically out to the far plane.
 * Built flat in the XY plane like a PlaneGeometry (the Water mesh is rotated to lie flat).
 */
function seaDiscGeometry(radius = 4500, segments = 192) {
  const radii = [0];
  let r = 3;
  while (r < 160) { radii.push(r); r += 4; }
  while (r < radius) { radii.push(r); r *= 1.07; }
  radii.push(radius);
  const pos = [], uv = [], idx = [];
  pos.push(0, 0, 0); uv.push(0.5, 0.5);
  for (let i = 1; i < radii.length; i++) {
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2, x = Math.cos(a) * radii[i], y = Math.sin(a) * radii[i];
      pos.push(x, y, 0); uv.push(x / (2 * radius) + 0.5, y / (2 * radius) + 0.5);
    }
  }
  const ring = (i, j) => (i === 0 ? 0 : 1 + (i - 1) * segments + (j % segments));
  for (let j = 0; j < segments; j++) idx.push(0, ring(1, j), ring(1, j + 1));
  for (let i = 1; i < radii.length - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = ring(i, j), b = ring(i, j + 1), c = ring(i + 1, j), d = ring(i + 1, j + 1);
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, k) => (k % 3 === 2 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export function createSky() {
  const sky = new Sky();
  sky.scale.setScalar(4000);
  const u = sky.material.uniforms;
  u.turbidity.value = 10;
  u.rayleigh.value = 3.0;
  u.mieCoefficient.value = 0.003;
  u.mieDirectionalG.value = 0.9;
  u.cloudCoverage.value = 0.32;
  u.cloudDensity.value = 0.35;
  u.cloudElevation.value = 0.55;
  u.cloudScale.value = 0.00018;
  u.cloudSpeed.value = 0.000012;

  // Ice-crystal sun pillar and horizon glow layered on top of the analytic sky.
  // horizonY: the elevation measured from the dipped, curved sea horizon. The grading bands
  // (warm haze, Earth's shadow, Belt of Venus) use it so they sit on the sea; the scattering
  // model, the sun disc and the clouds keep the true direction
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace(
      'vec3 direction = normalize( vWorldPosition - cameraPosition );',
      `vec3 direction = normalize( vWorldPosition - cameraPosition );
      float horizonY = direction.y + uHorizonDip;`,
    )
    // the scattering model keeps the true elevation: evaluated higher, the low sun's light
    // is barely dimmed by the air and its forward glow swells into a bright oval above it
    // (only the grading bands below use the dipped horizon)
    .replace(
      'vec3 texColor = ( Lin + L0 ) * 0.04 + sundiscColor + vec3( 0.0, 0.0003, 0.00075 );',
      `// keep the disc bright but finite so bloom produces a halo, not a white-out
      sundiscColor = vec3(0.0); // disc re-added after highlight compression
      vec3 texColor = ( Lin + L0 ) * 0.04 + sundiscColor + vec3( 0.0, 0.0003, 0.00075 );
      {
        // golden-hour grading of the analytic sky
        float sunLow = smoothstep(0.35, 0.0, vSunDirection.y);
        vec2 sAz = normalize(vSunDirection.xz + 1e-5);
        vec2 dAz = normalize(direction.xz + 1e-5);
        float sunSide = clamp(0.5 + 0.5 * dot(sAz, dAz), 0.0, 1.0);
        float hz = exp(-max(horizonY, 0.0) / 0.07);
        // the Preetham model drifts toward green at dusk: pull it to violet-blue
        texColor *= mix(vec3(1.0), vec3(1.06, 0.9, 1.1), sunLow * (1.0 - hz));
        // warm aerosol haze along the horizon: only on the sun's side of the sky
        texColor *= mix(vec3(1.0), vec3(1.45, 0.92, 0.62), hz * sunLow * sunSide * sunSide);
        // away from the sun the dusk sky is night blue: deep at height, a paler blue-grey
        // over the horizon (the Earth's shadow), with only a faint lavender Belt of Venus
        float anti = pow(1.0 - sunSide, 1.2) * sunLow;
        float lum = dot(texColor, vec3(0.2126, 0.7152, 0.0722));
        vec3 nightHigh = lum * vec3(0.42, 0.66, 1.75);
        vec3 nightLow = lum * vec3(0.72, 0.86, 1.32);
        vec3 night = mix(nightHigh, nightLow, hz) * mix(0.82, 1.0, hz);
        texColor = mix(texColor, night, anti * 0.9);
        float bq = (horizonY - 0.07) / 0.06;
        float belt = exp(-bq * bq);
        texColor *= 1.0 + vec3(0.16, 0.04, 0.2) * belt * anti;
        // brighten the twilight dome relative to the direct sun (Preetham underestimates it)
        texColor *= 1.0 + 0.9 * sunLow;
        // soft-compress the Mie hotspot (it peaks in the hundreds) so the disc reads as the
        // brightest thing and bloom makes a halo instead of flooding the frame
        // (it tops out near 3, under the bloom threshold of 3.5: only the disc itself blooms,
        // not a broad oval of sky glow above a low sun)
        float m = max(texColor.r, max(texColor.g, texColor.b));
        texColor *= 1.0 / (1.0 + m / 3.0);
        texColor += sundisc * vec3(26.0, 15.0, 7.5) * smoothstep(-0.02, 0.02, vSunDirection.y + 0.0);
      }`,
    )
    // clouds next to a low sun take their ambient light from the sky's Mie hotspot (hundreds
    // of times brighter than the rest): give them the same soft compression as the sky, or a
    // wisp above the sun turns into a glaring oval once bloom spreads it
    .replace(
      'cloudColor *= max( dayFactor, 0.03 );',
      `cloudColor *= max( dayFactor, 0.03 );
      { float cm = max(cloudColor.r, max(cloudColor.g, cloudColor.b)); cloudColor *= 1.0 / (1.0 + cm / 3.0); }`,
    )
    .replace(
    'gl_FragColor = vec4( texColor, 1.0 );',
    `{
      // sun pillar: light reflected by plate crystals in the cold air above the sun
      vec3 sd = vSunDirection;
      vec2 sAz = normalize(sd.xz + 1e-5);
      vec2 dAz = normalize(direction.xz + 1e-5);
      float azDiff = acos(clamp(dot(sAz, dAz), -1.0, 1.0));
      float above = direction.y - sd.y;
      float aq = azDiff / 0.012;
      float pillar = exp(-aq * aq) * smoothstep(-0.01, 0.02, above) * exp(-max(above, 0.0) / 0.12);
      pillar *= smoothstep(0.25, 0.02, sd.y);
      texColor += pillar * vSunE * Fex * 0.0009 * uPillar;
    }
    // storm overcast: the sky collapses to a flat, luminous grey that matches the fog
    texColor = mix(texColor, uOvercastColor, uOvercast);
    gl_FragColor = vec4( texColor, 1.0 );`,
  );
  sky.material.fragmentShader = 'uniform float uPillar;\nuniform float uOvercast;\nuniform vec3 uOvercastColor;\nuniform float uHorizonDip;\n' + sky.material.fragmentShader;
  sky.material.uniforms.uHorizonDip = SKY_DIP;
  if (!sky.material.fragmentShader.includes('float horizonY')) console.warn('sky: horizon dip patch did not apply');
  if (!sky.material.fragmentShader.includes('float cm = max(cloudColor.r')) console.warn('sky: cloud compression patch did not apply');
  sky.material.uniforms.uOvercast = { value: 0 };
  sky.material.uniforms.uOvercastColor = { value: new THREE.Color(0.5, 0.52, 0.58) };
  sky.material.uniforms.uPillar = { value: 1.0 };
  sky.material.needsUpdate = true;
  return sky;
}

function makeWaterNormals(size = 512) {
  const p = new Perlin2D(3);
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      h[j * size + i] = p.fbm(u * 6, v * 6, 5, 2, 0.5, 6) + 0.5 * p.fbm(u * 3 + 0.3, v * 12 + 0.1, 3, 2, 0.5, 3);
    }
  }
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const L = h[j * size + ((i - 1 + size) % size)], R = h[j * size + ((i + 1) % size)];
      const D = h[((j - 1 + size) % size) * size + i], U = h[((j + 1) % size) * size + i];
      const nx = (L - R) * 6, ny = (D - U) * 6, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const k = (j * size + i) * 4;
      // Water.js expects a tangent-space map: xy perturbation, z up (it swizzles internally)
      data[k] = (nx / l * 0.5 + 0.5) * 255;
      data[k + 1] = (ny / l * 0.5 + 0.5) * 255;
      data[k + 2] = (nz / l * 0.5 + 0.5) * 255;
      data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Water looks: body colour (seen from above), deep colour, the submerged shelf, and how
 * the sky reflection is tinted / weighted.
 */
export const WATER_TINTS = {
  // A — mirror: the sunset sky reflected as is, dark teal body
  current: { water: [0.024, 0.086, 0.125], deep: [0.004, 0.014, 0.024], shelf: [0.1, 0.58, 0.62], refl: [1, 1, 1], reflScale: 1, sat: 1, body: 1 },
  // B — night ink (the game's look): cold navy, the warm sky only as a muted sheen
  ink: { water: [0.01, 0.05, 0.16], deep: [0.002, 0.008, 0.03], shelf: [0.08, 0.32, 0.6], refl: [0.5, 0.62, 0.95], reflScale: 0.8, sat: 0.55, body: 2.2 },
  // C — arctic steel: desaturated blue-grey, like overcast polar water
  steel: { water: [0.07, 0.09, 0.11], deep: [0.015, 0.019, 0.026], shelf: [0.25, 0.42, 0.5], refl: [0.78, 0.82, 0.9], reflScale: 0.85, sat: 0.25, body: 2.0 },
  // D — glacial green: meltwater teal, more colour from within, less mirror
  glacier: { water: [0.02, 0.2, 0.19], deep: [0.003, 0.04, 0.042], shelf: [0.12, 0.72, 0.66], refl: [0.66, 0.9, 0.88], reflScale: 0.6, sat: 0.6, body: 3.2 },
  // E — gold mirror: keeps the sunset, warmer and cleaner than A, less red
  gold: { water: [0.03, 0.05, 0.08], deep: [0.006, 0.01, 0.018], shelf: [0.14, 0.5, 0.58], refl: [1.12, 0.97, 0.74], reflScale: 1.08, sat: 1.15, body: 0.8 },
};
export function applyWaterTint(water, name) {
  const t = WATER_TINTS[name];
  if (!t) return;
  const u = water.material.uniforms;
  u.waterColor.value.setRGB(...t.water);
  u.uDeep.value.setRGB(...t.deep);
  water.userData.shelfBase = new THREE.Color(...t.shelf); // lit per frame in main
  u.uReflTint.value.setRGB(...t.refl);
  u.uReflScale.value = t.reflScale;
  u.uReflSat.value = t.sat;
  u.uBodyGain.value = t.body;
}

export function createWater(sunDir, res = 512, heightTex = null, heightExtent = 64) {
  const water = new Water(seaDiscGeometry(4500), {
    textureWidth: res,
    textureHeight: res,
    waterNormals: makeWaterNormals(),
    sunDirection: sunDir.clone(),
    sunColor: 0xffb070,
    waterColor: 0x061620,
    distortionScale: 1.4,
    fog: true,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0;
  const u = water.material.uniforms;
  u.size.value = 1.6;
  u.tHeight = { value: heightTex };
  u.uHeightExtent = { value: heightExtent };
  u.uShelfColor = { value: new THREE.Color(0.04, 0.2, 0.24) };
  u.uFoamColor = { value: new THREE.Color(0.5, 0.5, 0.55) };
  u.uDeep = { value: new THREE.Color(0.004, 0.014, 0.024) };
  u.uChop = { value: 1.0 };
  u.uReflTint = { value: new THREE.Color(1, 1, 1) };
  u.uReflScale = { value: 1.0 };
  u.uReflSat = { value: 1.0 };
  u.uBodyGain = { value: 1.0 };

  // the curved sea: the surface is drawn where the round Earth puts it, while the mirror
  // coordinates and the shading keep the flat position (the reflection is rendered of a
  // flat world, see below, so it still lines up under each berg)
  u.uSeaCurve = SEA_CURVE;
  water.material.vertexShader = water.material.vertexShader
    .replace('void main() {', CURVE_PARS + '\nvarying float vGraze;\nvoid main() {')
    .replace('vec4 mvPosition =  modelViewMatrix * vec4( position, 1.0 );', `vec4 seaW = worldPosition; seaW.y -= seaDrop(seaW.xyz);
          // elevation of the line of sight above the (curved) surface: 0 on the horizon
          vGraze = (cameraPosition.y - seaW.y) / max(length(seaW.xz - cameraPosition.xz), 1.0) - seaSlope(seaW.xyz);
          vec4 mvPosition = viewMatrix * seaW;`);
  if (!water.material.vertexShader.includes('seaW')) console.warn('water: curvature patch did not apply');
  // the mirror is mip-mapped so the band of it squeezed into the horizon (the whole far
  // sea within a few pixel rows) is filtered instead of sampled as twinkling points
  {
    const t = u.mirrorSampler.value;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
  }
  // the mirror pass sees a flat world: curving there would sink the far ice below the
  // mirror's clip plane and double the offset of every reflection
  const mirror = water.onBeforeRender;
  water.onBeforeRender = function (...args) {
    const k = SEA_CURVE.value.x;
    SEA_CURVE.value.x = 0;
    try { mirror.apply(this, args); } finally { SEA_CURVE.value.x = k; }
  };

  // Sea-ice aware water: two scales of ripples, the floe's submerged shelf glowing
  // turquoise through the surface, and brash/foam lapping at the ice edge.
  const frag = water.material.fragmentShader;
  water.material.fragmentShader = frag.slice(0, frag.indexOf('void main()')) + /* glsl */`
    uniform sampler2D tHeight;
    uniform float uHeightExtent;
    uniform vec3 uShelfColor;
    uniform vec3 uFoamColor;
    uniform vec3 uDeep;
    uniform float uChop;
    uniform vec3 uReflTint;
    uniform float uReflScale;
    uniform float uReflSat;
    uniform float uBodyGain;
    varying float vGraze;
    void main() {
      #include <logdepthbuf_fragment>
      vec2 xz = worldPosition.xz;
      vec3 worldToEye = eye - worldPosition.xyz;
      float dist = length(worldToEye);
      vec3 eyeDirection = worldToEye / dist;
      // 1 where the surface is seen from above, 0 where it is seen edge-on (the horizon):
      // there a pixel covers hundreds of metres of sea, so waves, glints and reflection
      // detail all average out to a calm mirror
      float calm = smoothstep(0.0008, 0.008, vGraze);

      vec4 n1 = getNoise(xz * size);
      vec4 n2 = getNoise(xz * size * 5.3 + 31.7);
      float near = 1.0 / (1.0 + dist * 0.035);
      vec3 nn = n1.xzy + n2.xzy * vec3(0.7, 0.0, 0.7) * near;
      // distant water flattens toward a mirror (sub-pixel waves average out)
      float chop = uChop * mix(1.0, 0.35, smoothstep(40.0, 600.0, dist)) * mix(0.08, 1.0, calm);
      vec3 surfaceNormal = normalize(nn * vec3(1.5 * chop, 1.0, 1.5 * chop));

      vec3 diffuseLight = vec3(0.0);
      vec3 specularLight = vec3(0.0);
      sunLight(surfaceNormal, eyeDirection, 260.0, 3.0, 0.5, diffuseLight, specularLight);
      // far glints are smaller than a pixel: tame them so the horizon does not sparkle
      float farK = smoothstep(120.0, 700.0, dist);
      specularLight *= (1.0 - 0.85 * farK) * calm;

      vec2 mirrorUv = mirrorCoord.xy / mirrorCoord.w;
      vec2 distortion = surfaceNormal.xz * (0.001 + 1.0 / dist) * distortionScale * calm;
      // filter by the footprint of the undistorted lookup: squeezed toward the horizon it
      // reaches into the coarse mips, near the floe it stays sharp
      vec3 reflectionSample = min(textureGrad(mirrorSampler, mirrorUv + distortion, dFdx(mirrorUv), dFdy(mirrorUv)).rgb, vec3(mix(30.0, 4.0, max(farK, 1.0 - calm))));

      float theta = max(dot(eyeDirection, surfaceNormal), 0.0);
      float reflectance = (0.02 + 0.98 * pow(max(1.0 - theta, 0.0), 5.0)) * uReflScale;
      reflectionSample = mix(vec3(dot(reflectionSample, vec3(0.2126, 0.7152, 0.0722))), reflectionSample, uReflSat) * uReflTint;

      // distance to the floe edge (negative = open water)
      vec2 huv = xz / uHeightExtent + 0.5;
      float sdf = -60.0;
      if (huv.x > 0.002 && huv.x < 0.998 && huv.y > 0.002 && huv.y < 0.998) sdf = texture2D(tHeight, huv).g;
      float wob = n1.x * 0.18 + n2.x * 0.05;
      // the ice keeps going under water: a pale turquoise ledge that sinks into the dark
      // seen at a grazing angle the surface is a mirror: the ledge only shows from above
      float shelf = exp(min(sdf + wob, 0.0) / 2.4) * smoothstep(0.03, 0.22, eyeDirection.y);
      vec3 body = uDeep + waterColor * (0.25 + diffuseLight) * 0.12 * uBodyGain;
      body = mix(body, uShelfColor, shelf * 0.92);
      vec3 col = mix(body * (0.55 + 0.45 * getShadowMask()), reflectionSample + specularLight, reflectance);

      // brash ice and foam breathing against the edge
      float lap = sin(time * 1.6 + xz.x * 0.9 + xz.y * 0.6) * 0.07 + sin(time * 0.7 - xz.x * 0.35 + xz.y * 0.8) * 0.05;
      float foam = smoothstep(-0.5 + lap, -0.04, sdf + n2.x * 0.12);
      foam *= 0.45 + 0.55 * smoothstep(-0.35, 0.55, n2.z + n1.z * 0.6);
      col = mix(col, uFoamColor, foam * 0.9);

      gl_FragColor = vec4(col, alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`;
  return water;
}

function irregularShape(rnd, radius, points = 22, rough = 0.28, jitter = 1) {
  const shape = new THREE.Shape();
  const ph = Array.from({ length: 5 }, () => rnd() * Math.PI * 2);
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    let r = 1 + rough * (0.5 * Math.cos(2 * a + ph[0]) + 0.3 * Math.cos(3 * a + ph[1]) + 0.2 * Math.cos(5 * a + ph[2]));
    r *= 1 + (rnd() - 0.5) * rough * 0.6 * jitter;
    const x = Math.cos(a) * r * radius, y = Math.sin(a) * r * radius;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

function colorizeSlab(geo, topY) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const up = nor.getY(i);
    const y = pos.getY(i);
    const snow = up > 0.7 || y > topY - 0.06 ? 1 : 0;
    col[i * 3] = snow ? 0.93 : 0.5;
    col[i * 3 + 1] = snow ? 0.95 : 0.75;
    col[i * 3 + 2] = snow ? 0.98 : 0.86;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

// --- icebergs ---------------------------------------------------------------
// Built in polar rows (rho = fraction of the outline radius, y = height): a tabular
// berg is a flat snow cap with near-vertical fluted cliffs and a wave-cut notch; a
// weathered berg is a ridged dome. Vertex colours carry snow, blue ice and the
// darker, wetter band at the waterline.
function bergGeometry(seed, R, H, kind) {
  const rnd = mulberry32(seed);
  const n = new Perlin2D(seed);
  const M = 200;
  const harm = [];
  for (let k = 2; k <= 9; k++) harm.push({ k, a: (0.16 / Math.pow(k, 0.9)) * (0.4 + rnd()), p: rnd() * Math.PI * 2 });
  let outline = (th) => { let r = 1; for (const h of harm) r += h.a * Math.cos(h.k * th + h.p); return R * r; };
  if (kind === 'tabular') {
    // tabular bergs calve along straight fractures: a jittered polygon (flat faces,
    // sharp corners) with only a little waviness, not a smooth puck
    const N = 6 + Math.floor(rnd() * 4);
    const vs = [];
    for (let i = 0; i < N; i++) {
      const a = ((i + 0.5 * (rnd() - 0.5)) / N) * Math.PI * 2;
      const r = 0.82 + 0.3 * rnd();
      vs.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const poly = (th) => {
      const dx = Math.cos(th), dz = Math.sin(th);
      let best = 1;
      for (let i = 0; i < N; i++) {
        const [ax, az] = vs[i], [bx, bz] = vs[(i + 1) % N];
        const ex = bx - ax, ez = bz - az;
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = (ax * ez - az * ex) / den; // distance along the ray
        const u = (ax * dz - az * dx) / den; // position along the edge
        if (t > 0 && u >= -1e-6 && u <= 1 + 1e-6) { best = t; break; }
      }
      return best;
    };
    outline = (th) => { let r = poly(th); for (const h of harm) r += h.a * 0.25 * Math.cos(h.k * th + h.p); return R * r; };
  }

  // rows: [rho, y] where y may depend on theta
  let rows;
  if (kind === 'tabular') {
    const top = (th, rho) => H * (1 + 0.035 * n.fbm(Math.cos(th) * rho * 3 + 5, Math.sin(th) * rho * 3, 3));
    rows = [
      [0, top], [0.3, top], [0.6, top], [0.84, top], [0.925, top],
      [0.946, (th, r) => top(th, r) * 0.975], [0.956, () => H * 0.86], [0.961, () => H * 0.62], [0.965, () => H * 0.36],
      [0.969, () => H * 0.14], [0.972, () => 1.6], [0.958, () => 0.5], [0.975, () => -0.05], [1.03, () => -5],
    ];
  } else {
    const peak = (th, rho) => {
      const ridge = 1 - Math.abs(n.noise(Math.cos(th) * rho * 2.2 + 3, Math.sin(th) * rho * 2.2 - 1));
      const base = Math.pow(Math.max(0, 1 - Math.pow(rho, 2.4)), 0.75);
      return H * base * (0.45 + 0.75 * ridge * ridge) + 0.8;
    };
    rows = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.78, 0.85, 0.9, 0.94, 0.97].map((r) => [r, peak]);
    rows.push([0.985, () => 1.2], [0.972, () => 0.45], [0.99, () => -0.05], [1.05, () => -4]);
  }

  const NR = rows.length;
  const pos = new Float32Array((M + 1) * NR * 3);
  const wall = new Float32Array((M + 1) * NR);
  for (let m = 0; m <= M; m++) {
    const th = (m / M) * Math.PI * 2;
    const ro = outline(th);
    const cx = Math.cos(th), cz = Math.sin(th);
    for (let r = 0; r < NR; r++) {
      const [rho, yf] = rows[r];
      const y = yf(th, rho);
      // flutes and strata only on the steep part
      const steep = kind === 'tabular' ? (rho > 0.94 && rho < 1.0 ? 1 : 0) : THREE.MathUtils.smoothstep(rho, 0.55, 0.9);
      const flute = steep * (R * 0.014 * n.fbm(th * 34, y * 0.03, 3) + R * 0.005 * n.noise(th * 130, y * 0.2) + Math.sin(y * 0.8 + n.noise(th * 6, 0) * 4) * R * 0.0012);
      const rr = ro * rho + flute;
      const k = (m * NR + r) * 3;
      pos[k] = cx * rr; pos[k + 1] = y; pos[k + 2] = cz * rr;
      wall[m * NR + r] = steep;
    }
  }
  const idx = [];
  for (let m = 0; m < M; m++) for (let r = 0; r < NR - 1; r++) {
    const a = m * NR + r, b = (m + 1) * NR + r;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // close the seam: average normals of the first and last meridian
  const nor = geo.attributes.normal;
  for (let r = 0; r < NR; r++) {
    const a = r, b = M * NR + r;
    const x = nor.getX(a) + nor.getX(b), y = nor.getY(a) + nor.getY(b), z = nor.getZ(a) + nor.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    nor.setXYZ(a, x / l, y / l, z / l); nor.setXYZ(b, x / l, y / l, z / l);
  }
  const col = new Float32Array((M + 1) * NR * 3);
  for (let i = 0; i < (M + 1) * NR; i++) {
    const y = pos[i * 3 + 1], up = nor.getY(i);
    const th = Math.atan2(pos[i * 3 + 2], pos[i * 3]);
    const snow = THREE.MathUtils.smoothstep(up, 0.35, 0.75);
    // blue deepens in crevices and old compressed strata
    const crev = 0.5 + 0.5 * n.fbm(th * 22, y * 0.05, 3);
    let r = THREE.MathUtils.lerp(0.42, 0.8, crev), g = THREE.MathUtils.lerp(0.66, 0.9, crev), b = THREE.MathUtils.lerp(0.84, 0.97, crev);
    const wet = 1 - THREE.MathUtils.smoothstep(y, 0.2, 3.5); // waterline band
    r = THREE.MathUtils.lerp(r, 0.2, wet * 0.8); g = THREE.MathUtils.lerp(g, 0.5, wet * 0.8); b = THREE.MathUtils.lerp(b, 0.62, wet * 0.8);
    col[i * 3] = THREE.MathUtils.lerp(r, 0.93, snow);
    col[i * 3 + 1] = THREE.MathUtils.lerp(g, 0.95, snow);
    col[i * 3 + 2] = THREE.MathUtils.lerp(b, 0.98, snow);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/**
 * Pack ice and icebergs around the main floe. Everything sits within ~900 m and
 * dissolves into the haze: nothing is drawn (or reflected) beyond what can be seen.
 */
export function createDistantIce() {
  const group = new THREE.Group();
  const rnd = mulberry32(2024);

  // pack-ice floes: thin slabs with a snow cap, plus a translucent underwater ledge
  const variants = [];
  for (let v = 0; v < 7; v++) {
    const shape = irregularShape(rnd, 1, 18 + Math.floor(rnd() * 10), 0.3 + rnd() * 0.15);
    let geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: true, bevelThickness: 0.15, bevelSize: 0.06, bevelSegments: 2, steps: 1 });
    geo.rotateX(-Math.PI / 2); // extrude along +Y
    geo.deleteAttribute('normal');
    geo.deleteAttribute('uv');
    geo = mergeVertices(geo, 0.001);
    geo.computeVertexNormals();
    colorizeSlab(geo, 1.15);
    // ledge: a ring from the outline outward, opaque at the ice, fading to nothing
    const pts = shape.getPoints(1);
    const lp = [], la = [], li = [];
    pts.forEach((p, i) => {
      lp.push(p.x * 1.05, 0, -p.y * 1.05, p.x * 1.36, 0, -p.y * 1.36);
      la.push(1, 0);
      const a = i * 2, b = ((i + 1) % pts.length) * 2;
      li.push(a, b, a + 1, b, b + 1, a + 1);
    });
    const ledge = new THREE.BufferGeometry();
    ledge.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    ledge.setAttribute('aAlpha', new THREE.Float32BufferAttribute(la, 1));
    ledge.setIndex(li);
    variants.push({ geo, ledge });
  }
  const floeMat = applySeaCurve(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 }), { sinkEdgeOn: true });
  const ledgeMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0.04, 0.2, 0.24) }, fogColor: { value: new THREE.Color() }, fogDensity: { value: 0.001 }, uSeaCurve: SEA_CURVE },
    vertexShader: /* glsl */`
      attribute float aAlpha; varying float vA; varying float vDepth; varying float vGraze;
      ${CURVE_PARS}
      void main() {
        vA = aAlpha;
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        w.y -= seaDrop(w.xyz);
        // elevation of the line of sight above the (curved) surface there
        vGraze = (cameraPosition.y - w.y) / max(length(w.xz - cameraPosition.xz), 1.0) - seaSlope(w.xyz);
        vec4 mv = viewMatrix * w;
        vDepth = -mv.z; gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform vec3 fogColor; uniform float fogDensity; varying float vA; varying float vDepth; varying float vGraze;
      void main() {
        float f = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);
        // sub-pixel at a distance: fade out before it can shimmer on the horizon; and like
        // the floe's own shelf, it only shows from above (at a grazing angle the surface
        // is a mirror; dark dashes would otherwise line the horizon)
        float a = vA * vA * 0.85 * (1.0 - smoothstep(120.0, 320.0, vDepth)) * smoothstep(0.004, 0.02, vGraze);
        gl_FragColor = vec4(mix(uColor, fogColor, f), a);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -10,
  });
  group.userData.ledgeMaterial = ledgeMat;
  const perVariant = variants.map(() => ({ slab: [], ledge: [] }));
  const tmp = new THREE.Object3D();
  const placed = [];
  let tries = 0;
  while (placed.length < 260 && tries++ < 20000) {
    const ang = rnd() * Math.PI * 2;
    const dist = 26 + Math.pow(rnd(), 1.6) * 560;
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    const size = (1.2 + rnd() * 3.5) * (1 + dist / 110);
    if (floeSdf(x, z) > -size - 2) continue;
    let ok = true;
    for (const p of placed) {
      if (Math.hypot(p.x - x, p.z - z) < (p.s + size) * 1.1) { ok = false; break; }
    }
    if (!ok) continue;
    placed.push({ x, z, s: size });
    const rot = rnd() * Math.PI * 2, sz = size * (0.6 + rnd() * 0.6);
    const vi = Math.floor(rnd() * variants.length);
    // the slab spans y = -0.15..1.15 before scaling: place it so it always floats with
    // a real freeboard (a top at the waterline z-fights with the waves and vanishes,
    // leaving only its underwater ledge ring on the water)
    const sy = 0.45 + rnd() * 0.25;
    const freeboard = 0.14 + rnd() * 0.12;
    tmp.position.set(x, freeboard - 1.15 * sy, z);
    tmp.rotation.set(0, rot, 0);
    tmp.scale.set(size, sy, sz);
    tmp.updateMatrix();
    perVariant[vi].slab.push(tmp.matrix.clone());
    tmp.position.y = 0.012;
    tmp.scale.set(size, 1, sz);
    tmp.updateMatrix();
    perVariant[vi].ledge.push(tmp.matrix.clone());
  }
  group.userData.floes = placed;
  variants.forEach((v, i) => {
    const list = perVariant[i];
    if (!list.slab.length) return;
    const im = new THREE.InstancedMesh(v.geo, floeMat, list.slab.length);
    list.slab.forEach((m, k) => im.setMatrixAt(k, m));
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    group.add(im);
    const lm = new THREE.InstancedMesh(v.ledge, ledgeMat, list.ledge.length);
    list.ledge.forEach((m, k) => lm.setMatrixAt(k, m));
    lm.instanceMatrix.needsUpdate = true;
    lm.frustumCulled = false;
    lm.renderOrder = 1;
    lm.userData.noReflect = true;
    group.add(lm);
  });

  // icebergs: a few tabular giants in the haze, weathered bergs and bergy bits nearer
  const bergMat = applySeaCurve(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 }));
  // bergs are big and bright: they hold their form through the haze instead of turning
  // into sky-coloured glass blocks on the horizon
  bergMat.defines = { SKY_FOG_SCALE: '0.5' };
  const bergs = [
    { a: 0.2, d: 620, r: 110, h: 30, kind: 'tabular' },
    { a: 1.3, d: 820, r: 190, h: 38, kind: 'tabular' },
    { a: 3.85, d: 760, r: 150, h: 34, kind: 'tabular' },
    { a: 2.55, d: 430, r: 46, h: 30, kind: 'dome' },
    { a: 5.05, d: 520, r: 60, h: 36, kind: 'dome' },
    { a: 4.4, d: 240, r: 15, h: 9, kind: 'dome' },
    { a: 0.95, d: 190, r: 11, h: 6.5, kind: 'dome' },
    { a: 2.95, d: 150, r: 8, h: 4.5, kind: 'dome' },
  ];
  bergs.forEach((b, i) => {
    const m = new THREE.Mesh(bergGeometry(100 + i * 7, b.r, b.h, b.kind), bergMat);
    m.position.set(Math.cos(b.a) * b.d, 0, Math.sin(b.a) * b.d);
    // bergs rarely float level
    m.rotation.set((rnd() - 0.5) * 0.07, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.07);
    group.add(m);
  });
  return group;
}
