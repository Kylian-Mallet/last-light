import * as THREE from 'three';
import { gltfLoader } from './assets.js';
import { GpuSkinner } from './gpuskin.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { DEBUG } from './debug.js';
import { wrapAngle, weldPositions } from './util.js';

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/**
 * The walking style. stride scales the step length (shorter = quicker, shuffling steps);
 * hip = share of the leg swing taken at the hip (1 = the foot really travels as far as
 * the body moves, so it stays planted instead of skating; below 1 the ankle takes the
 * rest); flat = how much the ankle keeps the sole level; lift = swing-foot clearance;
 * roll/yaw/lean in degrees; bob = vertical rise over the stance leg (fraction of size);
 * flipOut (deg) / flipBack (rad) hold the flippers away from and behind the body,
 * flipSwing their counter-swing; headStab / spineRoll counter the roll so the head stays level.
 */
const GAIT = { stride: 1, hip: 0.55, flat: 0.82, lift: 0.3, roll: 8.5, yaw: 6, lean: 4, leanHurry: 0, bob: 0, flipOut: 4, flipBack: 0, flipSwing: 0.08, headStab: 0.55, spineRoll: 0.25 };

// Shared lighting uniforms for every penguin material (hero and colony).
export const PENGUIN_UNIFORMS = {
  uSunDirV: { value: new THREE.Vector3(0, 1, 0) },
  uSunRad: { value: new THREE.Color(1, 1, 1) },
  uSnowCover: { value: 0 }, // fresh snow settling on the plumage during the storm
};

/** Convert Meshy's PBR material to a sheen-lit plumage material (once per asset). */
function plumageMaterial(src, { fixRedEye = false } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    map: src.map,
    normalMap: src.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughnessMap: src.roughnessMap,
    roughness: 1.0,
    metalness: 0.0,
    sheen: 1.0,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0.85, 0.85, 0.88),
    side: THREE.FrontSide,
  });
  if (m.map) m.map.anisotropy = 8;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, PENGUIN_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vUpW;')
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\nvUpW = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunDirV;\nuniform vec3 uSunRad;\nuniform float uSnowCover;\nvarying vec3 vUpW;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        #ifdef FIX_RED_EYE
          // generated texture artefact: a saturated red pupil. Real chicks have dark eyes.
          if (diffuseColor.r > 0.2 && diffuseColor.r > diffuseColor.g * 1.9 && diffuseColor.r > diffuseColor.b * 1.9) diffuseColor.rgb = vec3(0.025, 0.022, 0.02);
        #endif
        // snow settles on upward-facing plumage
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), uSnowCover * smoothstep(0.15, 0.7, vUpW.y));`)
      .replace('#include <opaque_fragment>', `
        {
          vec3 Vv = normalize(vViewPosition);
          float back = pow(clamp(dot(Vv, normalize(uSunDirV)), 0.0, 1.0), 3.0);
          float rim = pow(clamp(1.0 - abs(dot(normal, -Vv)), 0.0, 1.0), 2.5);
          outgoingLight += uSunRad * diffuseColor.rgb * back * rim * 0.06;
        }
        #include <opaque_fragment>`);
  };
  if (fixRedEye) m.defines = { ...(m.defines || {}), FIX_RED_EYE: '' };
  m.customProgramCacheKey = () => 'plumage' + (fixRedEye ? '-eye' : '');
  return m;
}

function smoothDamp(cur, target, rate, dt) {
  return target + (cur - target) * Math.exp(-rate * dt);
}

/**
 * Meshy's auto-skin binds a wide band of the upper flank to the flipper bones, so a
 * flipper held out drags the body into a triangle. The flipper itself is a thin, flat
 * blade: fit its plane (the vertices bound almost only to the arm chain), and hand the
 * arm weight of everything lying on the body side of that plane to the shoulder bone,
 * which does not move. A gradual blend keeps a soft root where the blade meets the body.
 */
