import * as THREE from 'three';
import { SNOW_HEIGHT_GLSL } from './snow.js';
import { WIND_ANGLE } from './terrain.js';

// Airborne ice: diamond dust (glittering crystals hanging in cold air),
// spindrift (wind-blown snow skimming the surface) and optional snowfall.
// Particles live in a box that wraps around the camera, so density is constant.

const VERT = /* glsl */`
  ${SNOW_HEIGHT_GLSL}
  uniform float uTime;
  uniform vec3 uCenter;
  uniform vec3 uBox;
  uniform vec3 uWind;
  uniform vec3 uWindTravel;
  uniform float uMode;      // 0 dust, 1 spindrift, 2 snowfall
  uniform float uSize;
  uniform float uPixelRatio;
  attribute vec4 aSeed;
  varying float vSeed;
  varying float vFade;
  varying vec3 vWorld;
  varying vec2 vDir;
  uniform float uStreak;
  uniform float uHop;       // spindrift: how high the wind lifts it (storm styles)

  void main() {
    vec3 p = aSeed.xyz * uBox;
    float t = uTime * (0.6 + aSeed.w * 0.8);
    // the distance the wind has carried things so far, accumulated frame by frame: wind × time
    // would jump back and forth whenever a gust changes the wind speed
    vec3 drift = uWindTravel * (0.6 + aSeed.w * 0.8);
    if (uMode == 2.0) drift.y -= t * (0.55 + aSeed.w * 0.4);
    if (uMode == 0.0) drift.y -= t * 0.02;
    // turbulence
    drift += vec3(sin(t * 1.3 + aSeed.x * 40.0), sin(t * 0.9 + aSeed.y * 30.0) * 0.6, cos(t * 1.1 + aSeed.z * 50.0)) * (uMode == 1.0 ? 0.18 : 0.08);
    vec3 w = p + drift;
    // wrap into a box around the centre
    w = uCenter + mod(w - uCenter + uBox * 0.5, uBox) - uBox * 0.5;
    float ground = snowMacro(w.xz).r;
    if (uMode == 1.0) {
      // hug the snow: skimming height with occasional hops
      float hop = pow(abs(sin(t * 0.7 + aSeed.w * 20.0)), 6.0);
      w.y = max(ground, 0.0) + 0.01 + (aSeed.y * 0.12 + hop * 0.25) * uHop;
      vFade = smoothstep(-1.0, 0.0, snowMacro(w.xz).g); // only over the floe
    } else {
      vFade = 1.0;
      if (uMode == 2.0) vFade = smoothstep(ground - 0.05, ground + 0.2, w.y);
    }
    // fade at box edges to hide wrapping
    vec3 e = abs(w - uCenter) / (uBox * 0.5);
    vFade *= 1.0 - smoothstep(0.75, 1.0, max(e.x, max(e.y, e.z)));
    vSeed = aSeed.w;
    vWorld = w;
    vec4 mv = viewMatrix * vec4(w, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixelRatio * (1.0 + aSeed.w) * (1.0 + 2.2 * uStreak) / max(-mv.z, 0.05);
    // screen-space travel direction, for motion-stretched flakes in strong wind
    vec3 vel = uWind + vec3(0.0, uMode == 2.0 ? -0.75 : 0.0, 0.0);
    vec4 ahead = projectionMatrix * viewMatrix * vec4(w + vel * 0.02, 1.0);
    vec2 sd = ahead.xy / ahead.w - gl_Position.xy / gl_Position.w;
    vDir = length(sd) > 1e-6 ? normalize(sd) : vec2(1.0, 0.0);
  }
`;

const FRAG = /* glsl */`
  uniform vec3 uSunDir;
  uniform vec3 uSunRad;
  uniform vec3 uSkyTint;
  uniform float uMode;
  uniform float uIntensity;
  uniform float uTime;
  varying float vSeed;
  varying float vFade;
  varying vec3 vWorld;
  varying vec2 vDir;
  uniform float uStreak;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c);
    float disc = smoothstep(0.5, 0.0, r);
    if (uStreak > 0.01) {
      // a flake smeared along its path during the exposure
      vec2 q = vec2(c.x, -c.y);
      float along = abs(dot(q, vDir)), across = abs(dot(q, vec2(-vDir.y, vDir.x)));
      float streak = smoothstep(0.5, 0.1, along) * smoothstep(mix(0.5, 0.07, uStreak), 0.0, across);
      disc = mix(disc, streak, uStreak);
    }
    vec3 V = normalize(vWorld - cameraPosition);
    float toSun = clamp(dot(V, normalize(uSunDir)), 0.0, 1.0);
    vec3 col;
    float a;
    if (uMode == 0.0) {
      // plate crystals flash when their face mirrors the sun
      float flash = pow(max(0.5 + 0.5 * sin(uTime * (2.0 + vSeed * 6.0) + vSeed * 80.0), 0.0), 24.0);
      float forward = pow(toSun, 6.0) * 3.0 + 0.15;
      col = uSunRad * (forward + flash * 3.0) + uSkyTint * 0.2;
      a = disc * vFade * (0.18 + 0.7 * flash);
    } else if (uMode == 1.0) {
      col = uSunRad * (0.5 + pow(toSun, 4.0) * 2.0) + uSkyTint * 0.6;
      a = disc * vFade * 0.35;
    } else {
      col = uSunRad * (0.45 + pow(toSun, 5.0) * 2.0) + uSkyTint * 0.8;
      a = disc * vFade * 0.75;
    }
    gl_FragColor = vec4(col * uIntensity, a * uIntensity);
  }
`;

export class Particles {
  constructor({ heightTex, deformTex, count, mode, box, size, intensity = 1 }) {
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seeds[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.uniforms = {
      tHeight: { value: heightTex },
      tDeform: { value: deformTex },
      uHeightExtent: { value: 64 },
      uDeformExtent: { value: 44 },
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(...box) },
      uWind: { value: new THREE.Vector3() },
      uWindTravel: { value: new THREE.Vector3() },
      uMode: { value: mode },
      uSize: { value: size },
      uPixelRatio: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunRad: { value: new THREE.Color() },
      uSkyTint: { value: new THREE.Color() },
      uIntensity: { value: intensity },
      uStreak: { value: 0 },
      uHop: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: mode === 0 ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.mode = mode;
  }

  /** Draw only the first n particles (seeds are random, so any prefix is uniform). */
  setCount(n) { this.points.geometry.setDrawRange(0, Math.max(0, Math.round(n))); }

  update(time, center, windSpeed, sunDir, sunRad, skyTint, pixelRatio) {
    const u = this.uniforms;
    u.uTime.value = time;
    u.uCenter.value.copy(center);
    const w = this.mode === 1 ? windSpeed * 1.6 : windSpeed * 0.35;
    u.uWind.value.set(Math.cos(WIND_ANGLE) * w, 0, Math.sin(WIND_ANGLE) * w);
    // integrate the travel (wrapped: the particle box wraps anyway, this keeps floats small)
    const dt = this.lastTime == null ? 0 : Math.max(0, Math.min(0.1, time - this.lastTime));
    this.lastTime = time;
    u.uWindTravel.value.addScaledVector(u.uWind.value, dt);
    const bx = u.uBox.value;
    u.uWindTravel.value.set(u.uWindTravel.value.x % (bx.x * 1000), 0, u.uWindTravel.value.z % (bx.z * 1000));
    u.uSunDir.value.copy(sunDir);
    u.uSunRad.value.copy(sunRad);
    u.uSkyTint.value.copy(skyTint);
    u.uPixelRatio.value = pixelRatio;
  }
}
