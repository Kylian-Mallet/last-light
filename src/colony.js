import * as THREE from 'three';
import { gltfLoader, modelUrl } from './assets.js';
import { Penguin } from './penguin.js';
import { Fur } from './fur.js';
import { floeRadius, BAY_ANGLE } from './terrain.js';
import { wrapAngle } from './util.js';
import { beginDive, stepDive, SplashFx } from './dive.js';

// The colony: the chick's parent, the adults, the crèche, a lost chick, and fish.
// Every NPC is a Penguin driven by a small steering behaviour (no navmesh needed on
// an open floe): mill around a home, go to a point, follow someone, huddle, dive.

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _bowAxis = new THREE.Vector3(1, 0, 0);

export const PLACES = {
  hero: new THREE.Vector3(0.6, 0, 0.4),
  creche: new THREE.Vector3(0.3, 0, 0.8),
  colony: new THREE.Vector3(4.5, 0, 4.5),
  parentHome: new THREE.Vector3(7.2, 0, 6.2),
  friend: new THREE.Vector3(10.5, 0, -6.5),
  shelter: new THREE.Vector3(4.6, 0, -8.4),
  ridgeTop: new THREE.Vector3(4.0, 0, -11.0),
};
/**
 * Find the pressure ridge crest from the actual height field and put the shelter
 * in its lee (downwind), where the storm huddle happens.
 */
export function locateRidge(heightfield, windAngle) {
  let best = -Infinity, bx = 0, bz = 0;
  for (let x = -8; x <= 16; x += 0.25) {
    for (let z = -19; z <= -3; z += 0.25) {
      if (heightfield.sdfAt(x, z) < 3 || Math.hypot(x, z) > 17) continue;
      const h = heightfield.heightAt(x, z);
      if (h > best) { best = h; bx = x; bz = z; }
    }
  }
  PLACES.ridgeTop.set(bx, best, bz);
  // the lee: among directions pointing downwind, the one where the snow drops fastest
  const wx = Math.cos(windAngle), wz = Math.sin(windAngle);
  let low = Infinity, sx = bx + wx * 2.4, sz = bz + wz * 2.4;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    if (dx * wx + dz * wz < 0.3) continue;
    const x = bx + dx * 2.6, z = bz + dz * 2.6;
    const h = heightfield.heightAt(x, z);
    if (h < low && heightfield.sdfAt(x, z) > 3) { low = h; sx = x; sz = z; }
  }
  PLACES.shelter.set(sx, 0, sz);
  return { top: PLACES.ridgeTop, shelter: PLACES.shelter, height: best };
}

// the floe edge where the adults go to sea: the bay facing north-west
export const EDGE_ANGLE = BAY_ANGLE;
export function edgePoint(inset = 0, out = new THREE.Vector3(), angle = EDGE_ANGLE) {
  const r = floeRadius(angle) - inset;
  return out.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
}

/** Distance from point (px,pz) to the segment (ax,az)-(bx,bz). */
function segPointDist(ax, az, bx, bz, px, pz) {
  const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
  const t = l2 > 1e-8 ? Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2)) : 0;
  return Math.hypot(ax + vx * t - px, az + vz * t - pz);
}


class Agent {
  constructor(penguin, kind, home) {
    this.p = penguin;
    this.kind = kind; // 'parent' | 'adult' | 'chick' | 'friend'
    this.home = home.clone();
    this.mode = 'mill';
    this.target = home.clone();
    this.timer = Math.random() * 4;
    this.leader = null; // agent or object with .position to follow
    this.offset = new THREE.Vector3();
    this.arrive = 0.25 * penguin.size;
    this.onArrive = null;
    this.hurry = false;
    this.dive = 0;
    this.gone = false;
    this.voice = 0.9 + Math.random() * 0.25;
  }
  get position() { return this.p.root.position; }
}

export class Colony {
  constructor({ scene, heightfield, deformer, spray, sound, camera, rumble = null }) {
    Object.assign(this, { scene, heightfield, deformer, spray, sound, camera });
    this.splashFx = new SplashFx({ scene, spray, sound, camera, rumble });
    this.agents = [];
    this.furs = [];
    this.fish = [];
    this.leapers = [];
    this.time = 0;
    this.tasks = []; // delayed calls and small animations, on game time (pause-safe)
    this.gazeV = new THREE.Vector3();
    this.furShells = 6;
  }