function relaxFlipperWeights(mesh) {
  const g = mesh.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, pos = g.attributes.position;
  if (!si || !sw || !mesh.skeleton) return 0;
  const names = mesh.skeleton.bones.map((b) => b.name);
  g.computeBoundingBox();
  const H = g.boundingBox.max.y - g.boundingBox.min.y;
  // blade half-thickness ≈ 0.017·H; the blend into the body spans ~7 % of the height, wide
  // enough that a swinging flipper bends the flank gently instead of creasing the armpit
  const lo = -0.019 * H, hi = -0.09 * H;
  const v = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  let moved = 0;
  for (const side of ['Left', 'Right']) {
    const chain = ['Arm', 'ForeArm', 'Hand'].map((b) => names.indexOf(side + b)).filter((i) => i >= 0);
    const sh = names.indexOf(side + 'Shoulder');
    if (!chain.length || sh < 0) continue;
    const armW = (i) => { let w = 0; for (let k = 0; k < 4; k++) if (chain.includes(si.getComponent(i, k))) w += sw.getComponent(i, k); return w; };
    // the blade: centroid and least-variance direction (its normal)
    const core = [];
    for (let i = 0; i < pos.count; i++) if (armW(i) > 0.97) core.push(i);
    if (core.length < 50) continue;
    c.set(0, 0, 0);
    for (const i of core) c.add(v.fromBufferAttribute(pos, i));
    c.divideScalar(core.length);
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const i of core) {
      v.fromBufferAttribute(pos, i).sub(c);
      const a = [v.x, v.y, v.z];
      for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) m[r * 3 + q] += a[r] * a[q];
    }
    const tr = m[0] + m[4] + m[8];
    n.set(1, 0, 0);
    for (let it = 0; it < 60; it++) { // power iteration on (tr·I − M): its top vector is M's smallest
      const { x, y, z } = n;
      n.set(tr * x - (m[0] * x + m[1] * y + m[2] * z), tr * y - (m[3] * x + m[4] * y + m[5] * z), tr * z - (m[6] * x + m[7] * y + m[8] * z)).normalize();
    }
    if (n.x * c.x < 0) n.negate(); // pointing away from the body
    for (let i = 0; i < pos.count; i++) {
      if (armW(i) < 1e-4) continue;
      const d = v.fromBufferAttribute(pos, i).sub(c).dot(n);
      const t = THREE.MathUtils.clamp((d - lo) / (hi - lo), 0, 1);
      const b = t * t * (3 - 2 * t); // 0 on the blade, 1 well inside the body
      if (b <= 0) continue;
      moved++;
      // move the share b of the arm weight to the shoulder, then keep the four largest
      // influences: always a continuous change, so neighbouring vertices never split apart
      const ws = new Map();
      for (let k = 0; k < 4; k++) {
        const bone = si.getComponent(i, k), w = sw.getComponent(i, k);
        if (w <= 0) continue;
        if (chain.includes(bone)) {
          ws.set(bone, (ws.get(bone) || 0) + w * (1 - b));
          ws.set(sh, (ws.get(sh) || 0) + w * b);
        } else ws.set(bone, (ws.get(bone) || 0) + w);
      }
      const top = [...ws].sort((x, y) => y[1] - x[1]).slice(0, 4);
      const sum = top.reduce((s, e) => s + e[1], 0) || 1;
      for (let k = 0; k < 4; k++) {
        si.setComponent(i, k, top[k] ? top[k][0] : 0);
        sw.setComponent(i, k, top[k] ? top[k][1] / sum : 0);
      }
    }
  }
  si.needsUpdate = sw.needsUpdate = true;
  return moved;
}

/**
 * Generated meshes sometimes ship with pinholes (a few missing triangles). Find small
 * boundary loops on the position-welded surface and cap them with a triangle fan.
 */
function fillSmallHoles(geo, maxLoop = 16) {
  const pos = geo.attributes.position, index = geo.index;
  if (!index) return 0;
  const idx = index.array;
  const { weld, count: N } = weldPositions(pos, 2e4);
  const edges = new Map(); // directed welded edge → original start/end vertex
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e], b = idx[t + (e + 1) % 3];
      if (weld[a] !== weld[b]) edges.set(weld[a] * N + weld[b], [a, b]);
    }
  }
  const next = new Map(); // boundary: welded start → [original start, original end]
  for (const [a, b] of edges.values()) {
    if (!edges.has(weld[b] * N + weld[a])) next.set(weld[a], [a, b]);
  }
  const extra = [];
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let cur = start, ok = false;
    for (let guard = 0; guard <= maxLoop; guard++) {
      const e = next.get(cur);
      if (!e || seen.has(cur)) break;
      seen.add(cur);
      loop.push(e[0]);
      cur = weld[e[1]];
      if (cur === start) { ok = true; break; }
    }
    if (!ok || loop.length < 3) continue;
    for (let i = 1; i < loop.length - 1; i++) extra.push(loop[0], loop[i + 1], loop[i]);
  }
  if (extra.length) {
    const Arr = pos.count > 65535 ? Uint32Array : idx.constructor;
    const merged = new Arr(idx.length + extra.length);
    merged.set(idx); merged.set(extra, idx.length);
    geo.setIndex(new THREE.BufferAttribute(merged, 1));
  }
  return extra.length / 3;
}

