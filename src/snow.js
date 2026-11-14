import * as THREE from 'three';
import { HEIGHT_EXTENT, HEIGHT_RES, WIND_ANGLE } from './terrain.js';
import { DEFORM_EXTENT } from './deform.js';

// Shared GLSL for sampling the snow surface (macro height + deformation).
export const SNOW_HEIGHT_GLSL = /* glsl */`
  uniform sampler2D tHeight;
  uniform sampler2D tDeform;
  uniform float uHeightExtent;
  uniform float uDeformExtent;
  vec4 snowMacro(vec2 xz) { return textureLod(tHeight, xz / uHeightExtent + 0.5, 0.0); }
  vec2 snowDeformRaw(vec2 xz) {
    vec2 uv = xz / uDeformExtent + 0.5;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec2(0.0);
    return textureLod(tDeform, uv, 0.0).rg;
  }
  float snowDeformH(vec2 d) { return -d.r + d.g * (1.0 - smoothstep(0.0, 0.004, d.r)); }
  float snowHeight(vec2 xz) { return snowMacro(xz).r + snowDeformH(snowDeformRaw(xz)); }
`;

/**
 * Uniform grid for the area around the chick. Moved only by whole multiples of its
 * spacing, so every vertex lands exactly where another one was: footprint geometry
 * never re-samples (no swimming / shimmering while the camera follows).
 */
export function buildUniformGrid(segments = 640, size = 8) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2);
  geo.deleteAttribute('uv');
  return { geometry: geo, spacing: size / segments, half: size / 2 };
}

/** Camera-following grid, densest at the centre (≈1 cm) and coarse at the rim. */
export function buildSnowGrid(segments = 768, radius = 46, innerSpacing = 0.0105) {
  const n = segments + 1;
  const dt = 2 / segments;
  const c = innerSpacing / (radius * dt); // linear share of the warp
  const warp = (t) => radius * (c * t + (1 - c) * t * t * t);
  const pos = new Float32Array(n * n * 3);
  const nor = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    const z = warp(-1 + j * dt);
    for (let i = 0; i < n; i++) {
      const x = warp(-1 + i * dt);
      const k = (j * n + i) * 3;
      pos[k] = x; pos[k + 1] = 0; pos[k + 2] = z;
      nor[k + 1] = 1;
    }
  }
  const idx = new Uint32Array(segments * segments * 6);
  let p = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
      // alternate diagonal for a more isotropic triangulation
      if ((i + j) & 1) { idx[p++] = a; idx[p++] = d; idx[p++] = b; idx[p++] = b; idx[p++] = d; idx[p++] = e; }
      else { idx[p++] = a; idx[p++] = d; idx[p++] = e; idx[p++] = a; idx[p++] = e; idx[p++] = b; }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return { geometry: geo, innerSpacing };
}

