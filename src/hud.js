import { fitLine } from './fitline.js';
import { t, keyLabel, onLocaleChange } from './i18n.js';
import { ACTIONS, primary, onBindingsChange } from './bindings.js';
import { pad, PAD_ACTIONS, BTN } from './gamepad.js';

// a prompt's key may be an action name ("interact") or a raw key code; with the pad in
// hand, an action shows its controller button instead
const labelOf = (k) => (pad.mode === 'pad' && PAD_ACTIONS[k] != null ? pad.label(PAD_ACTIONS[k]) : keyLabel(ACTIONS.includes(k) ? primary(k) : k));

// Light white HUD. Everything is hidden by default and appears only when it has
// something to say: chapter cards, a one-line objective, world-anchored prompts,
// the call echo, warmth during the storm, letterbox bars for cinematics.

const html = /* html */`
  <div class="hud-letterbox top"></div><div class="hud-letterbox bottom"></div>
  <div class="hud-fade"></div>
  <div class="hud-chapter"><span class="hud-chapter-text"></span></div>
  <div class="hud-objective"><span class="hud-objective-text"></span></div>
  <div class="hud-objective-big"><span class="hud-objective-kicker"></span><span class="hud-objective-big-text"></span></div>
  <div class="hud-moment"></div>
  <div class="hud-prompt">
    <svg class="hud-prompt-ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="16" class="track"/>
      <circle cx="18" cy="18" r="16" class="fill"/>
    </svg>
    <span class="hud-prompt-key"></span>
    <span class="hud-prompt-verb"></span>
  </div>
  <div class="hud-mark hud-echo"><div class="hud-mark-in"><span class="hud-mark-label"></span><span class="hud-mark-pin"></span><span class="hud-mark-arrow">›</span></div></div>
  <div class="hud-mark hud-way"><div class="hud-mark-in"><span class="hud-mark-label"></span><span class="hud-mark-pin"></span><span class="hud-mark-arrow">›</span></div></div>
  <div class="hud-warmth">
    <svg viewBox="0 0 120 18" aria-hidden="true"><path class="track" d="M4 15 Q60 -3 116 15"/><path class="fill" d="M4 15 Q60 -3 116 15"/></svg>
    <span class="hud-warmth-label"></span>
  </div>
  <div class="hud-hints"></div>
  <div class="hud-skip"><svg class="hud-skip-ring" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" class="track"/><circle cx="10" cy="10" r="8" class="fill"/></svg><span class="hud-skip-text"></span></div>
  <div class="hud-subtitle"><span></span></div>
  <div class="hud-end">
    <div class="hud-end-title"></div>
    <div class="hud-end-line"></div>
    <div class="hud-end-actions"><button class="hud-end-again"></button><button class="hud-end-free"></button></div>
    <div class="hud-end-credits"></div>
  </div>
`;

export class Hud {
  constructor(root = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = html;
    root.appendChild(this.el);
    const $ = (s) => this.el.querySelector(s);
    this.$ = {
      chapter: $('.hud-chapter'), chapterText: $('.hud-chapter-text'),
      objective: $('.hud-objective'), objectiveText: $('.hud-objective-text'),
      objectiveBig: $('.hud-objective-big'), objectiveBigText: $('.hud-objective-big-text'), objectiveKicker: $('.hud-objective-kicker'),
      moment: $('.hud-moment'),
      prompt: $('.hud-prompt'), promptKey: $('.hud-prompt-key'), promptVerb: $('.hud-prompt-verb'), promptFill: $('.hud-prompt-ring .fill'),
      echo: $('.hud-echo'), echoLabel: $('.hud-echo .hud-mark-label'),
      way: $('.hud-way'), wayLabel: $('.hud-way .hud-mark-label'),
      warmth: $('.hud-warmth'), warmthFill: $('.hud-warmth .fill'), warmthLabel: $('.hud-warmth-label'),
      hints: $('.hud-hints'), skip: $('.hud-skip'), skipText: $('.hud-skip-text'), skipFill: $('.hud-skip-ring .fill'),
      fade: $('.hud-fade'),
      end: $('.hud-end'), endTitle: $('.hud-end-title'), endLine: $('.hud-end-line'), endCredits: $('.hud-end-credits'),
      endAgain: $('.hud-end-again'), endFree: $('.hud-end-free'),
    };
    this.state = { chapter: null, objective: null, moment: null, prompt: null, hints: false };
    this.timers = {};
    this.placed = new WeakMap(); // smoothed screen positions of world-anchored elements
    this.echoTime = 0;
    onLocaleChange(() => this.relabel());
    onBindingsChange(() => this.relabel());
    pad.onChange(() => this.relabel());
    this.relabel();
  }

