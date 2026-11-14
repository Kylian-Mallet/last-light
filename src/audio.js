// Soundscape: recorded and procedural ambience, penguin calls, steps, the score and the
// narrator. The world is heard from the camera: calls, steps and splashes are placed on
// what makes them (binaural HRTF, so in headphones they sit left, right, ahead or behind
// and follow a walking penguin); the wind blows from its real direction, the swell comes
// from the nearest stretch of coast, the colony and the crèche murmur from where they are.

// footsteps sit under the world: present when you listen for them, never insistent
const STEP_GAIN = 0.65;

export class Soundscape {
  constructor() {
    this.ctx = null;
  }

  start() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    // master → shelter muffle (low-pass) → gentle limiter → output
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass'; this.muffle.frequency.value = 20000; this.muffle.Q.value = 0.4;
    const limiter = ctx.createDynamicsCompressor();
    // a gentle bus limiter: catches peaks without pumping the ambience under the score
    limiter.threshold.value = -6; limiter.knee.value = 10; limiter.ratio.value = 4; limiter.attack.value = 0.008; limiter.release.value = 0.35;
    this.master.connect(this.muffle).connect(limiter).connect(ctx.destination);
    this.limiter = limiter;

    // open-air reverb: sound over snow is dry, with a faint long slap off the ice
    const irLen = Math.floor(ctx.sampleRate * 2.4);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen;
        lp += ((Math.random() * 2 - 1) - lp) * (0.5 - 0.42 * t); // darker as it decays
        const early = i > ctx.sampleRate * 0.09 && i < ctx.sampleRate * 0.11 ? 2.2 : 1; // one slap
        d[i] = lp * Math.pow(1 - t, 3.2) * early;
      }
    }
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = ir;
    this.reverbSend = ctx.createGain(); this.reverbSend.gain.value = 1;
    const wet = ctx.createGain(); wet.gain.value = 0.32;
    this.reverbSend.connect(this.reverb).connect(wet).connect(this.master);
    this.loops = {};
    this.colonyLevel = 0;
    this.boomTimer = 25 + Math.random() * 30;

    // shared noise buffers
    const len = ctx.sampleRate * 4;
    const white = ctx.createBuffer(1, len, ctx.sampleRate);
    const brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = white.getChannelData(0), b = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]) / 1.02;
      b[i] = last * 3.5;
    }
    this.white = white;

    // wind: brown noise through a moving band-pass, with gusts
    const wind = ctx.createBufferSource();
    wind.buffer = brown; wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass'; this.windFilter.frequency.value = 400; this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0.0;
    this.listenerPos = { x: 0, y: 1, z: 0 };
    this.listenerFwd = { x: 0, y: 0, z: -1 };
    this.spatials = [];
    this.beds = {};
    // wind beds: part all around, part from upwind
    this.bed('wind', 0.45);
    wind.connect(this.windFilter).connect(this.windGain).connect(this.beds.wind.in);
    wind.start();

    // high whistle layer
    const hiss = ctx.createBufferSource();
    hiss.buffer = white; hiss.loop = true;
    this.hissFilter = ctx.createBiquadFilter();
    this.hissFilter.type = 'bandpass'; this.hissFilter.frequency.value = 2400; this.hissFilter.Q.value = 2.5;
    this.hissGain = ctx.createGain(); this.hissGain.gain.value = 0;
    hiss.connect(this.hissFilter).connect(this.hissGain).connect(this.beds.wind.in);
    hiss.start(0, 1.3);

    // swell lapping against ice
    const sea = ctx.createBufferSource();
    sea.buffer = brown; sea.loop = true;
    const seaF = ctx.createBiquadFilter();
    seaF.type = 'lowpass'; seaF.frequency.value = 280;
    this.seaGain = ctx.createGain(); this.seaGain.gain.value = 0.0;
    this.bed('sea', 0.8); // the swell comes from the nearest coast
    sea.connect(seaF).connect(this.seaGain).connect(this.beds.sea.in);
    sea.start(0, 2.1);

    this.t = 0;
    this.loadSamples();
  }

  /** Real recordings (CC0): emperor + king penguin calls, snow footsteps. See public/audio/CREDITS.txt */
  async loadSamples(base = 'audio/') {
    try {
      const manifest = await (await fetch(base + 'manifest.json')).json();
      const load = async (name) => {
        const buf = await (await fetch(base + name)).arrayBuffer();
        const audio = await this.ctx.decodeAudioData(buf);
        audio.name = name;
        return audio;
      };
      const settle = async (list) => (await Promise.allSettled(list.map(load))).filter((r) => r.status === 'fulfilled').map((r) => r.value);
      // the score: decode the opening cues first, the rest in the background
      if (manifest.music?.length) { this.scoreAvailable = true; this.preloadScore(manifest.music); }
      this.samples = { calls: await settle(manifest.calls), steps: await settle(manifest.steps), chicks: await settle(manifest.chicks || []) };
      // long ambiences: real recordings, cross-faded into seamless loops
      for (const [name, file] of Object.entries(manifest.loops || {})) {
        try { this.startLoop(name, this.seamless(await load(file), 1.5)); } catch (err) { console.warn('Loop unavailable', name, err); }
      }
    } catch (err) {
      console.warn('Sound samples unavailable, using procedural audio', err);
    }
  }

  /** Fold the tail of a recording into its head (equal-power) so it loops without a click. */
  seamless(buf, fade = 1.5) {
    const sr = buf.sampleRate, X = Math.floor(fade * sr), L = buf.length - X;
    const out = this.ctx.createBuffer(buf.numberOfChannels, L, sr);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch), dst = out.getChannelData(ch);
      dst.set(src.subarray(0, L));
      for (let i = 0; i < X; i++) {
        const k = i / X;
        dst[i] = src[i] * Math.sin(k * Math.PI / 2) + src[L + i] * Math.cos(k * Math.PI / 2);
      }
    }
    return out;
  }

  startLoop(name, buffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer; src.loop = true;
    const gain = this.ctx.createGain(); gain.gain.value = 0;
    // recorded beds: the wind and blizzard share the wind's direction; the colony and
    // the crèche come from where they are (more enveloping the closer you are)
    const bed = name === 'blizzard' ? 'wind' : name;
    if (!this.beds[bed]) this.bed(bed, bed === 'wind' ? 0.45 : 0.7);
    src.connect(gain).connect(this.beds[bed].in);
    if (name === 'colony' || name === 'creche') gain.connect(this.reverbSend);
    src.start(0, Math.random() * buffer.duration);
    this.loops[name] = gain;
  }

  // --- 3D sound ------------------------------------------------------------------
  /** A binaural panner: direction only (each sound keeps its own distance curve). */
  panner(hrtf = true) {
    const p = this.ctx.createPanner();
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'linear';
    p.rolloffFactor = 0;
    p.refDistance = 1; p.maxDistance = 1e4;
    return p;
  }
  setPos(p, x, y, z, tau = 0.03) {
    const now = this.ctx.currentTime;
    if (p.positionX) { p.positionX.setTargetAtTime(x, now, tau); p.positionY.setTargetAtTime(y, now, tau); p.positionZ.setTargetAtTime(z, now, tau); } else p.setPosition(x, y, z);
  }
  /**
   * An ambience bed: `in` → one part heard all around (plain stereo), one part from a
   * direction (binaural). `spread` is how much stays all around by default.
   */
  bed(name, spread) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const wide = ctx.createGain(), aimed = ctx.createGain(), pan = this.panner();
    input.connect(wide).connect(this.master);
    input.connect(aimed).connect(pan).connect(this.master);
    wide.gain.value = spread; aimed.gain.value = 1 - spread;
    this.beds[name] = { in: input, wide, aimed, pan, spread };
    return this.beds[name];
  }
  /** Where a bed comes from; spread 0 = a point, 1 = all around. */
  aimBed(name, x, y, z, spread) {
    const b = this.beds[name];
    if (!b) return;
    const now = this.ctx.currentTime;
    // equal power between the two parts
    b.wide.gain.setTargetAtTime(Math.sqrt(spread), now, 0.4);
    b.aimed.gain.setTargetAtTime(Math.sqrt(1 - spread), now, 0.4);
    this.setPos(b.pan, x, y, z, 0.3);
  }

  /** The ear is the camera: call every frame. */
  setListener(camera) {
    if (!this.ctx) return;
    const L = this.ctx.listener, now = this.ctx.currentTime;
    const e = camera.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
    const fx = -e[8], fy = -e[9], fz = -e[10], ux = e[4], uy = e[5], uz = e[6];
    this.listenerPos = { x: px, y: py, z: pz };
    this.listenerFwd = { x: fx, y: fy, z: fz };
    if (L.positionX) {
      const T = 0.02;
      L.positionX.setTargetAtTime(px, now, T); L.positionY.setTargetAtTime(py, now, T); L.positionZ.setTargetAtTime(pz, now, T);
      L.forwardX.setTargetAtTime(fx, now, T); L.forwardY.setTargetAtTime(fy, now, T); L.forwardZ.setTargetAtTime(fz, now, T);
      L.upX.setTargetAtTime(ux, now, T); L.upY.setTargetAtTime(uy, now, T); L.upZ.setTargetAtTime(uz, now, T);
    } else {
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }
  /** Distance from the ear. */
  distTo(p) {
    const l = this.listenerPos;
    return Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z);
  }
  /**
   * Route a one-shot through a panner placed on `at` (a position, or something with a
   * `.position` that may move: it is followed until the sound ends). `gainFor(d)` gives the
   * loudness at distance d and is re-applied as the source or the ear moves. hrtf: false
   * for short, frequent sounds (steps), panned plainly, which costs next to nothing.
   */
  spatial(node, at, out, duration, gainFor, hrtf = true) {
    const pan = this.panner(hrtf);
    const g = this.ctx.createGain();
    node.connect(pan).connect(g).connect(out);
    const src = at.position || at;
    const d = this.distTo(src);
    g.gain.value = gainFor(d);
    this.setPos(pan, src.x, src.y + 0.3, src.z, 0.001);
    this.spatials.push({ pan, g, at, gainFor, until: this.ctx.currentTime + duration + 0.1 });
    return g;
  }
  updateSpatials() {
    const now = this.ctx.currentTime;
    for (let i = this.spatials.length - 1; i >= 0; i--) {
      const s = this.spatials[i];
      if (now > s.until) { this.spatials.splice(i, 1); continue; }
      const p = s.at.position || s.at;
      this.setPos(s.pan, p.x, p.y + 0.3, p.z);
      s.g.gain.setTargetAtTime(s.gainFor(this.distTo(p)), now, 0.05);
    }
  }

  /** 0..1: how present the colony is (adults left × proximity). */
  setColony(level) { this.colonyLevel = level; }
  /** 0..1: chicks close by (the crèche's whistling chatter). */
  setCreche(level) { this.crecheLevel = level; }
  /** 0..1: sheltered from the wind (huddle): highs are absorbed by bodies and snow. */
  setMuffle(v) { if (this.ctx) this.muffle.frequency.setTargetAtTime(20000 * Math.pow(0.06, v), this.ctx.currentTime, 0.6); }

  /** Sea ice working in the distance: a low thump and a long dark tail. */
  iceBoom(volume = 1) {
    const ctx = this.ctx, now = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    const f0 = 55 + Math.random() * 30;
    o.frequency.setValueAtTime(f0, now); o.frequency.exponentialRampToValueAtTime(f0 * 0.55, now + 1.6);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.22 * volume, now + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, now + 2.2);
    const n = ctx.createBufferSource(); n.buffer = this.white;
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 180 + Math.random() * 200; nf.Q.value = 1.2;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.0001, now); ng.gain.exponentialRampToValueAtTime(0.07 * volume, now + 0.02); ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 1.6 - 0.8;
    o.connect(g).connect(pan); n.connect(nf).connect(ng).connect(pan);
    pan.connect(this.master); pan.connect(this.reverbSend);
    o.start(now); o.stop(now + 2.4); n.start(now, Math.random() * 2); n.stop(now + 0.6);
  }

  /**
   * o.windFrom: unit vector toward where the wind comes from (xz); o.sea: nearest coast
   * point; o.colony / o.creche: { pos, radius } of each crowd.
   */
  update(dt, wind, seaProximity, o = {}) {
    if (!this.ctx) return;
    this.t += dt;
    const now = this.ctx.currentTime;
    this.updateSpatials();
    const L = this.listenerPos, F = this.listenerFwd;
    // facing into the wind it whistles brighter in both ears; turned away it is a duller roar
    let face = 0;
    if (o.windFrom) {
      const fl = Math.hypot(F.x, F.z) || 1;
      face = (F.x * o.windFrom.x + F.z * o.windFrom.z) / fl;
      this.aimBed('wind', L.x + o.windFrom.x * 12, L.y + 1, L.z + o.windFrom.z * 12, 0.45);
    }
    if (o.sea) {
      const ds = Math.hypot(o.sea.x - L.x, o.sea.z - L.z);
      this.aimBed('sea', o.sea.x, 0, o.sea.z, clampN(0.35 - ds * 0.01, 0.08, 0.35));
    }
    for (const k of ['colony', 'creche']) {
      const c = o[k];
      if (!c || !this.beds[k]) continue;
      const dc = Math.hypot(c.pos.x - L.x, c.pos.z - L.z);
      // inside the crowd it surrounds you; from outside it is a place you can point at
      this.aimBed(k, c.pos.x, c.pos.y + 0.4, c.pos.z, clampN(1 - (dc - c.radius * 0.5) / (c.radius * 2.5), 0.15, 0.9));
    }
    const storm = this.storm || 0;
    if (this.loops.wind) this.loops.wind.gain.setTargetAtTime(Math.min(1, wind / 7) * 0.5 * (1 - storm * 0.5), now, 0.8);
    if (this.loops.blizzard) this.loops.blizzard.gain.setTargetAtTime(Math.pow(storm, 1.4) * 0.85, now, 1.0);
    // a story call clears a little room: the crowd beds dip, then come back
    this.duckT = Math.max(0, (this.duckT || 0) - dt);
    const duck = 1 - 0.35 * Math.min(1, this.duckT / 0.4);
    const tau = this.duckT > 0 ? 0.12 : 1.2;
    if (this.loops.colony) this.loops.colony.gain.setTargetAtTime(this.colonyLevel * 0.55 * duck, now, tau);
    // the storm drowns the chatter, the huddle keeps it close
    if (this.loops.creche) this.loops.creche.gain.setTargetAtTime((this.crecheLevel || 0) * 0.7 * (1 - storm * 0.6) * duck, now, tau);
    this.boomTimer -= dt;
    if (this.boomTimer <= 0) { this.boomTimer = 35 + Math.random() * 55; if (storm < 0.4) this.iceBoom(0.6 + Math.random() * 0.5); }
    const gust = 0.6 + 0.4 * Math.sin(this.t * 0.31) * Math.sin(this.t * 0.17 + 1.3) + 0.15 * Math.sin(this.t * 1.7);
    const level = Math.min(1, wind / 4) * gust * (1 + storm * 0.6);
    // the synthetic bed carries the gusts; the recordings carry the body
    this.windGain.gain.setTargetAtTime((0.04 + level * 0.3) * (this.loops.wind ? 0.6 : 1), now, 0.3);
    this.windFilter.frequency.setTargetAtTime((250 + level * 700) * (1 + 0.25 * face), now, 0.4);
    this.hissGain.gain.setTargetAtTime(level * level * 0.06 * (0.7 + 0.5 * Math.max(0, face)), now, 0.4);
    const swell = 0.5 + 0.5 * Math.sin(this.t * 0.9) * Math.sin(this.t * 0.37);
    this.seaGain.gain.setTargetAtTime(seaProximity * (0.15 + 0.35 * swell), now, 0.5);
  }

  /** Snow crunch: a burst of tiny ice-bond fractures. */
  crunch(volume = 1, softness = 0.5, at = null) {
    if (!this.ctx || volume < 0.01) return;
    volume *= STEP_GAIN;
    const out = at ? this.ctx.createGain() : this.master; // placed under the foot
    if (at) this.spatial(out, at, this.master, 0.4, () => 1, false);
    const ctx = this.ctx;
    if (this.samples?.steps?.length) {
      // human-sized steps pitched up and trimmed: a 5 kg chick compresses far less snow
      const buf = this.samples.steps[Math.floor(Math.random() * this.samples.steps.length)];
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 1.55 + Math.random() * 0.35 + (1 - softness) * 0.2;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 380;
      const g = ctx.createGain();
      const now = ctx.currentTime, dur = Math.min(buf.duration / src.playbackRate.value, 0.22);
      g.gain.setValueAtTime(0.5 * volume, now);
      g.gain.setTargetAtTime(0, now + dur * 0.6, dur * 0.25);
      src.connect(hp).connect(g).connect(out);
      src.start(now, Math.random() < 0.5 ? 0 : 0.02);
      src.stop(now + dur + 0.1);
      return;
    }
    const dur = 0.07 + Math.random() * 0.05;
    const sr = ctx.sampleRate;
    const buf = ctx.createBuffer(1, Math.floor(sr * dur), sr);
    const d = buf.getChannelData(0);
    const grains = 60 + Math.floor(Math.random() * 60);
    for (let g = 0; g < grains; g++) {
      const at = Math.floor(Math.pow(Math.random(), 0.7) * d.length * 0.9);
      const amp = (Math.random() * 0.8 + 0.2) * (1 - at / d.length);
      const l = 8 + Math.floor(Math.random() * 40);
      for (let i = 0; i < l && at + i < d.length; i++) d[at + i] += (Math.random() * 2 - 1) * amp * Math.exp(-i / (l * 0.3));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1500 + (1 - softness) * 1800 + Math.random() * 600; bp.Q.value = 0.8;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 6000;
    const g = ctx.createGain(); g.gain.value = 0.55 * volume;
    src.connect(bp).connect(lp).connect(g).connect(out);
    src.start();
  }

  /** Chick contact call: rising-falling whistle trill (placeholder until samples load). */
  /**
   * A penguin call. Adults use the emperor recordings; chicks use the recorded chick
   * whistles (the adult calls pitched up when those are missing). pan: -1 left … 1 right.
   * focus: a call that matters to the story (the chick, its parent, the friend, a guide
   * call). It is louder (+4 dB, a little more at a distance) and stays bright, and the crowd
   * beds dip for a moment so it stands out from the colony.
   */
  call(distance = 2, { adult = false, rate = 1, volume = 1, pan = 0, focus = false, at = null, self = false } = {}) {
    if (!this.ctx) return;
    if (focus) {
      volume *= 1.6;
      distance *= 0.8;
      this.duckT = 1.8;
    }
    if (this.samples?.calls?.length) {
      // chicks: real emperor-chick whistles when available; adults: emperor calls
      const chicks = this.samples.chicks || [];
      const list = adult ? this.samples.calls.filter((b) => b.name?.startsWith('emperor')) : chicks.length ? chicks : this.samples.calls;
      const base = (adult ? 0.9 : 0.8) * volume, k = focus ? 0.06 * 0.64 : 0.06;
      // placed on the caller: loudness follows the live distance
      // the player's own chick: placed on it, but at the closeness the call was given
      const gainFor = self ? () => 1 / (1 + distance * distance * k) : (d) => 1 / (1 + d * d * k);
      if (at) return this.playSample(list.length ? list : this.samples.calls, base, { adult, rate, at, gainFor });
      return this.playSample(list.length ? list : this.samples.calls, base / (1 + distance * distance * 0.06), { adult, rate, pan });
    }
    const ctx = this.ctx, now = ctx.currentTime;
    const vol = 0.18 / (1 + distance * distance * 0.08);
    const notes = 2 + Math.floor(Math.random() * 3);
    for (let n = 0; n < notes; n++) {
      const t0 = now + n * 0.16;
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
      const f = 1900 + Math.random() * 500;
      o.frequency.setValueAtTime(f * 0.8, t0);
      o.frequency.linearRampToValueAtTime(f * 1.15, t0 + 0.05);
      o.frequency.linearRampToValueAtTime(f * 0.9, t0 + 0.12);
      o2.frequency.setValueAtTime(f * 0.8 + 90, t0); // two-voice syrinx beat
      o2.frequency.linearRampToValueAtTime(f * 1.15 + 90, t0 + 0.05);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.14);
      o.connect(g); o2.connect(g); g.connect(this.master);
      o.start(t0); o2.start(t0); o.stop(t0 + 0.16); o2.stop(t0 + 0.16);
    }
  }

  playSample(list, vol, { adult = false, rate = 1, pan = 0, at = null, gainFor = null } = {}) {
    const buf = list[Math.floor(Math.random() * list.length)];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    // adult emperor calls pitched up toward a chick's whistle; king chick calls are already high
    const isEmperor = buf.name?.startsWith('emperor');
    const isChick = buf.name?.startsWith('chick');
    // real chick whistles keep their own pitch (a little spread so a crèche is not a choir)
    src.playbackRate.value = isChick ? rate * (0.96 + Math.random() * 0.08) : (adult ? 0.95 : isEmperor ? 1.35 : 1.08) * rate + Math.random() * 0.08;
    const g = this.ctx.createGain(); g.gain.value = vol;
    // distant calls lose their highs over the snow
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass';
    if (at) {
      lp.frequency.value = 2500 + 9000 * Math.min(1, vol * gainFor(this.distTo(at.position || at)) * 2);
      src.connect(lp).connect(g);
      // the dry call comes from the bird; the reverb tail stays all around
      const placed = this.spatial(g, at, this.master, buf.duration / src.playbackRate.value, gainFor);
      placed.connect(this.reverbSend);
    } else {
      lp.frequency.value = 2500 + 9000 * Math.min(1, vol * 2);
      const p = this.ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
      src.connect(lp).connect(p).connect(g).connect(this.master);
      g.connect(this.reverbSend);
    }
    src.start();
  }

  /** Camera shutter: a short mechanical double click. */
  shutter() {
    if (!this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    [0, 0.055].forEach((dt, i) => {
      const src = ctx.createBufferSource(); src.buffer = this.white;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = i ? 2600 : 3800; bp.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + dt);
      g.gain.exponentialRampToValueAtTime(i ? 0.35 : 0.5, now + dt + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dt + 0.045);
      src.connect(bp).connect(g).connect(this.limiter);
      src.start(now + dt, Math.random()); src.stop(now + dt + 0.06);
    });
  }

  splash(volume = 1, at = null) {
    if (!this.ctx || volume < 0.01) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const out = at ? ctx.createGain() : this.master;
    if (at) this.spatial(out, at, this.master, 1.1, () => 1);
    const src = ctx.createBufferSource(); src.buffer = this.white;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(2400, now); lp.frequency.exponentialRampToValueAtTime(300, now + 0.7);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.5 * volume, now + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    src.connect(lp).connect(g).connect(out);
    g.connect(this.reverbSend);
    src.start(now, Math.random()); src.stop(now + 1);
  }

  gulp() {
    if (!this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(420, now); o.frequency.exponentialRampToValueAtTime(140, now + 0.18);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.25, now + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    o.connect(g).connect(this.master); o.start(now); o.stop(now + 0.25);
  }

  /** Storm intensity 0..1 boosts the wind bed beyond what the wind speed alone gives. */
  setStorm(v) { this.storm = v; }

  // --- orchestral score -------------------------------------------------------------
  // Pre-rendered cues (audio/music/*.mp3, see docs/music.md). The score bypasses the
  // shelter muffle (it is not in the world) but shares the limiter and a little reverb.
  /** Fetch and decode a cue (cached). */
  async loadCue(name) {
    this.cues = this.cues || {};
    if (!this.cues[name]) {
      this.cues[name] = (async () => {
        const buf = await (await fetch(`audio/music/${name}.mp3`)).arrayBuffer();
        return this.ctx.decodeAudioData(buf);
      })().catch((err) => { console.warn('Music cue unavailable', name, err); return null; });
    }
    return this.cues[name];
  }
  preloadScore(names) { if (this.ctx) names.forEach((n) => this.loadCue(n)); }
  /**
   * Cross-fade to a cue. opts: loop, volume (0..1, relative), fadeIn / fadeOut (s),
   * offset (s into the cue). The previous cue fades out underneath.
   */
  async playMusic(name, { loop = false, volume = 1, fadeIn = 1.5, fadeOut = 2.5, offset = 0 } = {}) {
    if (!this.ctx) return;
    this.scoreToken = (this.scoreToken || 0) + 1;
    const token = this.scoreToken;
    this.stopMusic(fadeOut);
    const buf = await this.loadCue(name);
    if (!buf || token !== this.scoreToken) return; // superseded while loading
    const ctx = this.ctx, now = ctx.currentTime;
    if (!this.scoreBus) {
      this.scoreBus = ctx.createGain(); this.scoreBus.gain.value = 0;
      this.scoreBus.connect(this.limiter);
      const send = ctx.createGain(); send.gain.value = 0.25;
      this.scoreBus.connect(send).connect(this.reverbSend);
      this.applyMix(0.05);
    }
    // loops: fold the tail into the head so the cue cycles without a gap
    this.loopBufs = this.loopBufs || {};
    const play = loop ? (this.loopBufs[name] ||= this.seamless(buf, 3)) : buf;
    const src = ctx.createBufferSource(); src.buffer = play; src.loop = loop;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(volume, now + Math.max(0.05, fadeIn));
    src.connect(g).connect(this.scoreBus);
    src.start(now, offset % play.duration);
    this.score = { name, src, g };
  }
  stopMusic(fade = 2.5) {
    const cur = this.score;
    if (!cur || !this.ctx) return;
    const now = this.ctx.currentTime;
    cur.g.gain.cancelScheduledValues(now);
    cur.g.gain.setValueAtTime(cur.g.gain.value, now);
    cur.g.gain.linearRampToValueAtTime(0.0001, now + Math.max(0.05, fade));
    cur.src.stop(now + fade + 0.1);
    this.score = null;
  }
  get musicName() { return this.score?.name ?? null; }

  setMood(name) {
    // the synthesized pads are only a fallback when the score is unavailable
    if (this.scoreAvailable) { this.mood = name; return; }
    if (!this.ctx || this.mood === name) return;
    this.mood = name;
    const ctx = this.ctx, now = ctx.currentTime;
    if (!this.musicBus) {
      this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0.22;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
      this.musicBus.connect(lp).connect(this.master);
      lp.connect(this.reverbSend);
    }
    if (this.voice) { const v = this.voice; v.gain.gain.setTargetAtTime(0, now, 1.6); setTimeout(() => v.oscs.forEach((o) => o.stop()), 7000); this.voice = null; }
    clearInterval(this.pluckTimer);
    const chords = {
      colony: [174.6, 220.0, 261.6, 329.6, 392.0], // F maj9
      departure: [146.8, 220.0, 293.7, 329.6, 349.2], // D m(add9)
      alone: [130.8, 196.0, 293.7], // open fifths
      storm: [65.4, 98.0, 103.8], // low, rubbing
      dawn: [174.6, 261.6, 329.6, 392.0, 523.3], // F maj7 → bright
    };
    const notes = chords[name];
    if (!notes) return; // 'silence'
    const gain = ctx.createGain(); gain.gain.value = 0; gain.connect(this.musicBus);
    gain.gain.setTargetAtTime(name === 'storm' ? 0.55 : 0.35, now, 2.5);
    const oscs = notes.map((f, i) => {
      const o = ctx.createOscillator(); o.type = i % 2 ? 'triangle' : 'sine'; o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 8;
      const og = ctx.createGain(); og.gain.value = 0.18 / notes.length * (i === 0 ? 1.6 : 1);
      // slow tremolo keeps the pad breathing
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07 + Math.random() * 0.1;
      const lg = ctx.createGain(); lg.gain.value = og.gain.value * 0.5; lfo.connect(lg).connect(og.gain); lfo.start();
      o.connect(og).connect(gain); o.start();
      return o;
    });
    this.voice = { gain, oscs };
    // sparse plucked notes over the pad (not in the storm)
    if (name !== 'storm') {
      this.pluckTimer = setInterval(() => {
        if (Math.random() < 0.45) return;
        const f = notes[Math.floor(Math.random() * notes.length)] * (Math.random() < 0.5 ? 2 : 4);
        const t = ctx.currentTime;
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
        o.connect(g).connect(this.musicBus); o.start(t); o.stop(t + 2.8);
      }, 1700);
    }
  }

  setMuted(m) {
    if (!this.ctx) return;
    this.muted = m;
    this.applyMix(0.1);
  }

  /**
   * Mix states. 'title' and 'cinematic' give the score the room (world ambience pulled
   * back), 'gameplay' gives it back to the world (wind, colony, calls) with the score
   * underneath.
   */
  setMix(name) {
    if (!this.ctx || this.mixName === name) return;
    this.mixName = name;
    this.applyMix(name === 'gameplay' ? 2.5 : 1.2);
  }
  applyMix(tau = 1) {
    if (!this.ctx) return;
    const MIX = { title: { world: 0.42, score: 1.0 }, cinematic: { world: 0.62, score: 1.05 }, gameplay: { world: 1, score: 0.6 } };
    const m = MIX[this.mixName] || MIX.gameplay;
    const v = this.volumes;
    const now = this.ctx.currentTime;
    // narration ducks the bed: in play the score dips ~5 dB under the voice; in the
    // cinematics only ~2 dB, so the music still carries the scene and the voice sits on it
    const cine = this.mixName === 'cinematic' || this.mixName === 'title';
    const duckScore = this.narrating ? (cine ? 0.78 : 0.55) : 1, duckWorld = this.narrating ? 0.56 : 1;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8 * m.world * v.master * v.world * duckWorld, now, tau / 3);
    this.scoreBus?.gain.setTargetAtTime(this.muted ? 0 : 0.85 * m.score * v.master * v.music * duckScore, now, tau / 3);
    this.voiceBus?.gain.setTargetAtTime(this.muted ? 0 : (cine ? 0.92 : 1.05) * v.master * (v.voice ?? 1), now, 0.05);
  }

  /** The narrator's voice: dry and close, outside the world (no shelter muffle). */
  playVoice(buf) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (!this.voiceBus) {
      this.voiceBus = ctx.createGain();
      this.voiceBus.connect(this.limiter);
      const send = ctx.createGain(); send.gain.value = 0.1; // a breath of room
      this.voiceBus.connect(send).connect(this.reverbSend);
      this.applyMix(0.05);
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    src.connect(this.voiceBus);
    src.start();
    return src;
  }
  /** While the narrator speaks, the score and the world step back. */
  setNarrating(on) {
    if (this.narrating === on) return;
    this.narrating = on;
    this.applyMix(on ? 0.6 : 2.4);
  }

  /** Player volumes (options menu), 0..1 each: overall, music, world (ambience + calls), voice. */
  get volumes() {
    if (!this._vol) {
      this._vol = { master: 1, music: 1, world: 1, voice: 1 };
      try { Object.assign(this._vol, JSON.parse(localStorage.getItem('pingu.volumes') || '{}')); } catch { /* storage unavailable */ }
    }
    return this._vol;
  }
  setVolume(kind, value) {
    this.volumes[kind] = Math.max(0, Math.min(1, value));
    try { localStorage.setItem('pingu.volumes', JSON.stringify(this.volumes)); } catch { /* storage unavailable */ }
    this.applyMix(0.15);
  }
}

const clampN = (v, a, b) => Math.min(b, Math.max(a, v));