/** Loads the Meshy-rigged chick and drives it with a procedural penguin gait. */
export class Penguin {
  /** Load a Meshy-rigged GLB once; instances are cloned from it. */
  static async loadAsset(url, onProgress, opts) {
    const gltf = await gltfLoader().loadAsync(url, onProgress);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.material = plumageMaterial(o.material, opts);
      const filled = fillSmallHoles(o.geometry);
      if (filled && DEBUG) console.info(`[mesh] ${url}: capped ${filled} missing triangle(s)`);
      if (o.isSkinnedMesh) relaxFlipperWeights(o);
    });
    return gltf.scene;
  }

  /**
   * @param {object} opts height: standing height in metres (gait scales with it)
   */
  constructor({ height = 0.45 } = {}) {
    const s = height / 0.45;
    this.size = s;
    this.cfg = {
      walk: 0.26 * Math.sqrt(s), // m/s, emperor chick shuffle
      hurry: 0.45 * Math.sqrt(s),
      step: 0.085 * s, // m per step
      leg: 0.095 * s, // hip → sole
    };
    this.root = new THREE.Group(); // world position + heading
    this.pose = new THREE.Group(); // belly-slide pitch, pivot at the body centre
    this.poseInner = new THREE.Group();
    this.waddle = new THREE.Group(); // roll pivot under the stance foot
    this.root.add(this.pose);
    this.pose.add(this.poseInner);
    this.poseInner.add(this.waddle);
    this.kickPhase = 0;

    this.heading = 0.6;
    this.gait = GAIT;
    this.speed = 0;
    this.targetSpeed = 0;
    this.turnRate = 0;
    this.phase = 0;
    this.gaitAmp = 0;
    this.slide = 0;
    this.sliding = false;
    this.slideTime = 0;
    this.time = 0;
    this.lastPlantPhase = 0;
    this.slideDist = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.lookTarget = new THREE.Vector2();
    this.flap = 0;
    this.onFootPlant = null; // (side, worldPos, heading, strength)
    this.onBelly = null; // (worldPos, heading)
  }

  async load(url, onProgress) {
    const asset = await Penguin.loadAsset(url, onProgress);
    return this.setup(asset);
  }

  /** Attach a model (an asset, or a skeleton-aware clone of one). */
  setup(model, clone = false) {
    if (clone) model = SkeletonUtils.clone(model);
    this.model = model;
    this.bones = {};
    model.traverse((o) => {
      if (o.isBone) this.bones[o.name] = o;
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
      }
    });
    model.updateMatrixWorld(true);
    // rest pose + parent orientation (model space) for character-space rotations
    const modelInv = model.getWorldQuaternion(new THREE.Quaternion()).invert();
    for (const b of Object.values(this.bones)) {
      b.userData.rest = b.quaternion.clone();
      const pq = b.parent.getWorldQuaternion(new THREE.Quaternion());
      b.userData.parentQ = modelInv.clone().multiply(pq);
      b.userData.parentQInv = b.userData.parentQ.clone().invert();
    }
    this.waddle.add(model);
    // measure foot spread for the waddle pivot
    const lf = this.bones.LeftFoot.getWorldPosition(new THREE.Vector3());
    const rf = this.bones.RightFoot.getWorldPosition(new THREE.Vector3());
    this.footHalfSpread = Math.max(0.02 * this.size, Math.abs(lf.x - rf.x) / 2);
    // collision body: a vertical cylinder fitted to the rest-pose mesh (torso depth and
    // flipper span, scaled to the standing height); the down may brush, bodies may not
    let sk = null;
    model.traverse((o) => { if (o.isSkinnedMesh && !sk) sk = o; });
    if (sk) {
      if (!sk.geometry.boundingBox) sk.geometry.computeBoundingBox();
      const bb = sk.geometry.boundingBox;
      const k = (0.45 * this.size) / Math.max(1e-6, bb.max.y - bb.min.y);
      const halfX = Math.max(-bb.min.x, bb.max.x) * k, depth = Math.max(-bb.min.z, bb.max.z) * k;
      this.bodyRadius = 0.5 * (halfX * 0.8 + depth) * 0.95;
    } else this.bodyRadius = 0.13 * this.size;
    this.time = Math.random() * 10;
    return this;
  }

  sunDirViewUniform = PENGUIN_UNIFORMS.uSunDirV;
  sunRadUniform = PENGUIN_UNIFORMS.uSunRad;

  /** Rotate a bone about a character-space axis (pivot = bone origin). */
  rotBone(name, axis, angle, accumulate = true) {
    const b = this.bones[name];
    if (!b) return;
    _q.setFromAxisAngle(axis, angle);
    // local delta = P^-1 * Q * P
    _q2.copy(b.userData.parentQInv).multiply(_q).multiply(b.userData.parentQ);
    if (accumulate) b.quaternion.premultiply(_q2);
    else b.quaternion.copy(_q2).multiply(b.userData.rest);
  }

  resetPose() {
    for (const b of Object.values(this.bones)) b.quaternion.copy(b.userData.rest);
  }

  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /**
   * input: { forward:-1..1, turn:-1..1, hurry:bool, slide:bool }
   * ground: { heightAt, normalAt }
   */
  update(dt, input, ground, bounds) {
    if (!this.model) return;
    this.time += dt;

    // --- locomotion -------------------------------------------------------
    if (input.slide && !this.sliding && this.slide < 0.05) {
      this.sliding = true;
      this.slideTime = 0;
      this.kickPhase = 0;
      this.speed = Math.max(this.speed, 0.5); // the dive itself carries momentum
    }
    // slope along the heading (rise over run, positive = uphill), from the snow surface
    const hx = Math.sin(this.heading), hz = Math.cos(this.heading), pp0 = this.root.position;
    const slope = (ground.heightAt(pp0.x + hx * 0.3, pp0.z + hz * 0.3) - ground.heightAt(pp0.x - hx * 0.3, pp0.z - hz * 0.3)) / 0.6;
    this.slope = smoothDamp(this.slope ?? slope, slope, 10, dt);
    if (this.sliding) {
      this.slideTime += dt;
      this.slideFree = input.slide ? 0 : (this.slideFree || 0) + dt;
      // let go: the belly digs in and the chick stops once it has slowed (a descent can
      // carry it a moment longer, never more than 2.5 s); held: it keeps tobogganing
      if ((this.slideFree > 0 && this.slideTime > 0.6 && this.speed < 0.25) || this.slideFree > 2.5 || this.slideTime > 14) this.sliding = false;
    }
    this.slide = smoothDamp(this.slide, this.sliding ? 1 : 0, this.sliding ? 5 : 3, dt);

    let target = input.forward > 0 ? (input.hurry ? this.cfg.hurry : this.cfg.walk) * input.forward : 0;
    // walking: slower up a drift, a little quicker down it
    target *= THREE.MathUtils.clamp(1 - this.slope * 2.2, 0.5, 1.3);
    if (this.slide > 0.5) {
      // tobogganing: gravity along the slope (snow is slippery, belly on it: ~g·sinθ
      // minus a little), snow friction and drag decelerate, alternate foot kicks push
      const gravity = -9.81 * (this.slope / Math.sqrt(1 + this.slope * this.slope)) * 0.55;
      const brake = this.sliding && !input.slide ? 0.9 : 0; // key released: slow down
      this.speed = Math.max(0, Math.min(3.2, this.speed + dt * (gravity - 0.35 - brake - 0.6 * this.speed * this.speed)));
      const prevK = this.kickPhase;
      this.kickPhase += dt * 2.6;
      // the feet only push while the slide key is held
      if (this.sliding && input.slide && Math.floor(this.kickPhase) !== Math.floor(prevK)) {
        this.speed = Math.max(this.speed, Math.min(1.1, this.speed + 0.2)); // kicks help on the flat, never brake a descent
        this.onKick?.(Math.floor(this.kickPhase) % 2 === 0 ? 'L' : 'R');
      }
    } else {
      this.speed = smoothDamp(this.speed, target, 4, dt);
    }
    // big birds turn slower; a pivot on the spot is a shuffle of small steps, each one
    // swinging the body round while a foot is planted (not a turntable spin)
    const maxTurn = (this.sliding ? 0.5 : 1.4) / Math.sqrt(Math.max(1, this.size));
    this.turnRate = smoothDamp(this.turnRate, input.turn * maxTurn, this.size > 1.5 ? 4 : 6, dt);
    const pivot = 1 - THREE.MathUtils.clamp(this.speed / (0.5 * this.cfg.walk), 0, 1);
    const shuffle = this.sliding ? 1 : 1 + 0.3 * pivot * Math.cos(this.phase * Math.PI * 4);
    this.heading += this.turnRate * shuffle * dt;

    const fwd = this.forward(_v);
    const p = this.root.position;
    let nx = p.x + fwd.x * this.speed * dt + (this.push ? this.push.x * dt : 0);
    let nz = p.z + fwd.z * this.speed * dt + (this.push ? this.push.z * dt : 0);
    // stay on the walkable part of the floe: steer back along the boundary
    if (!bounds(nx, nz)) {
      nx = p.x; nz = p.z;
      this.speed *= 0.5;
      if (this.sliding) this.sliding = false;
    }
    p.x = nx; p.z = nz;
    // gentle slope alignment, chick sinks a little into soft snow
    const gh = ground.heightAt(p.x, p.z);
    p.y = gh - 0.012 * Math.sqrt(this.size);
    const n = ground.normalAt(p.x, p.z, _v2);
    // slope alignment, low-passed: the height-field normal changes cell by cell
    this.tiltX = smoothDamp(this.tiltX ?? 0, Math.atan2(n.z * Math.cos(this.heading) + n.x * Math.sin(this.heading), n.y) * 0.5, 5, dt);
    this.tiltZ = smoothDamp(this.tiltZ ?? 0, Math.atan2(n.x * Math.cos(this.heading) - n.z * Math.sin(this.heading), n.y) * 0.5, 5, dt);
    const tiltX = this.tiltX, tiltZ = this.tiltZ;
    this.root.rotation.set(0, this.heading, 0);

    // --- gait ---------------------------------------------------------------
    // turning drives the feet too: about one short step per 25° of yaw
    const turnDrive = Math.abs(this.turnRate) * this.cfg.step * 2.3;
    const drive = this.speed + turnDrive;
    const walking = drive > (this.wasWalking ? 0.02 : 0.04) && !this.sliding;
    this.wasWalking = walking;
    const ampTarget = Math.min(1, this.speed / this.cfg.walk) + Math.min(0.55, turnDrive / this.cfg.walk) * (1 - Math.min(1, this.speed / this.cfg.walk));
    this.gaitAmp = smoothDamp(this.gaitAmp, walking ? Math.min(1, ampTarget) : 0, 6, dt);
    const g = this.gait;
    const stride = 2 * this.cfg.step * g.stride * (0.8 + 0.2 * this.gaitAmp);
    const prevPhase = this.phase;
    if (walking) this.phase = (this.phase + (drive * dt) / stride) % 1;
    else if (this.gaitAmp < 0.05) this.phase = smoothDamp(this.phase, this.phase < 0.5 ? 0.25 : 0.75, 2, dt);

    // foot plant events: left at phase 0, right at phase 0.5
    if (walking && this.gaitAmp > 0.3) {
      const crossed = (a, b, t) => (a <= t && b > t) || (a > b && (t >= a || t < b));
      if (crossed(prevPhase, this.phase, 0.0) || (prevPhase > 0.9 && this.phase < 0.1)) this.plant('L');
      if (crossed(prevPhase, this.phase, 0.5)) this.plant('R');
    }

    const amp = this.gaitAmp;
    const s = Math.sin(this.phase * Math.PI * 2); // + during left stance

    // waddle: body rocks over the stance foot, yaws with each step
    const rollAmp = THREE.MathUtils.degToRad(g.roll) * amp;
    // lean into a curve (centripetal), and the body leads the turn a little
    this.turnLean = smoothDamp(this.turnLean || 0, THREE.MathUtils.clamp(this.turnRate * this.speed * 0.9, -0.12, 0.12), 5, dt);
    this.turnLead = smoothDamp(this.turnLead || 0, THREE.MathUtils.clamp(this.turnRate * 0.16, -0.14, 0.14), 5, dt);
    const roll = -rollAmp * s - this.turnLean;
    // the body rocks over the stance foot; the pivot slides from one foot to the other
    // instead of jumping at each footfall (a jump shows as a hop whenever the body is
    // also leaning, turning or standing on a slope)
    this.waddle.position.set(this.footHalfSpread * THREE.MathUtils.clamp(s * 1.5, -1, 1), 0, 0);
    // the body rises a touch over the stance leg (mid-stance at phase 0.25 / 0.75)
    this.model.position.set(-this.waddle.position.x, -g.bob * this.size * amp * Math.cos(this.phase * Math.PI * 4), 0);
    const hurryK = THREE.MathUtils.clamp((this.speed - this.cfg.walk) / Math.max(1e-3, this.cfg.hurry - this.cfg.walk), 0, 1);
    this.waddle.rotation.set(
      THREE.MathUtils.degToRad(g.lean + g.leanHurry * hurryK) * amp + tiltX,
      THREE.MathUtils.degToRad(g.yaw) * amp * s + this.turnLead,
      roll + tiltZ,
      'YXZ',
    );

    // belly slide: pitch forward about the body centre so the belly settles
    // into its own trough (pivot height C, belly radius R below the centre after pitching)
    const C = 0.16 * this.size, R = 0.125 * this.size, SINK = 0.035 * this.size;
    const sl = THREE.MathUtils.smoothstep(this.slide, 0, 1);
    const slideAngle = THREE.MathUtils.degToRad(84) * sl;
    this.pose.position.set(0, C - (C - R * Math.sin(slideAngle) + SINK) * sl, 0);
    this.poseInner.position.set(0, -C, 0);
    this.pose.rotation.set(slideAngle, 0, Math.sin(this.kickPhase * Math.PI) * 0.05 * sl);
    if (this.slide > 0.6) {
      this.slideDist += this.speed * dt;
      if (this.slideDist > 0.025) {
        this.slideDist = 0;
        const c = this.root.localToWorld(_v.set(0, 0, R * Math.cos(slideAngle) + 0.02 * this.size));
        this.onBelly?.(c, this.heading);
      }
    }

    // --- skeleton -----------------------------------------------------------
    this.resetPose();
    const legPose = (side, ph) => {
      // ph: 0..1, stance [0,0.5), swing [0.5,1)
      let f, lift;
      if (ph < 0.5) { f = THREE.MathUtils.lerp(0.5, -0.5, ph / 0.5); lift = 0; }
      else { const t = (ph - 0.5) / 0.5; f = -0.5 + (0.5 - 0.5 * Math.cos(t * Math.PI)); lift = Math.sin(t * Math.PI); }
      const off = f * this.cfg.step * g.stride * amp;
      const pitch = -Math.asin(THREE.MathUtils.clamp(off / this.cfg.leg, -0.9, 0.9));
      const up = side === 'L' ? 'LeftUpLeg' : 'RightUpLeg';
      const foot = side === 'L' ? 'LeftFoot' : 'RightFoot';
      const toe = side === 'L' ? 'LeftToeBase' : 'RightToeBase';
      // the leg skin also drives the lower belly: keep hip rotation small and
      // let the ankle carry the rest so the body silhouette stays round
      this.rotBone(up, X, pitch * g.hip);
      this.rotBone(foot, X, -pitch * g.hip * g.flat - g.lift * lift * amp);
      this.rotBone(up, Z, (side === 'L' ? 1 : -1) * 0.06 * lift * amp);
      this.rotBone(toe, X, -0.2 * lift * amp);
    };
    if (this.slide < 0.5) {
      legPose('L', this.phase);
      legPose('R', (this.phase + 0.5) % 1);
    } else {
      // feet trail behind the body and push alternately against the snow
      const k = Math.sin(this.kickPhase * Math.PI);
      this.rotBone('LeftUpLeg', X, -0.15 + 0.25 * Math.max(0, k));
      this.rotBone('RightUpLeg', X, -0.15 + 0.25 * Math.max(0, -k));
      this.rotBone('LeftFoot', X, -0.5 - 0.5 * Math.max(0, k));
      this.rotBone('RightFoot', X, -0.5 - 0.5 * Math.max(0, -k));
    }

    // flippers held out for balance, counter-swinging with the roll
    this.flap = smoothDamp(this.flap, 0, 2, dt);
    if (!walking && !this.sliding && Math.random() < dt * 0.08) this.flap = 1;
    // Meshy's auto-skin lets the arm bones pull on the flank, so flipper motion is kept
    // small (a few degrees) and mostly a fore-aft swing, which deforms the body least.
    const flapOsc = this.flap * Math.sin(this.time * 16) * 0.12;
    const kick = Math.sin(this.kickPhase * Math.PI);
    const out = THREE.MathUtils.degToRad(3 + g.flipOut * amp + 10 * sl) + flapOsc;
    this.rotBone('LeftArm', Z, out - roll * 0.35);
    this.rotBone('RightArm', Z, -out - roll * 0.35);
    this.rotBone('LeftArm', X, -g.flipSwing * amp * s + g.flipBack * amp + sl * (0.15 + 0.12 * kick));
    this.rotBone('RightArm', X, g.flipSwing * amp * s + g.flipBack * amp + sl * (0.15 - 0.12 * kick));

    // spine & head: stabilise gaze, idle curiosity
    if (!walking && !this.gaze && Math.random() < dt * 0.4) this.lookTarget.set((Math.random() - 0.5) * 1.6, (Math.random() - 0.3) * 0.5);
    if (this.gaze) {
      // look at a world point: yaw relative to the body, pitch from the height difference
      const gx = this.gaze.x - p.x, gz = this.gaze.z - p.z, gd = Math.hypot(gx, gz);
      let gy = Math.atan2(gx, gz) - this.heading;
      gy = wrapAngle(gy);
      const headY = p.y + 0.4 * this.size;
      this.lookTarget.set(THREE.MathUtils.clamp(gy, -1.3, 1.3), THREE.MathUtils.clamp(-Math.atan2(this.gaze.y - headY, Math.max(gd, 0.05)), -0.7, 0.6));
    }
    // idle life: preening and flipper stretches between walks
    const calm = !walking && !this.sliding && !(this.hunker > 0.3) && !this.gaze;
    this.idleT = (this.idleT ?? 3 + Math.random() * 8) - dt;
    // interrupted (starts walking, looks at something): ease out of the preen / stretch
    // over half a second instead of snapping back
    if (!calm && this.idleAct) this.idleAct.out = true;
    if (calm && !this.idleAct && this.idleT <= 0) {
      const r = Math.random();
      this.idleAct = r < 0.5 ? { type: 'preen', t: 0, dur: 2.6 + Math.random() * 1.8, side: Math.random() < 0.5 ? -1 : 1, low: Math.random() } : { type: 'stretch', t: 0, dur: 1.8 + Math.random() };
      this.idleT = 7 + Math.random() * 12;
    }
    let preenYaw = 0, preenPitch = 0, stretch = 0;
    if (this.idleAct) {
      const a = this.idleAct;
      a.t += dt;
      if (a.out) a.mult = Math.max(0, (a.mult ?? 1) - dt / 0.5);
      const k = Math.sin(Math.PI * Math.min(1, a.t / a.dur));
      const e = k * k * (3 - 2 * k) * (a.mult ?? 1);
      if (a.type === 'preen') {
        preenYaw = a.side * (1.05 + 0.3 * a.low) * e;
        preenPitch = (0.45 + 0.45 * a.low) * e + Math.sin(this.time * 15) * 0.07 * e; // nibbling
      } else stretch = e;
      if (a.t >= a.dur || a.mult === 0) this.idleAct = null;
    }
    if (walking) this.lookTarget.multiplyScalar(Math.exp(-dt * 2));
    if (this.chirpTime > 0) { this.chirpTime -= dt; if (this.chirpTime <= 0) this.lookTarget.y = 0; }
    this.lookYaw = smoothDamp(this.lookYaw, this.lookTarget.x, 3, dt);
    this.lookPitch = smoothDamp(this.lookPitch, this.lookTarget.y, 3, dt);
    this.rotBone('Spine01', Z, -roll * g.spineRoll);
    this.rotBone('neck', Z, -roll * g.headStab);
    const yaw = this.lookYaw + preenYaw;
    this.rotBone('neck', Y, yaw * 0.4);
    this.rotBone('neck', X, preenPitch * 0.35 - 0.18 * stretch);
    this.rotBone('Head', Y, yaw * 0.6);
    if (preenPitch) this.rotBone('Head', X, preenPitch * 0.65);
    if (stretch) {
      // flippers out and a small shiver
      const sh = Math.sin(this.time * 22) * 0.05 * stretch;
      this.rotBone('LeftArm', Z, 0.3 * stretch + sh);
      this.rotBone('RightArm', Z, -0.3 * stretch + sh);
    }
    this.rotBone('neck', X, -0.55 * sl);
    this.rotBone('Head', X, this.lookPitch - 0.45 * sl + Math.sin(this.time * 2.1) * 0.02);
    // breathing
    this.rotBone('Spine02', X, Math.sin(this.time * 2.6) * 0.012);
    // hunkering against the cold: head drawn in, flippers pressed to the body
    const hk = this.hunker || 0;
    if (hk > 0.01) {
      this.rotBone('neck', X, 0.3 * hk);
      this.rotBone('Head', X, 0.35 * hk);
      this.rotBone('Spine02', X, 0.08 * hk);
      this.rotBone('LeftArm', Z, -0.08 * hk);
      this.rotBone('RightArm', Z, 0.08 * hk);
    }
    // shaking off the snow (finale): quick body shimmy
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      const sh = Math.sin(this.time * 38) * Math.min(1, this.shake) * 0.12;
      this.rotBone('Spine01', Y, sh);
      this.rotBone('neck', Y, -sh * 1.5);
      this.flap = Math.max(this.flap, Math.min(1, this.shake));
    }
  }

  /**
   * Replace the SkinnedMesh draw by a plain mesh reading GPU-skinned vertices, so the
   * 210k-vertex skin is evaluated once per frame instead of once per pass (main, shadow,
   * reflection, fur shells).
   */
  enableGpuSkinning(renderer) {
    let sk = null;
    this.model.traverse((o) => { if (o.isSkinnedMesh && !sk) sk = o; });
    if (!sk) return;
    this.skinnedMesh = sk;
    this.skinner = new GpuSkinner(renderer, sk);
    const g = new THREE.BufferGeometry();
    g.setIndex(sk.geometry.index);
    for (const k of ['position', 'normal', 'uv']) g.setAttribute(k, sk.geometry.attributes[k]);
    this.skinner.patch(sk.material);
    const body = new THREE.Mesh(g, sk.material);
    body.castShadow = true;
    body.receiveShadow = true;
    body.frustumCulled = false;
    const depth = new THREE.MeshDepthMaterial();
    this.skinner.patch(depth);
    body.customDepthMaterial = depth;
    sk.parent.add(body);
    body.position.copy(sk.position);
    body.quaternion.copy(sk.quaternion);
    body.scale.copy(sk.scale);
    sk.visible = false;
    this.body = body;
  }

  /** Calling: head up, beak raised, a quick flipper flutter. */
  chirp() {
    this.lookTarget.set(this.lookTarget.x * 0.3, -0.45);
    this.flap = 0.6;
    this.chirpTime = 0.9;
  }

  plant(side) {
    if (!this.onFootPlant) return;
    this.model.updateMatrixWorld(true);
    const foot = this.bones[side === 'L' ? 'LeftFoot' : 'RightFoot'].getWorldPosition(new THREE.Vector3());
    const toe = this.bones[side === 'L' ? 'LeftToeBase' : 'RightToeBase'].getWorldPosition(new THREE.Vector3());
    const c = foot.lerp(toe, 0.5);
    const toeOut = (side === 'L' ? 1 : -1) * THREE.MathUtils.degToRad(9 + Math.random() * 6);
    this.onFootPlant(side, c, this.heading + toeOut, this.speed);
  }
}
