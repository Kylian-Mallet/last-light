import * as THREE from 'three';
import { floeSdf } from './terrain.js';

// Adults going to sea: two ways off the floe edge.
// The ice lip sits ~0.6 m above the water. Each style drives the whole body directly:
// the body centre (pivot of penguin.pose, C above the feet), the pitch about it
// (+ = head forward and down), and a handful of bones; the walk cycle is off meanwhile.
//
//   A · head first   — peers over, crouches, springs out and down, flippers swept back
//   B · feet first   — a short upright hop, flippers raised, drops in standing
//
// Each adult picks one at random, so the file going to sea does not dive in unison.

const G = 9.81;
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const smooth = (x) => x * x * (3 - 2 * x);
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

/** Start state for a dive from where the penguin stands now. */
export function beginDive(p, style, heightfield) {
  const pos = p.root.position;
  // face straight out to sea: the outward normal of the coastline (down the distance field)
  const e = 0.25;
  const out = new THREE.Vector3(
    floeSdf(pos.x - e, pos.z) - floeSdf(pos.x + e, pos.z), 0,
    floeSdf(pos.x, pos.z - e) - floeSdf(pos.x, pos.z + e),
  ).normalize();
  const heading = Math.atan2(out.x, out.z);
  const lip = Math.max(0.05, floeSdf(pos.x, pos.z) + 0.03); // metres to the edge of the lip
  const ground = heightfield.heightAt(pos.x, pos.z);
  const lipY = heightfield.heightAt(pos.x + out.x * (lip - 0.1), pos.z + out.z * (lip - 0.1));
  const s = p.size;
  return {
    style, t: 0, done: false,
    from: pos.clone(), fwd: out, heading, lip, ground, lipY,
    C: 0.16 * s, H: 0.45 * s, R: 0.125 * s, // body centre height, standing height, belly radius
    // integrated free flight (set at take-off)
    c: new THREE.Vector3(), v: new THREE.Vector3(), pitch: 0, pitchV: 0,
    airborne: false, inWater: false, tWater: 0, splashes: 0,
  };
}

/**
 * Advance one frame. fx: { splash(pos, kind, strength) }. Returns true when the
 * penguin is out of sight under the water.
 */
export function stepDive(p, d, dt, fx) {
  d.t += dt;
  p.resetPose();
  p.waddle.rotation.set(0, 0, 0);
  p.waddle.position.set(0, 0, 0);
  p.poseInner.position.set(0, -d.C, 0);
  p.heading = d.heading;
  p.root.rotation.y = d.heading;
  const fn = d.style === 'B' ? diveB : diveA;
  fn(p, d, dt, fx);
  // place: body centre + pitch about it
  p.pose.position.set(0, d.C, 0);
  p.pose.rotation.set(d.pitch, 0, d.roll || 0);
  p.root.position.set(d.c.x, d.c.y - d.C, d.c.z);
  return d.done;
}

// --- shared pieces ---------------------------------------------------------------

/** Body centre standing on the ice, `along` metres out from the start. */
function standAt(d, along, crouch = 0) {
  d.c.copy(d.from).addScaledVector(d.fwd, along);
  d.c.y = d.ground + (d.lipY - d.ground) * clamp01(along / d.lip) + d.C - crouch;
}

/** A point on the body axis, `k` × standing height above the feet (0 feet, 1 crown). */
function axisPoint(d, k, out) {
  const a = (k * d.H) - d.C; // from the centre along the body axis
  return out.copy(d.c).addScaledVector(d.fwd, Math.sin(d.pitch) * a).setY(d.c.y + Math.cos(d.pitch) * a);
}

/** Free flight + water: ballistic in air, heavy drag and a little buoyancy in water. */
function fly(d, dt, { pitchTo = null, pitchRate = 4, water = {} } = {}) {
  if (!d.inWater) {
    d.v.y -= G * dt;
  } else {
    const drag = water.drag ?? 3.2;
    d.v.multiplyScalar(Math.exp(-drag * dt));
    d.v.y += (water.sink ?? -0.6) * dt;
    if (water.glide) d.v.addScaledVector(d.fwd, water.glide * dt);
  }
  d.c.addScaledVector(d.v, dt);
  if (pitchTo != null) d.pitch += (pitchTo - d.pitch) * (1 - Math.exp(-pitchRate * dt));
}

/** Pitch that lines the body up with the velocity (head leading). */
const alongVelocity = (d) => Math.atan2(d.v.dot(d.fwd), d.v.y);

