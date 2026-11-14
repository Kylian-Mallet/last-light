import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import { buildHeightfield, buildDetailTexture, buildFloeCliff, HEIGHT_EXTENT, WALK_RADIUS, floeRadius, WIND_ANGLE } from './terrain.js';
import { FlyCam } from './flycam.js';
import { SnowDeformer } from './deform.js';
import { buildSnowGrid, buildUniformGrid, createSnowMaterial, TerrainShadowBaker } from './snow.js';
import { createSky, createWater, createDistantIce, sunRadiance, applyWaterTint, WATER_TINTS } from './environment.js';
import { Penguin, PENGUIN_UNIFORMS } from './penguin.js';
import { Fur } from './fur.js';
import { Particles } from './particles.js';
import { SnowSpray } from './spray.js';
import { Soundscape } from './audio.js';
import { PreShader, FinalShader, FrostBaker, DepthTapPass, MsaaScenePass, sunScreen, CHROMATIC_ON } from './post.js';
import { applySkyFog, HorizonProbe } from './fog.js';
import { Colony, locateRidge, PLACES } from './colony.js';
import { Story } from './story.js';
import { Weather } from './weather.js';
import { GroundBlow } from './groundblow.js';
import { fullscreenSupported, isFullscreen, toggleFullscreen, onFullscreenChange } from './fullscreen.js';
import { modelUrl } from './assets.js';
import { DEBUG } from './debug.js';
import { wrapAngle } from './util.js';
import { Hud } from './hud.js';
import { t, translateDom, setLocale, getLocale, onLocaleChange, loadKeyboardLayout, learnKey, keyLabel } from './i18n.js';
import { actionOf, isDown } from './bindings.js';
import { pad, BTN, PAD_ACTIONS, navigate, ensureFocus } from './gamepad.js';
import { Options } from './options.js';
import { PhotoMode, saveCanvas } from './photo.js';
import { Narrator } from './narration.js';

// ---------------------------------------------------------------------------
// Quality presets
const PRESETS = {
  low: { deform: 2048, grid: 384, near: 6, fur: 0, shadow: 1024, water: 256, msaa: 0, pr: 1.0, dust: 1200, drift: 3000, rays: false, minScale: 0.5 },
  medium: { deform: 2048, grid: 512, near: 7, fur: 6, shadow: 2048, water: 384, msaa: 2, pr: 1.25, dust: 2500, drift: 7000, rays: true, minScale: 0.6 },
  high: { deform: 4096, grid: 640, near: 8, fur: 10, shadow: 2048, water: 512, msaa: 4, pr: 1.5, dust: 4000, drift: 10000, rays: true, minScale: 0.65 },
  ultra: { deform: 4096, grid: 768, near: 9, fur: 16, shadow: 4096, water: 768, msaa: 4, pr: 2.0, dust: 5000, drift: 14000, rays: true, minScale: 0.75 },
};
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
const url = new URLSearchParams(location.search);
const storedQ = localStorageGet('pingu.quality');
let qualityName = PRESETS[url.get('quality')] ? url.get('quality') : PRESETS[storedQ] ? storedQ : 'high';
const Q = { ...PRESETS[qualityName] }; // mutated in place by applyQuality()

const params = {
  quality: qualityName,
  sunElevation: 3.2,
  sunAzimuth: 128,
  exposure: 0.5,
  autoExposure: true,
  sunIntensity: 7.0,
  clouds: 0.32,
  sunPillar: 1.0,
  wind: 1.6,
  diamondDust: true,
  spindrift: true,
  snowfall: false,
  sparkle: 0.5, // the crystal glints, kept discreet
  snowSoftness: 1.25,
  refill: 0.004,
  fur: Q.fur > 0,
  autopilot: false,
  cinematic: false,
  bloom: 1.05,
  autoBloom: true, // bloom follows the sun (height and whether it is in front of the lens)
  godRays: Q.rays,
  lensFlare: true,
  fisheye: 0.03,
  chromatic: CHROMATIC_ON,
  frost: 0.38,
  dof: qualityName !== 'low',
  aperture: 1.8, // a shallow depth of field in play
  sound: true,
  dynamicRes: true,
  renderScale: 1.0,
};
const STORY = !url.has('free');
const TIME_SCALE = DEBUG && url.has('speed') ? parseFloat(url.get('speed')) : 1; // test harness only
if (DEBUG) document.body.classList.add('debug'); // tuning panel + fps (?debug only; F2 hides / shows them)
if (url.has('elev')) params.sunElevation = parseFloat(url.get('elev'));
if (url.has('az')) params.sunAzimuth = parseFloat(url.get('az'));

// ---------------------------------------------------------------------------
// Renderer
const canvas = document.getElementById('scene');
// No default framebuffer AA/depth/stencil/alpha: the scene is drawn into the composer's
// MSAA float target, the canvas only receives the final full-screen pass.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: url.has('capture'),
});
renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in the final pass
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
let basePR = Math.min(window.devicePixelRatio, Q.pr);
let dynScale = 1;
// Canvas resolution is fixed (resizing a canvas clears it → black frame). Dynamic
// resolution only scales the internal render targets; the final pass upsamples.
const canvasPR = () => basePR * params.renderScale;
const effectivePR = () => canvasPR() * dynScale;
renderer.setPixelRatio(canvasPR());
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.03, 4200);

// ---------------------------------------------------------------------------
// World
const progressEl = document.getElementById('progress');
const loadbar = document.querySelector('.loadbar');
const setProgress = (text, p) => {
  if (progressEl) progressEl.textContent = text;
  if (p != null) loadbar?.style.setProperty('--p', String(p));
};
setProgress(t('loading'));

const heightfield = buildHeightfield();
const detailTex = buildDetailTexture(renderer);
const deformer = new SnowDeformer(renderer, Q.deform);
const baker = new TerrainShadowBaker(renderer, heightfield.texture, 1024);

const sky = createSky();
scene.add(sky);
const envSky = createSky();
envSky.material = sky.material;
envSky.scale.setScalar(80);
const envScene = new THREE.Scene();
envScene.add(envSky);
// sunlit snow below the horizon: the dominant fill light for anything standing on it
const envGroundMat = new THREE.MeshBasicMaterial({ color: 0x888888, side: THREE.DoubleSide });
const envGround = new THREE.Mesh(new THREE.CircleGeometry(60, 48).rotateX(-Math.PI / 2), envGroundMat);
envGround.position.y = -1.2;
envScene.add(envGround);
const pmrem = new THREE.PMREMGenerator(renderer);
const horizonProbe = new HorizonProbe(renderer);
let envRT = null;

const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.castShadow = true;
sun.shadow.mapSize.set(Q.shadow, Q.shadow);
sun.shadow.camera.left = -0.75; sun.shadow.camera.right = 0.75;
sun.shadow.camera.top = 0.75; sun.shadow.camera.bottom = -0.75;
sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 90;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.004;
sun.shadow.radius = 3;
scene.add(sun, sun.target);

// Snow surface = stable uniform grid around the chick (carries footprint geometry)
// + a warped far grid out to the floe edge (macro relief only, prints shaded per pixel).
let nearGrid = buildUniformGrid(Q.grid, Q.near);
const snowMat = createSnowMaterial({ heightTex: heightfield.texture, deformTex: deformer.texture, detailTex, deformSize: deformer.size });
snowMat.userData.uniforms.tTerrainShadow.value = baker.texture;
snowMat.userData.uniforms.uNear.value.z = nearGrid.half;
const snowFarMat = createSnowMaterial({ heightTex: heightfield.texture, deformTex: deformer.texture, detailTex, deformSize: deformer.size, far: true, shared: snowMat.userData.uniforms });
const farGrid = buildSnowGrid(320, 46, 0.03);
const snowNear = new THREE.Mesh(nearGrid.geometry, snowMat);
const snowFar = new THREE.Mesh(farGrid.geometry, snowFarMat);
for (const m of [snowNear, snowFar]) { m.frustumCulled = false; m.receiveShadow = true; scene.add(m); }
const snow = { set visible(v) { snowNear.visible = v; snowFar.visible = v; } };

// Cheap stand-in for the floe surface in the water reflection (the full snow shader
// would otherwise be rendered a second time every frame).
const proxyGeo = new THREE.PlaneGeometry(HEIGHT_EXTENT, HEIGHT_EXTENT, 160, 160).rotateX(-Math.PI / 2);
{
  const p = proxyGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, heightfield.sdfAt(x, z) > 0 ? heightfield.heightAt(x, z) : -2);
  }
  proxyGeo.computeVertexNormals();
}
const reflProxy = new THREE.Mesh(proxyGeo, new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.85 }));
reflProxy.visible = false;
scene.add(reflProxy);

const cliff = buildFloeCliff(heightfield);
scene.add(cliff);

const sunDir = new THREE.Vector3();
const water = createWater(sunDir, Q.water, heightfield.texture, HEIGHT_EXTENT);
applyWaterTint(water, 'ink'); // deep navy, the sunset only as a muted sheen
scene.add(water);
const distantIce = createDistantIce();
scene.add(distantIce);
// everything seen at a distance fades to the sky's own horizon colour
const fogged = new Set([snowMat, snowFarMat, cliff.material, water.material, reflProxy.material]);
distantIce.traverse((o) => { if (o.isMesh && !o.material.isShaderMaterial) fogged.add(o.material); });
fogged.forEach(applySkyFog);

scene.fog = new THREE.FogExp2(0x9c8fa6, 0.0011);

// allocated for the richest preset; quality only changes how many are drawn
const dust = new Particles({ heightTex: heightfield.texture, deformTex: deformer.texture, count: Math.round(PRESETS.ultra.dust * 0.6), mode: 0, box: [16, 7, 16], size: 2.0, intensity: 0.5 });
const drift = new Particles({ heightTex: heightfield.texture, deformTex: deformer.texture, count: PRESETS.ultra.drift, mode: 1, box: [22, 3, 22], size: 1.6, intensity: 0.7 });
const fall = new Particles({ heightTex: heightfield.texture, deformTex: deformer.texture, count: Math.round(PRESETS.ultra.drift * 0.7), mode: 2, box: [26, 14, 26], size: 5, intensity: 0.9 });
const spray = new SnowSpray();
scene.add(dust.points, drift.points, fall.points, spray.points);
let flakeAmount = 1; // storm style: more or fewer falling flakes
function applyParticleCounts() { dust.setCount(Q.dust * 0.4); drift.setCount(Q.drift); fall.setCount(Math.min(PRESETS.ultra.drift * 0.7, Q.drift * 0.7 * flakeAmount)); }
// knee-high blowing snow (storm styles)
const groundBlow = new GroundBlow({ heightTex: heightfield.texture, deformTex: deformer.texture });
let driftMul = 1;
applyParticleCounts();
const transient = [dust.points, drift.points, fall.points, spray.points];

let fur = null;
// water reflection: swap in the proxy, skip particles and fur shells
const waterBefore = water.onBeforeRender;
water.onBeforeRender = function (...args) {
  snow.visible = false;
  reflProxy.visible = true;
  const vis = transient.map((o) => o.visible);
  transient.forEach((o) => (o.visible = false));
  const furVis = fur ? fur.shells.map((s) => s.visible) : null;
  if (fur) fur.shells.forEach((s) => (s.visible = false));
  const npcFurVis = colony ? colony.furs.map((f) => f.mesh.visible) : null;
  if (colony) colony.furs.forEach((f) => (f.mesh.visible = false));
  // the chick can only appear in the reflection when it stands near the floe edge
  const pp = penguin.root.position;
  const penguinVis = penguin.root.visible;
  if (heightfield.sdfAt(pp.x, pp.z) > 3.5) penguin.root.visible = false;
  waterBefore.apply(this, args);
  penguin.root.visible = penguinVis;
  snow.visible = true;
  reflProxy.visible = false;
  transient.forEach((o, i) => (o.visible = vis[i]));
  if (fur) fur.shells.forEach((s, i) => (s.visible = furVis[i]));
  if (colony) colony.furs.forEach((f, i) => (f.mesh.visible = npcFurVis[i]));
};

// ---------------------------------------------------------------------------
// Penguin
const penguin = new Penguin();
scene.add(penguin.root);
penguin.root.position.set(0, heightfield.heightAt(0, 0), 0);
const sound = new Soundscape();
let narrator = null; // created with the story (the hud must exist)