  async load() {
    const [parent, crowd, chickA, chickB, fishGltf] = await Promise.all([
      Penguin.loadAsset(modelUrl('adult.glb')),
      Penguin.loadAsset(modelUrl('adult_crowd.glb')),
      Penguin.loadAsset(modelUrl('chick_a.glb'), undefined, { fixRedEye: true }),
      Penguin.loadAsset(modelUrl('chick_b.glb')),
      gltfLoader().loadAsync(modelUrl('fish.glb')),
    ]);
    this.assets = { parent, crowd, chickA, chickB, fish: fishGltf.scene };
  }

  makeAgent(asset, kind, height, home, heading = Math.random() * Math.PI * 2) {
    const p = new Penguin({ height }).setup(asset, true);
    p.root.position.copy(home);
    p.root.position.y = this.heightfield.heightAt(home.x, home.z);
    p.heading = heading;
    p.root.rotation.y = heading;
    this.scene.add(p.root);
    const a = new Agent(p, kind, home);
    if (kind === 'chick' || kind === 'friend') {
      // down for the crèche: instanced shells on the skinned mesh
      let sk = null;
      p.model.traverse((o) => { if (o.isSkinnedMesh && !sk) sk = o; });
      const pale = asset === this.assets.chickB;
      a.fur = new Fur(sk, null, { shells: Math.max(1, this.furShells), length: 0.012 * p.size, density: 900, even: 0, maskMode: pale ? 'bones' : 'color', lodDistance: 11 });
      this.furs.push(a.fur);
    }
    // adults leave big prints; everyone crunches the snow
    p.onFootPlant = (side, pos, h, speed) => this.footstep(a, pos, h, speed);
    this.agents.push(a);
    return a;
  }

