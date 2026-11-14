// Free-flying exploration camera (map review).
// Contract used by main.js: new FlyCam(camera, domElement); .active (bool);
// .update(dt) moves the camera when active. It handles its own input/toggle.
// Keys by physical position (KeyboardEvent.code): V toggles, WASD (ZQSD on AZERTY) moves,
// Space / C up and down, Shift fast; drag to look, wheel changes the speed.
import * as THREE from 'three';
import { fitLine } from './fitline.js';
import { t, keyLabel, learnKey, onLocaleChange } from './i18n.js';
import { pad, BTN } from './gamepad.js';
import { DEBUG } from './debug.js';

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC', 'ShiftLeft', 'ShiftRight']);

export class FlyCam {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.active = false;
    this.speed = 4; // m/s
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.vel = new THREE.Vector3();
    this.drag = null;
    /** Optional (x, z) => snow height; without it the camera only stays above y = 0.4. */
    this.ground = null;
    /** Photo mode drives the camera (slower, steadier); set by the page. */
    this.photo = false;
    /** The page's look settings: { photoSens, invertX, invertY }. */
    this.mouse = null;
    /** May V toggle the free camera? (map review and ?debug only; set by the page) */
    this.allowToggle = true;

    // key hints in the same chips as the in-game hints (.hud-hints)
    this.hint = document.createElement('div');
    this.hint.className = 'hud-hints cam-hints';
    document.body.appendChild(this.hint);
    onLocaleChange(() => this.showHint());
    pad.onChange(() => this.showHint());
    /** Pad input for this frame, set by the page: { x, y, up, lookX, lookY, fast }, or null. */
    this.pad = null;
    if (DEBUG) window.__flycam = this; // console: __flycam.look(x, y, z, tx, ty, tz)

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'KeyV' && this.allowToggle && !this.photo && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) { this.toggle(); return; }
      if (!this.active || !MOVE_KEYS.has(e.code)) return;
      this.keys.add(e.code);
      // the game never sees these keys, so learn the layout from them here
      if (learnKey(e)) this.showHint();
      // the game must not see these while flying (Space, etc.)
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); }, true);
    window.addEventListener('blur', () => this.keys.clear());

    const target = dom || window;
    target.addEventListener('pointerdown', (e) => {
      if (!this.active || e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      e.stopImmediatePropagation();
    }, true);
    window.addEventListener('pointermove', (e) => {
      if (!this.active || !this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      // gentle by default, and slower still at long focal lengths (the frame is narrower)
      const k = 0.0015 * this.lookScale();
      this.turn(dx * k, dy * k);
    }, true);
    window.addEventListener('pointerup', () => { this.drag = null; }, true);
    target.addEventListener('wheel', (e) => {
      if (!this.active) return;
      this.speed = THREE.MathUtils.clamp(this.speed * Math.exp(-e.deltaY * 0.0015), 0.3, 60);
      this.showHint();
      e.preventDefault();
      e.stopImmediatePropagation();
    }, { capture: true, passive: false });
  }

  toggle(on = !this.active) {
    this.active = on;
    this.keys.clear();
    this.drag = null;
    this.vel.set(0, 0, 0);
    if (on) {
      // start from wherever the camera is looking
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.yaw = e.y;
      this.pitch = e.x;
    }
    this.showHint();
  }

  /** Look sensitivity: the player's setting, slower at long focal lengths (narrower frame). */
  lookScale() { return (this.mouse?.photoSens ?? 1) * THREE.MathUtils.clamp(this.camera.fov / 40, 0.25, 1.6); }

  /** Turn the view (radians; + = right / down), honouring the player's inverted axes. */
  turn(dx, dy) {
    this.yaw -= dx * (this.mouse?.invertX ? -1 : 1);
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * (this.mouse?.invertY ? -1 : 1), -1.5, 1.5);
  }

  /** Jump to a viewpoint (debug / screenshots). */
  look(x, y, z, tx, ty, tz) {
    if (!this.active) this.toggle(true);
    this.camera.position.set(x, y, z);
    const d = new THREE.Vector3(tx - x, ty - y, tz - z).normalize();
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    this.vel.set(0, 0, 0);
  }

  /** Key chips, bottom left. Photo mode adds the shutter and leaves with Esc; the plain
   *  free camera leaves with V. Labels follow the player's layout (ZQSD / WASD). */
  showHint() {
    this.hint.classList.toggle('on', this.active);
    if (!this.active) return;
    const photo = document.body.classList.contains('photo');
    if (pad.mode === 'pad' && photo) {
      this.hint.innerHTML = `
        <span>${pad.stickChip('L')} ${t('cam.move')}</span>
        <span>${pad.chip(BTN.LT)}${pad.chip(BTN.RT)} ${t('cam.updown')}</span>
        <span>${pad.chip(BTN.RB)} ${t('cam.fast')}</span>
        <span>${pad.stickChip('R')} ${t('cam.lookPad')}</span>
        <span><kbd class="pad">↑↓←→</kbd> ${t('cam.settings')}</span>
        <span>${pad.chip(BTN.A)} ${t('cam.shoot')}</span>
        <span>${pad.chip(BTN.B)} ${t('cam.leave')}</span>`;
      fitLine(this.hint);
      return;
    }
    const k = (c) => `<kbd>${keyLabel(c)}</kbd>`;
    const mouse = `<kbd aria-label="${t('aria.mouse')}"><svg viewBox="0 0 10 14" aria-hidden="true"><rect x="0.6" y="0.6" width="8.8" height="12.8" rx="4.4" fill="none" stroke="currentColor" stroke-width="1"/><line x1="5" y1="2.6" x2="5" y2="5" stroke="currentColor" stroke-width="1"/></svg></kbd>`;
    this.hint.innerHTML = `
      <span>${k('KeyW')}${k('KeyA')}${k('KeyS')}${k('KeyD')} ${t('cam.move')}</span>
      <span>${k('Space')}${k('KeyC')} ${t('cam.updown')}</span>
      <span>${k('ShiftLeft')} ${t('cam.fast')}</span>
      <span>${mouse} ${t('cam.look')}</span>
      ${photo ? `<span>${k('Enter')} ${t('cam.shoot')}</span><span>${k('Escape')} ${t('cam.leave')}</span>` : `<span>${k('KeyV')} ${t('cam.quit')}</span>`}`;
    fitLine(this.hint);
  }

  update(dt) {
    if (!this.active) return;
    dt = Math.min(dt, 0.1);
    const k = this.keys, p = this.pad;
    let f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    let r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    let u = (k.has('Space') ? 1 : 0) - (k.has('KeyC') ? 1 : 0);
    const fast = k.has('ShiftLeft') || k.has('ShiftRight') || p?.fast ? (this.photo ? 3 : 4) : 1;
    // framing a shot: slower at long focal lengths, where every centimetre shows
    const lens = this.photo ? THREE.MathUtils.clamp(this.camera.fov / 40, 0.3, 1.3) : 1;
    if (p) {
      f -= p.y; r += p.x; u += p.up;
      const look = 1.7 * dt * this.lookScale();
      this.turn(p.lookX * look, p.lookY * look);
    }
    const cam = this.camera;
    cam.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const want = new THREE.Vector3()
      .addScaledVector(fwd, f)
      .addScaledVector(right, r)
      .addScaledVector(THREE.Object3D.DEFAULT_UP, u);
    if (want.lengthSq() > 1) want.normalize();
    want.multiplyScalar(this.speed * fast * lens);
    // eased start/stop (softer when framing a photo)
    this.vel.lerp(want, 1 - Math.exp(-dt * (this.photo ? 5 : 8)));
    cam.position.addScaledVector(this.vel, dt);
    // stay above the snow (ground: (x, z) => snow height, set by the page; else y > 0.4)
    const { x, z } = cam.position;
    const floor = this.ground ? this.ground(x, z) + 0.3 : 0.4;
    if (cam.position.y < floor) cam.position.y = floor;
    cam.updateMatrixWorld();
  }
}