const bounds = (x, z) => heightfield.sdfAt(x, z) > 2.0 && Math.hypot(x, z) < WALK_RADIUS;
const groundAt = (x, z) => heightfield.heightAt(x, z);
const lastFoot = { L: null, R: null };
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
penguin.onFootPlant = (side, pos, heading, speed) => {
  const soft = params.snowSoftness;
  const sliding = penguin.slide > 0.5;
  const depth = (0.02 + Math.random() * 0.008) * soft * (sliding ? 0.8 : 0.8 + 0.4 * Math.min(1, speed / 0.3));
  deformer.stamp('foot', pos.x, pos.z, heading, { depth, rim: 0.005 * soft, halfW: 0.05, halfL: 0.055 });
  // chicks shuffle: the toes often drag a furrow between prints
  const prev = lastFoot[side];
  if (!sliding && prev && Math.random() < 0.55) {
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const ax = prev.x + fx * 0.04, az = prev.z + fz * 0.04;
    const bx = pos.x - fx * 0.02, bz = pos.z - fz * 0.02;
    const len = Math.hypot(bx - ax, bz - az);
    if (len > 0.02 && len < 0.3) {
      deformer.stamp('drag', (ax + bx) / 2, (az + bz) / 2, Math.atan2(bx - ax, bz - az), { depth: 0.005 * soft, rim: 0.0014 * soft, halfW: 0.012, halfL: len / 2 });
    }
  }
  lastFoot[side] = pos.clone();
  // powder puff thrown forward by the step
  const g = groundAt(pos.x, pos.z);
  spray.emit(_a.set(pos.x, g, pos.z), _b.set(Math.sin(heading) * 0.5, 0, Math.cos(heading) * 0.5), Math.round(6 * soft), { speed: 0.35 + speed, spread: 0.7, up: 0.5, size: 0.005, life: 0.6 });
  const d = camera.position.distanceTo(pos);
  sound.crunch(1 / (1 + d * d * 0.25), 1 - Math.min(1, soft / 2), pos);
  if (!sliding) pad.rumble(0, 0.06 + 0.08 * Math.min(1, speed / 1.2), 35); // each step, lightly
};
penguin.onKick = (side) => penguin.plant(side);
penguin.onBelly = (pos, heading) => {
  const soft = params.snowSoftness;
  deformer.stamp('belly', pos.x, pos.z, heading, { depth: 0.05 * soft, rim: 0.014 * soft, halfW: 0.11, halfL: 0.1 });
  // bow wave of powder off both sides of the belly
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const g = groundAt(pos.x, pos.z);
  for (const s of [-1, 1]) {
    spray.emit(
      _a.set(pos.x + fz * 0.1 * s + fx * 0.08, g, pos.z - fx * 0.1 * s + fz * 0.08),
      _b.set(fz * s * 0.8 + fx * 0.4, 0, -fx * s * 0.8 + fz * 0.4),
      Math.round(4 * soft * penguin.speed + 1),
      { speed: 0.3 + penguin.speed * 0.8, spread: 0.4, up: 0.45, size: 0.006, life: 0.7 },
    );
  }
  if (Math.random() < 0.3) sound.crunch(0.25 / (1 + camera.position.distanceTo(pos) ** 2 * 0.25), 0.9, pos.clone());
};

// ---------------------------------------------------------------------------
// Camera
const controls = new OrbitControls(camera, renderer.domElement);
const flyCam = new FlyCam(camera, renderer.domElement); // map review (?free): toggles itself
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.35;
controls.maxDistance = 45;
controls.maxPolarAngle = Math.PI * 0.495;
controls.autoRotateSpeed = 0.35;
const camTarget = new THREE.Vector3();

// Mouse look: in play the pointer is captured, so moving the mouse turns the camera
// without holding a button. The cursor comes back for the pause menu, the options,
// photo mode, the title and the end card; a click or any key in play captures it again.
const MOUSE_KEY = 'pingu.mouse';
const mouse = { lock: true, sens: 1, photoSens: 1, invertX: false, invertY: false };
try { Object.assign(mouse, JSON.parse(localStorageGet(MOUSE_KEY) || '{}')); } catch { /* malformed */ }
flyCam.mouse = mouse; // photo mode reads its own sensitivity
flyCam.allowToggle = !STORY || DEBUG; // the free camera (V) is for map review and debugging
// the free camera stays above the snow (and 40 cm above the sea)
flyCam.ground = (x, z) => Math.max(0.1, heightfield.sdfAt(x, z) > -0.5 ? heightfield.heightAt(x, z) : 0);
let releasingPointer = false, lockLostAt = -1e9, endCard = null;
function wantPointerLock() {
  return STORY && mouse.lock && document.body.classList.contains('started') && !titleMode && !paused && !photoMode
    && !document.querySelector('.options.on') && !(endCard ??= document.querySelector('.hud-end'))?.classList.contains('on');
}
function lockPointer() {
  if (!wantPointerLock() || document.pointerLockElement) return;
  try { renderer.domElement.requestPointerLock()?.catch?.(() => { /* needs a fresh gesture */ }); } catch { /* unsupported */ }
}
function releasePointer() {
  if (!document.pointerLockElement) return;
  releasingPointer = true;
  document.exitPointerLock();
}
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  document.body.classList.toggle('mouse-locked', locked);
  // the browser gave the cursor back by itself (Esc, switching window): that is a pause
  if (!locked && !releasingPointer && wantPointerLock()) { lockLostAt = performance.now(); setPaused(true); }
  if (!locked) releasingPointer = false;
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement || !controls.enabled || photoMode) return;
  const k = 0.0024 * mouse.sens;
  lookBy(e.movementX * k, e.movementY * k);
});
/** Turn the play camera (radians; + = right / down), honouring the inverted axes. */
function lookBy(dx, dy) {
  controls.rotateLeft(dx * (mouse.invertX ? -1 : 1)); // + turns the view right
  controls.rotateUp(dy * (mouse.invertY ? -1 : 1)); // mouse up looks up
}
renderer.domElement.addEventListener('pointerdown', () => lockPointer());
// default gameplay framing (orbit distance / height above the chick)
const PLAY_DIST = 2.9, PLAY_HEIGHT = 0.95;
function placeCameraInitial() {
  const p = penguin.root.position;
  camTarget.set(p.x, p.y + 0.2, p.z);
  controls.target.copy(camTarget);
  // low three-quarter view with the sun raking from the side-back
  const az = THREE.MathUtils.degToRad(params.sunAzimuth) + Math.PI * 0.62;
  camera.position.set(p.x + Math.sin(az) * PLAY_DIST, p.y + PLAY_HEIGHT, p.z + Math.cos(az) * PLAY_DIST);
  controls.update();
}

// ---------------------------------------------------------------------------
// Post-processing: render (MSAA HDR, sanitised once) → pre (light shafts) → bloom → final
// (flare, ACES, sRGB, lens distortion, chromatic aberration, frost, vignette, grain)
// the scene alone is multisampled (MsaaScenePass); the post passes run on plain HDR buffers
const composerRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, stencilBuffer: false, depthBuffer: false });
const composer = new EffectComposer(renderer, composerRT);
const scenePass = new MsaaScenePass(scene, camera, Q.msaa);
composer.addPass(scenePass);
// the blowing snow is drawn after the scene, fading softly against its depth
scenePass.overlay = groundBlow.scene;
scenePass.onOverlay = (target, out) => {
  groundBlow.setView(camera);
  const u = groundBlow.shared;
  u.tDepth.value = target.depthTexture;
  u.uRes.value.set(out.width, out.height);
  u.uClip.value.set(camera.near, camera.far);
};
const prePass = new ShaderPass(PreShader);
composer.addPass(prePass);
// the scene pass hands over a clean HDR image (no NaN / Inf, capped), so bloom needs no guard
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), params.bloom, 0.45, 3.5);
composer.addPass(bloom);
const finalPass = new ShaderPass(FinalShader);
{ const tap = new DepthTapPass(finalPass.uniforms.tDepth); tap.source = scenePass; composer.insertPass(tap, 1); }
composer.addPass(finalPass);
finalPass.uniforms.uClip.value.set(camera.near, camera.far);
const frostBaker = new FrostBaker(renderer);
finalPass.uniforms.tFrost.value = frostBaker.texture;

