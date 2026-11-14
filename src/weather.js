import * as THREE from 'three';
import { WIND_ANGLE } from './terrain.js';

// Weather is a handful of scalars eased between presets; the frame loop reads them
// to drive wind, snowfall, fog, sky overcast, sun strength, lens frost and audio.

// storm look knobs (neutral outside a storm): groundBlow = the blowing-snow layer, blowDepth
// its height (m), blowVeil the wind streaks across the lens, flakeSize / flakeAmount scale the
// falling snow, driftAmount / driftHeight the skimming spindrift, gustiness how hard gusts
// thicken the view, fogR/G/B the colour the storm fades everything to
export const CALM = {
  wind: 1.6, snowfall: 0, clouds: 0.32, overcast: 0, sunMul: 1, fog: 0.0011, frost: 0.38, exposureMul: 1, snowCover: 0, storm: 0,
  groundBlow: 0, blowDepth: 0.6, blowVeil: 0, flakeSize: 1, flakeAmount: 1, driftAmount: 1, driftHeight: 1, gustiness: 0, fogR: 0.62, fogG: 0.66, fogB: 0.74,
};
export const BREEZE = { ...CALM, wind: 3.2, clouds: 0.45, frost: 0.42 };
/**
 * The storm: a ground blizzard. The wind tears the snow off the floe in a river of white
 * taller than the camera, streaming past the lens; the dim sun and the sky still show above.
 */
export const STORM = {
  ...CALM,
  wind: 11, snowfall: 0.45, clouds: 0.7, overcast: 0.55, sunMul: 0.38, fog: 0.016, frost: 0.55, exposureMul: 1.15, snowCover: 0.75, storm: 1,
  groundBlow: 1, blowDepth: 2.2, blowVeil: 0.9, flakeSize: 0.7, flakeAmount: 0.6, driftAmount: 2.4, driftHeight: 3.2, gustiness: 0.35, fogR: 0.72, fogG: 0.76, fogB: 0.84,
};
export const AFTER = { wind: 0.7, snowfall: 0, clouds: 0.12, overcast: 0, sunMul: 1.08, fog: 0.0013, frost: 0.55, exposureMul: 1, snowCover: 0.35, storm: 0 };

const KEYS = Object.keys(CALM);
for (const st of [BREEZE, AFTER]) for (const k of KEYS) if (!(k in st)) st[k] = CALM[k];
const ease = (t) => t * t * (3 - 2 * t);

export class Weather {
  constructor(initial = CALM) {
    this.state = { ...initial };
    this.from = { ...initial };
    this.to = { ...initial };
    this.t = 1;
    this.dur = 1;
    this.gust = 0;
    this.time = 0;
    this.windHeading = Math.atan2(Math.cos(WIND_ANGLE), Math.sin(WIND_ANGLE)); // heading the wind blows toward
  }

  set(target, seconds = 10) {
    this.from = { ...this.state };
    this.to = { ...this.state, ...target };
    this.t = seconds <= 0 ? 1 : 0;
    this.dur = Math.max(seconds, 1e-3);
    if (seconds <= 0) this.state = { ...this.to };
  }

  update(dt) {
    this.time += dt;
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / this.dur);
      const k = ease(this.t);
      for (const key of KEYS) this.state[key] = THREE.MathUtils.lerp(this.from[key], this.to[key], k);
    }
    // gusts scale with how stormy it is
    const s = this.state.storm;
    this.gust = 0.5 + 0.5 * Math.sin(this.time * 0.37) * Math.sin(this.time * 0.91 + 1.3) + 0.25 * Math.sin(this.time * 2.3);
    this.windNow = this.state.wind * (1 + s * 0.35 * this.gust);
    // a gust "wall": sharp peaks of the gust signal, scaled by how gusty this storm is
    this.gustWall = s * this.state.gustiness * Math.pow(Math.max(0, this.gust - 0.35) / 0.9, 2.2);
  }

  /** Wind force on a small chick (m/s drift), world XZ. */
  push(out = new THREE.Vector3(), shelter = 0) {
    const k = this.state.storm * 0.16 * (0.6 + 0.6 * this.gust) * (1 - shelter);
    return out.set(Math.cos(WIND_ANGLE) * k, 0, Math.sin(WIND_ANGLE) * k);
  }
}