  relabel() {
    const s = this.state;
    if (s.chapter) this.$.chapterText.textContent = t(s.chapter);
    if (s.objective) this.$.objectiveText.textContent = this.$.objectiveBigText.textContent = t(s.objective);
    this.$.objectiveKicker.textContent = t('obj.new');
    if (s.moment) this.$.moment.textContent = t(s.moment);
    this.$.echoLabel.textContent = t('echo.reply');
    if (this.wayKey) this.$.wayLabel.textContent = t(this.wayKey);
    this.$.warmthLabel.textContent = t('warmth');
    this.$.endTitle.textContent = t('end.title');
    this.$.endLine.textContent = t('end.line');
    this.$.endCredits.textContent = t('end.credits');
    this.$.endAgain.textContent = t('end.again');
    this.$.endFree.textContent = t('end.free');
    this.$.skipText.textContent = t('skip', { key: labelOf('slide') });
    if (s.hints) this.hints(true);
    if (s.prompt) { this.$.promptVerb.textContent = t(s.prompt.verb); this.$.promptKey.textContent = labelOf(s.prompt.code); }
  }

  flash(el, key, ms) {
    clearTimeout(this.timers[key]);
    el.classList.add('on');
    if (ms) this.timers[key] = setTimeout(() => el.classList.remove('on'), ms);
  }

  chapter(key, ms = 4200) {
    this.state.chapter = key;
    this.$.chapterText.textContent = t(key);
    this.flash(this.$.chapter, 'chapter', ms);
  }

  /** One-line objective; shows for a while, recallable with Tab. */
  objective(key, ms = 6000) {
    const fresh = key && key !== this.state.objective;
    this.state.objective = key;
    this.cancelReveal();
    if (!key) { this.$.objective.classList.remove('on'); return; }
    this.$.objectiveText.textContent = t(key);
    if (fresh) this.reveal(ms);
    else this.flash(this.$.objective, 'objective', ms);
  }

  /**
   * A new objective is first announced large at the top centre of the screen (clear of
   * the prompts and markers in the middle), then fades out and settles, fading in, in
   * its place in the top-left corner.
   */
  reveal(ms) {
    const $ = this.$;
    $.objective.classList.remove('on');
    $.objectiveBigText.textContent = $.objectiveText.textContent;
    $.objectiveBig.classList.add('on');
    this.timers.reveal = setTimeout(() => {
      $.objectiveBig.classList.remove('on');
      this.timers.reveal = setTimeout(() => this.flash($.objective, 'objective', ms), 700);
    }, 3200);
  }

  cancelReveal() {
    clearTimeout(this.timers.reveal);
    this.$.objectiveBig.classList.remove('on');
  }
  recallObjective() { if (this.state.objective) this.flash(this.$.objective, 'objective', 4000); }

  moment(key, ms = 4500) {
    this.state.moment = key;
    this.$.moment.textContent = t(key);
    this.flash(this.$.moment, 'moment', ms);
  }