export function createSnowMaterial({ heightTex, deformTex, detailTex, deformSize, far = false, shared = null }) {
  const uniforms = shared || {
    tHeight: { value: heightTex },
    tDeform: { value: deformTex },
    tDetail: { value: detailTex },
    tTerrainShadow: { value: null },
    uHeightExtent: { value: HEIGHT_EXTENT },
    uDeformExtent: { value: DEFORM_EXTENT },
    uHeightTexel: { value: HEIGHT_EXTENT / HEIGHT_RES },
    uDeformTexel: { value: DEFORM_EXTENT / deformSize },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunRadiance: { value: new THREE.Color(1, 1, 1) },
    uSkyTint: { value: new THREE.Color(0.5, 0.6, 0.9) },
    uSparkle: { value: 1.0 },
    uWindRot: { value: new THREE.Vector2(Math.cos(WIND_ANGLE), Math.sin(WIND_ANGLE)) },
    uTime: { value: 0 },
    uContact: { value: new THREE.Vector4(0, 0, 0, 0.16) },
    uDrift: { value: 0 },
    uDriftScroll: { value: 0 }, // accumulated wind travel (m), driven from main
    uNear: { value: new THREE.Vector3(0, 0, 4) }, // xz centre + half size of the near grid
  };

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        ${SNOW_HEIGHT_GLSL}
        varying vec3 vSnowWorld;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec2 snowXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
        #ifdef SNOW_FAR
          // far grid carries only the smooth macro relief; footprints there are shaded per pixel
          transformed.y = snowMacro(snowXZ).r;
        #else
          transformed.y = snowHeight(snowXZ);
        #endif
        vSnowWorld = vec3(snowXZ.x, transformed.y, snowXZ.y);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${SNOW_HEIGHT_GLSL}
        varying vec3 vSnowWorld;
        uniform sampler2D tDetail;
        uniform sampler2D tTerrainShadow;
        uniform float uHeightTexel;
        uniform float uDeformTexel;
        uniform vec3 uSunDir;
        uniform vec3 uSunRadiance;
        uniform vec3 uSkyTint;
        uniform float uSparkle;
        uniform vec2 uWindRot;
        uniform float uTime;
        uniform vec4 uContact;
        uniform vec3 uNear;
        uniform float uDrift;
        uniform float uDriftScroll;

        vec3 hash33(vec3 p3) {
          p3 = fract(p3 * vec3(.1031, .1030, .0973));
          p3 += dot(p3, p3.yxz + 33.33);
          return fract((p3.xxy + p3.yxx) * p3.zyx);
        }

        // One layer of crystal facets: a few cells hold a mirror-like grain with a random normal.
        float glitterLayer(vec3 wp, float cellsPerM, vec3 N, vec3 V, vec3 L, float pf, float density) {
          vec3 p = wp * cellsPerM;
          vec3 cell = floor(p);
          vec3 h = hash33(cell);
          vec3 h2 = hash33(cell + 17.31);
          if (h2.x > density) return 0.0;
          vec3 fn = normalize(N * 1.4 + (h - 0.5) * 2.2 + vec3(0.0, 1e-3, 0.0));
          vec3 H = normalize(L + V);
          float a = clamp(dot(fn, H), 0.0, 1.0);
          float g = pow(a, 1400.0);
          // the crystal occupies a small dot inside its cell
          vec3 f = fract(p) - 0.5 - (h2.yzx - 0.5) * 0.5;
          float cellPx = (1.0 / cellsPerM) / max(pf, 1e-5);
          float rad = max(0.18, 0.6 / max(cellPx, 0.01)); // never thinner than ~a pixel
          float dotMask = smoothstep(rad, rad * 0.35, length(f));
          // distant cells fall below a pixel: fade energy instead of aliasing
          float fade = clamp(cellPx * 0.6, 0.0, 1.0);
          return g * dotMask * fade * (0.5 + h2.z);
        }

        float snowSelfShadow;
        float snowAO;
        float snowCavity;
        vec3 snowExtra;`)

      // Surface reconstruction: discard off-floe, build normal and material params.
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        vec2 sxz = vSnowWorld.xz;
        vec4 macro = snowMacro(sxz);
        if (macro.g < 0.0) discard;
        #ifdef SNOW_FAR
          // the near grid owns this area (small overlap hides the seam)
          vec2 nd = abs(sxz - uNear.xy);
          if (max(nd.x, nd.y) < uNear.z - 0.03) discard;
        #endif

        float pf = length(fwidth(sxz)); // pixel footprint (m)
        // macro gradient, filtered to the pixel footprint
        float eM = max(uHeightTexel, pf * 0.75);
        float hmx = snowMacro(sxz + vec2(eM, 0.0)).r - snowMacro(sxz - vec2(eM, 0.0)).r;
        float hmz = snowMacro(sxz + vec2(0.0, eM)).r - snowMacro(sxz - vec2(0.0, eM)).r;
        vec2 gradM = vec2(hmx, hmz) / (2.0 * eM);
        // deformation gradient
        float eD = max(uDeformTexel, pf * 0.75);
        vec2 dC = snowDeformRaw(sxz);
        float hdx = snowDeformH(snowDeformRaw(sxz + vec2(eD, 0.0))) - snowDeformH(snowDeformRaw(sxz - vec2(eD, 0.0)));
        float hdz = snowDeformH(snowDeformRaw(sxz + vec2(0.0, eD))) - snowDeformH(snowDeformRaw(sxz - vec2(0.0, eD)));
        vec2 gradD = vec2(hdx, hdz) / (2.0 * eD);
        vec2 grad = gradM + gradD;
        vec3 Nmacro = normalize(vec3(-grad.x, 1.0, -grad.y));

        float compressed = smoothstep(0.0015, 0.012, dC.r);
        snowCavity = smoothstep(0.002, 0.03, dC.r);

        // micro detail: grain + wind ripples aligned with the wind
        vec2 wuv = vec2(dot(sxz, uWindRot), dot(sxz, vec2(-uWindRot.y, uWindRot.x)));
        vec4 g1 = texture2D(tDetail, sxz * 2.2);
        vec4 g2 = texture2D(tDetail, sxz * 7.7 + 0.37);
        vec4 rp = texture2D(tDetail, vec2(wuv.y * 0.28, wuv.x * 0.09));
        vec2 dGrain = (g1.rg * 2.0 - 1.0) * 0.55 + (g2.rg * 2.0 - 1.0) * 0.35;
        vec2 dRipple = (rp.ba * 2.0 - 1.0);
        // rotate ripple slope back into world xz
        dRipple = vec2(dRipple.y * uWindRot.x - dRipple.x * uWindRot.y, dRipple.y * uWindRot.y + dRipple.x * uWindRot.x);
        float flatness = clamp(Nmacro.y * 1.4 - 0.4, 0.0, 1.0);
        float detailAmt = (1.0 - compressed * 0.75);
        vec2 dDetail = dGrain * 0.45 * detailAmt + dRipple * 0.55 * flatness * (1.0 - compressed);
        vec3 snowN = normalize(Nmacro + vec3(dDetail.x, 0.0, dDetail.y) * 0.55);

        // terrain self-shadow: baked macro shadow (dunes, ridges) + short march for footprint rims
        vec2 bake = texture2D(tTerrainShadow, sxz / uHeightExtent + 0.5).rg;
        float sh = 1.0;
        float camDist = distance(cameraPosition.xz, sxz);
        if (camDist < 22.0 && dC.r + dC.g > 1e-5) {
          vec2 sd = normalize(uSunDir.xz + 1e-6);
          float tanE = uSunDir.y / max(length(uSunDir.xz), 1e-4);
          float h0 = snowDeformH(dC) + 0.0008;
          float t = 0.004;
          for (int i = 0; i < 7; i++) {
            vec2 off = sd * t;
            float hq = dot(gradM, off) + snowDeformH(snowDeformRaw(sxz + off));
            sh = min(sh, 5.0 * (h0 + t * tanE - hq) / t + 0.5);
            t *= 1.85;
          }
          sh = mix(sh, 1.0, smoothstep(14.0, 22.0, camDist));
        }
        snowSelfShadow = smoothstep(0.0, 1.0, sh) * bake.r;
        snowAO = (1.0 - snowCavity * 0.45) * mix(0.55, 1.0, bake.g);
        // contact occlusion under the chick (sky light blocked by its body)
        vec2 cd = sxz - uContact.xz;
        snowAO *= 1.0 - 0.55 * exp(-dot(cd, cd) / (uContact.w * uContact.w));
        `)

      .replace('#include <color_fragment>', `#include <color_fragment>
        // fresh snow is not perfectly white; packed snow is denser, slightly greyer and bluer
        float alb = 0.94 + 0.03 * (g1.r - 0.5);
        vec3 snowAlb = vec3(alb, alb * 0.995, alb * 1.0);
        snowAlb = mix(snowAlb, vec3(0.84, 0.87, 0.91), compressed * 0.5);
        diffuseColor.rgb = snowAlb;`)

      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.82, 0.5, compressed);
        // wind-glazed crust on the ridges is smoother
        roughnessFactor -= 0.18 * smoothstep(0.3, 0.9, dRipple.x * 0.5 + 0.5) * flatness;`)

      .replace('#include <normal_fragment_maps>', `
        normal = normalize((viewMatrix * vec4(snowN, 0.0)).xyz);`)

      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= snowSelfShadow;',
      ))

      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= snowAO;
        reflectedLight.indirectSpecular *= snowAO;`)

      .replace('#include <opaque_fragment>', `
        {
          vec3 Vw = normalize(cameraPosition - vSnowWorld);
          vec3 L = normalize(uSunDir);
          float casterShadow = 1.0;
          #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
            casterShadow = getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowIntensity, directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ] );
          #endif
          float vis = snowSelfShadow * casterShadow;
          float NdL = max(dot(snowN, L), 0.0);

          // sub-surface scattering: light diffuses through the snowpack and leaks out
          // blue-green, strongest inside cavities and along the shadow terminator
          float wrap = clamp((dot(snowN, L) + 0.6) / 1.6, 0.0, 1.0) * (1.0 - min(NdL, 1.0));
          vec3 sssTint = vec3(0.22, 0.55, 1.0);
          vec3 sss = uSunRadiance * sssTint * (0.018 * wrap * mix(1.0, vis, 0.5) + 0.022 * snowCavity * (0.4 + 0.6 * vis));
          sss += uSkyTint * sssTint * 0.018 * snowCavity;

          // forward scattering sheen when looking toward a low sun across the snow
          float fwd = pow(clamp(dot(-Vw, L), 0.0, 1.0), 6.0) * pow(clamp(1.0 - dot(snowN, Vw), 0.0, 1.0), 3.0);
          vec3 sheen = uSunRadiance * 0.12 * fwd * vis;

          // crystal glints at three scales
          // (the coarse layer stays faint: its big glints bloomed into soft orbs)
          float glit = glitterLayer(vSnowWorld, 320.0, snowN, Vw, L, pf, 0.22)
                     + 0.5 * glitterLayer(vSnowWorld + 3.1, 140.0, snowN, Vw, L, pf, 0.12)
                     + 0.12 * glitterLayer(vSnowWorld + 7.7, 55.0, snowN, Vw, L, pf, 0.05);
          glit *= (1.0 - compressed * 0.8);
          vec3 sparkle = uSunRadiance * glit * vis * smoothstep(0.0, 0.08, NdL) * 40.0 * uSparkle;
          // faint sky glints in shadow
          sparkle += uSkyTint * glitterLayer(vSnowWorld + 1.3, 260.0, snowN, Vw, vec3(0.0, 1.0, 0.0), pf, 0.15) * 3.0 * uSparkle;

          outgoingLight += sss + sheen + sparkle;
          // spindrift: faint wisps of blown snow sliding over the surface. They only lighten
          // the snow a little, in its own colour (a blue veil read as a pattern painted on the
          // ground), and travel by the accumulated wind (never back and forth with the gusts)
          if (uDrift > 0.01) {
            vec2 dv = vec2(wuv.x * 0.06 - uDriftScroll * 0.08, wuv.y * 0.38);
            float d1 = texture2D(tDetail, dv).a;
            float d2 = texture2D(tDetail, dv * vec2(2.1, 1.6) + vec2(-uDriftScroll * 0.11, 0.13)).b;
            float d3 = texture2D(tDetail, dv * vec2(0.45, 0.5) + vec2(-uDriftScroll * 0.02, 0.4)).r;
            float ribbon = smoothstep(0.42, 0.75, d1 * 0.55 + d2 * 0.3 + d3 * 0.3 - 0.07);
            vec3 veil = outgoingLight * 1.18 + uSunRadiance * 0.04 * fwd * vis;
            outgoingLight = mix(outgoingLight, veil, ribbon * min(uDrift, 1.0) * 0.45);
          }
        }
        #include <opaque_fragment>`);
  };
  if (far) mat.defines = { SNOW_FAR: '' };
  mat.customProgramCacheKey = () => (far ? 'snow-far' : 'snow-near');
  return mat;
}