  /** Soft contact shadows: ground every penguin even when the sun is hidden. */
  buildContacts() {
    if (this.contacts) { this.scene.remove(this.contacts); this.contacts.dispose(); }
    const geo = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0.4 } },
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uOpacity; varying vec2 vP; void main(){ float r = length(vP); float a = pow(max(0.0, 1.0 - r), 1.7) * uOpacity; gl_FragColor = vec4(0.01, 0.015, 0.035, a); }',
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    });
    this.contacts = new THREE.InstancedMesh(geo, mat, this.agents.length);
    this.contacts.frustumCulled = false;
    this.contacts.renderOrder = 1;
    this.contacts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.contacts);
    this.contactM = new THREE.Matrix4();
  }

  spawn() {
    const rnd = (a, b) => a + Math.random() * (b - a);
    const C = PLACES.colony;
    // the parent: the hi-res adult, standing a little apart
    this.parent = this.makeAgent(this.assets.parent, 'parent', 1.12, PLACES.parentHome, -2.4);
    this.parent.voice = 1.0;
    // adults: loose groups around the colony centre
    for (let i = 0; i < 22; i++) {
      const ang = rnd(0, Math.PI * 2), r = Math.sqrt(Math.random()) * 5.5 + 1.2;
      const home = new THREE.Vector3(C.x + Math.cos(ang) * r, 0, C.z + Math.sin(ang) * r);
      if (home.distanceTo(PLACES.creche) < 2.2) continue;
      this.makeAgent(this.assets.crowd, 'adult', rnd(1.0, 1.16), home);
    }
    // the crèche: chicks of two looks, slightly different sizes
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 + rnd(-0.3, 0.3), r = rnd(0.5, 1.2);
      const home = new THREE.Vector3(PLACES.creche.x + Math.cos(ang) * r, 0, PLACES.creche.z + Math.sin(ang) * r);
      const a = i % 2 === 0;
      const c = this.makeAgent(a ? this.assets.chickA : this.assets.chickB, 'chick', (a ? 0.56 : 0.48) * rnd(0.94, 1.06), home);
      c.arrive = 0.3;
    }
    // the lost chick of act III, alone near the ridge
    this.friend = this.makeAgent(this.assets.chickB, 'friend', 0.47, PLACES.friend, 2.0);
    this.friend.p.root.visible = false;
    this.friend.mode = 'idle';
    this.buildContacts();
  }

  get adults() { return this.agents.filter((a) => a.kind === 'adult' || a.kind === 'parent'); }
  get chicks() { return this.agents.filter((a) => a.kind === 'chick'); }

  footstep(a, pos, heading, speed) {
    const s = a.p.size;
    const d = this.camera.position.distanceTo(pos);
    if (d < 25) {
      // prints scale with the bird: an adult emperor's foot is about twice a chick's
      const f = Math.min(s, 2);
      this.deformer.stamp('foot', pos.x, pos.z, heading, { depth: 0.018 * Math.min(s, 1.8), rim: 0.004 * f, halfW: 0.05 * f, halfL: 0.055 * f });
    }
    if (d < 12) this.sound.crunch(0.6 * s / (1 + d * d * 0.3), 0.5, pos.clone());
  }

  /** Everyone within earshot looks toward the caller for a few seconds. */
  heard(seconds = 2.5) { for (const a of this.agents) if (!a.gone) a.attention = seconds * (0.5 + Math.random() * 0.8); }

  // --- behaviour commands ---------------------------------------------------
  goTo(a, target, { hurry = false, onArrive = null, arrive } = {}) {
    a.mode = 'goto'; a.target.copy(target); a.hurry = hurry; a.onArrive = onArrive;
    if (arrive) a.arrive = arrive;
  }
  follow(a, leader, offset = new THREE.Vector3(), hurry = false) {
    a.mode = 'follow'; a.leader = leader; a.offset.copy(offset); a.hurry = hurry;
  }
  mill(a, home = a.home, radius = 1.5) { a.mode = 'mill'; a.home.copy(home); a.millRadius = radius; a.timer = Math.random() * 3; }
  /**
   * Huddle place for one chick: slot 0 is the centre (the hero's), the others fill
   * rings packed shoulder to shoulder (ring k holds about 6k bodies), so the targets
   * themselves never overlap and the bodies settle touching, not inside each other.
   */
  huddle(a, center, slot, total) {
    const r = 0.15; // typical chick body radius (m)
    let ring = 1, first = 1, n = 6;
    while (slot >= first + n) { first += n; ring++; n = 6 * ring; }
    const k = slot - first;
    const ang = (k / n) * Math.PI * 2 + ring * 0.6;
    const R = ring * 2 * r * 1.02;
    a.mode = 'huddle';
    a.arrive = 0.05; // shuffle all the way in (a stale arrive radius left gaps)
    a.target.set(center.x + Math.cos(ang) * R, 0, center.z + Math.sin(ang) * R);
    a.home.copy(center);
    a.hurry = true;
  }

  // --- keeping out of the chick's way -----------------------------------------
  /**
   * How much room an NPC leaves the player's chick (metres, centre to centre). Adults
   * keep about a metre, chicks a bit over half that; a follower trails closer, and a
   * huddle packs right around him (bodies touch there, collisions sort it out).
   */
  personalSpace(a, hero) {
    if (!hero.root.visible || a.mode === 'huddle' || a.mode === 'dive' || a.mode === 'idle') return 0;
    if (a.mode === 'follow') return 0.42;
    return a.kind === 'chick' || a.kind === 'friend' ? 0.6 : 1.0;
  }

  /** A new wander point around home that is clear of the chick and not reached through him. */
  pickMillTarget(a, hp, ps) {
    const P = a.p.root.position;
    const startClear = ps > 0 && Math.hypot(P.x - hp.x, P.z - hp.z) > ps;
    for (let i = 0; i < 10; i++) {
      const r = (a.millRadius ?? 1.5) * Math.sqrt(Math.random());
      const ang = Math.random() * Math.PI * 2;
      const tx = a.home.x + Math.cos(ang) * r, tz = a.home.z + Math.sin(ang) * r;
      if (ps > 0) {
        if (Math.hypot(tx - hp.x, tz - hp.z) < ps + 0.3) continue;
        if (startClear && segPointDist(P.x, P.z, tx, tz, hp.x, hp.z) < ps * 0.9) continue;
      }
      a.target.set(tx, 0, tz);
      return;
    }
    a.target.set(P.x, 0, P.z); // no clear spot near home right now: stay put
  }

  /** He walked right up to it: shuffle a little way off, away from him and to one side. */
  stepAside(a, hp, ps, ux, uz) {
    const side = Math.random() < 0.5 ? -0.6 : 0.6;
    for (let k = 0; k < 3; k++) {
      const s = k === 0 ? side : k === 1 ? -side : 0;
      let vx = ux - uz * s, vz = uz + ux * s;
      const l = Math.hypot(vx, vz); vx /= l; vz /= l;
      const tx = hp.x + vx * (ps + 0.45), tz = hp.z + vz * (ps + 0.45);
      if (this.heightfield.sdfAt(tx, tz) > 0.6 || k === 2) {
        a.target.set(tx, 0, tz);
        a.timer = Math.max(a.timer, 3 + Math.random() * 4);
        return;
      }
    }
  }

  /**
   * Steering around the chick. Returns a direction to add to the goal direction plus a
   * brake (0..1) on forward speed, or null when he is nowhere near the way.
   * gx,gz: unit direction to the goal; dist: distance to it.
   */
  avoidHero(a, hp, ps, gx, gz, dist, goal) {
    const p = a.p, P = p.root.position;
    const ox = P.x - hp.x, oz = P.z - hp.z, dh = Math.hypot(ox, oz) || 1e-4;
    if (dh > ps + 2.6) { a.avoidSide = 0; return null; }
    let x = 0, z = 0, brake = 1;
    // inside his space: drift back out
    if (dh < ps) { const k = (ps - dh) / ps; x += (ox / dh) * k * 2.2; z += (oz / dh) * k * 2.2; }
    // heading for him on purpose (the parent coming to feed, a follower trailing):
    // only the brake below, no detour
    const toHim = Math.hypot(goal.x - hp.x, goal.z - hp.z) < ps + 0.5;
    if (!toHim) {
      // where he will be in a moment: a walking chick is anticipated, not bumped into
      const hv = this.heroVel;
      const hx = hp.x + hv.x * 0.7, hz = hp.z + hv.z * 0.7;
      const rx = hx - P.x, rz = hz - P.z;
      const t = rx * gx + rz * gz; // along the way
      const lat = rx * gz - rz * gx; // to the side, along n = (gz, -gx)
      const reach = Math.min(dist + ps, ps + 1.8);
      const clear = ps + p.bodyRadius * 0.5;
      if (t > -0.2 && t < reach && Math.abs(lat) < clear) {
        // pass on the side away from him; keep the chosen side so it doesn't dither
        if (!a.avoidSide) a.avoidSide = lat > 0 ? -1 : 1;
        const k = (1 - Math.abs(lat) / clear) * (1 - Math.max(t, 0) / reach);
        const w = 0.6 + 2.4 * k;
        // the way's side normal is n = (gz, -gx); lat > 0 means he is on the +n side
        x += gz * a.avoidSide * w; z += -gx * a.avoidSide * w;
      } else a.avoidSide = 0;
    }
    // he stands right in front of it: slow down, then stop and let the turn take it round
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    const tf = -ox * fx - oz * fz, lf = Math.abs(-ox * fz + oz * fx);
    if (tf > 0 && lf < ps * 0.75 + 0.1) brake = THREE.MathUtils.clamp((dh - ps * 0.8) / (ps * 0.6), 0, 1);
    return { x, z, brake };
  }

  /**
   * Hard collisions: every penguin is a vertical cylinder that nobody can walk into.
   * Overlaps are pushed apart (a few relaxation passes), adults are heavy and barely
   * budge, chicks shove each other, and the hero is never pushed off the floe.
   */
  resolveCollisions(hero, heroBounds) {
    const bodies = this._bodies || (this._bodies = []);
    bodies.length = 0;
    if (hero.root.visible) bodies.push({ pos: hero.root.position, r: hero.bodyRadius, w: 1, hero: true, give: 0 });
    for (const a of this.agents) {
      if (a.gone || !a.p.root.visible || a.mode === 'dive') continue;
      const heavy = a.kind === 'adult' || a.kind === 'parent';
      // against the player's chick an NPC gives way and takes most of the correction;
      // one on a scripted walk (going to the sea, coming to feed) shares it evenly
      const give = a.mode === 'goto' ? 0.5 : heavy ? 0.85 : 0.9;
      bodies.push({ pos: a.p.root.position, r: a.p.bodyRadius, w: heavy ? 0.12 : 1, hero: false, give });
    }
    const n = bodies.length;
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < n; i++) {
        const A = bodies[i];
        for (let j = i + 1; j < n; j++) {
          const B = bodies[j];
          let dx = B.pos.x - A.pos.x, dz = B.pos.z - A.pos.z;
          const min = A.r + B.r;
          const d2 = dx * dx + dz * dz;
          if (d2 >= min * min) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-5) { dx = Math.cos(i + j); dz = Math.sin(i + j); d = 1; }
          const push = min - Math.min(d, min);
          const nx = dx / d, nz = dz / d;
          // wa, wb: each one's share of the correction (w is mobility: adults barely budge)
          let wa = A.w / (A.w + B.w), wb = 1 - wa;
          if (A.hero) { wb = B.give; wa = 1 - wb; } else if (B.hero) { wa = A.give; wb = 1 - wa; }
          // the hero cannot be shoved off the walkable floe: the other one takes it all
          if (A.hero && !heroBounds(A.pos.x - nx * push * wa, A.pos.z - nz * push * wa)) { wb = 1; wa = 0; }
          if (B.hero && !heroBounds(B.pos.x + nx * push * wb, B.pos.z + nz * push * wb)) { wa = 1; wb = 0; }
          A.pos.x -= nx * push * wa; A.pos.z -= nz * push * wa;
          B.pos.x += nx * push * wb; B.pos.z += nz * push * wb;
        }
      }
    }
    // a cinematic lens: nobody stands between the camera and its subject
    const K = this.keepOut;
    if (K) {
      const fx = K.from.x, fz = K.from.z, dx = K.to.x - fx, dz = K.to.z - fz, L2 = dx * dx + dz * dz || 1;
      for (const b of bodies) {
        if (b.hero) continue;
        const t = ((b.pos.x - fx) * dx + (b.pos.z - fz) * dz) / L2;
        if (t < -0.15 || t > (K.upTo ?? 0.85)) continue;
        const tc = Math.max(0, t);
        const ox = b.pos.x - (fx + dx * tc), oz = b.pos.z - (fz + dz * tc);
        const d = Math.hypot(ox, oz), need = K.width + b.r;
        if (d >= need) continue;
        const nx = d > 1e-4 ? ox / d : -dz / Math.sqrt(L2), nz = d > 1e-4 ? oz / d : dx / Math.sqrt(L2);
        b.pos.x += nx * (need - d); b.pos.z += nz * (need - d);
      }
    }
  }
  startDive(a) { if (a.gone || a.mode === 'dive') return; a.mode = 'dive'; a.diveStyle ??= Math.random() < 0.55 ? 'A' : 'B'; a.diveState = beginDive(a.p, a.diveStyle, this.heightfield); }

  /** Adults leave in a loose file toward the edge, then dive one by one. */
  departToSea(onFirstDive, exclude = null) {
    const edge = edgePoint(0.6);
    const adults = this.adults.filter((a) => a !== exclude).sort((x, y) => x.position.distanceTo(edge) - y.position.distanceTo(edge));
    let first = true;
    adults.forEach((a, i) => {
      this.after(i * 1.6 + Math.random() * 1.2, () => {
        // spread along the real coastline so they don't queue on a single point
        const e = edgePoint(0.7, new THREE.Vector3(), EDGE_ANGLE + (Math.random() - 0.5) * 0.24);
        a.toSea = true;
        this.goTo(a, e, {
          arrive: 0.6,
          onArrive: () => {
            this.after(0.4 + Math.random() * 2.5, () => {
              this.startDive(a);
              if (first) { first = false; onFirstDive?.(a); }
            });
          },
        });
      });
    });
  }

  // --- fish -------------------------------------------------------------------
  makeFish() {
    const f = this.assets.fish.clone();
    f.scale.setScalar(0.15);
    f.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.material = o.material.clone(); o.material.roughness = 0.35; o.material.metalness = 0.2; } });
    this.scene.add(f);
    return f;
  }

  /** The parent bows and drops a fish in front of the chick. */
  feed(hero, onReady) {
    const fish = this.makeFish();
    const p = this.parent;
    p.bow = 0;
    p.bowing = true;
    const fromBeak = new THREE.Vector3();
    let t = 0;
    this.animate((dt) => {
      t += dt;
      p.bow = Math.min(1, t / 1.2) * (t < 3.2 ? 1 : Math.max(0, 1 - (t - 3.2) / 1.0));
      // fish slides from the parent's beak down onto the snow in front of the chick
      const head = p.p.bones.Head.getWorldPosition(fromBeak);
      const land = _v.copy(hero.root.position).addScaledVector(_w.set(Math.sin(hero.heading), 0, Math.cos(hero.heading)), 0.22);
      land.y = this.heightfield.heightAt(land.x, land.z) + 0.012;
      const k = THREE.MathUtils.smoothstep(t, 1.2, 2.0);
      fish.position.lerpVectors(head, land, k);
      fish.position.y += Math.sin(k * Math.PI) * 0.08;
      fish.rotation.set(0, hero.heading + Math.PI / 2, (1 - k) * 1.2);
      if (t < 4.4) return true;
      p.bowing = false;
      onReady?.(fish);
      return false;
    });
    return fish;
  }

  eatFish(fish, hero, onDone) {
    const from = fish.position.clone();
    let t = 0;
    this.animate((dt) => {
      t = Math.min(1, t + dt / 0.7);
      const head = hero.bones.Head.getWorldPosition(_v);
      fish.position.lerpVectors(from, head, t);
      fish.scale.setScalar(0.15 * (1 - t * 0.85));
      if (t < 1) return true;
      this.scene.remove(fish);
      onDone?.();
      return false;
    });
  }

  /** Silverfish leaping at the surface just off the ice (finale). */
  startLeapers(coast, outDir, count = 5) {
    this.leaperCoast = coast.clone();
    this.leaperOut = outDir.clone();
    for (let i = 0; i < count; i++) {
      const f = this.makeFish();
      f.visible = false;
      this.leapers.push({ f, t: -Math.random() * 5, dur: 0.9 + Math.random() * 0.4, origin: new THREE.Vector3(), dir: 0, active: false });
    }
  }

  // --- simulation ----------------------------------------------------------
  /** Run `fn` after `sec` seconds of game time (stops while the game is paused). */
  after(sec, fn) { this.tasks.push({ at: this.time + sec, fn }); }
  /** Step `fn(dt)` every frame (game time) for as long as it returns true. */
  animate(fn) { if (fn(0)) this.tasks.push({ step: fn }); }

  runTasks(dt) {
    const due = [];
    this.tasks = this.tasks.filter((k) => {
      if (k.step) return k.step(dt);
      if (this.time < k.at) return true;
      due.push(k.fn);
      return false;
    });
    due.forEach((fn) => fn()); // after the sweep: a call may schedule new tasks
  }

  update(dt, hero, weather) {
    this.time += dt;
    this.runTasks(dt);
    this.splashFx.update(dt);
    const hp = hero.root.position;
    // the chick's walking velocity: NPCs read where he is going, not only where he is
    if (!this._heroPrev) { this._heroPrev = hp.clone(); this.heroVel = new THREE.Vector3(); }
    if (dt > 0) {
      this.heroVel.set((hp.x - this._heroPrev.x) / dt, 0, (hp.z - this._heroPrev.z) / dt);
      if (this.heroVel.lengthSq() > 4) this.heroVel.set(0, 0, 0); // a teleport, not a walk
    }
    this._heroPrev.copy(hp);
    for (const a of this.agents) {
      if (a.gone) continue;
      const p = a.p;
      if (!p.root.visible && a.kind !== 'friend') continue;
      if (a.mode === 'dive') { this.updateDive(a, dt); continue; }
      if (a.mode === 'idle') { p.update(dt, { forward: 0, turn: 0 }, this.heightfield, () => true); continue; }

      // desired point
      let goal = null;
      if (a.mode === 'goto' || a.mode === 'huddle') goal = a.target;
      else if (a.mode === 'follow' && a.leader) {
        const lp = a.leader.position || a.leader.root.position;
        goal = _v.copy(lp).add(a.offset);
      } else if (a.mode === 'mill') {
        a.timer -= dt;
        a.yieldCd = Math.max(0, (a.yieldCd || 0) - dt);
        const ps = this.personalSpace(a, hero);
        if (a.timer <= 0) {
          this.pickMillTarget(a, hp, ps);
          a.timer = 4 + Math.random() * 9;
          if (Math.random() < 0.25 && a.kind !== 'chick') this.ambientCall(a);
        } else if (ps > 0 && Math.hypot(a.target.x - hp.x, a.target.z - hp.z) < ps + 0.15) {
          // he has walked onto the spot it was heading for: wander somewhere else
          this.pickMillTarget(a, hp, ps);
        }
        // he came right up to it: shuffle a step or two aside instead of holding ground
        const ox = p.root.position.x - hp.x, oz = p.root.position.z - hp.z, dh = Math.hypot(ox, oz);
        if (ps > 0 && dh < ps * 0.85 && a.yieldCd <= 0 && !a.bowing) {
          this.stepAside(a, hp, ps, ox / Math.max(dh, 1e-4), oz / Math.max(dh, 1e-4));
          a.yieldCd = 1.2;
        }
        goal = a.target;
      }

      let forward = 0, turn = 0;
      if (goal) {
        const dx = goal.x - p.root.position.x, dz = goal.z - p.root.position.z;
        const dist = Math.hypot(dx, dz);
        const ps = this.personalSpace(a, hero);
        // separation from neighbours (and the hero) keeps the crowd from interpenetrating
        let sx = 0, sz = 0;
        // avoid with a small margin around the real body (collisions do the rest)
        const margin = a.mode === 'huddle' ? 0.02 : 0.12 * Math.sqrt(p.size);
        const rad = p.bodyRadius + margin;
        for (const b of this.agents) {
          if (b === a || b.gone || !b.p.root.visible) continue;
          const ox = p.root.position.x - b.position.x, oz = p.root.position.z - b.position.z;
          const d2 = ox * ox + oz * oz, rr = rad + b.p.bodyRadius;
          if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2); sx += (ox / d) * (rr - d); sz += (oz / d) * (rr - d); }
        }
        { const ox = p.root.position.x - hp.x, oz = p.root.position.z - hp.z; const d = Math.hypot(ox, oz); const rr = rad + hero.bodyRadius; if (d < rr && d > 1e-4) { sx += (ox / d) * (rr - d) * 2; sz += (oz / d) * (rr - d) * 2; } }
        const huddled = a.mode === 'huddle' && dist < 0.15;
        // jammed at the edge behind others: count it as arrived
        if (a.mode === 'goto' && a.toSea && p.speed < 0.06 && (dist < 3.5 || this.heightfield.sdfAt(p.root.position.x, p.root.position.z) < 1.5)) a.stuckT = (a.stuckT || 0) + dt; else a.stuckT = 0;
        if (a.stuckT > 1.5) { a.arrive = dist + 0.01; a.stuckT = 0; }
        // close but circling (others crowd the goal, big birds turn slowly): call it arrived
        if (a.mode === 'goto' && dist < a.arrive + 0.7) a.nearT = (a.nearT || 0) + dt; else a.nearT = 0;
        if (a.nearT > 2.5) { a.arrive = dist + 0.01; a.nearT = 0; }
        if (dist > a.arrive && !huddled) {
          let wx = dx / dist + sx * 2.5, wz = dz / dist + sz * 2.5;
          const avoid = ps > 0 ? this.avoidHero(a, hp, ps, dx / dist, dz / dist, dist, goal) : null;
          if (avoid) { wx += avoid.x; wz += avoid.z; }
          const want = Math.atan2(wx, wz);
          const err = wrapAngle(want - p.heading);
          turn = THREE.MathUtils.clamp(err * 1.6, -1, 1);
          // walk a curve: keep some pace through a turn, only shuffle round when the
          // goal is well behind
          const pace = Math.abs(err) > 1.9 ? 0.08 : Math.max(0.2, Math.cos(Math.min(Math.abs(err), 1.5)));
          forward = pace * Math.min(1, dist / (a.arrive * 3 + 0.2));
          // never walk on into him: ease off, then stop, while he stands in the way
          if (avoid) forward *= avoid.brake;
        } else {
          if (a.mode === 'goto') {
            const cb = a.onArrive; a.onArrive = null;
            a.mode = 'mill'; a.home.copy(p.root.position); a.millRadius = 0.3; a.timer = 6 + Math.random() * 4;
            a.target.copy(p.root.position);
            cb?.();
          }
          // nudge apart while standing (shuffling in a huddle)
          if (Math.hypot(sx, sz) > 0.02) { const want = Math.atan2(sx, sz); turn = THREE.MathUtils.clamp(wrapAngle(want - p.heading), -1, 1) * 0.6; forward = 0.25; }
          // face the wind when hunkered down in the storm, like real huddles
          if (a.mode === 'huddle' && weather) { const err = wrapAngle(weather.windHeading + Math.PI - p.heading); turn = THREE.MathUtils.clamp(err, -0.5, 0.5); }
        }
      }
      p.hunker = THREE.MathUtils.lerp(p.hunker || 0, a.mode === 'huddle' ? 1 : 0, 1 - Math.exp(-dt * 2));
      // gaze: the parent watches its chick; anyone nearby turns to a call for a moment
      const dh = Math.hypot(p.root.position.x - hp.x, p.root.position.z - hp.z);
      a.attention = Math.max(0, (a.attention || 0) - dt);
      const watch = (a.kind === 'parent' && dh < 5 && !a.toSea) || (a.attention > 0 && dh < 9) || (a.kind === 'friend' && dh < 2.5 && a.mode !== 'huddle');
      // no gaze while feeding: the bow sets the head, a look-down on top folded it in
      if (watch && a.mode !== 'huddle' && !(a.bow > 0.01)) { this.gazeV.set(hp.x, hp.y + 0.32, hp.z); p.gaze = this.gazeV; } else p.gaze = null;
      p.update(dt, { forward, turn, hurry: a.hurry, slide: false }, this.heightfield, (x, z) => this.heightfield.sdfAt(x, z) > (a.toSea ? 0.15 : 0.35));
      if (a.bow) this.applyBow(a);
    }
    this.updateLeapers(dt);
    // contact shadows follow the feet; stronger when there is no sun to cast real ones
    if (this.contacts) {
      this.contacts.material.uniforms.uOpacity.value = 0.22 + 0.3 * (weather ? weather.state.overcast : 0);
      for (let i = 0; i < this.agents.length; i++) {
        const a = this.agents[i], q = a.position;
        const on = !a.gone && a.p.root.visible && a.mode !== 'dive';
        const r = on ? 0.3 * a.p.size : 0;
        this.contactM.makeScale(r, 1, r).setPosition(q.x, this.heightfield.heightAt(q.x, q.z) + 0.006, q.z);
        this.contacts.setMatrixAt(i, this.contactM);
      }
      this.contacts.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Feeding bow. A penguin feeding its chick bends from the back and reaches forward
   * with the neck, beak angled down toward the chick: the pitch is spread down the
   * spine, the neck barely folds and the head tips back up a little (folding at the
   * neck and head is what pushed the beak into the chest).
   */
  applyBow(a) {
    const b = a.bow || 0;
    if (!b) return;
    const X = _bowAxis;
    a.p.rotBone('Spine02', X, 0.26 * b);
    a.p.rotBone('Spine01', X, 0.22 * b);
    a.p.rotBone('Spine', X, 0.14 * b);
    a.p.rotBone('neck', X, 0.06 * b);
    a.p.rotBone('Head', X, -0.16 * b);
  }

  updateDive(a, dt) {
    if (stepDive(a.p, a.diveState, dt, this.splashFx)) { a.p.root.visible = false; a.gone = true; }
  }

  /** focus: the call is meant for the player (friend, guide) rather than crowd life. */
  ambientCall(a, focus = false) {
    const d = this.camera.position.distanceTo(a.position);
    if (d < 30) this.sound.call(d, { adult: a.kind !== 'chick' && a.kind !== 'friend', rate: a.voice, volume: 0.5, focus, at: a.p.root });
  }

  updateLeapers(dt) {
    if (!this.leapers.length) return;
    for (const L of this.leapers) {
      L.t += dt;
      if (L.t < 0) continue;
      if (!L.active) {
        L.active = true;
        const o = this.leaperOut, off = 1.5 + Math.random() * 6, lat = (Math.random() - 0.5) * 9;
        L.origin.set(this.leaperCoast.x + o.x * off - o.z * lat, 0, this.leaperCoast.z + o.z * off + o.x * lat);
        L.dir = Math.random() * Math.PI * 2;
        L.f.visible = true;
        this.spray.emit(L.origin, _w.set(0, 0, 0), 6, { speed: 0.6, spread: 1, up: 1, size: 0.006, life: 0.5 });
      }
      const k = L.t / L.dur;
      if (k >= 1) {
        L.f.visible = false; L.active = false; L.t = -2 - Math.random() * 5;
        this.spray.emit(_v.copy(L.f.position).setY(0), _w.set(0, 0, 0), 5, { speed: 0.5, spread: 1, up: 0.8, size: 0.006, life: 0.4 });
        continue;
      }
      const dx = Math.cos(L.dir) * 0.5 * k, dz = Math.sin(L.dir) * 0.5 * k;
      L.f.position.set(L.origin.x + dx, Math.sin(k * Math.PI) * 0.35, L.origin.z + dz);
      L.f.rotation.set(0, -L.dir, Math.cos(k * Math.PI) * 0.9);
    }
  }

}