function resizeInternal() {
  composer.setPixelRatio(effectivePR());
  composer.setSize(window.innerWidth, window.innerHeight);
  // the last pass draws to the canvas: keep its viewport at full canvas size
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(canvasPR());
  renderer.setSize(w, h);
  resizeInternal();
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  finalPass.uniforms.uRes.value.set(w, h);
  finalPass.uniforms.uAspect.value = w / h;
  prePass.uniforms.uAspect.value = w / h;
  frostBaker.bake(renderer.domElement.width, renderer.domElement.height);
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Experience systems
const weather = new Weather();
const hud = new Hud();
translateDom();
onLocaleChange(() => translateDom());
loadKeyboardLayout().then(() => hud.relabel());
let colony = null;
let story = null;

// ---------------------------------------------------------------------------
// Sun / atmosphere
const sunRad = new THREE.Color();
const skyTint = new THREE.Color();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
let envDirty = true;
const stormFog = new THREE.Color(0.62, 0.66, 0.74);
function updateSun(full = true) {
  const W = STORY ? weather.state : null;
  const el = THREE.MathUtils.degToRad(params.sunElevation);
  const az = THREE.MathUtils.degToRad(params.sunAzimuth);
  sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
  sky.material.uniforms.sunPosition.value.copy(sunDir).multiplyScalar(10000);
  sky.material.uniforms.cloudCoverage.value = W ? W.clouds : params.clouds;
  sky.material.uniforms.uOvercast.value = W ? W.overcast : 0;
  sky.material.uniforms.uPillar.value = params.sunPillar;
  const rad = sunRadiance(params.sunElevation);
  const sunMul = W ? W.sunMul : 1;
  // bloom by sun height: a low sun glows (1.05 up to 4°), daylight is crisp (0.4 from 12°)
  if (params.autoBloom) bloomSunset = bloomForElevation(params.sunElevation);
  sunRad.copy(rad).multiplyScalar(params.sunIntensity * sunMul);
  sun.color.copy(rad);
  sun.intensity = params.sunIntensity * sunMul;
  water.material.uniforms.sunDirection.value.copy(sunDir);
  water.material.uniforms.sunColor.value.copy(rad).multiplyScalar(1.4 * sunMul);
  // skylight colour for SSS / glints: deep blue-violet at dusk
  const dusk = THREE.MathUtils.smoothstep(params.sunElevation, -2, 18);
  skyTint.setRGB(0.18 + 0.15 * dusk, 0.22 + 0.25 * dusk, 0.42 + 0.35 * dusk);
  const su = snowMat.userData.uniforms;
  su.uSunDir.value.copy(sunDir);
  su.uSunRadiance.value.copy(sunRad);
  su.uSkyTint.value.copy(skyTint);
  // haze colour sits between the warm sunward horizon and the violet anti-sun sky
  scene.fog.color.setRGB(0.42 + 0.2 * dusk, 0.36 + 0.3 * dusk, 0.44 + 0.38 * dusk).multiplyScalar(0.55);
  {
    // submerged ice and foam are lit by what is left of the sun plus the sky
    const sunL = Math.max(sunRad.r, sunRad.g, sunRad.b), skyL = (skyTint.r + skyTint.g + skyTint.b) / 3;
    const wu = water.material.uniforms;
    wu.uShelfColor.value.copy(water.userData.shelfBase ?? _c.setRGB(0.1, 0.58, 0.62)).multiplyScalar(sunL * 0.04 + skyL * 0.45);
    wu.uFoamColor.value.copy(skyTint).multiplyScalar(0.9).add(_c.copy(sunRad).multiplyScalar(0.07));
    distantIce.userData.ledgeMaterial.uniforms.uColor.value.copy(wu.uShelfColor.value);
    distantIce.userData.ledgeMaterial.uniforms.fogColor.value.copy(scene.fog.color);
    distantIce.userData.ledgeMaterial.uniforms.fogDensity.value = scene.fog.density;
  }
  if (W) {
    // whiteout: fog and sky converge on the same luminous blue-grey
    scene.fog.color.lerp(stormFog, W.overcast);
    scene.fog.density = W.fog;
    sky.material.uniforms.uOvercastColor.value.copy(stormFog).multiplyScalar(0.9);
    skyTint.lerp(_c.setRGB(0.42, 0.46, 0.55), W.overcast);
  }
  penguin.sunRadUniform.value.copy(sunRad);
  // snow radiance seen from above: albedo × (sun·sinE / π + sky)
  envGroundMat.color.copy(sunRad).multiplyScalar(0.92 * Math.max(Math.sin(el), 0.02) / Math.PI).add(_c.copy(skyTint).multiplyScalar(0.55));
  prePass.uniforms.uSunColor.value.copy(rad);
  finalPass.uniforms.uSunColor.value.copy(rad);
  if (full) { baker.bake(sunDir); envDirty = true; bakedThisFrame = true; }
}

/**
 * Bloom follows the light, set every frame. The sun's height gives the strength with the
 * sun in front of the lens (4° → 1.05, 8° → 0.8, 12° and up → 0.4); with
 * the sun behind you it is the daylight 0.4 (crisp snow, no halo round every glint).
 */
const BLOOM_DAY = 0.4;
const BLOOM_CURVE = [[4, 1.05], [8, 0.8], [12, 0.4]];
function bloomForElevation(e) {
  if (e <= BLOOM_CURVE[0][0]) return BLOOM_CURVE[0][1];
  for (let i = 1; i < BLOOM_CURVE.length; i++) {
    const [e1, b1] = BLOOM_CURVE[i], [e0, b0] = BLOOM_CURVE[i - 1];
    if (e <= e1) return b0 + (b1 - b0) * (e - e0) / (e1 - e0);
  }
  return BLOOM_CURVE[BLOOM_CURVE.length - 1][1];
}
let bloomSunset = 1.05;
const _bf = new THREE.Vector3();
function updateBloom(dt) {
  if (!params.autoBloom) return;
  camera.getWorldDirection(_bf);
  const fl = Math.hypot(_bf.x, _bf.z) || 1, sl = Math.hypot(sunDir.x, sunDir.z) || 1;
  const facing = THREE.MathUtils.smoothstep((_bf.x * sunDir.x + _bf.z * sunDir.z) / (fl * sl), -0.1, 0.75);
  const goal = THREE.MathUtils.lerp(BLOOM_DAY, bloomSunset, facing);
  params.bloom += (goal - params.bloom) * (1 - Math.exp(-dt * 2.5));
  bloom.strength = params.bloom;
}
// Story-driven sun path: eased toward a target, full relight at most every 1.5 s.
const sunGoal = { elev: params.sunElevation, az: params.sunAzimuth };
let sunRelightTimer = 0, lastEnvOvercast = 0;
function setSun(elev, az, immediate = false) {
  sunGoal.elev = elev; sunGoal.az = az;
  if (immediate) { params.sunElevation = elev; params.sunAzimuth = az; updateSun(true); }
}
function stepSun(dt) {
  const de = sunGoal.elev - params.sunElevation, da = sunGoal.az - params.sunAzimuth;
  sunRelightTimer -= dt;
  if ((Math.abs(de) > 0.01 || Math.abs(da) > 0.05) && sunRelightTimer <= 0) {
    params.sunElevation += Math.sign(de) * Math.min(Math.abs(de), 0.04 * 1.5);
    params.sunAzimuth += Math.sign(da) * Math.min(Math.abs(da), 0.6 * 1.5);
    sunRelightTimer = 1.5;
    updateSun(true);
  } else if (STORY) {
    updateSun(false);
    // overcast changes the whole sky dome: refresh image-based lighting now and then
    if (Math.abs(weather.state.overcast - lastEnvOvercast) > 0.06 && sunRelightTimer <= 0) {
      lastEnvOvercast = weather.state.overcast; envDirty = true; sunRelightTimer = 1.5;
    }
  }
}
const moltTexture = new THREE.TextureLoader().load('models/penguin_molt.jpg', (tx) => { tx.flipY = false; tx.colorSpace = THREE.SRGBColorSpace; tx.anisotropy = 8; tx.needsUpdate = true; });
function setMolt(on) {
  if (!on || !penguin.body) return;
  penguin.body.material.map = moltTexture;
  penguin.body.material.needsUpdate = true;
  if (fur) { fur.mesh.material.map = moltTexture; fur.mesh.material.needsUpdate = true; }
}
let bakedThisFrame = false;
function updateEnv() {
  // never relight the terrain bake and the image-based lighting in the same frame
  if (bakedThisFrame) { bakedThisFrame = false; return; }
  if (!envDirty) return;
  envDirty = false;
  const prev = envRT;
  // 64 px faces are plenty for snow and plumage (rough surfaces) and 16x cheaper than the default
  envGround.visible = false;
  horizonProbe.update(envScene, sky.material.uniforms.showSunDisc);
  envGround.visible = true;
  envRT = pmrem.fromScene(envScene, 0, 0.1, 200, { size: 64 });
  scene.environment = envRT.texture;
  prev?.dispose();
}
updateSun();

// ---------------------------------------------------------------------------
// Input: keyboard uses physical keys (ZQSD on AZERTY = WASD on QWERTY), gamepad, autopilot
const keys = new Set();
let photoMode = false;
let gui = null;
const refreshGui = () => gui?.controllersRecursive().forEach((c) => c.updateDisplay());
// Keyboard: everything goes through the bindings (physical keys, rebindable).
const MOVE_ACTIONS = ['forward', 'back', 'left', 'right', 'slide'];
// a lost player: a few presses that do nothing in a row bring the key list back
const lost = { n: 0, t: 0 };
function uselessPress() {
  const now = performance.now();
  lost.n = now - lost.t < 3000 ? lost.n + 1 : 1;
  lost.t = now;
  if (lost.n >= 3 && document.body.classList.contains('started')) { lost.n = 0; hud.flashHints(); }
}
/**
 * A game action was pressed, from the keyboard or the pad. Returns whether it did
 * anything (a lost player pressing keys that do nothing gets the key list back).
 */
function actionPress(action) {
  let useful = true;
  // the skip button held through a cinematic must not turn into a belly slide once it is
  // over: the slide stays off until it has been let go
  if (STORY && story && action === 'slide' && story.cine.active) {
    slideLatch = true;
    story.onSkip(true);
    return true;
  }
  if (STORY && story) {
    if (action === 'call' || action === 'interact') hud.pressed(action);
    if (action === 'call') { story.onCall(); useful = story.control; if (useful) pad.rumble(0.08, 0.3, 120); }
    if (action === 'interact') { story.onInteract(true); useful = !!story.prompt; }
    if (action === 'objective') hud.recallObjective();
  }
  if ((MOVE_ACTIONS.includes(action) || action === 'hurry') && params.autopilot) { params.autopilot = false; refreshGui(); }
  if (action === 'hideUI') document.body.classList.toggle('hide-ui');
  if (action === 'photo') togglePhotoMode();
  if (action === 'interact' && !STORY) { sound.call(camera.position.distanceTo(penguin.root.position), { at: penguin.root, self: true }); penguin.chirp(); }
  return useful;
}
/** A game action was let go. */
function actionRelease(action) {
  if (action === 'slide') slideLatch = false;
  if (STORY && story) {
    if (action === 'interact') story.onInteract(false);
    if (action === 'slide') story.onSkip(false);
  }
}
window.addEventListener('keydown', (e) => {
  if (e.target.closest && (e.target.closest('.lil-gui') || e.target.closest('.options'))) return;
  if (e.code !== 'Escape') lockPointer();
  if (learnKey(e)) hud.relabel(); // the player's layout shows in prompts and hints
  const action = actionOf(e.code);
  if (action === 'slide' || action === 'objective' || e.code.startsWith('Arrow')) e.preventDefault();
  if (STORY && story && action === 'slide' && story.cine.active) {
    if (!e.repeat) actionPress('slide');
    return;
  }
  keys.add(e.code);
  let useful = !!action || e.code === 'Escape' || (e.code === 'KeyV' && flyCam.allowToggle) || (DEBUG && e.code === 'F2');
  if (action && !e.repeat) useful = actionPress(action);
  if (e.code === 'KeyP' && !STORY) { params.autopilot = !params.autopilot; refreshGui(); useful = true; }
  if (e.code === 'KeyC' && !STORY) { params.cinematic = !params.cinematic; refreshGui(); useful = true; }
  if (DEBUG && e.code === 'F2') { e.preventDefault(); document.body.classList.toggle('debug'); }
  if (!useful && !e.repeat) uselessPress();
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  actionRelease(actionOf(e.code));
});
window.addEventListener('blur', () => keys.clear());

// Free camera helpers (photo mode / map review) ---------------------------------
/** Penguin bodies as vertical cylinders: { x, z, y0, h, r }. */
function penguinBodies() {
  const out = [];
  const add = (p) => { if (p.root.visible) out.push({ x: p.root.position.x, z: p.root.position.z, y0: p.root.position.y, h: 0.45 * p.size, r: p.bodyRadius ?? 0.14 * p.size }); };
  add(penguin);
  colony?.agents.forEach((a) => { if (!a.gone) add(a.p); });
  return out;
}
let bergCyl = null;
/** Distant bergs as cylinders (built once from the scene). */
function bergs() {
  if (bergCyl) return bergCyl;
  bergCyl = [];
  distantIce.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    const r = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.5 * o.scale.x * 0.92;
    bergCyl.push({ x: o.position.x, z: o.position.z, r, top: bb.max.y * o.scale.y + o.position.y });
  });
  return bergCyl;
}
/** The free camera never ends up inside a penguin, a berg, the snow or the sea. */
function keepCameraClear(p) {
  for (const b of penguinBodies()) {
    if (p.y > b.y0 + b.h * 1.08 + 0.06) continue;
    const dx = p.x - b.x, dz = p.z - b.z, d = Math.hypot(dx, dz), min = b.r + 0.12;
    if (d < min) { const k = d > 1e-4 ? min / d : 0; p.x = b.x + (d > 1e-4 ? dx * k : min); p.z = b.z + dz * k; }
  }
  for (const b of bergs()) {
    if (p.y > b.top + 0.6) continue;
    const dx = p.x - b.x, dz = p.z - b.z, d = Math.hypot(dx, dz), min = b.r + 0.6;
    if (d < min) { const k = min / Math.max(d, 1e-4); p.x = b.x + dx * k; p.z = b.z + dz * k; }
  }
  // soft bounds: the camera stays within 35 m of the floe's centre (~23 m radius) and
  // under 14 m. Past 30 m / 11 m each outward step shrinks as the wall nears, so the
  // camera eases to a stop instead of hitting it (and never creeps back on its own).
  const R = 35, RS = 30, H = 14, HS = 11;
  const last = keepCameraClear.last;
  let r = Math.hypot(p.x, p.z);
  if (last && r > RS && r > last.r) {
    const nr = last.r + (r - last.r) * THREE.MathUtils.clamp((R - last.r) / (R - RS), 0, 1);
    p.x *= nr / r; p.z *= nr / r; r = nr;
  }
  if (r > R) { p.x *= R / r; p.z *= R / r; r = R; }
  if (last && p.y > HS && p.y > last.y) p.y = last.y + (p.y - last.y) * THREE.MathUtils.clamp((H - last.y) / (H - HS), 0, 1);
  if (p.y > H) p.y = H;
  const onFloe = heightfield.sdfAt(p.x, p.z) > -0.3;
  const floor = onFloe ? heightfield.heightAt(p.x, p.z) + 0.12 : 0.55; // floes drift off the main floe
  if (p.y < floor) p.y = floor;
  const mem = keepCameraClear.last ??= { r: 0, y: 0 };
  mem.r = r; mem.y = p.y;
}
/** Autofocus: distance to whatever sits at the centre of the frame. */
const _af = new THREE.Vector3(), _afd = new THREE.Vector3();
function centreDepth() {
  camera.getWorldDirection(_afd);
  const bodies = penguinBodies();
  let t = 0.15;
  while (t < 90) {
    _af.copy(camera.position).addScaledVector(_afd, t);
    for (const b of bodies) {
      if (_af.y < b.y0 - 0.02 || _af.y > b.y0 + b.h) continue;
      if (Math.hypot(_af.x - b.x, _af.z - b.z) < b.r * 0.9) return t;
    }
    const g = heightfield.sdfAt(_af.x, _af.z) > -0.3 ? heightfield.heightAt(_af.x, _af.z) : 0.02;
    if (_af.y < g) return t;
    t += Math.max(0.03, t * 0.04);
  }
  return 90;
}
/** Where the detailed snow and the sun's shadow map gather: the chick, or in a free
 *  camera the ground the camera looks at (otherwise far snow looks coarse and penguins
 *  away from the chick lose their shadows). */