// Bakes sun visibility (R) and sky-dome visibility / AO (G) of the macro height field.
// Re-run only when the sun moves: replaces an 18-tap per-pixel raymarch.
export class TerrainShadowBaker {
  constructor(renderer, heightTex, res = 1024) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(res, res, {
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tHeight: { value: heightTex },
        uHeightExtent: { value: HEIGHT_EXTENT },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tHeight; uniform float uHeightExtent; uniform vec3 uSunDir; varying vec2 vUv;
        float H(vec2 xz) { return textureLod(tHeight, xz / uHeightExtent + 0.5, 0.0).r; }
        void main() {
          vec2 xz = (vUv - 0.5) * uHeightExtent;
          float h0 = H(xz) + 0.004;
          // sun visibility: soft shadow march up to ~40 m
          vec2 sd = normalize(uSunDir.xz + 1e-6);
          float tanE = uSunDir.y / max(length(uSunDir.xz), 1e-4);
          float sh = 1.0, t = 0.03;
          for (int i = 0; i < 48; i++) {
            float hq = H(xz + sd * t);
            sh = min(sh, 7.0 * (h0 + t * tanE - hq) / t + 0.5);
            t *= 1.13;
            if (sh < 0.0 || t > 40.0) break;
          }
          // sky visibility: horizon angle in 8 directions
          float occ = 0.0;
          for (int d = 0; d < 8; d++) {
            float a = float(d) * 0.785398 + 0.39;
            vec2 dir = vec2(cos(a), sin(a));
            float maxSlope = 0.0, r = 0.08;
            for (int k = 0; k < 7; k++) {
              maxSlope = max(maxSlope, (H(xz + dir * r) - h0) / r);
              r *= 1.8;
            }
            occ += sin(atan(maxSlope));
          }
          float sky = 1.0 - occ / 8.0;
          gl_FragColor = vec4(smoothstep(0.0, 1.0, sh), clamp(sky, 0.0, 1.0), 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.scene = new THREE.Scene();
    const q = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    q.frustumCulled = false;
    this.scene.add(q);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  bake(sunDir) {
    this.material.uniforms.uSunDir.value.copy(sunDir);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.rt);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);
  }

  get texture() { return this.rt.texture; }
}
