import * as THREE from 'three';
import { SNOW_HEIGHT_GLSL } from './snow.js';
import { WIND_ANGLE } from './terrain.js';

const _f = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _w = new THREE.Vector3();

// Ground blizzard: the snow the wind lifts off the floe, streaming in a knee-high layer
// that swallows feet and legs while the sky can still show above. Thin sheets hug the
// snow surface at rising heights; each scrolls a wind-stretched noise, so together they
// read as a moving, layered haze. They are drawn after the scene (see MsaaScenePass)
// and read its depth: each sheet fades out softly where it meets a body or the snow, so
// no sheet ever draws a hard line across a penguin. When the layer is taller than the
// camera, a screen-space veil of wind streaks fills the view around it (sheets seen
// edge-on would draw a line at eye level), so the lens itself is inside the blizzard.

const VERT = /* glsl */`
  ${SNOW_HEIGHT_GLSL}
  uniform vec3 uCenter;
  uniform float uLayerH;
  varying vec3 vWorld;
  varying float vLayer;
  varying float vViewZ;
  void main() {
    vec3 p = position + vec3(uCenter.x, 0.0, uCenter.z);
    p.y = max(snowMacro(p.xz).r, 0.0) + uLayerH;
    vWorld = p;
    vLayer = uLayerH;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    vViewZ = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  uniform float uTime;
  uniform float uAmount;
  uniform float uDepth;      // layer thickness (m)
  uniform vec2 uWind;        // wind velocity (m/s, xz)
  uniform vec3 uColor;
  uniform float uScroll;     // how far the wind has carried the snow so far (m)
  uniform sampler2D tDepth;  // the scene's depth (drawn after the scene)
  uniform vec2 uRes;         // render target size (px)
  uniform vec2 uClip;        // camera near, far
  varying vec3 vWorld;
  varying float vLayer;
  varying float vViewZ;
  float sceneDepth(vec2 uv) {
    float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
    return 2.0 * uClip.x * uClip.y / (uClip.y + uClip.x - z * (uClip.y - uClip.x));
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    float ws = length(uWind) + 1e-4;
    vec2 along = uWind / ws, across = vec2(-along.y, along.x);
    // streaks: long along the wind, thin across it, racing downwind (lower layers faster)
    vec2 q = vec2(dot(vWorld.xz, along), dot(vWorld.xz, across));
    // accumulated travel (wind × time would lurch back and forth as gusts change the speed)
    q.x -= uScroll * (1.3 - vLayer / max(uDepth, 0.01) * 0.6);
    float n = noise(q * vec2(0.35, 2.2)) * 0.55 + noise(q * vec2(0.9, 5.5) + 7.1) * 0.3 + noise(q * vec2(2.4, 13.0) + 3.7) * 0.15;
    // big slow sheets of thicker blowing snow
    float sheet = smoothstep(0.3, 0.75, noise(q * vec2(0.06, 0.25) + vec2(uTime * 0.05, 0.0)));
    float dens = smoothstep(0.35, 0.95, n) * (0.35 + 0.65 * sheet);
    // thinner with height; never right in front of the lens (the sheets would show)
    float h = vLayer / max(uDepth, 0.01);
    float d = distance(vWorld, cameraPosition);
    float a = dens * (1.0 - h * 0.55) * smoothstep(0.6, 2.2, d) * (1.0 - smoothstep(26.0, 40.0, d));
    // a sheet seen edge-on (near eye level) would draw a line: it gives way to the veil
    float grazing = abs(normalize(vWorld - cameraPosition).y);
    a *= mix(0.12, 1.0, smoothstep(0.02, 0.2, grazing));
    // behind something: hidden; close in front of it: fades out over a few centimetres
    float behind = sceneDepth(gl_FragCoord.xy / uRes) - vViewZ;
    if (behind <= 0.0) discard;
    a *= smoothstep(0.0, 0.25, behind);
    gl_FragColor = vec4(uColor, a * uAmount * 0.8);
  }
`;