const _vf = new THREE.Vector3();
function viewFocus(pp) {
  if (!flyCam.active) return _vf.copy(pp);
  camera.getWorldDirection(_afd);
  const flat = Math.hypot(_afd.x, _afd.z) || 1;
  const ahead = THREE.MathUtils.clamp(camera.position.y * 2.5, 2.5, 9);
  _vf.set(camera.position.x + (_afd.x / flat) * ahead, 0, camera.position.z + (_afd.z / flat) * ahead);
  _vf.y = heightfield.heightAt(_vf.x, _vf.z);
  return _vf;
}

// Photo mode: the moment freezes, the camera flies free with a simple camera body.
// Photo mode previews at a reduced internal resolution (smooth while framing); the
// shutter re-renders the frozen frame at full definition, supersampled up to ~4K, behind
// a "developing" veil with a progress bar, then saves it and drops back to the preview.
const PHOTO_PREVIEW = 0.65;
let shadowKey = ''; // photo mode: last shadow frame drawn
const capture = { stage: 0, frames: 0, saved: null };
const developEl = document.createElement('div');
developEl.className = 'photo-develop';
developEl.innerHTML = '<img class="ph-dev-print" alt=""><span class="ph-dev-label"></span><span class="ph-dev-bar"><i></i></span>';
document.body.appendChild(developEl);
const developBar = developEl.querySelector('i'), developLabel = developEl.querySelector('.ph-dev-label'), developPrint = developEl.querySelector('img');
/**
 * The bar never stalls: each phase has an expected duration and the bar eases toward the
 * phase's end along it (rendering a few frames, then encoding the PNG, which is the long,
 * opaque part: its length is estimated from the pixel count). It snaps to full when done.
 */
const develop = { shown: 0, from: 0, to: 0, t0: 0, dur: 1, timer: 0 };
function developPhase(from, to, seconds) {
  Object.assign(develop, { from: Math.max(from, develop.shown), to, t0: performance.now(), dur: Math.max(0.05, seconds) });
}
function developTick() {
  const k = (performance.now() - develop.t0) / 1000 / develop.dur;
  // eases out and keeps creeping a little past the estimate rather than freezing
  const e = 1 - Math.exp(-2.6 * k);
  develop.shown = Math.max(develop.shown, develop.from + (develop.to - develop.from) * e);
  developBar.style.transform = `scaleX(${Math.min(1, develop.shown)})`;
}
function startCapture() {
  if (capture.stage) return;
  sound.shutter?.();
  pad.rumble(0.15, 0.4, 60);
  developLabel.textContent = t('ph.develop');
  developEl.classList.remove('printed');
  develop.shown = 0;
  developPhase(0, 0.12, 0.15);
  clearInterval(develop.timer);
  develop.timer = setInterval(developTick, 30);
  developEl.classList.add('on');
  capture.stage = 1;
  // let the veil paint before the canvas is resized (a resize clears it for a frame)
  setTimeout(() => {
    capture.saved = { rs: params.renderScale, dyn: dynScale };
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(3840 / w, 2160 / h, Math.max(1, window.devicePixelRatio) * 1.5);
    params.renderScale = Math.max(params.renderScale, pr / basePR);
    dynScale = 1;
    resize();
    capture.stage = 2;
    capture.frames = 4; // a few frames so focus, exposure and shadows settle at the new size
    developPhase(0.12, 0.35, 0.4);
  }, 120);
}
/** The bitmap is read: encoding starts (≈ 0.3 s + 0.2 s per megapixel). */
function encodingCapture(frame) {
  const mp = (frame.width * frame.height) / 1e6;
  developPhase(0.35, 0.96, 0.3 + mp * 0.2);
}
function finishCapture(blob) {
  params.renderScale = capture.saved.rs;
  dynScale = photoMode ? Math.min(capture.saved.dyn, PHOTO_PREVIEW) : capture.saved.dyn;
  resize();
  developPhase(develop.shown, 1, 0.12);
  // the print: the photo itself appears for a moment before the camera comes back
  const blobUrl = blob ? URL.createObjectURL(blob) : null;
  setTimeout(() => {
    clearInterval(develop.timer);
    developBar.style.transform = 'scaleX(1)';
    if (blobUrl) {
      developPrint.onload = () => developEl.classList.add('printed');
      developPrint.src = blobUrl;
      developLabel.textContent = t('ph.saved');
    }
    setTimeout(() => {
      developEl.classList.remove('on');
      setTimeout(() => { developEl.classList.remove('printed'); developPrint.removeAttribute('src'); if (blobUrl) URL.revokeObjectURL(blobUrl); capture.stage = 0; }, 400);
    }, blobUrl ? 1700 : 250);
  }, 220);
}
const photo = new PhotoMode({ onShutter: startCapture });
function togglePhotoMode(on = !photoMode) {
  if (on === photoMode) return;
  if (on && (titleMode || !document.body.classList.contains('started'))) return;
  photoMode = on;
  document.body.classList.toggle('photo', photoMode);
  document.body.classList.toggle('hide-ui', photoMode);
  // photo mode moves at a walking pace (the map review keeps its 4 m/s fly-over)
  if (photoMode) { flyCam.photo = true; flyCam.speed = 1.2; } else flyCam.photo = false;
  flyCam.toggle(photoMode);
  if (photoMode) { photo.enter(); releasePointer(); } else { photo.exit(); lockPointer(); }
  // lighter preview while framing; the shutter renders at full definition
  if (photoMode) { capture.previewFrom = dynScale; dynScale = Math.min(dynScale, PHOTO_PREVIEW); }
  else if (capture.previewFrom != null) { dynScale = capture.previewFrom; capture.previewFrom = null; }
  resizeInternal();
}

const _gf = new THREE.Vector3();
const _gr = new THREE.Vector3();
let padSprint = false;
/** Walking from the left stick (camera-relative), or null while the pad is idle. */
function gamepadInput() {
  if (!pad.connected) return null;
  const slide = pad.down(PAD_ACTIONS.slide) && !slideLatch && !padConsumed.has(PAD_ACTIONS.slide);
  const { lx, ly } = pad;
  // clicking the left stick sprints until the stick is let go
  if (pad.pressed(BTN.L3)) padSprint = true;
  if (!lx && !ly) padSprint = false;
  const hurry = pad.down(PAD_ACTIONS.hurry) || pad.rt > 0.3 || padSprint;
  if (!lx && !ly && !slide) return null;
  if (params.autopilot) { params.autopilot = false; refreshGui(); }
  // steer toward the stick direction, seen from the camera
  camera.getWorldDirection(_gf).setY(0).normalize();
  _gr.set(-_gf.z, 0, _gf.x);
  const want = _gf.multiplyScalar(-ly).add(_gr.multiplyScalar(lx));
  const mag = Math.min(1, want.length());
  let turn = 0;
  if (mag > 0.1) {
    turn = THREE.MathUtils.clamp(wrapAngle(Math.atan2(want.x, want.z) - penguin.heading) * 2, -1, 1);
  }
  return { forward: mag, turn, hurry, slide };
}

/**
 * Controller rumble from the world, in play and in the cinematics alike: a belly flop and
 * the slide, the storm's wind, the handheld camera of a cinematic, the warmth of a huddle
 * (a slow heartbeat), the chick shaking off the snow. Splashes rumble from SplashFx.
 */
let padSliding = false, padShaking = false;
function padRumble() {
  if (!pad.connected) return;
  const sliding = penguin.slide > 0.5;
  if (sliding && !padSliding) pad.rumble(0.35, 0.5, 150); // the belly flop
  padSliding = sliding;
  if (sliding) pad.hum(0.04, 0.08 + 0.18 * Math.min(1, penguin.speed / 1.5));
  const shaking = (penguin.shake || 0) > 0.3;
  if (shaking && !padShaking) pad.rumble(0.25, 0.45, 500); // shaking off the snow
  padShaking = shaking;
  if (!STORY || !story) return;
  const storm = weather.state.storm, gust = weather.gust;
  // the wind shoves harder in the gusts, less with the head down; in a cinematic the
  // storm is felt whatever the shelter, more softly
  const exposed = story.cine.active ? storm * 0.6 : storm * (1 - (story.shelter || 0)) * (penguin.hunker > 0.5 ? 0.6 : 1);
  if (exposed > 0.05) pad.hum(exposed * (0.12 + 0.35 * gust), exposed * (0.08 + 0.25 * gust));
  if (story.cine.active) {
    // the handheld camera: its shake comes through the hands, faintly
    const hand = story.cine.shake ?? 0;
    if (hand > 0.001) pad.hum(0, Math.min(0.25, 0.04 + hand * 20));
    // huddled close in a cinematic: a slow, soft heartbeat (lub-dub every 1.1 s)
    if (story.huddling) {
      const ph = (story.time % 1.1) / 1.1;
      if (ph < 0.08 || (ph > 0.2 && ph < 0.26)) pad.hum(0.14, 0.05);
    }
  }
}

// Controller: menus, photo mode and the game's actions (walking is gamepadInput).
// A button that opened or confirmed something in a menu is ignored by the game until it
// is let go (A on "Resume" must not become a belly slide).
const padConsumed = new Set();
let padTs = 0;
/** The open menu the pad drives, or null in play. */
function padMenu() {
  if (options.open) return { root: options.el, back: () => options.hide(), tabs: true };
  if (paused) return { root: document.querySelector('#pause .pause-card'), back: () => setPaused(false), prefer: document.getElementById('pause-resume') };
  if ((endCard ??= document.querySelector('.hud-end'))?.classList.contains('on')) return { root: endCard };
  if (!document.body.classList.contains('started')) return document.body.classList.contains('ready') ? { root: document.getElementById('intro'), prefer: startBtn } : null;
  return null;
}
function padFrame(ts) {
  const dt = Math.min(0.1, Math.max(0, (ts - padTs) / 1000));
  padTs = ts;
  pad.poll();
  for (const b of padConsumed) if (!pad.down(b)) padConsumed.delete(b);
  if (!pad.connected) { flyCam.pad = null; return; }
  const press = (b) => { if (!pad.pressed(b)) return false; padConsumed.add(b); return true; };
  const menu = padMenu();
  if (menu) {
    flyCam.pad = null;
    const dir = pad.menuDir(dt);
    if (dir) {
      if (menu.root.contains(document.activeElement) && document.activeElement !== menu.root) navigate(menu.root, dir);
      else ensureFocus(menu.root, menu.prefer); // the first press only shows where the focus is
    }
    if (press(BTN.A)) ensureFocus(menu.root, menu.prefer)?.click();
    if (press(BTN.B) || press(BTN.MENU)) menu.back?.();
    if (menu.tabs && press(BTN.LB)) options.cycleTab(-1);
    if (menu.tabs && press(BTN.RB)) options.cycleTab(1);
    return;
  }
  if (photoMode) {
    // the camera body: sticks fly and look, triggers rise and sink, the D-pad sets it up
    flyCam.pad = { x: pad.lx, y: pad.ly, up: pad.rt - pad.lt, lookX: pad.rx, lookY: pad.ry, fast: pad.down(BTN.RB) || pad.down(BTN.L3) };
    const dir = pad.menuDir(dt, true);
    if (dir) navigate(photo.el, dir);
    if (press(BTN.A)) {
      const f = document.activeElement;
      if (photo.el.contains(f) && f.matches('button')) f.click(); else photo.shutter();
    }
    if (press(BTN.B) || press(BTN.Y)) togglePhotoMode(false);
    if (press(BTN.MENU)) setPaused(true);
    return;
  }
  flyCam.pad = null;
  for (const [action, b] of Object.entries(PAD_ACTIONS)) {
    if (padConsumed.has(b)) continue;
    if (pad.pressed(b)) { if (action === 'pause') { padConsumed.add(b); setPaused(true); } else actionPress(action); }
    if (pad.released(b)) actionRelease(action);
  }
  // right stick: the follow camera (vertical a little slower, as with the mouse feel)
  if ((pad.rx || pad.ry) && controls.enabled && !flyCam.active) {
    const k = 2.6 * dt * mouse.sens;
    lookBy(pad.rx * k, pad.ry * 0.7 * k);
  }
}