  /**
   * Move a world-anchored element on screen: sub-pixel (whole-pixel rounding made the
   * text hop a pixel back and forth as the chick walked) and lightly smoothed, so the
   * frame-to-frame wobble of the follow camera does not shimmer through. A big jump (a
   * cut, or the element reappearing elsewhere) snaps instead of sliding.
   */
  place(el, x, y) {
    const now = performance.now();
    let s = this.placed.get(el);
    if (!s || now - s.t > 250 || Math.hypot(x - s.x, y - s.y) > 120) s = { x, y, t: now };
    else {
      const k = 1 - Math.exp(-(now - s.t) / 40);
      s.x += (x - s.x) * k; s.y += (y - s.y) * k; s.t = now;
    }
    this.placed.set(el, s);
    el.style.transform = `translate3d(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px, 0)`;
  }

  /** World-anchored interaction prompt. screen = {x, y} in CSS px, or null to hide. */
  prompt(screen, verb, code = 'interact', hold = 0) {
    if (!screen) {
      if (this.state.prompt) { this.$.prompt.classList.remove('on'); this.state.prompt = null; }
      return;
    }
    if (!this.state.prompt || this.state.prompt.verb !== verb || this.state.prompt.code !== code) {
      this.$.promptVerb.textContent = t(verb);
      this.$.promptKey.textContent = labelOf(code);
    }
    this.state.prompt = { verb, code, hold: hold > 0 || this.state.prompt?.hold };
    this.$.prompt.classList.add('on');
    this.place(this.$.prompt, screen.x, screen.y);
    this.$.promptFill.style.strokeDashoffset = String(100.5 * (1 - hold));
  }

  /**
   * Key feedback: the prompt for that key answers the press (ring fills, the key dips,
   * a ripple leaves the ring), so the player knows it registered.
   */
  pressed(code) {
    const st = this.state.prompt;
    if (!st || st.code !== code) return;
    const el = this.$.prompt;
    el.classList.remove('pressed', 'pressed-hold');
    void el.offsetWidth; // restart the animation on repeated presses
    el.classList.add(st.hold ? 'pressed-hold' : 'pressed');
    clearTimeout(this.timers.pressed);
    this.timers.pressed = setTimeout(() => el.classList.remove('pressed', 'pressed-hold'), 700);
  }

  /**
   * Point at something in the world. ndc: the target projected by the camera (x, y, z),
   * or null to hide. On screen, a pin floats right above the target; off screen (or
   * behind the camera), a chevron on the frame edge shows which way to turn.
   */
  point(el, ndc) {
    if (!ndc) { el.classList.remove('on'); return; }
    const w = window.innerWidth, h = window.innerHeight;
    const behind = ndc.z > 1;
    const onScreen = !behind && Math.abs(ndc.x) < 0.92 && ndc.y > -0.9 && ndc.y < 0.8;
    el.classList.toggle('edge', !onScreen);
    if (onScreen) {
      this.place(el, (ndc.x * 0.5 + 0.5) * w, (-ndc.y * 0.5 + 0.5) * h);
    } else {
      let ex = ndc.x, ey = -ndc.y;
      if (behind) { ex = -ex; ey = -ey; } // behind the camera: point the other way
      const angle = Math.atan2(ey, ex * w / h);
      const cx = w / 2, cy = h / 2;
      const dx = Math.cos(angle), dy = Math.sin(angle);
      const k = Math.min((cx - 64) / Math.max(Math.abs(dx), 1e-3), (cy - 64) / Math.max(Math.abs(dy), 1e-3));
      this.place(el, cx + dx * k, cy + dy * k);
      el.querySelector('.hud-mark-arrow').style.transform = `rotate(${angle}rad)`;
    }
    el.classList.add('on');
  }
  echo(ndc) { this.point(this.$.echo, ndc); }
  /** Where to go next: labelKey names the place, ndc as in point(). */
  waypoint(ndc, labelKey) {
    if (labelKey && labelKey !== this.wayKey) { this.wayKey = labelKey; this.$.wayLabel.textContent = t(labelKey); }
    this.point(this.$.way, ndc);
  }