const VEIL_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const VEIL_FRAG = /* glsl */`
  uniform float uVeil;        // 0..1
  uniform float uScroll;
  uniform float uTime;
  uniform vec2 uWindScreen;   // wind direction on screen (aspect-corrected)
  uniform float uAcross;      // how much the wind crosses the view (0: blowing at / away from the lens)
  uniform vec3 uColor;
  uniform sampler2D tDepth;
  uniform vec2 uRes;
  uniform vec2 uClip;
  varying vec2 vUv;
  float sceneDepth(vec2 uv) {
    float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
    return 2.0 * uClip.x * uClip.y / (uClip.y + uClip.x - z * (uClip.y - uClip.x));
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    float aspect = uRes.x / uRes.y;
    vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
    vec2 along = uWindScreen, across = vec2(-along.y, along.x);
    vec2 q = vec2(dot(p, along), dot(p, across));
    q.x -= uScroll * 0.06;
    // long thin streaks racing downwind, and broad slow gusts of thicker snow
    float s1 = noise(q * vec2(2.5, 38.0));
    float s2 = noise(q * vec2(5.0, 90.0) + vec2(-uScroll * 0.05, 3.1));
    float streaks = smoothstep(0.45, 0.95, s1 * 0.6 + s2 * 0.4);
    float gust = smoothstep(0.25, 0.8, noise(q * vec2(0.8, 2.2) + vec2(-uScroll * 0.015, uTime * 0.03)));
    // thicker with distance: a penguin two metres away stays readable, the distance goes white
    float dist = sceneDepth(vUv);
    float deep = 1.0 - exp(-max(dist - 2.5, 0.0) * 0.12);
    float a = (0.4 * gust + 0.4 * streaks * mix(0.25, 1.0, uAcross)) * deep * mix(1.0, 0.55, vUv.y);
    gl_FragColor = vec4(uColor, a * uVeil);
  }
`;

export class GroundBlow {
  /** layers: sheet count; size: side of the square around the camera (m). */
  constructor({ heightTex, deformTex, layers = 12, size = 80 }) {
    this.group = new THREE.Group();
    this.step = size / 96; // the sheets move in whole grid steps, so the snow under them never re-samples
    this.group.frustumCulled = false;
    const geo = new THREE.PlaneGeometry(size, size, 96, 96).rotateX(-Math.PI / 2);
    this.shared = {
      tHeight: { value: heightTex },
      tDeform: { value: deformTex },
      uHeightExtent: { value: 64 },
      uDeformExtent: { value: 44 },
      uCenter: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uAmount: { value: 0 },
      uDepth: { value: 0.7 },
      uWind: { value: new THREE.Vector2() },
      uColor: { value: new THREE.Color(0.8, 0.84, 0.9) },
      uScroll: { value: 0 },
      tDepth: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uClip: { value: new THREE.Vector2(0.1, 1000) },
      uVeil: { value: 0 },
      uWindScreen: { value: new THREE.Vector2(1, 0) },
      uAcross: { value: 1 },
    };
    this.scene = new THREE.Scene(); // drawn on its own, after the main scene
    this.scene.add(this.group);
    this.layers = [];
    for (let i = 0; i < layers; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...this.shared, uLayerH: { value: 0 } },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = 3;
      this.group.add(m);
      this.layers.push(m);
    }
    // the veil: one full-screen quad drawn after the sheets
    this.veil = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: this.shared, vertexShader: VEIL_VERT, fragmentShader: VEIL_FRAG,
      transparent: true, depthWrite: false, depthTest: false,
    }));
    this.veil.frustumCulled = false;
    this.veil.renderOrder = 4;
    this.group.add(this.veil);
  }

  /** Wind direction as seen by the camera (call each frame before rendering). */
  setView(camera) {
    const fwd = camera.getWorldDirection(_f);
    const a = _a.copy(camera.position).addScaledVector(fwd, 4);
    const b = _b.copy(a).add(_w.set(Math.cos(WIND_ANGLE), 0, Math.sin(WIND_ANGLE)));
    a.project(camera); b.project(camera);
    const dx = (b.x - a.x) * camera.aspect, dy = b.y - a.y, l = Math.hypot(dx, dy);
    this.shared.uAcross.value = Math.min(1, Math.abs(dx) * 2.5);
    // blowing snow runs level with the ground: keep the streaks close to horizontal on
    // screen (a wind blowing along the view would otherwise turn them into falling rain)
    if (l > 1e-4) {
      const sx = Math.sign(dx || 1) * Math.max(Math.abs(dx) / l, 0.85), sy = (dy / l) * 0.3;
      const k = Math.hypot(sx, sy);
      this.shared.uWindScreen.value.set(sx / k, sy / k);
    }
  }

  /** amount 0..1; depth: layer thickness (m); color: lit snow colour. */
  update(time, center, windSpeed, amount, depth, color, veil = 0) {
    const s = this.shared;
    const dt = this.lastTime == null ? 0 : Math.max(0, Math.min(0.1, time - this.lastTime));
    this.lastTime = time;
    s.uScroll.value = (s.uScroll.value + windSpeed * dt) % 100000;
    s.uTime.value = time;
    s.uCenter.value.set(Math.round(center.x / this.step) * this.step, 0, Math.round(center.z / this.step) * this.step);
    s.uWind.value.set(Math.cos(WIND_ANGLE) * windSpeed, Math.sin(WIND_ANGLE) * windSpeed);
    s.uAmount.value = amount;
    s.uDepth.value = depth;
    s.uColor.value.copy(color);
    s.uVeil.value = veil;
    this.layers.forEach((m, i) => { m.material.uniforms.uLayerH.value = 0.03 + (i / Math.max(1, this.layers.length - 1)) * depth; });
    this.group.visible = amount > 0.005;
  }
}