const auto = { state: 'idle', timer: 1.5, turn: 0, turnTimer: 0 };
function autopilotInput(dt) {
  auto.timer -= dt;
  auto.turnTimer -= dt;
  const p = penguin.root.position;
  if (auto.timer <= 0) {
    const r = Math.random();
    if (auto.state === 'walk' && r < 0.14) { auto.state = 'slide'; auto.timer = 2.5 + Math.random() * 1.5; }
    else if (auto.state === 'walk' && r < 0.45) { auto.state = 'idle'; auto.timer = 2 + Math.random() * 3.5; }
    else { auto.state = 'walk'; auto.timer = 5 + Math.random() * 9; }
    if (auto.state === 'idle' && Math.random() < 0.7) { sound.call(camera.position.distanceTo(p), { at: penguin.root, self: true }); penguin.chirp(); }
  }
  if (auto.turnTimer <= 0) { auto.turn = (Math.random() - 0.5) * 0.9; auto.turnTimer = 1 + Math.random() * 3; }
  let turn = auto.turn;
  // keep away from the floe edge and the deformation field boundary
  const fx = Math.sin(penguin.heading), fz = Math.cos(penguin.heading);
  const ahead = heightfield.sdfAt(p.x + fx * 2.5, p.z + fz * 2.5);
  const rAhead = Math.hypot(p.x + fx * 2.5, p.z + fz * 2.5);
  if (ahead < 4 || rAhead > 16) {
    const toC = Math.atan2(-p.x, -p.z);
    turn = THREE.MathUtils.clamp(wrapAngle(toC - penguin.heading) * 1.5, -1, 1);
  }
  return { forward: auto.state === 'idle' ? 0 : 1, turn, hurry: false, slide: auto.state === 'slide' };
}
let slideLatch = false; // set while a skip press is still held
const _back = new THREE.Vector3();
function manualInput() {
  const f = isDown('forward', keys) ? 1 : 0;
  const t = (isDown('left', keys) ? 1 : 0) - (isDown('right', keys) ? 1 : 0);
  const hurry = isDown('hurry', keys), slide = !slideLatch && isDown('slide', keys);
  // back (S): a chick does not walk backwards: it turns round and comes toward the camera
  // (the follow camera keeps its distance, so it keeps coming, face on); Q / D still bend
  // the path
  if (!f && isDown('back', keys)) {
    const p = penguin.root.position;
    _back.set(camera.position.x - p.x, 0, camera.position.z - p.z);
    if (_back.lengthSq() < 1e-4) _back.set(-Math.sin(penguin.heading), 0, -Math.cos(penguin.heading));
    _back.setLength(5).add(p);
    const s = steerTo(_back);
    return { forward: s.forward, turn: THREE.MathUtils.clamp(s.turn + t * 0.6, -1, 1), hurry, slide };
  }
  return { forward: f, turn: t, hurry, slide };
}

// ---------------------------------------------------------------------------
// Tuning panel (?debug only): loaded on demand, so lil-gui stays out of the game bundle
if (DEBUG) import('lil-gui').then(({ default: GUI }) => {
  gui = new GUI({ title: 'Simulator' });
  gui.add(params, 'quality', Object.keys(PRESETS)).name('quality preset').listen().onChange((v) => {
    applyQuality(v);
  });
  const fEnv = gui.addFolder('Sun & sky');
  fEnv.add(params, 'sunElevation', -2, 25, 0.1).name('sun elevation °').onChange(updateSun);
  fEnv.add(params, 'sunAzimuth', 0, 360, 1).name('sun azimuth °').onChange(updateSun);
  fEnv.add(params, 'sunIntensity', 1, 15, 0.1).name('sun intensity').onChange(updateSun);
  fEnv.add(params, 'exposure', 0.1, 2, 0.01);
  fEnv.add(params, 'autoExposure').name('eye adaptation');
  fEnv.add(params, 'clouds', 0, 0.9, 0.01).onChange(updateSun);
  fEnv.add(params, 'sunPillar', 0, 3, 0.01).name('sun pillar').onChange(updateSun);
  const fLens = gui.addFolder('Camera lens');
  fLens.add(params, 'autoBloom').name('bloom follows sun').onChange((v) => { if (v) updateSun(); });
  fLens.add(params, 'bloom', 0, 1.5, 0.01).listen().onChange((v) => { params.autoBloom = false; bloom.strength = v; refreshGui(); });
  fLens.add(params, 'godRays').name('light shafts');
  fLens.add(params, 'lensFlare').name('lens flare');
  fLens.add(params, 'fisheye', 0, 0.3, 0.005);
  fLens.add(params, 'chromatic', 0, 3, 0.01).name('chromatic aberration');
  fLens.add(params, 'frost', 0, 1, 0.01).name('frost on lens');
  fLens.add(params, 'dof').name('depth of field');
  fLens.add(params, 'aperture', 0, 4, 0.05).name('aperture');
  const fSnow = gui.addFolder('Snow');
  fSnow.add(params, 'snowSoftness', 0.2, 2.5, 0.01).name('powder depth');
  fSnow.add(params, 'refill', 0, 0.1, 0.001).name('wind refill rate');
  fSnow.add(params, 'sparkle', 0, 3, 0.01).onChange((v) => (snowMat.userData.uniforms.uSparkle.value = v));
  fSnow.add(params, 'wind', 0, 8, 0.1).name('wind m/s');
  fSnow.add(params, 'diamondDust').name('diamond dust');
  fSnow.add(params, 'spindrift');
  fSnow.add(params, 'snowfall');
  fSnow.add({ clear: () => deformer.clear() }, 'clear').name('erase all tracks');
  const fP = gui.addFolder('Penguin & camera');
  fP.add(params, 'autopilot').name('autopilot (P)');
  fP.add(params, 'cinematic').name('cinematic orbit (C)');
  fP.add(params, 'fur').name('down feathers');
  fP.add(params, 'sound').onChange((v) => sound.setMuted(!v));
  fP.add({ photo: togglePhotoMode }, 'photo').name('photo mode (F)');
  const fPerf = gui.addFolder('Performance');
  fPerf.add(params, 'dynamicRes').name('dynamic resolution');
  fPerf.add(params, 'renderScale', 0.5, 1.5, 0.05).name('render scale').onChange(resize);
  fPerf.close();
  fLens.close();
  gui.close(); // collapsed by default, even when shown
});
snowMat.userData.uniforms.uSparkle.value = params.sparkle;

// ---------------------------------------------------------------------------
// Loop
const timer = new THREE.Timer();
let time = 0;
const fpsEl = document.getElementById('fps');
let fpsAcc = 0, fpsFrames = 0, drsAcc = 0, drsFrames = 0, drsCooldown = 3;
const tmpV = new THREE.Vector3();
const prevPenguinPos = new THREE.Vector3();
const sunViewDir = new THREE.Vector3();
const sunUv = new THREE.Vector3();
const camDir = new THREE.Vector3();
const furForce = new THREE.Vector3();
const npcFurForce = new THREE.Vector3();
const penguinVel = new THREE.Vector3();
const windVec = new THREE.Vector3();
// where the sounds of the world come from, refreshed each frame for the soundscape
const audioScene = {
  windFrom: new THREE.Vector3(-1, 0, 0), sea: new THREE.Vector3(),
  colony: null, creche: null,
  colonyC: { pos: new THREE.Vector3(), radius: 4 }, crecheC: { pos: new THREE.Vector3(), radius: 2 },
};
let adaptedExposure = params.exposure;
const camLook = new THREE.Vector3();
let wasCine = false;
let focusDist = 2, apertureNow = 1, snapLens = false;
const cineBase = new THREE.Vector3();
let titleMode = false, titleT = 0;
// ---------------------------------------------------------------------------
// Title screen: one of two framings, drawn at random each time the game starts
// (?title=foreground|snowline forces one, for checking).
const TITLE_SHOTS = ['foreground', 'snowline'];
const titleShotKey = (() => { const v = url.get('title'); return TITLE_SHOTS.includes(v) ? v : TITLE_SHOTS[Math.floor(Math.random() * TITLE_SHOTS.length)]; })();
let titleLens = { fov: 33, aperture: 2.2, focus: new THREE.Vector3() };
const _ts = { pos: new THREE.Vector3(), look: new THREE.Vector3(), focus: new THREE.Vector3(), fov: 33, aperture: 2.2 };
const _tv = new THREE.Vector3(), _tw = new THREE.Vector3();
/** Close title framings: chicks wandering between the lens and the hero step aside. */
function keepTitleLensClear(cam, subject) {
  if (!colony) return;
  const dx = subject.x - cam.x, dz = subject.z - cam.z, L2 = dx * dx + dz * dz || 1, L = Math.sqrt(L2);
  for (const a of colony.agents) {
    if (a.gone || !a.p.root.visible) continue;
    const p = a.position;
    const t = ((p.x - cam.x) * dx + (p.z - cam.z) * dz) / L2;
    if (t < -0.2 || t > 1.4) continue;
    const cx = cam.x + dx * t, cz = cam.z + dz * t;
    const ox = p.x - cx, oz = p.z - cz, d = Math.hypot(ox, oz);
    const need = a.p.bodyRadius + 0.35 + 0.25 * Math.max(0, t);
    if (d >= need) continue;
    const nx = d > 1e-3 ? ox / d : -dz / L, nz = d > 1e-3 ? oz / d : dx / L;
    const k = need - d;
    p.x += nx * k; p.z += nz * k;
    a.home.x += nx * k; a.home.z += nz * k; a.target.x += nx * k; a.target.z += nz * k;
  }
}
/** The colony drift (original title shot); also where the opening starts from. */
function titleColonyPose(t, out = _ts) {
  const C = PLACES.colony;
  const a = Math.atan2(-sunDir.z, -sunDir.x) + 0.18 + Math.sin(t * 0.045) * 0.2;
  const R = 12.5 - 1.2 * Math.sin(t * 0.03);
  const tx = C.x + Math.cos(a) * R, tz = C.z + Math.sin(a) * R;
  out.pos.set(tx, heightfield.heightAt(tx, tz) + 0.62, tz);
  out.look.set(C.x, 0.95, C.z);
  out.focus.set(C.x, heightfield.heightAt(C.x, C.z) + 0.5, C.z);
  out.fov = 33; out.aperture = 2.2;
  return out;
}
function titleShot(t) {
  const C = PLACES.colony, hp = penguin.root.position, s = _ts;
  const sun = _tv.set(sunDir.x, 0, sunDir.z).normalize();
  const g = (x, z) => heightfield.heightAt(x, z);
  if (titleShotKey === 'foreground') {
    // the chick small in the foreground (right third), the backlit colony soft behind it
    const toC = _tw.set(C.x - hp.x, 0, C.z - hp.z).normalize().lerp(sun, 0.3).normalize();
    penguin.heading = Math.atan2(toC.x, toC.z) + 2.2;
    const side = new THREE.Vector3(-toC.z, 0, toC.x);
    const drift = Math.sin(t * 0.05) * 0.12;
    // side is screen-right: the lens sits left of the chick so it lands on the right third
    s.pos.copy(hp).addScaledVector(toC, -1.45).addScaledVector(side, -0.45 + drift);
    s.pos.y = g(s.pos.x, s.pos.z) + 0.3;
    s.look.copy(hp).addScaledVector(toC, 5).addScaledVector(side, -0.55);
    s.look.y = g(hp.x, hp.z) + 0.38;
    s.focus.copy(hp); s.focus.y = g(hp.x, hp.z) + 0.3;
    s.fov = 30; s.aperture = 3.4;
    keepTitleLensClear(s.pos, hp);
    return s;
  }
  if (titleShotKey === 'snowline') {
    // lens on the snow: glittering crust in front, the colony in silhouette against the sun
    const a = Math.atan2(-sun.z, -sun.x) + 0.08 + Math.sin(t * 0.04) * 0.06;
    const R = 9.5;
    s.pos.set(C.x + Math.cos(a) * R, 0, C.z + Math.sin(a) * R);
    s.pos.y = g(s.pos.x, s.pos.z) + 0.14;
    s.look.set(C.x, g(C.x, C.z) + 0.55, C.z);
    s.focus.copy(s.look);
    s.fov = 28; s.aperture = 3.0;
    return s;
  }
  return titleColonyPose(t, s);
}
let camReturn = null;
const pushV = new THREE.Vector3();
const _proj = new THREE.Vector3();
function steerTo(goal) {
  const p = penguin.root.position;
  const dx = goal.x - p.x, dz = goal.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.2) return { forward: 0, turn: 0 };
  const err = wrapAngle(Math.atan2(dx, dz) - penguin.heading);
  return { forward: Math.abs(err) > 1.2 ? 0.2 : 1, turn: THREE.MathUtils.clamp(err * 2, -1, 1) };
}

