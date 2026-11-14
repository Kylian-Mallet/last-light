import * as THREE from 'three';
import { PLACES, edgePoint, EDGE_ANGLE } from './colony.js';
import { CALM, BREEZE, STORM, AFTER } from './weather.js';
import { PENGUIN_UNIFORMS } from './penguin.js';

// Story director: five acts (~10 min). Written as async sequences driven by game
// time; `wait`/`until` resolve inside update(), so pausing the loop pauses the story.

const _v = new THREE.Vector3();

export class Story {
  constructor(ctx) {
    // { hero, colony, hud, sound, weather, params, camera, heightfield, deformer, setSun,
    //   setMolt, narrator, windAngle, sunDir, playFraming, titleStart, startAct, snapCamera,
    //   rumble(strong, weak, ms), hum(strong, weak) }
    this.ctx = ctx;
    this.time = 0;
    this.waiters = [];
    this.control = false; // player steers the chick
    this.cine = { active: false, pos: new THREE.Vector3(), look: new THREE.Vector3(), speed: 1.2 };
    this.prompt = null; // { pos, verb, code, hold }
    this.echo = null; // { pos, until, h: marker height above pos }
    this.waypoint = null; // { pos, label, near, h }
    this.warmth = null;
    this.cold = 0;
    this.act = 0;
    this.flags = {};
    this.holdE = 0;
    this.eDown = false;
    this.skipHold = 0;
    this.skipping = false;
    this.free = false;
    this.moments = new Set();
    this.camAnim = null;
    this.camFocus = new THREE.Vector3();
    this.gazeAt = null; // the chick's gaze during scripted shots (also stops idle fidgets)
  }

  // --- timing helpers ----------------------------------------------------------
  wait(sec) { const until = this.time + sec; return this.until(() => this.time >= until || this.skipping); }
  until(cond) { return new Promise((resolve) => this.waiters.push({ cond, resolve })); }
  /** Run `fn` after `sec` seconds of story time (pauses with the game; a skip does not hurry it). */
  after(sec, fn) { const at = this.time + sec; this.waiters.push({ cond: () => this.time >= at, resolve: fn }); }
  /** Run `fn` every `sec` seconds of story time, until it returns false. */
  every(sec, fn) { this.after(sec, () => { if (fn() !== false) this.every(sec, fn); }); }
  dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
  get heroPos() { return this.ctx.hero.root.position; }

  // --- input from main -----------------------------------------------------------
  onCall() {
    if (!this.control) return;
    const { sound, hero } = this.ctx;
    sound.call(0.4, { adult: false, rate: 1.0, focus: true, at: this.ctx.hero.root, self: true });
    hero.chirp();
    this.lastCall = this.time;
    this.ctx.colony.heard();
    this.flags.called = (this.flags.called || 0) + 1;
    const responder = this.responder?.();
    if (responder) {
      this.after(0.7 + Math.random() * 0.5, () => {
        const p = responder.position || responder.root.position;
        const d = this.ctx.camera.position.distanceTo(p);
        sound.call(d, { adult: responder.kind === 'parent' || responder.kind === 'adult', rate: responder.voice || 1, focus: true, at: responder.p?.root ?? p });
        this.echo = { pos: p, until: this.time + 3.2, h: 0.45 * (responder.p?.size ?? responder.size ?? 1) + 0.25 };
        this.onReply?.(responder);
      });
    }
  }
  onInteract(down) { this.eDown = down; if (!down) this.holdE = 0; }
  onSkip(down) { this.skipDown = down; }

  /** A cinematic begins that the player may skip (hold the slide button). */
  skippableStart() {
    this.skippable = true;
    this.skipping = false;
    this.skipHold = 0;
    this.ctx.hud.skip(true);
  }
  /** The skippable stretch ends (skipped or not); the waits run normally again. */
  skippableEnd() {
    this.skippable = false;
    this.skipping = false;
    this.skipHold = 0;
    this.ctx.hud.skip(false);
  }
  /** A narrator line inside a cinematic: dropped once the player has skipped. */
  say(id, opts) { return this.skipping ? Promise.resolve() : this.ctx.narrator?.say(id, opts); }

