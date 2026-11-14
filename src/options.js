import { t, keyLabel, getLocale, setLocale, onLocaleChange } from './i18n.js';
import { ACTIONS, primary, rebind, resetBindings, onBindingsChange } from './bindings.js';
import { fullscreenSupported, isFullscreen, setFullscreen, onFullscreenChange } from './fullscreen.js';
import { pad, PAD_ACTIONS, keepFocus } from './gamepad.js';
import { CHROMATIC_ON } from './post.js';

// Options menu (title screen and pause): graphics, sound, controls, display. One panel,
// four tabs; every setting applies live and is remembered.

const TABS = ['graphics', 'sound', 'controls', 'display'];
const QUALITIES = ['low', 'medium', 'high', 'ultra'];

/** Subtitles setting (narration). On by default. */
export function subtitlesOn() {
  try { return localStorage.getItem('pingu.subtitles') !== '0'; } catch { return true; }
}

export class Options {
  /** ctx: { params, sound, applyQuality(name), quality(), save(), mouse, saveMouse(), onClose()? } */
  constructor(ctx) {
    this.ctx = ctx;
    this.tab = 'graphics';
    this.capturing = null;
    const el = document.createElement('div');
    el.className = 'options';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    document.body.appendChild(el);
    this.el = el;
    onLocaleChange(() => this.open && this.render());
    onBindingsChange(() => this.open && this.render());
    onFullscreenChange(() => this.open && this.render());
    pad.onChange(() => this.open && this.render());
    // capture phase: the menu sees keys before the game does
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  get open() { return this.el.classList.contains('on'); }
  /** Next / previous tab (controller bumpers). */
  cycleTab(step) {
    this.tab = TABS[(TABS.indexOf(this.tab) + step + TABS.length) % TABS.length];
    this.capturing = null;
    this.render();
    this.el.querySelector(`[data-tab="${this.tab}"]`)?.focus({ preventScroll: true });
  }
  show() { this.render(); this.el.classList.add('on'); }
  hide() {
    this.capturing = null;
    this.el.classList.remove('on');
    this.ctx.onClose?.();
  }

  onKey(e) {
    if (!this.open) return;
    if (this.capturing) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.code !== 'Escape') rebind(this.capturing, e.code);
      this.capturing = null;
      this.render();
      return;
    }
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.hide(); }
  }

  render() {
    const { params, sound } = this.ctx;
    const q = this.ctx.quality();
    const seg = (name, items, cur) => `<div class="op-seg" data-name="${name}">${items.map(([v, l]) => `<button data-v="${v}" aria-pressed="${String(v) === String(cur)}">${l}</button>`).join('')}</div>`;
    const onOff = (name, on) => seg(name, [['1', t('pause.on')], ['0', t('pause.off')]], on ? '1' : '0');
    const slider = (name, v) => `<input type="range" min="0" max="100" step="1" value="${Math.round(v * 100)}" data-name="${name}" aria-label="${t('opt.' + name)}">`;
    const row = (label, ctl) => `<div class="op-row"><span>${label}</span>${ctl}</div>`;
    let body = '';
    if (this.tab === 'graphics') {
      body = row(t('opt.preset'), seg('quality', QUALITIES.map((k) => [k, t('q.' + k)]), q))
        + row(t('opt.dof'), onOff('dof', params.dof))
        + row(t('opt.lens'), onOff('lens', params.lensFlare))
        + `<p class="op-note">${t('opt.presetNote')}</p>`;
    } else if (this.tab === 'sound') {
      const v = sound.volumes;
      body = row(t('opt.master'), slider('master', v.master))
        + row(t('opt.music'), slider('music', v.music))
        + row(t('opt.world'), slider('world', v.world))
        + row(t('opt.voice'), slider('voice', v.voice ?? 1))
        + row(t('pause.sound'), onOff('sound', params.sound));
    } else if (this.tab === 'controls') {
      // two columns filled top to bottom, so the list fits without scrolling
      const m = this.ctx.mouse || { lock: true, sens: 1, photoSens: 1 };
      // with a controller connected, its (fixed) button sits beside each key
      const padChip = (a) => (pad.connected && PAD_ACTIONS[a] != null ? pad.chip(PAD_ACTIONS[a]) : '');
      const rows = [
        ...ACTIONS.map((a) => row(t('bind.' + a), `<span class="op-keys">${padChip(a)}<button class="op-key${this.capturing === a ? ' wait' : ''}" data-bind="${a}">${this.capturing === a ? t('opt.pressKey') : keyLabel(primary(a))}</button></span>`)),
        row(t('opt.mouseLock'), onOff('mouseLock', m.lock)),
        row(t('opt.mouseSens'), `<input type="range" min="25" max="250" step="5" value="${Math.round(m.sens * 100)}" data-mouse="sens" aria-label="${t('opt.mouseSens')}">`),
        row(t('opt.photoSens'), `<input type="range" min="25" max="250" step="5" value="${Math.round((m.photoSens ?? 1) * 100)}" data-mouse="photoSens" aria-label="${t('opt.photoSens')}">`),
        row(t('opt.invertX'), onOff('invertX', !!m.invertX)),
        row(t('opt.invertY'), onOff('invertY', !!m.invertY)),
        row(t('opt.vibration'), onOff('vibration', pad.vibration)),
      ];
      body = `<div class="op-binds" style="--rows: ${Math.ceil(rows.length / 2)}">${rows.join('')}</div><p class="op-note">${t('opt.bindNote')}</p><button class="op-reset" data-act="reset">${t('opt.reset')}</button>`;
    } else {
      body = row(t('menu.language'), seg('lang', [['en-US', 'English'], ['fr-FR', 'Français']], getLocale()))
        + row(t('opt.subtitles'), onOff('subs', subtitlesOn()))
        + (fullscreenSupported ? row(t('opt.fullscreen'), onOff('fullscreen', isFullscreen())) : '');
    }
    keepFocus(this.el, () => { this.el.innerHTML = `
      <div class="op-card">
        <h2>${t('opt.title')}</h2>
        <div class="op-tabs" role="tablist">${TABS.map((k) => `<button role="tab" data-tab="${k}" aria-selected="${k === this.tab}">${t('opt.tab.' + k)}</button>`).join('')}</div>
        <div class="op-body">${body}</div>
        <button class="op-back" data-act="close">${t('opt.back')}</button>
      </div>`; });
    this.wire();
  }

  wire() {
    const { params, sound } = this.ctx;
    const el = this.el;
    el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { this.tab = b.dataset.tab; this.capturing = null; this.render(); });
    el.querySelector('[data-act=close]').onclick = () => this.hide();
    el.querySelectorAll('.op-seg').forEach((g) => g.querySelectorAll('button').forEach((b) => b.onclick = () => {
      const v = b.dataset.v, name = g.dataset.name;
      if (name === 'quality') this.ctx.applyQuality(v);
      if (name === 'dof') params.dof = v === '1';
      if (name === 'lens') { params.lensFlare = v === '1'; params.chromatic = v === '1' ? CHROMATIC_ON : 0; }
      if (name === 'sound') { params.sound = v === '1'; if (params.sound) sound.start(); sound.setMuted(!params.sound); }
      if (name === 'lang') setLocale(v);
      if (name === 'fullscreen') setFullscreen(v === '1'); // the panel re-renders on the change event
      if (name === 'subs') { try { localStorage.setItem('pingu.subtitles', v); } catch { /* storage unavailable */ } }
      if (name === 'mouseLock' && this.ctx.mouse) { this.ctx.mouse.lock = v === '1'; this.ctx.saveMouse?.(); }
      if ((name === 'invertX' || name === 'invertY') && this.ctx.mouse) { this.ctx.mouse[name] = v === '1'; this.ctx.saveMouse?.(); }
      if (name === 'vibration') pad.setVibration(v === '1');
      this.ctx.save?.();
      this.render();
    }));
    el.querySelectorAll('input[type=range][data-name]').forEach((r) => r.oninput = () => sound.setVolume(r.dataset.name, r.value / 100));
    el.querySelectorAll('input[data-mouse]').forEach((r) => r.oninput = () => { if (this.ctx.mouse) { this.ctx.mouse[r.dataset.mouse] = r.value / 100; this.ctx.saveMouse?.(); } });
    el.querySelectorAll('[data-bind]').forEach((b) => b.onclick = () => { this.capturing = b.dataset.bind; this.render(); });
    el.querySelector('[data-act=reset]')?.addEventListener('click', () => { resetBindings(); this.render(); });
  }
}