  warmth(v) {
    if (v == null) { this.$.warmth.classList.remove('on'); return; }
    this.$.warmth.classList.add('on');
    this.$.warmthFill.style.strokeDashoffset = String(130 * (1 - Math.max(0, Math.min(1, v))));
    this.$.warmth.classList.toggle('low', v < 0.3);
  }

  hints(show) {
    this.state.hints = show;
    if (!show) { this.$.hints.classList.remove('on'); return; }
    if (pad.mode === 'pad') {
      const b = (a) => pad.chip(PAD_ACTIONS[a]);
      this.$.hints.innerHTML = `
        <span>${pad.stickChip('L')} ${t('hint.move')}</span>
        <span>${pad.stickChip('R')} ${t('hint.camera')}</span>
        <span>${b('hurry')}${pad.chip(BTN.L3)} ${t('hint.hurry')}</span>
        <span>${b('slide')} ${t('hint.slide')}</span>
        <span>${b('call')} ${t('hint.call')}</span>
        <span>${b('interact')} ${t('hint.interact')}</span>
        <span>${b('objective')} ${t('hint.objective')}</span>
        <span>${b('photo')} ${t('hint.photo')}</span>
        <span>${b('pause')} ${t('hint.menu')}</span>`;
      this.$.hints.classList.add('on');
      fitLine(this.$.hints);
      return;
    }
    const k = (c) => `<kbd>${keyLabel(c)}</kbd>`;
    this.$.hints.innerHTML = `
      <span>${k(primary('forward'))}${k(primary('left'))}${k(primary('back'))}${k(primary('right'))} ${t('hint.move')}</span>
      <span>${k(primary('hurry'))} ${t('hint.hurry')}</span>
      <span>${k(primary('slide'))} ${t('hint.slide')}</span>
      <span>${k(primary('call'))} ${t('hint.call')}</span>
      <span>${k(primary('interact'))} ${t('hint.interact')}</span>
      <span>${k(primary('objective'))} ${t('hint.objective')}</span>
      <span>${k(primary('photo'))} ${t('hint.photo')}</span>
      <span>${k('Escape')} ${t('hint.menu')}</span>`;
    this.$.hints.classList.add('on');
    fitLine(this.$.hints);
  }

  /** Show the key list for a while (a player pressing keys that do nothing). */
  flashHints(ms = 9000) {
    this.hints(true);
    clearTimeout(this.timers.hints);
    this.timers.hints = setTimeout(() => this.hints(false), ms);
  }

  /**
   * Narrator subtitle (a new line replaces the previous one; '' hides it). The narrator
   * clears it on game time, so a paused line keeps its subtitle.
   */
  subtitle(text) {
    const el = this.el.querySelector('.hud-subtitle');
    if (text) el.querySelector('span').textContent = text;
    el.classList.toggle('on', !!text);
  }

  letterbox(on) { this.el.classList.toggle('cinematic', on); }
  skip(on) { this.$.skip.classList.toggle('on', on); }
  /** How far the skip key has been held (0..1): the ring beside "Hold … to skip" fills. */
  skipProgress(k) {
    k = Math.max(0, Math.min(1, k || 0));
    if (k === this.skipK) return;
    this.skipK = k;
    this.$.skipFill.style.strokeDashoffset = String(50.3 * (1 - k));
    this.$.skip.classList.toggle('holding', k > 0);
  }

  /** Fade overlay: color 'black' | 'white', opacity 0..1, seconds. */
  fade(opacity, seconds = 1.5, color = 'black') {
    const f = this.$.fade;
    f.style.transition = `opacity ${seconds}s ease`;
    f.style.background = color === 'white' ? '#f4f6fa' : '#000';
    requestAnimationFrame(() => (f.style.opacity = String(opacity)));
    return new Promise((r) => setTimeout(r, seconds * 1000));
  }

  ending(show, { onAgain, onFree } = {}) {
    this.$.end.classList.toggle('on', show);
    this.$.endAgain.onclick = onAgain || null;
    this.$.endFree.onclick = onFree || null;
  }
}