  // --- per-frame -------------------------------------------------------------------
  update(dt) {
    this.time += dt;
    this.updateCamAnim();
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].cond()) { const w = this.waiters[i]; this.waiters.splice(i, 1); w.resolve(); }
    }
    // hold-to-skip cinematics
    if (this.cine.active && this.skippable) {
      this.skipHold = this.skipDown ? this.skipHold + dt : 0;
      if (this.skipHold > 0.8 && !this.skipping) {
        this.skipping = true;
        this.skipHold = 0;
        this.ctx.narrator?.cancel(); // the voice stops with the pictures
        this.ctx.rumble?.(0.2, 0.35, 120);
      }
    }
    if (this.echo && this.time > this.echo.until) this.echo = null;
    this.tick?.(dt);
    this.updateWarmth(dt);
    this.updateReminder(dt);
  }

  /**
   * A player who has lost the thread gets the objective (and its marker) back: after
   * 30 s in control with the same objective, and every 30 s after that.
   */
  updateReminder(dt) {
    const hud = this.ctx.hud, key = hud.state.objective;
    if (key !== this.remindKey) { this.remindKey = key; this.remindT = 0; }
    if (!key || !this.control || this.cine.active || this.prompt) { this.remindT = 0; return; }
    this.remindT += dt;
    if (this.remindT > 30) { this.remindT = 0; hud.recallObjective(); }
  }

  /** self: the prompt hangs over the chick itself (it should not stare at it). */
  setPrompt(pos, verb, code = 'interact', hold = 0, self = false) { this.prompt = pos ? { pos, verb, code, hold, self } : null; }

  /** Interaction helper: show a prompt near `pos` within `radius`; resolves on press (or hold). */
  interact(getPos, verb, { radius = 1.4, hold = 0, height = 0.45 } = {}) {
    return new Promise((resolve) => {
      const prev = this.tick;
      this.tick = (dt) => {
        prev?.(dt);
        const p = typeof getPos === 'function' ? getPos() : getPos;
        if (this.control && this.dist(this.heroPos, p) < radius) {
          if (this.eDown) this.holdE += dt;
          const prog = hold ? Math.min(1, this.holdE / hold) : 0;
          if (prog > 0) this.ctx.hum?.(0.1 * prog, 0.3 * prog); // the hold builds in the hands
          this.setPrompt(_v.copy(p).setY(this.ctx.heightfield.heightAt(p.x, p.z) + height), verb, 'interact', prog);
          if (this.eDown && (hold === 0 || this.holdE >= hold)) {
            this.eDown = false; this.holdE = 0;
            this.ctx.rumble?.(0.3, 0.5, 140);
            this.setPrompt(null); this.tick = prev; resolve();
          }
        } else if (this.prompt?.verb === verb) {
          this.setPrompt(null);
        }
      };
    });
  }

  // --- camera ----------------------------------------------------------------------
  /**
   * opts: fov (degrees), aperture (1 = gameplay), focus (Vector3, defaults to the look
   * target), cut (snap instead of easing), shake (handheld amplitude, m).
   */
  shot(pos, look, speed = 1.2, opts = {}) {
    const c = this.cine;
    c.active = true; c.pos.copy(pos); c.look.copy(look); c.speed = speed;
    c.fov = opts.fov ?? 34; c.aperture = opts.aperture ?? 2.2;
    c.focus = opts.focus ?? c.look; c.focusExact = !!opts.focusExact;
    c.focusSpeed = opts.focusSpeed ?? 4;
    c.cut = !!opts.cut; c.shake = opts.shake ?? 0.004;
    if (!opts.keepAnim) this.camAnim = null;
  }
  /**
   * Scripted camera move (dolly / crane / slide), cut in by default.
   * o: from, to, lookFrom, lookTo, dur, fov, aperture, shake, cut,
   *    focusFrom/focusTo + rack [t0, t1] (seconds into the shot) for a rack focus,
   *    track(cine, e) for anything that must follow a moving subject.
   */
  move(o) {
    const look = o.lookFrom ?? o.lookTo;
    this.camFocus.copy(o.focusFrom ?? o.focus ?? o.lookTo ?? look);
    this.shot(o.from, look, o.speed ?? (o.cut === false ? 3 : 40), { ...o, cut: o.cut ?? true, focus: this.camFocus, focusExact: true, keepAnim: true });
    this.camAnim = { ...o, t0: this.time };
  }
  updateCamAnim() {
    const m = this.camAnim;
    if (!m || !this.cine.active) return;
    const k = THREE.MathUtils.clamp((this.time - m.t0) / m.dur, 0, 1);
    const e = k * k * (3 - 2 * k);
    if (m.to) this.cine.pos.lerpVectors(m.from, m.to, e);
    if (m.lookTo) this.cine.look.lerpVectors(m.lookFrom ?? m.lookTo, m.lookTo, e);
    if (m.focusTo) {
      const [r0, r1] = m.rack ?? [0, m.dur];
      const f = THREE.MathUtils.smoothstep(this.time - m.t0, r0, r1);
      this.camFocus.lerpVectors(m.focusFrom, m.focusTo, f);
    }
    m.track?.(this.cine, e);
  }
  release() { this.cine.active = false; this.camAnim = null; this.gazeAt = null; }

  // --- shot geometry helpers ------------------------------------------------------
  headOf(p, out = new THREE.Vector3()) { return (p.bones?.Head ?? p.root).getWorldPosition(out); }
  /** Horizontal unit vector toward the sun. */
  sunXZ(out = new THREE.Vector3()) { const d = this.ctx.sunDir; return out.set(d.x, 0, d.z).normalize(); }
  rotY(v, a) { const c = Math.cos(a), s = Math.sin(a); return new THREE.Vector3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }
  ground(v, h) { v.y = this.ctx.heightfield.heightAt(v.x, v.z) + h; return v; }
  /** Everyone within r of `center` stands still until the returned function is called. */
  holdCrowd(center, r) {
    const held = [];
    for (const a of this.ctx.colony.agents) {
      if (a.gone || a.mode === 'dive' || a.mode === 'idle') continue;
      if (Math.hypot(a.position.x - center.x, a.position.z - center.z) > r) continue;
      held.push([a, a.mode]);
      a.mode = 'idle';
    }
    return () => held.forEach(([a, m]) => { if (a.mode === 'idle') a.mode = m; });
  }
  /**
   * Keep the lens clear: penguins standing in the corridor between the camera and the
   * subject step aside (done on a cut, so nobody sees them move).
   */
  clearLine(from, to, width = 0.5) {
    const moved = [];
    const dx = to.x - from.x, dz = to.z - from.z, L2 = dx * dx + dz * dz || 1;
    for (const a of this.ctx.colony.agents) {
      if (a.gone || !a.p.root.visible) continue;
      const p = a.position;
      // only the corridor between the lens and the subject: what stands beside or
      // behind the subject (the rest of a huddle) is left alone
      const tt = ((p.x - from.x) * dx + (p.z - from.z) * dz) / L2;
      if (tt < -0.05 || tt > 0.9) continue;
      const t = THREE.MathUtils.clamp(tt, 0, 1);
      const cx = from.x + dx * t, cz = from.z + dz * t;
      const ox = p.x - cx, oz = p.z - cz, d = Math.hypot(ox, oz);
      const need = width + a.p.bodyRadius;
      if (d >= need) continue;
      const nx = d > 1e-3 ? ox / d : -dz / Math.sqrt(L2), nz = d > 1e-3 ? oz / d : dx / Math.sqrt(L2);
      const shift = need - d + 0.1;
      p.x += nx * shift; p.z += nz * shift;
      p.y = this.ctx.heightfield.heightAt(p.x, p.z);
      moved.push([a, a.target.clone(), a.home.clone()]);
      a.home.x += nx * shift; a.home.z += nz * shift;
      a.target.x += nx * shift; a.target.z += nz * shift;
    }
    // call after the shot to send everyone back to their own place (e.g. in a huddle)
    return () => moved.forEach(([a, t, h]) => { a.target.copy(t); a.home.copy(h); });
  }

  // =================================================================================
  async start() {
    const { hud, sound, colony, weather, hero } = this.ctx;
    this.act = 0;
    weather.set(CALM, 0);
    this.ctx.setSun(3.6, 128, true);
    hero.root.position.copy(PLACES.hero);
    hero.heading = 2.5;

    // test harness (?debug&act=N): jump straight to an act
    const jump = this.ctx.startAct || 0;
    if (jump > 1) {
      await hud.fade(0, 0.5);
      this.control = true;
      const acts = [null, null, () => this.actDeparture(), () => this.actAlone(), () => this.actStorm(), () => this.actDawn()];
      if (jump >= 3) colony.adults.forEach((a) => { a.gone = true; a.p.root.visible = false; });
      for (let i = jump; i <= 5; i++) await acts[i]();
      return;
    }

    // ---- 0. Opening -------------------------------------------------------------
    hud.letterbox(true);
    this.skippableStart();
    sound.setMood('colony');
    // the title theme carries the prelude (started here if the title screen was silent)
    if (sound.musicName !== 'title') sound.playMusic('title', { loop: true, volume: 0.8, fadeIn: 3 });
    const C = PLACES.colony, hf = this.ctx.heightfield, V = THREE.Vector3;
    const sun = this.sunXZ();
    // the chick turns three-quarters toward where the close-up will be
    const away = new V(hero.root.position.x - C.x, 0, hero.root.position.z - C.z).normalize();
    const camDir = away.clone().addScaledVector(sun, -0.9).normalize(); // head → lens: backlit, colony behind
    const faceDir = this.rotY(camDir, 0.65);
    hero.heading = Math.atan2(faceDir.x, faceDir.z);
    this.gazeAt = this.ground(hero.root.position.clone().addScaledVector(faceDir, 4), 0.3);

    // the opening starts from the title camera when it frames the colony; any other title
    // framing cuts to the colony drift so the push-in never travels through the crowd
    const ts = this.ctx.titleStart?.();
    const cam0 = ts ? ts.pos.clone() : this.ctx.camera.position.clone();
    const toC = new V(C.x - cam0.x, 0, C.z - cam0.z).normalize();
    const cam1 = this.ground(cam0.clone().addScaledVector(toC, 2.6), 0.62);
    const gC = hf.heightAt(C.x, C.z);
    hud.fade(0, 0.1);

    // 0. prelude, no voice: the player is carried in slowly. A high, wide glide down onto
    //    the colony in the low sun while the title theme gives way to the opening cue and
    //    the controller starts to breathe with it. Then the narrator.
    {
      const side = new V(-toC.z, 0, toC.x);
      const camP = this.ground(cam0.clone().addScaledVector(toC, -3.4).addScaledVector(side, 1.6), 1.7);
      this.move({ from: camP, to: cam0, lookFrom: new V(C.x, gC + 0.6, C.z), lookTo: new V(C.x, 0.95, C.z), dur: 10, fov: 36, aperture: 1.4, cut: !!ts, focus: new V(C.x, gC + 0.5, C.z), shake: 0.002 });
      // a slow swell in the hands, fading in over the first seconds and out after the prelude
      const t0 = this.time;
      this.every(0.05, () => {
        const t = this.time - t0, k = Math.min(1, t / 4) * (t < 10 ? 1 : 1 - (t - 10) / 2);
        if (k <= 0 || this.skipping) return false;
        this.ctx.hum?.(k * (0.1 + 0.06 * Math.sin(t * 0.9)), k * 0.05);
      });
      let cue = false;
      // the cue is cut to the shots that follow: it starts as the prelude hands over
      this.after(9.4, () => {
        if (cue || this.skipping) return;
        cue = true;
        sound.playMusic('opening', { fadeIn: 2.5, fadeOut: 4 });
        this.ctx.rumble?.(0.14, 0.08, 700); // the cue swells in the hands
      });
      await this.wait(10);
      if (!cue) { cue = true; sound.playMusic('opening', { fadeIn: 0.6, fadeOut: 1.5 }); } // skipped
    }

    // 1. the drift carries on: a slow push in, low through the backlit colony
    this.move({ from: cam0, to: cam1, lookFrom: new V(C.x, 0.95, C.z), lookTo: new V(C.x, gC + 0.5, C.z), dur: 8, fov: 31, aperture: 2.2, cut: false, focus: new V(C.x, gC + 0.5, C.z) });
    this.wait(0.8).then(() => this.say('open1'));
    await this.wait(7);

    // 2. close on the chick: the down lit from behind, the colony melting into bokeh
    const releaseCrowd = this.holdCrowd(hero.root.position, 4.5);
    {
      const h = this.headOf(hero);
      const side = new V(-camDir.z, 0, camDir.x);
      const c = h.clone().addScaledVector(camDir, 0.62);
      c.y = h.y - 0.015;
      this.clearLine(c, h, 0.35);
      this.move({ from: c.clone().addScaledVector(side, -0.08), to: c.clone().addScaledVector(side, 0.08), lookFrom: h, lookTo: h.clone().addScaledVector(side, 0.02), dur: 11, fov: 19, aperture: 4.6, focus: h, shake: 0.0015 });
      this.say('open2');
      await this.wait(10.6); // the chick peeps once the line has settled
      if (!this.skipping) { sound.call(0.5, { rate: 1.05, volume: 0.6, focus: true, at: this.ctx.hero.root, self: true }); hero.chirp(); this.ctx.rumble?.(0.05, 0.25, 120); }
      await this.wait(0.6);
    }

    // 3. from just behind the chick, into the low sun: focus racks from its head to the
    //    adults standing in the light
    {
      const hp = hero.root.position;
      const d = new V(C.x - hp.x, 0, C.z - hp.z).normalize().lerp(sun, 0.35).normalize();
      hero.heading = Math.atan2(d.x, d.z);
      const sd = new V(-d.z, 0, d.x);
      const h = hp.clone().setY(hp.y + 0.36);
      const far = this.ground(hp.clone().addScaledVector(d, 6), 0.75);
      this.gazeAt = far;
      const c = this.ground(hp.clone().addScaledVector(d, -0.6).addScaledVector(sd, 0.22), 0.4);
      this.clearLine(c, far, 0.4);
      // the crane that follows ends exactly on the play camera (same place, lens and aim
      // the player gets), so control is handed over without the camera moving
      const pf = this.ctx.playFraming;
      const craneEnd = hp.clone().addScaledVector(d, -pf.dist);
      craneEnd.y = hp.y + pf.height;
      this.clearLine(c, craneEnd, 0.55);
      const look = new V().lerpVectors(h, far, 0.55);
      look.addScaledVector(sd, -0.25); // the chick sits on the right third
      this.move({ from: c, to: c.clone().addScaledVector(d, 0.12), lookFrom: look, lookTo: look, dur: 8.5, fov: 27, aperture: 3.8, focusFrom: h, focusTo: far, rack: [3.5, 6], shake: 0.003 });
      this.say('open3');
      await this.wait(8);
      // 4. crane up and back to the play camera: the colony opens up around the chick
      const lookPlay = hp.clone().setY(hp.y + 0.2);
      this.move({ from: c.clone().addScaledVector(d, 0.12), to: craneEnd, lookFrom: look, lookTo: lookPlay, dur: 7.5, fov: pf.fov, aperture: 1, focus: hp.clone().setY(hp.y + 0.22), cut: false, speed: 40, shake: 0 });
      await this.wait(7.7);
    }
    releaseCrowd();
    this.skippableEnd();
    hud.letterbox(false);
    this.release();
    this.control = true;

    await this.actColony();
    await this.actDeparture();
    await this.actAlone();
    await this.actStorm();
    await this.actDawn();
  }

  // ---- I. The colony ---------------------------------------------------------------
  async actColony() {
    const { hud, colony, sound } = this.ctx;
    this.act = 1;
    hud.chapter('chapter.1');
    hud.hints(true);
    this.after(28, () => hud.hints(false));
    await this.wait(2.5);
    hud.objective('obj.findParent', 8000);
    this.ctx.narrator?.say('call');
    const parent = colony.parent;
    colony.mill(parent, PLACES.parentHome, 0.6);
    this.responder = () => parent;

    // the parent answers calls; after two calls (or once close) it comes over
    let coming = false;
    const comeOver = () => {
      if (coming) return;
      coming = true;
      colony.goTo(parent, this.heroPos, { arrive: 1.35 });
      // keep tracking the chick while walking over
      const t0 = this.tick;
      this.tick = (dt) => { t0?.(dt); if (this.act === 1 && parent.mode === 'goto') parent.target.copy(this.heroPos); };
    };
    this.onReply = () => { if (this.flags.called >= 2 || this.dist(this.heroPos, parent.position) < 6) comeOver(); };
    // if the player never calls, the parent calls first
    this.every(9, () => {
      if (coming || this.act !== 1) return false;
      if (this.time - (this.lastCall || 0) > 14) {
        sound.call(this.ctx.camera.position.distanceTo(parent.position), { adult: true, focus: true, at: parent.p.root });
        this.echo = { pos: parent.position, until: this.time + 3, h: 0.45 * parent.p.size + 0.25 };
      }
    });
    // teach the call: an R prompt over the chick until its parent starts toward it
    {
      const prev = this.tick;
      const callPos = new THREE.Vector3();
      this.tick = (dt) => {
        prev?.(dt);
        if (this.act !== 1 || coming) return;
        if (this.control) this.setPrompt(callPos.copy(this.heroPos).setY(this.heroPos.y + 0.62), 'act.call', 'call', 0, true);
      };
      await this.until(() => coming || this.dist(this.heroPos, parent.position) < 3.5);
      // (the tick stays chained: comeOver() wraps it, and it goes quiet once `coming`)
      if (this.prompt?.verb === 'act.call') this.setPrompt(null);
    }
    comeOver();
    await this.until(() => parent.mode !== 'goto');

    // feeding
    hud.objective('obj.eat', 6000);
    sound.playMusic('reunion', { volume: 0.75, fadeIn: 2 });
    this.ctx.narrator?.say('feed');
    const fish = await new Promise((r) => colony.feed(this.ctx.hero, r));
    await this.interact(() => fish.position, 'act.eat', { radius: 1.0, height: 0.15 });
    colony.eatFish(fish, this.ctx.hero, () => sound.gulp());
    this.ctx.hero.chirp();
    await this.wait(2.5);

    // back to the crèche: huddle with the other chicks
    hud.objective('obj.creche', 6000);
    this.responder = () => colony.chicks[0];
    this.waypoint = { pos: PLACES.creche, label: 'mark.creche', near: 1.8, h: 0.55 };
    await this.interact(PLACES.creche, 'act.huddle', { radius: 1.7, height: 0.35 });
    this.waypoint = null;
    this.huddleHero(true, PLACES.creche);
    colony.chicks.forEach((c, i, all) => colony.huddle(c, PLACES.creche, i + 1, all.length + 1));
    // let the chick reach the middle and the ring close round it before the lens comes in
    const t0 = this.time;
    await this.until(() => this.dist(this.heroPos, PLACES.creche) < 0.3 || this.time - t0 > 4);
    await this.wait(0.8);
    // close-up in the crèche: a slow arc around the chick's head, backlit, the others soft
    hud.letterbox(true);
    this.skippableStart();
    let restoreRing;
    {
      const hero = this.ctx.hero;
      const h = this.headOf(hero);
      const base = this.rotY(this.sunXZ().negate(), 0.55);
      const at = (a, c = h, out = new THREE.Vector3()) => { const v = this.rotY(base, a); return out.set(c.x + v.x * 0.78, c.y + 0.1, c.z + v.z * 0.78); };
      const look = h.clone().setY(h.y - 0.03);
      this.gazeAt = h.clone().addScaledVector(base, 3).setY(h.y - 0.1);
      // open a gap in the ring toward the lens, and keep it open for the whole arc
      // (the huddle keeps shuffling in, and the camera travels)
      restoreRing = this.clearLine(at(0), h, 0.24);
      const head = h.clone(); // smoothed: the huddle jostles the chick a little
      colony.keepOut = { from: this.ctx.camera.position, to: head, width: 0.12, upTo: 0.8 };
      this.move({
        from: at(-0.2), to: at(0.2), lookFrom: look, lookTo: look, dur: 11.5, fov: 23, aperture: 4.2, focus: h, shake: 0.002,
        // the arc and the aim follow the chick's head, wherever the huddle nudges it
        track: (cine, e) => {
          head.lerp(this.headOf(hero), 0.06);
          at(-0.2 + 0.4 * e, head, cine.pos);
          cine.look.copy(head).setY(head.y - 0.03);
          this.camFocus.copy(head);
        },
      });
    }
    this.say('creche');
    await this.wait(11.2);
    colony.keepOut = null;
    restoreRing?.();
    this.skippableEnd();
    hud.letterbox(false);
    this.release();
    this.huddleHero(false);
    colony.chicks.forEach((c) => colony.mill(c, PLACES.creche, 1.2));
  }

  /** center: the chick shuffles into the middle of the huddle (the others ring it). */
  huddleHero(on, center = null) {
    const hero = this.ctx.hero;
    this.huddling = on;
    this.control = !on;
    hero.hunker = on ? 1 : 0;
    if (on && center) { this.autoWalk = center; this.huddleWalk = true; }
    if (!on && this.huddleWalk) { this.autoWalk = null; this.huddleWalk = false; }
  }

  // ---- II. The departure -----------------------------------------------------------
  async actDeparture() {
    const { hud, colony, sound } = this.ctx;
    this.act = 2;
    sound.setMood('departure');
    sound.stopMusic(4);
    hud.chapter('chapter.2');
    const parent = colony.parent;
    // the parent calls one last time, then joins the file to the sea
    sound.call(this.ctx.camera.position.distanceTo(parent.position), { adult: true, focus: true, at: parent.p.root });
    this.echo = { pos: parent.position, until: this.time + 3, h: 0.45 * parent.p.size + 0.25 };
    await this.wait(2.5);
    hud.objective('obj.follow', 8000);
    this.responder = () => parent;
    // the marker rides on the parent; once it has gone under, it marks the edge it left from
    const followWay = { pos: parent.position.clone(), label: 'mark.parent', near: 2.5, h: 0.45 * parent.p.size + 0.15 };
    this.waypoint = followWay;
    {
      const prev = this.tick;
      this.tick = (dt) => {
        prev?.(dt);
        if (this.waypoint !== followWay) return;
        if (!parent.gone && parent.mode !== 'dive') followWay.pos.copy(parent.position);
        else { followWay.label = 'mark.sea'; followWay.h = 0.4; }
      };
    }
    // parent last in line
    const adults = colony.adults.filter((a) => a !== parent);
    let first = null;
    colony.departToSea((a) => (first = a), parent);
    this.after(6, () => { parent.toSea = true; colony.goTo(parent, edgePoint(0.7), { arrive: 0.6, onArrive: () => colony.after(3.5, () => colony.startDive(parent)) }); });

    const edge = edgePoint(0);
    await this.until(() => first);
    // the chick reaches the edge, or the colony is mostly gone
    await this.until(() => this.dist(this.heroPos, edge) < 7 || adults.filter((a) => a.gone).length > adults.length * 0.7);
    hud.objective(null);
    this.waypoint = null;
    // cinematic: the last adults go; the chick is left at the brink
    this.control = false;
    hud.letterbox(true);
    this.skippableStart();
    sound.setMood('silence');
    // lament → surge on the close-up → silence before the unanswered call
    sound.playMusic('departure', { fadeIn: 1.2 });
    const V = THREE.Vector3, hf = this.ctx.heightfield, hero = this.ctx.hero;
    const along = new V(Math.cos(EDGE_ANGLE), 0, Math.sin(EDGE_ANGLE)); // out to sea
    const perp = new V(-along.z, 0, along.x);
    // 1. wide, raised, in profile: the file of adults dives off the edge, the chick in front
    {
      const cam = this.ground(edgePoint(5.5).addScaledVector(perp, 6.8), 1.55);
      const look = this.ground(edgePoint(0.5).addScaledVector(perp, 0.6), 0.2);
      this.move({ from: cam, to: cam.clone().addScaledVector(perp, -0.9), lookFrom: look, lookTo: look, dur: 13, fov: 30, aperture: 1.5, focus: this.ground(edgePoint(2.3), 0.3) });
    }
    this.wait(1.2).then(() => this.say('depart1'));
    // the chick walks into frame up to the brink (placed on the cut)
    {
      const start = edgePoint(4.4);
      hero.root.position.set(start.x, hf.heightAt(start.x, start.z), start.z);
      hero.heading = Math.atan2(along.x, along.z);
    }
    this.autoWalk = edgePoint(2.3);
    const t1 = this.time;
    // the wide holds at least as long as the narrator's line over it
    await this.until(() => this.skipping || ((parent.gone && adults.every((a) => a.gone)) && this.time - t1 > 10.6) || this.time - t1 > 12.5);
    if (this.skipping) { // skipped: the chick is at the brink, as it would have walked
      const at = this.autoWalk;
      hero.root.position.set(at.x, hf.heightAt(at.x, at.z), at.z);
    }
    // the stage clears while we are close on the chick: anyone near the water dives,
    // stragglers out of frame slip away
    for (const a of [...adults, parent]) {
      if (a.gone || a.mode === 'dive') continue;
      a.gone = true; a.p.root.visible = false;
    }
    this.autoWalk = null;
    hero.heading = Math.atan2(along.x, along.z);
    this.gazeAt = this.ground(this.heroPos.clone().addScaledVector(along, 12), 0.1);
    // 2. close profile: the chick watches the water, the last splashes blur behind it
    {
      const h = this.headOf(hero);
      const sign = perp.dot(this.sunXZ()) > 0 ? -1 : 1; // the lens on the shadow side: rim light
      const c = h.clone().addScaledVector(perp, sign * 0.6).addScaledVector(along, -0.1);
      c.y = h.y + 0.01;
      const look = h.clone().addScaledVector(along, 0.06);
      this.move({ from: c, to: c.clone().addScaledVector(along, 0.07), lookFrom: look, lookTo: look, dur: 7.5, fov: 19, aperture: 4.6, focus: h, shake: 0.0015 });
    }
    this.say('depart2');
    await this.wait(7);
    // 3. over the chick's shoulder, long lens, nothing left but water; it calls, nobody answers
    {
      const hp = this.heroPos;
      const c = this.ground(hp.clone().addScaledVector(along, -1.25).addScaledVector(perp, 0.42), 0.4);
      const look = hp.clone().addScaledVector(along, 7).setY(0.2);
      this.move({ from: c, to: c, lookFrom: look, lookTo: look, dur: 10, fov: 26, aperture: 3.4, focus: this.headOf(hero), shake: 0.003 });
    }
    await this.wait(3.5);
    if (!this.skipping) { sound.call(0.6, { rate: 1.0, focus: true, at: this.ctx.hero.root, self: true }); this.ctx.hero.chirp(); this.ctx.rumble?.(0.05, 0.3, 140); }
    await this.wait(6.5);
    this.skippableEnd();
    hud.letterbox(false);
    this.release();
    this.control = true;
    this.ctx.narrator?.say('noanswer');
  }

  // ---- III. Alone ---------------------------------------------------------------
  async actAlone() {
    const { hud, colony, sound, weather } = this.ctx;
    this.act = 3;
    sound.setMood('alone');
    sound.playMusic('alone', { loop: true, volume: 0.6, fadeIn: 8, fadeOut: 4 });
    hud.chapter('chapter.3');
    weather.set(BREEZE, 70);
    this.ctx.setSun(2.2, 132);
    await this.wait(3);
    // a lone chick calls from across the floe: going to it is the thread of the act
    hud.objective('obj.friend', 8000);
    this.wait(9).then(() => this.ctx.narrator?.say('alone'));
    // the crèche scatters
    colony.chicks.forEach((c) => colony.mill(c, PLACES.creche, 4));
    const friend = colony.friend;
    friend.p.root.visible = true;
    colony.mill(friend, PLACES.friend, 0.4);
    this.responder = () => friend;
    this.waypoint = { pos: friend.position, label: 'mark.friend', near: 2.4, h: 0.55 };
    // it calls once straight away, so the marker and the voice point the same way
    this.wait(1.5).then(() => { if (!this.flags.friend) { colony.ambientCall(friend, true); this.echo = { pos: friend.position, until: this.time + 2.5, h: 0.45 * friend.p.size + 0.25 }; } });
    this.every(11, () => {
      if (this.act !== 3 || this.flags.friend) return false;
      const d = this.dist(this.heroPos, friend.position);
      if (d < 40) { colony.ambientCall(friend, true); this.echo = { pos: friend.position, until: this.time + 2.5, h: 0.45 * friend.p.size + 0.25 }; }
    });

    // The storm waits for the friend: once the two chicks are together they get time to
    // wander (at least 40 s, and the ridge or a slide on top of the meeting), never more
    // than 90 s, before the wind turns.
    let metAt = Infinity;
    const prev = this.tick;
    this.tick = (dt) => {
      prev?.(dt);
      const hp = this.heroPos;
      if (!this.moments.has('ridge') && this.dist(hp, PLACES.ridgeTop) < 1.6 && hp.y > PLACES.ridgeTop.y - 0.18) {
        this.moments.add('ridge'); hud.moment('moment.ridge'); this.ctx.narrator?.say('ridge', { queue: false });
        if (this.waypoint?.label === 'mark.ridge') this.waypoint = null;
      }
      if (!this.moments.has('slide') && this.ctx.hero.slide > 0.8) { this.moments.add('slide'); this.after(0.9, () => hud.moment('moment.slide')); }
    };
    this.interact(() => friend.position, 'act.nudge', { radius: 1.3, height: 0.4 }).then(() => {
      this.flags.friend = true;
      metAt = this.time;
      this.moments.add('friend');
      hud.moment('moment.friend');
      this.ctx.narrator?.say('friend', { queue: false });
      colony.follow(friend, this.ctx.hero.root, new THREE.Vector3(-0.45, 0, -0.35));
      colony.ambientCall(friend, true);
      // together now: the ridge is the next thing worth seeing
      hud.objective('obj.explore', 7000);
      this.waypoint = this.moments.has('ridge') ? null : { pos: PLACES.ridgeTop, label: 'mark.ridge', near: 2.2, h: 0.4 };
    });
    await this.until(() => {
      const together = this.time - metAt;
      return (together > 40 && this.moments.size >= 2) || together > 90;
    });
    this.tick = prev;
    this.waypoint = null;
  }

  // ---- IV. The storm ------------------------------------------------------------
  async actStorm() {
    const { hud, colony, sound, weather } = this.ctx;
    this.act = 4;
    sound.setMood('storm');
    sound.playMusic('storm', { loop: true, volume: 0.45, fadeIn: 10, fadeOut: 5 });
    weather.set(STORM, 30);
    await this.wait(7);
    hud.chapter('chapter.4');
    this.ctx.narrator?.say('storm');
    await this.wait(8);
    hud.objective('obj.shelter', 9000);
    this.ctx.narrator?.say('shelter');
    this.warmth = 1;
    // the others make for the lee of the ridge
    const crowd = [...colony.chicks, ...(this.flags.friend ? [] : [colony.friend])];
    crowd.forEach((c, i) => colony.huddle(c, PLACES.shelter, i + 1, crowd.length + 1));
    this.responder = () => colony.chicks[0];
    this.every(6.5, () => {
      if (this.act !== 4 || this.huddling) return false;
      if (this.warmth < 0.45 || this.time - (this.lastCall || 0) > 20) {
        const c = colony.chicks[0];
        colony.ambientCall(c, true);
        this.echo = { pos: PLACES.shelter, until: this.time + 3 };
      }
    });
    this.waypoint = { pos: PLACES.shelter, label: 'mark.shelter', near: 1.9, h: 0.6 };
    await this.interact(PLACES.shelter, 'act.huddleHold', { radius: 1.8, hold: 1.2, height: 0.35 });
    this.waypoint = null;
    hud.objective(null);
    this.huddleHero(true, PLACES.shelter);
    // the friend takes the next place in the ring (the middle is the hero's)
    if (this.flags.friend) colony.huddle(colony.friend, PLACES.shelter, crowd.length + 1, crowd.length + 2);
    // close, low shot of the huddle while the storm peaks and passes
    hud.letterbox(true);
    this.skippableStart();
    sound.playMusic('huddle', { volume: 0.85, fadeIn: 2.5, fadeOut: 3 });
    this.wait(1.5).then(() => this.say('huddle'));
    const sp = PLACES.shelter;
    // The storm is sat out in three shots while it peaks, then whites out.
    const hf = this.ctx.heightfield;
    const gy = hf.heightAt(sp.x, sp.z);
    const wx = Math.cos(this.ctx.windAngle), wz = Math.sin(this.ctx.windAngle);
    weather.set({ wind: STORM.wind * 1.2, fog: STORM.fog * 1.25 }, 14); // the storm peaks
    // stragglers join the huddle off-camera (the cut hides it)
    for (const c of [...crowd, ...(this.flags.friend ? [colony.friend] : [])]) {
      if (c.position.distanceTo(_v.set(c.target.x, c.position.y, c.target.z)) > 2.5) {
        c.p.root.position.set(c.target.x, hf.heightAt(c.target.x, c.target.z), c.target.z);
      }
    }
    const V = THREE.Vector3, hero = this.ctx.hero;
    // 1. from the lee side, low: the huddle closing up, snow streaming past
    {
      const c = new V(sp.x + wx * 2.6 - wz * 0.7, gy + 0.75, sp.z + wz * 2.6 + wx * 0.7);
      const look = new V(sp.x, gy + 0.22, sp.z);
      this.move({ from: c, to: c.clone().lerp(look, 0.15), lookFrom: look, lookTo: look, dur: 11, fov: 32, aperture: 2.4, focus: look, shake: 0.007 });
    }
    await this.wait(11);
    // 2. close on the chick: snow building up on its down, eyes half hidden
    let restoreHuddle, releaseHuddle;
    {
      const h = this.headOf(hero), hd = hero.heading;
      const f = new V(Math.sin(hd + 0.5), 0, Math.cos(hd + 0.5));
      const c = h.clone().addScaledVector(f, 0.72);
      c.y = h.y + 0.06;
      const look = h.clone().setY(h.y - 0.02);
      restoreHuddle = this.clearLine(c, h, 0.3);
      // the huddle stops shuffling for the close-up so nobody wanders into the lens
      releaseHuddle = this.holdCrowd(hero.root.position, 2.5);
      this.move({ from: c, to: c.clone().lerp(h, 0.12), lookFrom: look, lookTo: look, dur: 11, fov: 22, aperture: 4, focus: h, shake: 0.004 });
    }
    await this.wait(11);
    releaseHuddle();
    restoreHuddle(); // the chicks moved for the lens shuffle back into the ring
    // 3. pulling up and away downwind: a small knot of warmth in the white
    {
      const look = new V(sp.x, gy + 0.2, sp.z);
      const c0 = new V(sp.x + wx * 4.5 + wz * 1.2, gy + 2.4, sp.z + wz * 4.5 - wx * 1.2);
      const c1 = new V(sp.x + wx * 7.0 + wz * 1.8, gy + 5.0, sp.z + wz * 7.0 - wx * 1.8);
      this.move({ from: c0, to: c1, lookFrom: look, lookTo: look, dur: 14, fov: 36, aperture: 1.2, focus: look, shake: 0.01 });
    }
    await this.wait(12);
    await this.ctx.hud.fade(1, this.skipping ? 0.8 : 4.5, 'white');
    this.skippableEnd();
  }

  // ---- V. First light -------------------------------------------------------------
  async actDawn() {
    const { hud, colony, sound, weather, deformer, hero } = this.ctx;
    this.act = 5;
    this.warmth = null;
    weather.set(AFTER, 0);
    this.ctx.setSun(2.8, 238, true); // the sun has slid along the horizon overnight
    deformer.clear(); // fresh snow: every track is gone
    PENGUIN_UNIFORMS.uSnowCover.value = 0.6;
    sound.setMood('dawn');
    sound.playMusic('dawn', { volume: 0.6, fadeIn: 3, fadeOut: 2 });
    this.skippableStart();
    const V = THREE.Vector3;
    const sun = this.sunXZ();
    // 1. behind the white: close on the chick, the new sun low behind its head
    {
      const h = this.headOf(hero);
      // the chick turns its face to the new sun; the lens sits three-quarters off the
      // light, so the white face glows gold against the cold, shadowed floe behind
      hero.heading = Math.atan2(sun.x, sun.z);
      // the head bone follows the new heading next frame: place it from the root
      h.set(hero.root.position.x + sun.x * 0.035, h.y, hero.root.position.z + sun.z * 0.035);
      const dir = this.rotY(sun, 1.05);
      const side = new V(-dir.z, 0, dir.x);
      const c = h.clone().addScaledVector(dir, 0.62);
      c.y = h.y + 0.02;
      this.gazeAt = h.clone().addScaledVector(sun, 3).setY(h.y + 0.15);
      this.clearLine(c, h, 0.22);
      this.move({ from: c.clone().addScaledVector(side, -0.05), to: c.clone().addScaledVector(side, 0.05), lookFrom: h, lookTo: h, dur: 9.5, fov: 20, aperture: 4.4, focus: h, shake: 0.0015 });
    }
    await this.wait(1.0);
    await hud.fade(0, this.skipping ? 0.8 : 3.5, 'white');
    hud.chapter('chapter.5');
    this.say('dawn');
    // the huddle breaks up, everyone shakes off the snow
    hero.shake = 1.6;
    colony.agents.forEach((a) => { if (!a.gone) { a.p.shake = 1.2 + Math.random(); colony.mill(a, a.position.clone(), 1.0); } });
    await this.wait(4.5);
    // 2. low and wide into the sun: the huddle loosening, long shadows on fresh snow
    {
      const sp = PLACES.shelter;
      const side = new V(-sun.z, 0, sun.x);
      const c = this.ground(new V(sp.x, 0, sp.z).addScaledVector(sun, -4.2).addScaledVector(side, 1.3), 0.5);
      const look = this.ground(new V(sp.x, 0, sp.z).addScaledVector(sun, 0.8), 0.3);
      this.move({ from: c, to: c.clone().addScaledVector(side, -0.5), lookFrom: look, lookTo: look, dur: 6, fov: 30, aperture: 2.2, focus: this.ground(new V(sp.x, 0, sp.z), 0.25), shake: 0.003 });
    }
    await this.wait(5);
    this.skippableEnd();
    this.huddleHero(false);
    hud.letterbox(false);
    this.release();
    hud.objective('obj.sea', 8000);
    this.wait(4).then(() => this.ctx.narrator?.say('tracks'));
    this.responder = null;
    const hf = this.ctx.heightfield;
    const t0 = this.time;
    // the sea is all around: point at the nearest stretch of coast as the chick moves
    {
      const coast = [];
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        let r = 2;
        while (r < 60 && hf.sdfAt(ca * r, sa * r) > 1.2) r += 0.25;
        coast.push(new THREE.Vector3(ca * r, 0, sa * r));
      }
      const way = { pos: coast[0].clone(), label: 'mark.sea', near: 0, h: 0.4 };
      this.waypoint = way;
      const prev = this.tick;
      this.tick = (dt) => {
        prev?.(dt);
        if (this.waypoint !== way) return;
        let best = Infinity;
        for (const c of coast) { const d = this.dist(this.heroPos, c); if (d < best) { best = d; way.pos.copy(c); } }
        way.near = 0;
      };
    }
    // any stretch of coast will do: the sea is all around
    await this.until(() => hf.sdfAt(this.heroPos.x, this.heroPos.z) < 4.6 || this.time - t0 > 110);
    // ending: the chick walks to the brink, the camera pulls back and up over the floe
    this.waypoint = null;
    this.control = false;
    const base = this.heroPos.clone();
    const out = new THREE.Vector3(base.x, 0, base.z).normalize();
    const toEdge = Math.max(0, hf.sdfAt(base.x, base.z));
    const brink = base.clone().addScaledVector(out, Math.max(0, toEdge - 2.4));
    const horizon = base.clone().addScaledVector(out, toEdge + 30);
    colony.startLeapers(base.clone().addScaledVector(out, toEdge), out);
    this.autoWalk = brink;
    hud.objective(null);
    hud.letterbox(true);
    this.skippableStart();
    sound.call(1, { rate: 1.05, focus: true, at: this.ctx.hero.root, self: true });
    sound.playMusic('ending', { volume: 0.85, fadeIn: 2.5, fadeOut: 4 });
    const endLine = this.wait(1.5).then(() => this.say('end1'));
    // lean the view toward the sun so the sea catches the light
    const view = out.clone().addScaledVector(this.sunXZ(), 0.35).normalize();
    const side2 = new V(-view.z, 0, view.x);
    this.gazeAt = horizon.clone().setY(0.3);
    // 1. low behind the chick, long lens: it walks to the brink, the sea beyond
    const c1 = this.ground(base.clone().addScaledVector(view, -1.7).addScaledVector(side2, 0.28), 0.46);
    const lookFar = base.clone().addScaledVector(view, 25).setY(hf.heightAt(base.x, base.z) + 0.05);
    const heroFocus = new V();
    this.move({ from: c1, to: c1.clone().addScaledVector(view, 0.4), lookFrom: lookFar, lookTo: lookFar, dur: 8, fov: 26, aperture: 3.2, shake: 0.003,
      track: () => { this.camFocus.copy(this.heroPos); this.camFocus.y += 0.3; } });
    await this.wait(7.5);
    // 2. the crane pulls back and up over the floe; the horizon stays in frame
    const start = this.time;
    const from2 = c1.clone().addScaledVector(view, 0.4);
    this.move({ from: from2, lookFrom: lookFar, dur: 18, fov: 32, aperture: 1.6, cut: false, shake: 0.004,
      track: (cine) => {
        const k = Math.min(1, (this.time - start) / 18);
        const e = k * k * (3 - 2 * k);
        const d = 1.7 + e * 8;
        const p = this.heroPos;
        const cx = p.x - view.x * d + side2.x * (0.28 + e * 1.2), cz = p.z - view.z * d + side2.z * (0.28 + e * 1.2);
        cine.pos.set(cx, hf.heightAt(cx, cz) + 0.46 + e * 2.2, cz);
        // the chick sinks to the lower third while the view opens onto the sea
        cine.look.lerpVectors(heroFocus.copy(p).setY(p.y + 0.25), lookFar, 0.35 + e * 0.35);
        this.camFocus.copy(p); this.camFocus.y += 0.3;
      } });
    // the title card waits for the line (and at least 9 s of the crane)
    await Promise.all([this.wait(9), endLine]);
    if (this.skipping) { // skipped: the chick already stands at the brink
      hero.root.position.set(brink.x, hf.heightAt(brink.x, brink.z), brink.z);
      this.autoWalk = null;
    }
    this.skippableEnd();
    hud.ending(true, {
      onAgain: () => location.reload(),
      onFree: () => this.freeRoam(),
    });
    this.wait(1.5).then(() => this.ctx.narrator?.say('end2'));
  }

  freeRoam() {
    const { hud } = this.ctx;
    hud.ending(false);
    hud.letterbox(false);
    this.tick = null;
    this.autoWalk = null;
    this.release();
    this.control = true;
    this.free = true;
    this.responder = null;
  }

  // ---- warmth (storm only; no fail state) --------------------------------------------
  updateWarmth(dt) {
    if (this.warmth == null) { this.cold = Math.max(0, this.cold - dt * 0.3); return; }
    const storm = this.ctx.weather.state.storm;
    const sheltered = this.dist(this.heroPos, PLACES.shelter) < 3.2 || this.huddling;
    this.shelter = sheltered ? 1 : Math.max(0, 1 - (this.dist(this.heroPos, PLACES.shelter) - 3.2) / 3);
    const rate = sheltered ? 0.12 : -storm * (this.ctx.hero.hunker > 0.5 ? 0.006 : 0.012);
    this.warmth = THREE.MathUtils.clamp(this.warmth + rate * dt, 0.12, 1);
    this.cold = THREE.MathUtils.lerp(this.cold, (1 - this.warmth) * storm, 1 - Math.exp(-dt));
  }
}