function enterWater(d, fx, kind, strength, at) {
  d.inWater = true;
  d.tWater = d.t;
  fx.splash(at.clone().setY(0.02), kind, strength, d.fwd);
}

/** Out of sight: deep enough under the dark water, or long enough after the entry. */
function goneUnder(d, depth = -0.75, after = 1.4) {
  if (d.inWater && (d.c.y < depth || d.t - d.tWater > after)) d.done = true;
}

function flippers(p, out, back) {
  p.rotBone('LeftArm', Z, out);
  p.rotBone('RightArm', Z, -out);
  p.rotBone('LeftArm', X, back);
  p.rotBone('RightArm', X, back);
}
function legs(p, hip, foot, kick = 0) {
  p.rotBone('LeftUpLeg', X, hip + kick);
  p.rotBone('RightUpLeg', X, hip - kick);
  p.rotBone('LeftFoot', X, foot);
  p.rotBone('RightFoot', X, foot);
}
function neck(p, spine, neckX, head) {
  p.rotBone('Spine', X, spine);
  p.rotBone('neck', X, neckX);
  p.rotBone('Head', X, head);
}
/** A short shuffle: a little roll and alternating feet while the centre moves. */
function shuffle(p, d, k, steps) {
  const ph = k * steps * Math.PI;
  const s = Math.sin(ph);
  d.roll = s * 0.09 * (1 - k * 0.3);
  p.rotBone('LeftUpLeg', X, Math.max(0, s) * 0.35);
  p.rotBone('RightUpLeg', X, Math.max(0, -s) * 0.35);
  p.rotBone('LeftFoot', X, -Math.max(0, s) * 0.3);
  p.rotBone('RightFoot', X, -Math.max(0, -s) * 0.3);
}

// --- A · head first ---------------------------------------------------------------
function diveA(p, d, dt, fx) {
  const t = d.t;
  const walkEnd = 0.25 + d.lip * 2.6; // shuffle up to the lip
  if (!d.airborne) {
    const kw = seg(t, 0, walkEnd);
    const peer = seg(t, walkEnd, walkEnd + 0.7); // looks down at the water
    const crouch = smooth(seg(t, walkEnd + 0.7, walkEnd + 1.05));
    standAt(d, (d.lip - 0.12) * smooth(kw), 0.12 * crouch);
    d.roll = 0;
    if (kw < 1) shuffle(p, d, kw, Math.max(2, Math.round(d.lip * 6)));
    d.pitch = 0.18 * smooth(peer) + 0.32 * crouch;
    neck(p, 0.12 * peer, 0.35 * peer - 0.15 * crouch, 0.35 * peer - 0.25 * crouch);
    flippers(p, 0.12 + 0.1 * crouch, 0.3 * crouch); // swung back, ready
    legs(p, 0.35 * crouch, -0.35 * crouch);
    if (t >= walkEnd + 1.05) {
      d.airborne = true;
      d.v.copy(d.fwd).multiplyScalar(1.9);
      d.v.y = 1.7;
    }
    return;
  }
  // flight: stretched like an arrow, flippers swept back, feet trailing
  fly(d, dt, { pitchTo: d.inWater ? 2.0 : alongVelocity(d), pitchRate: d.inWater ? 2.5 : 9, water: { drag: 1.6, sink: -1.2, glide: 1.5 } });
  neck(p, -0.05, -0.18, -0.12);
  flippers(p, -0.04, 0.08); // pressed along the flanks (the rest pose already points them at the feet)
  legs(p, -0.15, -0.5);
  if (!d.inWater && axisPoint(d, 0.95, _v).y < 0) enterWater(d, fx, 'clean', 0.8, _v);
  if (d.inWater && d.splashes === 0 && axisPoint(d, 0.05, _w).y < 0) { d.splashes = 1; fx.splash(_w.clone().setY(0.02), 'trail', 0.35, d.fwd); }
  goneUnder(d, -0.8, 1.2);
}

