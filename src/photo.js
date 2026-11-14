import * as THREE from 'three';
import { t, onLocaleChange } from './i18n.js';
import { keepFocus } from './gamepad.js';

// Photo mode: the world freezes, the camera flies free, and a simple camera body is
// in your hands — focal length (mm, full-frame equivalent), aperture (f-number),
// focus (auto at the centre, or manual distance), exposure, tilt, a look, grain and a
// rule-of-thirds grid. The shutter saves a PNG of the frame (without the interface),
// re-rendered at full definition (see startCapture in main.js).

const SENSOR_H = 24; // mm, full-frame height: vertical FOV = 2·atan(12 / f)
const FOCALS = [14, 18, 24, 35, 50, 85, 135, 200];
const FSTOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];
const LOOKS = ['natural', 'bw', 'warm', 'cool'];

export class PhotoMode {
  constructor({ onShutter }) {
    this.onShutter = onShutter;
    this.active = false;
    this.s = { focal: 35, fstop: 2.8, af: true, focus: 3, ev: 0, roll: 0, look: 'natural', grain: 0.3, vignette: 0.3, grid: false };
    this.autoFocus = 3; // metres, measured each frame at the centre of the frame
    const el = document.createElement('div');
    el.className = 'photo-ui';
    document.body.appendChild(el);
    this.el = el;
    this.grid = document.createElement('div');
    this.grid.className = 'photo-grid';
    document.body.appendChild(this.grid);
    this.flash = document.createElement('div');
    this.flash.className = 'photo-flash';
    document.body.appendChild(this.flash);
    onLocaleChange(() => this.active && this.render());
  }

  /** Vertical field of view (degrees) of the chosen focal length. */
  get fov() { return THREE.MathUtils.radToDeg(2 * Math.atan(SENSOR_H / 2 / this.s.focal)); }
  /**
   * Depth-of-field strength for the final pass (1 = the game's default). Real blur
   * grows with focal² / f-number; softened (×0.65) so close-ups stay usable at long focals.
   */
  get aperture() {
    // the wide stops get extra blur (f/1.4 ×2.2, f/2 ×1.8, f/2.8 ×1.6, f/4 ×1.3): a real fast
    // lens melts the background far more than the plain formula gave
    const boost = { 1.4: 2.2, 2: 1.8, 2.8: 1.6, 4: 1.3 }[this.s.fstop] ?? 1;
    return THREE.MathUtils.clamp((this.s.focal * this.s.focal) / (this.s.fstop * 35 * 35) * 2.8 * 0.65 * boost, 0.12, 9);
  }
  /** Film grain strength for the final pass (slider 0–100 %). */
  get grainAmount() { return 0.14 * this.s.grain; }
  get focusDistance() { return this.s.af ? this.autoFocus : this.s.focus; }

  enter() { this.active = true; this.render(); this.el.classList.add('on'); this.grid.classList.toggle('on', this.s.grid); }
  exit() { this.active = false; this.el.classList.remove('on'); this.grid.classList.remove('on'); }

  shutter() {
    this.flash.classList.remove('go'); void this.flash.offsetWidth; this.flash.classList.add('go');
    this.onShutter?.();
  }

  render() {
    const s = this.s;
    const range = (name, min, max, step, val) => `<label class="ph-row"><span>${t('ph.' + name)}</span><output>${this.label(name)}</output><input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-k="${name}"></label>`;
    const fi = FOCALS.indexOf(s.focal), si = FSTOPS.indexOf(s.fstop);
    keepFocus(this.el, () => { this.el.innerHTML = `
      <div class="ph-title">${t('ph.title')}</div>
      ${range('focal', 0, FOCALS.length - 1, 1, fi)}
      ${range('fstop', 0, FSTOPS.length - 1, 1, si)}
      <div class="ph-row"><span>${t('ph.focus')}</span><div class="ph-seg"><button data-af="1" aria-pressed="${s.af}">${t('ph.af')}</button><button data-af="0" aria-pressed="${!s.af}">${t('ph.mf')}</button></div></div>
      ${s.af ? '' : range('focus', 0, 100, 1, Math.round(Math.log(s.focus / 0.3) / Math.log(200) * 100))}
      ${range('ev', -2, 2, 0.1, s.ev)}
      ${range('roll', -20, 20, 1, s.roll)}
      ${range('grain', 0, 100, 1, Math.round(s.grain * 100))}
      ${range('vignette', 0, 100, 1, Math.round(s.vignette * 100))}
      <div class="ph-row"><span>${t('ph.look')}</span><div class="ph-seg">${LOOKS.map((l) => `<button data-look="${l}" aria-pressed="${s.look === l}">${t('ph.look.' + l)}</button>`).join('')}</div></div>
      <div class="ph-row"><span>${t('ph.extras')}</span><div class="ph-seg"><button data-tog="grid" aria-pressed="${s.grid}">${t('ph.grid')}</button></div></div>
      <button class="ph-shutter" data-act="shoot">${t('ph.shoot')}</button>`; });
    // sliders update their value in place: rebuilding the panel mid-drag would drop the thumb
    this.el.querySelectorAll('input[type=range]').forEach((r) => r.oninput = () => {
      const k = r.dataset.k, v = parseFloat(r.value);
      if (k === 'focal') s.focal = FOCALS[v];
      if (k === 'fstop') s.fstop = FSTOPS[v];
      if (k === 'focus') s.focus = 0.3 * Math.pow(200, v / 100);
      if (k === 'ev') s.ev = v;
      if (k === 'roll') s.roll = v;
      if (k === 'grain') s.grain = v / 100;
      if (k === 'vignette') s.vignette = v / 100;
      r.closest('.ph-row').querySelector('output').textContent = this.label(k);
    });
    this.el.querySelectorAll('[data-af]').forEach((b) => b.onclick = () => { s.af = b.dataset.af === '1'; if (!s.af) s.focus = this.autoFocus; this.render(); });
    this.el.querySelectorAll('[data-look]').forEach((b) => b.onclick = () => { s.look = b.dataset.look; this.render(); });
    this.el.querySelectorAll('[data-tog]').forEach((b) => b.onclick = () => { s[b.dataset.tog] = !s[b.dataset.tog]; this.grid.classList.toggle('on', s.grid); this.render(); });
    this.el.querySelector('[data-act=shoot]').onclick = () => this.shutter();
    // the panel must not steal the free camera's drag or keys
    this.el.onpointerdown = (e) => e.stopPropagation();
  }

  /** The value shown beside a slider. */
  label(k) {
    const s = this.s;
    if (k === 'focal') return s.focal + ' mm';
    if (k === 'fstop') return 'f/' + s.fstop;
    if (k === 'focus') return s.focus.toFixed(s.focus < 10 ? 1 : 0) + ' m';
    if (k === 'ev') return (s.ev > 0 ? '+' : '') + s.ev.toFixed(1) + ' EV';
    if (k === 'roll') return s.roll + '°';
    if (k === 'grain') return Math.round(s.grain * 100) + ' %';
    if (k === 'vignette') return Math.round(s.vignette * 100) + ' %';
    return '';
  }

  /** Index of the look for the final pass. */
  get lookIndex() { return LOOKS.indexOf(this.s.look); }
}

/** Save the canvas (call right after the frame was drawn). */
export function saveCanvas(canvas, name = 'derniere-lumiere', done = null) {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  canvas.toBlob((blob) => {
    done?.(blob);
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }, 'image/png');
}