const pacing = { buf: new Float32Array(1200), n: 0, long: [] }; // frame times (?debug only)
// Test harness only (?debug): when the page is hidden the browser stops animation
// frames, so a worker clock keeps the simulation stepping for automated checks.
let bgClock = false;
if (DEBUG) {
  try {
    const w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 16)'], { type: 'text/javascript' })));
    w.onmessage = () => { if (document.hidden && frameStarted) frame(performance.now(), true); };
    bgClock = true;
  } catch { /* no worker: fall back to animation frames only */ }
}
let frameStarted = false;

// Pause menu (Esc): resume, start over, quality, sound, language
let paused = false;
function setPaused(v) {
  if (titleMode || !document.body.classList.contains('started')) return;
  paused = v;
  if (v) releasePointer();
  document.body.classList.toggle('paused', v);
  if (sound.ctx) (v ? sound.ctx.suspend() : sound.ctx.resume());
  if (v) document.getElementById('pause-resume').focus();
  keys.clear();
}
document.getElementById('pause-resume').addEventListener('click', () => { setPaused(false); lockPointer(); });
// "Esc to resume", or the controller's B (○) with the pad in hand
const pauseHint = () => { document.getElementById('pause-hint').textContent = t('pause.hint', { key: pad.mode === 'pad' ? pad.label(BTN.B) : keyLabel('Escape') }); };
onLocaleChange(pauseHint);
pad.onChange(pauseHint);
pauseHint();
// photo mode from the pause menu: resume, then open the camera (or go back to it)
document.getElementById('pause-photo').addEventListener('click', () => { setPaused(false); if (!photoMode) togglePhotoMode(true); });
// options (title + pause): graphics, sound, controls, display
const GFX_KEY = 'pingu.gfx';
try { const g = JSON.parse(localStorageGet(GFX_KEY) || '{}'); if (typeof g.dof === 'boolean') params.dof = g.dof; if (typeof g.lens === 'boolean') { params.lensFlare = g.lens; params.chromatic = g.lens ? CHROMATIC_ON : 0; } } catch { /* storage unavailable */ }
const options = new Options({
  params, sound,
  applyQuality: (q) => applyQuality(q),
  quality: () => qualityName,
  save: () => localStorageSet(GFX_KEY, JSON.stringify({ dof: params.dof, lens: params.lensFlare })),
  mouse,
  saveMouse: () => localStorageSet(MOUSE_KEY, JSON.stringify(mouse)),
});
document.getElementById('pause-options').addEventListener('click', () => options.show());
document.getElementById('title-options').addEventListener('click', (e) => { e.stopPropagation(); options.show(); });
document.getElementById('pause-restart').addEventListener('click', () => location.reload());
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    e.preventDefault();
    if (options.open) return; // the options close themselves (capture phase)
    // this Esc already released the pointer and paused: don't unpause straight away
    if (performance.now() - lockLostAt < 500) return;
    // paused (even from photo mode): Esc resumes; in photo mode it leaves photo mode
    if (paused) setPaused(false); else if (photoMode) togglePhotoMode(false); else setPaused(true);
  }
  if (photoMode && (e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat) { e.preventDefault(); photo.shutter(); }
});
window.addEventListener('blur', () => { if (!DEBUG) setPaused(true); });
function frame(ts, fromClock = false) {
  frameStarted = true;
  if (!fromClock) requestAnimationFrame(frame);
  if (bgClock && document.hidden && !fromClock) return;
  timer.update(ts);
  // the end card, an options panel or a disabled setting hand the cursor back
  if (document.pointerLockElement && !wantPointerLock()) releasePointer();
  padFrame(ts); // the pad drives the menus too, so it is read even while paused
  if (paused) { timer.getDelta(); return; } // hold the last image; nothing advances
  const rawDt = timer.getDelta();
  if (DEBUG) {
    pacing.buf[pacing.n++ % 1200] = rawDt * 1000;
    if (rawDt > 0.034 && pacing.long.length < 200) pacing.long.push([Math.round(time), Math.round(rawDt * 1000)]);
  }
  const dt = Math.min(rawDt, 1 / 20) * TIME_SCALE;
  time += dt;

  // weather + story first: they decide what the chick may do this frame
  // (photo mode freezes the moment: weather, story and the sun hold still)
  const simDt = photoMode ? 0 : dt;
  if (STORY) {
    weather.update(simDt);
    const W = weather.state;
    params.wind = weather.windNow;
    params.snowfall = W.snowfall > 0.03;
    params.frost = W.frost;
    // a gust wall thickens everything for a few seconds (storm style C above all)
    const wall = weather.gustWall || 0;
    fall.uniforms.uIntensity.value = 0.9 * Math.min(1, W.snowfall * 1.2) * (1 + 0.6 * wall);
    fall.uniforms.uStreak.value = W.storm;
    fall.uniforms.uSize.value = 5 * W.flakeSize;
    if (Math.abs(W.flakeAmount - flakeAmount) > 0.02) { flakeAmount = W.flakeAmount; applyParticleCounts(); }
    drift.uniforms.uHop.value = W.driftHeight;
    driftMul = W.driftAmount * (1 + 0.8 * wall);
    stormFog.setRGB(W.fogR, W.fogG, W.fogB);
    drift.uniforms.uStreak.value = Math.min(1, W.storm + Math.max(0, weather.windNow - 3) * 0.15);
    snowMat.userData.uniforms.uDrift.value = THREE.MathUtils.clamp((weather.windNow - 2.2) / 5.5, 0, 1.3);
    { const u = snowMat.userData.uniforms.uDriftScroll; u.value = (u.value + weather.windNow * simDt) % 10000; }
    water.material.uniforms.uChop.value = 1 + W.storm * 0.9 + Math.max(0, weather.windNow - 2) * 0.05;
    sound.setStorm(W.storm);
    const cover = PENGUIN_UNIFORMS.uSnowCover;
    cover.value += (W.snowCover - cover.value) * (1 - Math.exp(-dt * 0.15));
    stepSun(simDt);
    // storm visibility breathes with the gusts (after stepSun, which may reset the fog)
    if (W.storm > 0.01) scene.fog.density = W.fog * (1 + 2.5 * wall);
    _c.copy(stormFog).lerp(_c2.setRGB(0.95, 0.96, 1.0), 0.3).multiplyScalar(0.55 + 0.45 * Math.min(1, W.sunMul * 3 + 0.4));
    groundBlow.update(time, camera.position, weather.windNow * 0.9, W.groundBlow * Math.min(1, W.storm * 1.2) * (1 + 0.7 * wall), W.blowDepth, _c,
      W.blowVeil * Math.min(1, W.storm * 1.2) * (1 + 0.5 * wall));
    story?.update(simDt);
    narrator?.update(simDt);
  }

  // penguin (frozen in photo mode)
  prevPenguinPos.copy(penguin.root.position);
  if (!photoMode) {
    let input;
    if (STORY && story && !story.free) {
      if (story.control) input = (DEBUG && window.__botInput?.(steerTo)) || gamepadInput() || manualInput();
      else if (story.autoWalk) input = steerTo(story.autoWalk);
      else input = { forward: 0, turn: 0 };
      // braving the storm: head down into the wind, every step costs more
      const exposed = weather.state.storm * (1 - (story.shelter || 0));
      const hunkerGoal = story.huddling ? 1 : 0.55 * exposed;
      penguin.hunker = (penguin.hunker || 0) + (hunkerGoal - (penguin.hunker || 0)) * (1 - Math.exp(-dt * 2));
      if (input.forward) input.forward *= 1 - 0.3 * exposed * (0.5 + 0.5 * weather.gust);
      // the storm shoves a small chick around unless it hunkers down
      penguin.push = weather.push(pushV, story.shelter || 0).multiplyScalar(penguin.hunker > 0.5 ? 0.25 : 1);
    } else {
      input = gamepadInput() || (params.autopilot ? autopilotInput(dt) : manualInput());
    }
    penguin.update(dt, input, heightfield, bounds);
    colony?.update(dt, penguin, weather);
    colony?.resolveCollisions(penguin, bounds);
    padRumble();
  }
  const pp = penguin.root.position;
  penguinVel.subVectors(pp, prevPenguinPos).divideScalar(Math.max(dt, 1e-4));

  if (flyCam.active) {
    flyCam.update(dt);
    keepCameraClear(camera.position);
    if (photoMode && photo.s.roll) { camera.rotateZ(THREE.MathUtils.degToRad(photo.s.roll)); camera.updateMatrixWorld(); }
    controls.enabled = false;
    wasCine = true;
  } else if (titleMode) {
    // title screen: one of several framings, picked at random (or with ?title=)
    titleT += dt;
    const shot = titleShot(titleT);
    camera.position.copy(shot.pos);
    camLook.copy(shot.look);
    camera.lookAt(camLook);
    titleLens = shot;
    controls.enabled = false;
    wasCine = true;
  } else if (story?.cine.active) {
    // scripted camera: a cut snaps to the shot, otherwise the rig eases toward it;
    // a faint handheld breathing keeps locked-off shots alive
    const c = story.cine;
    if (!wasCine) cineBase.copy(camera.position);
    if (c.cut) {
      c.cut = false;
      cineBase.copy(c.pos);
      camLook.copy(c.look);
      snapLens = true;
    } else {
      const k = 1 - Math.exp(-dt * c.speed);
      cineBase.lerp(c.pos, k);
      camLook.lerp(c.look, k);
    }
    const tt = story.time, hh = c.shake ?? 0.004;
    camera.position.set(
      cineBase.x + hh * (Math.sin(tt * 0.71) + 0.5 * Math.sin(tt * 1.83 + 1.1)),
      cineBase.y + hh * 0.7 * (Math.sin(tt * 0.53 + 2.0) + 0.4 * Math.sin(tt * 1.37)),
      cineBase.z + hh * (Math.sin(tt * 0.62 + 4.0) + 0.5 * Math.sin(tt * 1.61 + 0.3)),
    );
    camera.lookAt(camLook);
    controls.enabled = false;
    wasCine = true;
  } else {
    if (wasCine) {
      // hand back to the orbit camera; if the shot ended far away, glide back to the chick
      wasCine = false;
      controls.enabled = true;
      camTarget.set(pp.x, pp.y + 0.2, pp.z);
      controls.target.copy(camTarget);
      // always settle on the standard play framing: far enough to read the chick in its
      // surroundings (the close shots belong to the cinematics)
      {
        const back = tmpV.subVectors(camera.position, pp).setY(0);
        if (back.lengthSq() < 1e-4) back.set(Math.sin(penguin.heading), 0, Math.cos(penguin.heading)).negate();
        back.normalize();
        camReturn = { t: 0, from: camera.position.clone(), to: new THREE.Vector3(pp.x + back.x * PLAY_DIST, pp.y + PLAY_HEIGHT, pp.z + back.z * PLAY_DIST) };
      }
    }
    if (camReturn) {
      camReturn.t = Math.min(1, camReturn.t + dt / 1.8);
      const e = camReturn.t * camReturn.t * (3 - 2 * camReturn.t);
      camera.position.lerpVectors(camReturn.from, camReturn.to, e);
      if (camReturn.t >= 1) camReturn = null;
    }
    // follow camera: translate with the chick, keep the user's orbit offset
    tmpV.subVectors(pp, prevPenguinPos);
    camera.position.add(tmpV);
    camTarget.lerp(tmpV.set(pp.x, pp.y + 0.2 - 0.1 * penguin.slide - 0.08 * (penguin.hunker || 0), pp.z), 1 - Math.exp(-dt * 8));
    controls.target.copy(camTarget);
    controls.autoRotate = params.cinematic;
    controls.update();
    camLook.copy(controls.target);
  }
  const gh = heightfield.sdfAt(camera.position.x, camera.position.z) > 0 ? heightfield.heightAt(camera.position.x, camera.position.z) : 0.1;
  if (camera.position.y < gh + 0.07) camera.position.y = gh + 0.07;
  // the storm buffets the camera: a fast shiver plus heavier jolts on the gusts (rotation
  // only, re-applied on top of a fresh orientation each frame, so nothing accumulates);
  // calmer in the shelter of the huddle, none in photo mode
  if (STORY && !photoMode && weather.state.storm > 0.02) {
    const W = weather.state, tt = time;
    const calm = story?.huddling ? 0.35 : 1 - 0.6 * (story?.shelter || 0);
    const amp = W.storm * calm * (0.0022 + 0.0011 * Math.max(0, weather.windNow - 4) / 6 + 0.007 * (weather.gustWall || 0)) * (story?.cine.active ? 0.6 : 1);
    const jolt = (weather.gustWall || 0) * W.storm * calm * 0.004;
    const yaw = amp * (Math.sin(tt * 7.1) + 0.6 * Math.sin(tt * 13.3 + 1.0) + 0.4 * Math.sin(tt * 23.7 + 2.0)) + jolt * Math.sin(tt * 1.7) * Math.sin(tt * 0.9 + 0.4);
    const pitch = amp * (Math.sin(tt * 8.3 + 0.7) + 0.6 * Math.sin(tt * 15.1 + 2.2) + 0.4 * Math.sin(tt * 27.9 + 0.3)) * 0.8 + jolt * 0.6 * Math.sin(tt * 2.3 + 1.1);
    const roll = amp * (Math.sin(tt * 5.3 + 1.9) + 0.5 * Math.sin(tt * 11.7)) * 0.7;
    camera.rotateY(yaw); camera.rotateX(pitch); camera.rotateZ(roll);
  }

  // the snow grids follow the chick in whole steps of their own spacing, so vertices never swim
  const vf = viewFocus(pp);
  const ns = nearGrid.spacing;
  snowNear.position.set(Math.round(vf.x / ns) * ns, 0, Math.round(vf.z / ns) * ns);
  snowMat.userData.uniforms.uNear.value.set(snowNear.position.x, snowNear.position.z, nearGrid.half);
  const fs = farGrid.innerSpacing;
  snowFar.position.set(Math.round(vf.x / fs) * fs, 0, Math.round(vf.z / fs) * fs);
  const su = snowMat.userData.uniforms;
  su.uTime.value = time;
  su.uContact.value.set(pp.x, pp.y, pp.z, penguin.slide > 0.5 ? 0.24 : 0.15);

  // tight shadow frustum around the chick, aimed down the sun ray; widened while the
  // colony is around so every penguin casts its long sunset shadow
  const wide = flyCam.active || colony && colony.agents.some((a) => !a.gone && a.p.root.visible && a.position.distanceTo(pp) < 14 && a.kind !== 'friend');
  const half = wide ? 9 : 0.75;
  if (sun.shadow.camera.right !== half) {
    sun.shadow.camera.left = -half; sun.shadow.camera.right = half; sun.shadow.camera.top = half; sun.shadow.camera.bottom = -half;
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.normalBias = wide ? 0.02 : 0.004;
  }
  sun.target.position.set(vf.x, vf.y + 0.2, vf.z);
  sun.position.copy(sun.target.position).addScaledVector(sunDir, 40);
  sun.target.updateMatrixWorld();
  // photo mode freezes the world: the shadow map only needs redrawing when its frame moves
  if (photoMode) {
    const r = renderer.shadowMap, key = `${sun.position.x.toFixed(3)},${sun.position.y.toFixed(3)},${sun.position.z.toFixed(3)},${half}`;
    r.autoUpdate = false;
    if (key !== shadowKey) { shadowKey = key; r.needsUpdate = true; }
  } else if (!renderer.shadowMap.autoUpdate) { renderer.shadowMap.autoUpdate = true; shadowKey = ''; }

  camera.updateMatrixWorld();
  sunViewDir.copy(sunDir).transformDirection(camera.matrixWorldInverse);
  penguin.sunDirViewUniform.value.copy(sunViewDir);

  // skin the chick once for every consumer this frame (body, shadow, reflection, fur)
  penguin.root.updateMatrixWorld(true);
  penguin.skinner?.update();

  windVec.set(Math.cos(WIND_ANGLE), 0, Math.sin(WIND_ANGLE)).multiplyScalar(params.wind);
  if (fur) {
    fur.enabled = params.fur;
    // strands droop, trail behind motion and flutter in the wind
    furForce.set(0, -0.3, 0).addScaledVector(penguinVel, -0.35).addScaledVector(windVec, 0.03 * (1 + 0.6 * Math.sin(time * 3.1) * Math.sin(time * 1.7)));
    fur.update(camera, sunViewDir, sunRad, furForce);
  }
  if (colony) {
    npcFurForce.set(0, -0.3, 0).addScaledVector(windVec, 0.03 * (1 + 0.6 * Math.sin(time * 2.7 + 1.0) * Math.sin(time * 1.3)));
    for (const f of colony.furs) { f.enabled = params.fur; f.update(camera, sunViewDir, sunRad, npcFurForce); }
  }
  // the chick looks at what it can interact with, or toward the last reply
  if (story) penguin.gaze = story.gazeAt || (story.prompt && !story.prompt.self ? story.prompt.pos : story.echo ? story.echo.pos : null);

  // snow deformation
  deformer.update(dt, params.refill * (0.3 + params.wind * 0.35));

  // particles
  const pr = renderer.getPixelRatio();
  dust.points.visible = params.diamondDust;
  drift.points.visible = params.spindrift && params.wind > 0.3;
  fall.points.visible = params.snowfall;
  dust.update(time, camera.position, params.wind, sunDir, sunRad, skyTint, pr);
  drift.update(time, pp, params.wind, sunDir, sunRad, skyTint, pr);
  drift.uniforms.uIntensity.value = 0.7 * Math.min(1, params.wind / 3) * driftMul;
  fall.update(time, camera.position, params.wind, sunDir, sunRad, skyTint, pr);
  spray.update(dt, _b.copy(windVec).multiplyScalar(0.5), groundAt, sunDir, sunRad, skyTint, renderer.domElement.height / 1080);

  water.material.uniforms.time.value = time * 0.35;
  sky.material.uniforms.time.value = time;

  // lens: the sun on screen drives shafts + flare; the eye adapts when looking into it
  sunScreen(camera, sunDir, sunUv);
  prePass.uniforms.uSun.value.copy(sunUv);
  prePass.uniforms.uIntensity.value = params.godRays ? 0.55 : 0;
  prePass.enabled = params.godRays && sunUv.z > 0.001;
  prePass.uniforms.uTime.value = time;
  const fu = finalPass.uniforms;
  fu.uSun.value.copy(sunUv);
  fu.uIntensity.value = params.lensFlare ? 1 : 0;
  fu.uTime.value = time;
  // a touch of barrel distortion (0.03: stronger values stretched the edges)
  fu.uFisheye.value = params.fisheye;
  fu.uCA.value = params.chromatic;
  fu.uFrost.value = params.frost;
  updateBloom(dt);
  // lens: focus follows the subject; scripted shots can open the aperture and tighten the field of view
  const cine = story?.cine.active ? story.cine : null;
  const subject = titleMode ? titleLens.focus : cine?.focus || pp;
  if (photoMode) photo.autoFocus = centreDepth();
  let focusNow = photoMode ? photo.focusDistance : Math.max(0.35, camera.position.distanceTo(_proj.copy(subject).setY(subject.y + (subject === pp ? 0.22 : cine?.focusExact || titleMode ? 0 : 0.5))));
  // zoomed right in on the chick: focus on the down actually at the centre of the frame
  // (its chest or face), not on the middle of its body, which is a hand's width deeper
  let closeUp = 0;
  if (!photoMode && !cine && !titleMode && subject === pp && focusNow < 2.2) {
    closeUp = 1 - THREE.MathUtils.smoothstep(focusNow, 1.0, 2.2);
    focusNow = THREE.MathUtils.lerp(focusNow, Math.max(0.2, Math.min(focusNow, centreDepth())), closeUp);
  }
  focusDist += (focusNow - focusDist) * (1 - Math.exp(-dt * (cine?.focusSpeed ?? (4 + 4 * closeUp))));
  fu.uFocus.value = focusDist;
  const ap = titleMode ? titleLens.aperture : photoMode ? photo.aperture : cine ? cine.aperture ?? 2.2 : 1;
  apertureNow += (ap - apertureNow) * (1 - Math.exp(-dt * 2));
  if (snapLens) {
    // a cut lands with the new lens already set: focus, aperture and focal length
    snapLens = false;
    focusDist = focusNow; apertureNow = ap;
    const fg = cine ? cine.fov ?? 34 : 42;
    camera.fov = fg; camera.updateProjectionMatrix();
  }
  fu.uAperture.value = params.dof ? 0.006 * params.aperture * apertureNow : 0;
  fu.uFarBlur.value = params.dof ? 0.0035 : 0;
  const fovGoal = titleMode ? titleLens.fov : photoMode ? photo.fov : cine ? cine.fov ?? 34 : 42;
  if (Math.abs(camera.fov - fovGoal) > 0.02) { camera.fov += (fovGoal - camera.fov) * (1 - Math.exp(-dt * (photoMode ? 8 : 1.2))); camera.updateProjectionMatrix(); }
  camera.getWorldDirection(camDir);
  const intoSun = Math.pow(Math.max(0, camDir.dot(sunDir)), 3);
  const targetExp = params.autoExposure ? params.exposure * (1 - 0.38 * intoSun) : params.exposure;
  adaptedExposure += (targetExp - adaptedExposure) * (1 - Math.exp(-dt * 1.8));
  fu.uExposure.value = adaptedExposure * (STORY ? weather.state.exposureMul : 1) * (photoMode ? Math.pow(2, photo.s.ev) : 1);
  fu.uGrain.value = photoMode ? photo.grainAmount : 0.025;
  fu.uVignette.value = photoMode ? photo.s.vignette : 0.3;
  fu.uCocMax.value = photoMode ? 0.02 : 0.0105;
  fu.uLook.value = photoMode ? photo.lookIndex : 0;
  fu.uCold.value = story ? story.cold : 0;

  // HUD: world-anchored prompt, call echo, warmth
  if (story) {
    if (story.prompt) {
      // a prompt over the chick itself follows where it is now (the story set it before
      // the chick moved this frame: one frame behind the camera, it would jitter)
      if (story.prompt.self) _proj.set(pp.x, pp.y + 0.62, pp.z).project(camera);
      else _proj.copy(story.prompt.pos).project(camera);
      const vis = _proj.z < 1 && Math.abs(_proj.x) < 1.1 && Math.abs(_proj.y) < 1.1;
      hud.prompt(vis ? { x: (_proj.x * 0.5 + 0.5) * innerWidth, y: (-_proj.y * 0.5 + 0.5) * innerHeight } : null, story.prompt.verb, story.prompt.code, story.prompt.hold);
    } else hud.prompt(null);
    if (story.echo) {
      // pin just above the caller's head
      _proj.copy(story.echo.pos).setY(story.echo.pos.y + (story.echo.h ?? 0.6)).project(camera);
      hud.echo(_proj);
    } else hud.echo(null);
    // where to go next (hidden once the chick is there or a prompt takes over)
    const way = story.waypoint;
    if (way && !story.cine.active && !story.prompt && Math.hypot(pp.x - way.pos.x, pp.z - way.pos.z) > (way.near ?? 2)) {
      _proj.copy(way.pos).setY(heightfield.heightAt(way.pos.x, way.pos.z) + (way.h ?? 0.5)).project(camera);
      hud.waypoint(_proj, way.label);
    } else hud.waypoint(null);
    // the gauge is a gameplay readout: gone once the huddle (and its cinematic) takes over
    hud.warmth(story.cine.active || story.huddling ? null : story.warmth);
    hud.skipProgress(story.cine.active && story.skippable ? story.skipHold / 0.8 : 0);
  }

  // audio
  // mix: the score leads on the title and in cinematics, the world leads in play
  sound.setMix(titleMode ? 'title' : story && (story.cine.active || hud.el.classList.contains('cinematic')) ? 'cinematic' : 'gameplay');
  const edge = heightfield.sdfAt(camera.position.x, camera.position.z);
  // the ear is the camera; where the wind, the swell and the crowds come from
  sound.setListener(camera);
  {
    const cx = camera.position.x, cz = camera.position.z, th = Math.atan2(cz, cx), fr = floeRadius(th) + 0.6;
    audioScene.sea.set(Math.cos(th) * fr, 0, Math.sin(th) * fr);
    const wl = Math.hypot(windVec.x, windVec.z);
    if (wl > 1e-4) audioScene.windFrom.set(-windVec.x / wl, 0, -windVec.z / wl);
    audioScene.colony = audioScene.creche = null;
    if (colony) {
      // each crowd is heard from its middle, as wide as it is spread out
      const crowd = (pick, out) => {
        out.pos.set(0, 0, 0); let n = 0;
        for (const a of colony.agents) if (!a.gone && a.p.root.visible && pick(a)) { out.pos.add(a.position); n++; }
        if (!n) return null;
        out.pos.divideScalar(n);
        let r = 0;
        for (const a of colony.agents) if (!a.gone && a.p.root.visible && pick(a)) r += a.position.distanceTo(out.pos);
        out.radius = Math.max(1.5, r / n);
        return out;
      };
      audioScene.colony = crowd((a) => a.kind === 'adult' || a.kind === 'parent', audioScene.colonyC);
      audioScene.creche = crowd((a) => a.kind === 'chick' || a.kind === 'friend', audioScene.crecheC);
    }
  }
  sound.update(dt, params.wind, THREE.MathUtils.clamp(1 - edge / 12, 0.1, 1), audioScene);
  if (colony) {
    // the colony's murmur thins out as the adults leave, and with distance
    let present = 0, total = 0;
    for (const a of colony.agents) if (a.kind === 'adult' || a.kind === 'parent') { total++; if (!a.gone) present++; }
    const dC = camera.position.distanceTo(PLACES.colony);
    sound.setColony(titleMode ? 0 : (present / Math.max(total, 1)) / (1 + dC * dC * 0.0035));
    // the crèche's chatter: chicks near the listener, a handful is enough for full level
    let near = 0;
    for (const a of colony.agents) {
      if (a.gone || !a.p.root.visible || (a.kind !== 'chick' && a.kind !== 'friend')) continue;
      const d = camera.position.distanceTo(a.position);
      near += 1 / (1 + d * d * 0.012);
    }
    sound.setCreche(THREE.MathUtils.clamp(near / 3.5, 0, 1) * (titleMode ? 0.5 : 1));
    sound.setMuffle(story?.huddling ? 0.55 * weather.state.storm + 0.15 : 0);
  }

  updateEnv();
  composer.render();
  if (capture.stage === 2) {
    capture.frames--;
    if (capture.frames <= 0) {
      // read the drawing buffer now, in the same task as the render
      capture.stage = 3;
      encodingCapture(renderer.domElement);
      saveCanvas(renderer.domElement, 'derniere-lumiere', finishCapture);
    }
  }

  // dynamic resolution: hold ~60 fps by trading pixels
  fpsAcc += rawDt; fpsFrames++;
  drsAcc += rawDt; drsFrames++;
  drsCooldown -= rawDt;
  if (fpsAcc > 0.5) {
    if (fpsEl) fpsEl.textContent = `${Math.round(fpsFrames / fpsAcc)} fps · ${qualityName} · ${Math.round(dynScale * 100)}%`;
    fpsAcc = 0; fpsFrames = 0;
  }
  if (drsAcc > 1.0) {
    const ms = (drsAcc / drsFrames) * 1000;
    drsAcc = 0; drsFrames = 0;
    if (params.dynamicRes && drsCooldown <= 0 && !photoMode) {
      let next = dynScale;
      // hysteresis: drop fast when heavy, climb back slowly, never oscillate every second
      if (ms > 19.5) next = Math.max(Q.minScale, dynScale - 0.1);
      else if (ms < 13.5) next = Math.min(1, dynScale + 0.05);
      if (next !== dynScale) { drsCooldown = next < dynScale ? 1.5 : 4; dynScale = Math.round(next * 100) / 100; resizeInternal(); }
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Quality presets switch live: render targets, shadow map, snow grid, fur shells and
// particle counts are rebuilt in place, the game keeps running. (The footprint field
// keeps the resolution it was created with, so prints already made are not lost.)
function npcShells() { return Q.fur > 0 ? Math.max(4, Math.round(Q.fur * 0.6)) : 4; }
function applyQuality(name) {
  if (!PRESETS[name] || name === qualityName) return;
  qualityName = name;
  params.quality = name;
  Object.assign(Q, PRESETS[name]);
  localStorageSet('pingu.quality', name);
  if (url.has('quality')) {
    url.delete('quality');
    const u = new URL(location.href); u.searchParams.delete('quality');
    history.replaceState(null, '', u.toString());
  }
  // shadow map
  sun.shadow.mapSize.set(Q.shadow, Q.shadow);
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  // water reflection
  water.material.uniforms.mirrorSampler.value.renderTarget?.setSize(Q.water, Q.water);
  // MSAA on the scene target (re-allocated on next use)
  scenePass.setSamples(Q.msaa);
  // near snow grid (footprint geometry)
  const g = buildUniformGrid(Q.grid, Q.near);
  snowNear.geometry.dispose();
  snowNear.geometry = g.geometry;
  nearGrid = g;
  // fur, particles, post toggles
  params.fur = Q.fur > 0;
  if (Q.fur > 0) fur?.setShells(Q.fur);
  if (colony) { colony.furShells = npcShells(); colony.furs.forEach((f) => f.setShells(colony.furShells)); }
  applyParticleCounts();
  params.godRays = Q.rays;
  params.dof = name !== 'low';
  // resolution
  basePR = Math.min(window.devicePixelRatio, Q.pr);
  dynScale = 1;
  resize();
}

async function boot() {
  await penguin.load(modelUrl('penguin.glb'), (e) => {
    if (e.total) setProgress(t('loading.chick', { p: Math.round((e.loaded / e.total) * 100) }), 0.05 + 0.55 * (e.loaded / e.total));
  });
  penguin.root.position.y = heightfield.heightAt(0, 0);
  penguin.enableGpuSkinning(renderer);
  // always built (quality can switch it on mid-game); hidden when the preset has none
  fur = new Fur(penguin.skinnedMesh, penguin.skinner, { shells: Math.max(1, Q.fur), length: 0.0145, density: 900, even: 0 });
  if (STORY) {
    setProgress(t('loading.colony'), 0.7);
    locateRidge(heightfield, WIND_ANGLE);
    colony = new Colony({ scene, heightfield, deformer, spray, sound, camera, rumble: (s, w, ms) => pad.rumble(s, w, ms) });
    colony.furShells = npcShells();
    await colony.load();
    colony.spawn();
    penguin.root.position.set(0.6, heightfield.heightAt(0.6, 0.4), 0.4);
    story = new Story({
      hero: penguin, colony, hud, sound, weather, params, camera, heightfield, deformer,
      setSun, setMolt, windAngle: WIND_ANGLE, rumble: (s, w, ms) => pad.rumble(s, w, ms), hum: (s, w) => pad.hum(s, w), sunDir, narrator: (narrator = new Narrator({ sound, hud })), playFraming: { dist: PLAY_DIST, height: PLAY_HEIGHT, fov: 42 },
      // both title framings are close: the opening cuts to the colony drift
      titleStart: () => titleColonyPose(0, { pos: new THREE.Vector3(), look: new THREE.Vector3(), focus: new THREE.Vector3() }),
      startAct: DEBUG ? parseInt(url.get('act') || '0', 10) : 0,
      snapCamera: () => { camera.position.copy(story.cine.pos); camLook.copy(story.cine.look); camera.lookAt(camLook); },
    });
    hud.fade(1, 0);
    titleMode = true;
  } else {
    hud.fade(0, 0);
  }
  placeCameraInitial();
  setProgress(t('loading.shaders'), 0.9);
  updateEnv(); updateEnv();
  await renderer.compileAsync(scene, camera);
  setProgress('', 1);
  requestAnimationFrame(frame);
  // let a few frames render behind the black veil (shadow maps, reflections, first uploads)
  await new Promise((r) => setTimeout(r, 600));
  document.body.classList.add('ready');
  if (STORY) hud.fade(0, 2.8);
}
// the title theme starts with the first gesture on the page (browsers keep audio
// locked until then); Begin cross-fades it into the opening cue
const titleMusic = () => {
  if (!STORY || !params.sound || document.body.classList.contains('started')) return;
  sound.start();
  sound.playMusic('title', { loop: true, volume: 0.8, fadeIn: 4 });
};
window.addEventListener('pointerdown', titleMusic, { once: true });
window.addEventListener('keydown', titleMusic, { once: true });
const startBtn = document.getElementById('start');
startBtn?.addEventListener('click', () => {
  document.body.classList.add('started');
  if (params.sound) sound.start();
  narrator?.load(); // decode the recorded lines (subtitles show regardless)
  if (STORY) { titleMode = false; story.start(); }
  lockPointer();
});
// full screen: an icon on the title screen, a line in the pause menu, a switch in the options
{
  const pauseFs = document.getElementById('pause-fullscreen'), titleFs = document.getElementById('title-fullscreen');
  const sync = () => {
    const on = isFullscreen();
    document.body.classList.toggle('fullscreen', on);
    document.body.classList.toggle('no-fullscreen', !fullscreenSupported);
    pauseFs.textContent = t(on ? 'fs.exit' : 'fs.enter');
    titleFs.setAttribute('aria-label', t(on ? 'fs.exit' : 'fs.enter'));
    titleFs.title = t(on ? 'fs.exit' : 'fs.enter');
  };
  pauseFs.addEventListener('click', () => toggleFullscreen());
  titleFs.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });
  onFullscreenChange(sync);
  onLocaleChange(sync);
  sync();
}
// language toggle on the title screen: the EN/FR buttons follow the language wherever it
// is changed (title, options)
const syncLangButtons = () => document.querySelectorAll('.lang button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.locale === getLocale())));
onLocaleChange(syncLangButtons);
syncLangButtons();
document.querySelectorAll('.lang button').forEach((b) => b.addEventListener('click', () => setLocale(b.dataset.locale)));
// test harness handle (?debug only)
if (DEBUG) window.__sim = { params, penguin, camera, controls, deformer, heightfield, renderer, updateSun, sky, bloom, scene, water, sun, snowMat, composer, baker, sound, hud, weather,
  pacing: () => { const a = Array.from(pacing.buf.slice(0, Math.min(pacing.n, 1200))).sort((x, y) => x - y); const q = (f) => a[Math.min(a.length - 1, Math.floor(a.length * f))]; return { frames: pacing.n, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), max: +a[a.length - 1].toFixed(1), long: pacing.long.slice(-25) }; },
  resetPacing: () => { pacing.n = 0; pacing.long.length = 0; },
  // true cost of a frame: step N frames back to back, forcing the GPU to finish each one
  bench: (n = 60) => {
    const gl = renderer.getContext(), px = new Uint8Array(4), times = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      frame(performance.now(), true);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { median: +times[n >> 1].toFixed(2), p95: +times[Math.floor(n * 0.95)].toFixed(2), max: +times[n - 1].toFixed(2) };
  }, places: PLACES, get story() { return story; }, get colony() { return colony; }, snowNear, snowFar, get nearGrid() { return nearGrid; }, farGrid, applyQuality, get titleShot() { return titleShotKey; }, bergs: () => bergs(), keepCameraClear: (p) => keepCameraClear(p), waterTint: (n) => { applyWaterTint(water, n); envDirty = true; }, WATER_TINTS, get fur() { return fur; } };
boot().catch((err) => {
  console.error(err);
  setProgress(t('error.start') + ' ' + err.message);
});