// --- B · feet first ---------------------------------------------------------------
function diveB(p, d, dt, fx) {
  const t = d.t;
  const walkEnd = 0.25 + d.lip * 2.6;
  if (!d.airborne) {
    const kw = seg(t, 0, walkEnd);
    const look = seg(t, walkEnd, walkEnd + 0.5);
    const crouch = smooth(seg(t, walkEnd + 0.5, walkEnd + 0.85));
    standAt(d, (d.lip - 0.1) * smooth(kw), 0.13 * crouch);
    d.roll = 0;
    if (kw < 1) shuffle(p, d, kw, Math.max(2, Math.round(d.lip * 6)));
    d.pitch = 0.08 * look + 0.22 * crouch;
    neck(p, 0.05 * look, 0.25 * look - 0.1 * crouch, 0.25 * look);
    flippers(p, 0.15 + 0.25 * crouch, 0.25 * crouch);
    legs(p, 0.5 * crouch, -0.5 * crouch);
    if (t >= walkEnd + 0.85) {
      d.airborne = true;
      d.v.copy(d.fwd).multiplyScalar(1.05);
      d.v.y = 2.0;
    }
    return;
  }
  // upright flight: flippers flung up and out, feet together, a slight backward lean on the drop
  fly(d, dt, { pitchTo: d.inWater ? 0.0 : (d.v.y > 0 ? 0.1 : -0.08), pitchRate: 5, water: { drag: 4.5, sink: -1.6 } });
  const up = d.inWater ? Math.max(0, 1 - (d.t - d.tWater) * 2) : 1;
  neck(p, -0.04, -0.12 * up, 0.1 * up);
  flippers(p, 0.25 + 0.75 * up, -0.2 * up);
  legs(p, 0.05, 0.25);
  if (!d.inWater && axisPoint(d, 0.0, _v).y < 0) enterWater(d, fx, 'plop', 1.0, _v);
  if (d.inWater && d.splashes === 0 && d.t - d.tWater > 0.32) { d.splashes = 1; fx.splash(axisPoint(d, 0.9, _w).setY(0.02), 'column', 0.55, d.fwd); }
  goneUnder(d, -0.7, 1.2);
}

// --- splashes ---------------------------------------------------------------------

const SPLASH = {
  clean: { n: 34, speed: 1.4, spread: 0.45, up: 1.7, size: 0.012, life: 0.9, ring: 0.9 },
  trail: { n: 12, speed: 0.8, spread: 0.5, up: 1.0, size: 0.009, life: 0.6, ring: 0.5 },
  plop: { n: 46, speed: 1.7, spread: 0.75, up: 1.9, size: 0.013, life: 1.0, ring: 1.2 },
  column: { n: 26, speed: 1.3, spread: 0.12, up: 3.2, size: 0.012, life: 1.0, ring: 0 },
};

/**
 * Splash effects: spray droplets (the shared snow-spray particles), an expanding
 * ring on the water and the splash sound.
 */
export class SplashFx {
  /** rumble(strong, weak, ms): optional controller rumble for nearby splashes. */
  constructor({ scene, spray, sound, camera, rumble = null }) {
    Object.assign(this, { spray, sound, camera, rumble });
    this.rings = [];
    const geo = new THREE.RingGeometry(0.82, 1, 48, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xdfe8f2, transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false;
      m.renderOrder = 4;
      scene.add(m);
      this.rings.push({ m, t: 0, life: 0, size: 1 });
    }
    this.next = 0;
  }

  splash(pos, kind = 'clean', strength = 1, dir = null) {
    const k = SPLASH[kind] || SPLASH.clean;
    const fwd = dir && k.ahead ? _v.copy(dir).multiplyScalar(k.ahead) : _v.set(0, 0, 0);
    this.spray.emit(pos, fwd, Math.round(k.n * strength), { speed: k.speed * (0.7 + 0.3 * strength), spread: k.spread, up: k.up, size: k.size, life: k.life });
    if (k.ring) {
      const r = this.rings[this.next];
      this.next = (this.next + 1) % this.rings.length;
      r.m.position.set(pos.x, 0.012, pos.z);
      r.t = 0; r.life = 1.8; r.size = k.ring * (0.6 + 0.4 * strength); r.m.visible = true;
    }
    const d = this.camera.position.distanceTo(pos);
    const near = Math.min(1, strength) / (1 + d * d * 0.02);
    this.sound?.splash?.(near, pos.clone());
    if (near > 0.08) this.rumble?.(0.4 * near, 0.25 * near, 180);
  }

  update(dt) {
    for (const r of this.rings) {
      if (!r.m.visible) continue;
      r.t += dt;
      const k = r.t / r.life;
      if (k >= 1) { r.m.visible = false; continue; }
      const s = r.size * (0.15 + 0.85 * (1 - Math.pow(1 - k, 2.2)));
      r.m.scale.setScalar(s);
      r.m.material.opacity = 0.32 * (1 - k) * Math.min(1, k * 8);
    }
  }
}
