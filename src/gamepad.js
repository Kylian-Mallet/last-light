// Gamepad support, standard mapping (Xbox, PlayStation and most controllers the browser
// knows). The pad is polled once per frame. It remembers whether the player last used the
// pad or the keyboard and mouse, so prompts and hints show the right glyphs (Xbox letters
// or PlayStation shapes), and it drives every menu: the D-pad or the left stick moves the
// focus, A (✕) confirms, B (○) goes back, the bumpers switch tabs.

/** Button indices of the standard mapping. */
export const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

/** The pad button of each game action (fixed; the keyboard keys are rebindable). */
export const PAD_ACTIONS = {
  slide: BTN.A, call: BTN.B, interact: BTN.X, photo: BTN.Y, hurry: BTN.RB,
  objective: BTN.VIEW, hideUI: BTN.UP, pause: BTN.MENU,
};

const BUTTONS = 17; // buttons of the standard mapping (with the home button)
const DEAD = 0.2; // stick dead zone (radial)
const REPEAT_FIRST = 0.38, REPEAT_NEXT = 0.11; // menu auto-repeat, seconds

const XBOX = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', '↑', '↓', '←', '→'];
const PLAYSTATION = ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', '↑', '↓', '←', '→'];

/**
 * 'ps' for Sony controllers (by name or USB vendor 054c), otherwise 'xbox'. Xbox is checked
 * first: "Xbox Wireless Controller" also contains the DualShock 4's bare name.
 */
function familyOf(id) {
  if (/xbox|xinput|045e/i.test(id)) return 'xbox';
  return /054c|playstation|dualsense|dualshock|wireless controller/i.test(id) ? 'ps' : 'xbox';
}

class Pad {
  constructor() {
    this.connected = false;
    this.family = 'xbox';
    this.dualSense = false;
    /** 'keys' (keyboard and mouse) or 'pad': whichever the player touched last. */
    this.mode = 'keys';
    this.now = new Array(BUTTONS).fill(false);
    this.prev = new Array(BUTTONS).fill(false);
    this.lx = 0; this.ly = 0; this.rx = 0; this.ry = 0; this.lt = 0; this.rt = 0;
    this.listeners = new Set();
    this.repeat = { dir: null, t: 0 };
    this.gp = null;
    /** Vibration on / off (Options › Controls), remembered. */
    try { this.vibration = localStorage.getItem('pingu.vibration') !== '0'; } catch { this.vibration = true; }
    this.humNext = [0, 0]; // continuous rumble asked for during this frame
    this.humAt = 0;
    const toKeys = () => this.use('keys');
    window.addEventListener('keydown', toKeys, true);
    window.addEventListener('pointerdown', toKeys, true);
    window.addEventListener('mousemove', (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 3) toKeys(); }, true);
    window.addEventListener('gamepaddisconnected', () => { this.poll(); if (!this.connected) this.use('keys'); });
  }

  /** Read the pad (call once per frame, before anything asks about it). */
  poll() {
    this.sendHum();
    this.prev.splice(0, BUTTONS, ...this.now);
    const pads = navigator.getGamepads?.() ?? [];
    let gp = null;
    for (const p of pads) if (p?.connected && (!gp || p.timestamp > gp.timestamp)) gp = p;
    this.connected = !!gp;
    this.gp = gp;
    if (!gp) { this.now.fill(false); this.lx = this.ly = this.rx = this.ry = this.lt = this.rt = 0; return; }
    if (gp.id !== this.id) {
      this.id = gp.id;
      this.family = familyOf(gp.id);
      this.dualSense = /dualsense|0ce6|0df2/i.test(gp.id);
      if (this.mode === 'pad') this.emit();
    }
    for (let i = 0; i < BUTTONS; i++) {
      const b = gp.buttons[i];
      this.now[i] = !!b && (b.pressed || b.value > 0.4);
    }
    this.lt = gp.buttons[BTN.LT]?.value ?? 0;
    this.rt = gp.buttons[BTN.RT]?.value ?? 0;
    [this.lx, this.ly] = stick(gp.axes[0], gp.axes[1]);
    [this.rx, this.ry] = stick(gp.axes[2], gp.axes[3]);
    if (this.now.some(Boolean) || this.lx || this.ly || this.rx || this.ry) this.use('pad');
  }

  /** Is the button held? */
  down(b) { return this.now[b]; }
  /** Was the button pressed this frame? */
  pressed(b) { return this.now[b] && !this.prev[b]; }
  /** Was the button let go this frame? */
  released(b) { return !this.now[b] && this.prev[b]; }

  /**
   * Menu direction this frame ('up' | 'down' | 'left' | 'right' | null), from the D-pad
   * (and the left stick unless `dpadOnly`), with keyboard-like auto-repeat while held.
   */
  menuDir(dt, dpadOnly = false) {
    const lx = dpadOnly ? 0 : this.lx, ly = dpadOnly ? 0 : this.ly;
    let dir = null;
    if (this.now[BTN.UP] || ly < -0.5) dir = 'up';
    else if (this.now[BTN.DOWN] || ly > 0.5) dir = 'down';
    else if (this.now[BTN.LEFT] || lx < -0.5) dir = 'left';
    else if (this.now[BTN.RIGHT] || lx > 0.5) dir = 'right';
    const r = this.repeat;
    if (dir !== r.dir) { r.dir = dir; r.t = REPEAT_FIRST; return dir; }
    if (!dir) return null;
    r.t -= dt;
    if (r.t > 0) return null;
    r.t = REPEAT_NEXT;
    return dir;
  }

  setVibration(on) {
    this.vibration = on;
    try { localStorage.setItem('pingu.vibration', on ? '1' : '0'); } catch { /* storage unavailable */ }
    if (on) this.rumble(0.3, 0.5, 160); // a taste of it
  }

  /**
   * A one-off rumble: strong (low, heavy motor) and weak (high, light motor) in 0..1, for
   * `ms` milliseconds. Only with the pad in hand and vibration on.
   */
  rumble(strong, weak = strong, ms = 120) {
    if (!this.vibration || this.mode !== 'pad' || !this.gp) return;
    const s = Math.min(1, Math.max(0, strong)), w = Math.min(1, Math.max(0, weak));
    const act = this.gp.vibrationActuator;
    if (act?.playEffect) act.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: s, weakMagnitude: w }).catch(() => { /* busy or unsupported */ });
    else this.gp.hapticActuators?.[0]?.pulse?.(Math.max(s, w), ms); // Firefox
  }

  /**
   * A continuous rumble (wind, a slide): call it every frame with the level wanted; the
   * strongest request of the frame is played as a short effect, renewed while asked for.
   */
  hum(strong, weak = strong) {
    this.humNext[0] = Math.max(this.humNext[0], strong);
    this.humNext[1] = Math.max(this.humNext[1], weak);
  }
  sendHum() {
    const [s, w] = this.humNext;
    this.humNext[0] = this.humNext[1] = 0;
    const now = performance.now();
    if (Math.max(s, w) < 0.02 || now - this.humAt < 90) return;
    this.humAt = now;
    this.rumble(s, w, 140);
  }

  use(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    document.body.classList.toggle('pad-mode', mode === 'pad');
    this.emit();
  }
  emit() { this.listeners.forEach((fn) => fn(this.mode)); }
  /** Called when the player switches between pad and keyboard (or plugs another pad). */
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Text of a button for the current controller family. */
  label(b) {
    if (b === BTN.VIEW && this.family === 'ps') return this.dualSense ? 'Create' : 'Share';
    return (this.family === 'ps' ? PLAYSTATION : XBOX)[b] ?? '';
  }
  /** A button as a key chip. */
  chip(b) {
    const face = b <= BTN.Y ? ' pad-face' : '';
    return `<kbd class="pad${face}">${this.label(b)}</kbd>`;
  }
  /** A stick as a key chip ('L' or 'R'). */
  stickChip(side) {
    return `<kbd class="pad pad-stick">${this.family === 'ps' ? side : side + 'S'}</kbd>`;
  }
}

/** Radial dead zone, rescaled so the stick still reaches 1. */
function stick(x = 0, y = 0) {
  const m = Math.hypot(x, y);
  if (m < DEAD) return [0, 0];
  const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / m;
  return [x * k, y * k];
}

export const pad = new Pad();

// ---------------------------------------------------------------------------
// Menus: spatial focus navigation inside whichever panel is open.

const FOCUSABLE = 'button:not([disabled]), input[type=range], [tabindex]:not([tabindex="-1"])';

function visible(el) {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

/** The focusable controls of a panel, in reading order. */
function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(visible);
}

/** Focus a control (showing the focus ring even though no key was pressed). */
function focusEl(el) {
  if (!el) return;
  try { el.focus({ focusVisible: true, preventScroll: false }); } catch { el.focus(); }
  el.scrollIntoView?.({ block: 'nearest' });
}

/** Make sure something in the panel has the focus (the first control, or `prefer`). */
export function ensureFocus(root, prefer) {
  if (root.contains(document.activeElement) && document.activeElement !== root && visible(document.activeElement)) return document.activeElement;
  const el = (prefer && visible(prefer) ? prefer : null) ?? focusables(root)[0];
  focusEl(el);
  return el;
}

/**
 * Move the focus one step in a direction: the nearest control that way, favouring ones in
 * line. A slider takes left / right for its value.
 */
export function navigate(root, dir) {
  const cur = ensureFocus(root);
  if (!cur) return;
  const horizontal = dir === 'left' || dir === 'right';
  if (horizontal && cur.matches('input[type=range]')) {
    const before = cur.value;
    if (dir === 'right') cur.stepUp(); else cur.stepDown();
    if (cur.value !== before) cur.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  const vx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0, vy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
  let best = null, bestScore = Infinity;
  for (const el of focusables(root)) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    // gap along the direction (edge to edge) and offset across it (centre to centre)
    const along = vx ? (vx > 0 ? b.left - a.right : a.left - b.right) : (vy > 0 ? b.top - a.bottom : a.top - b.bottom);
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    const ahead = vx ? (bx - ax) * vx : (by - ay) * vy;
    if (ahead <= 1 || along < -Math.min(a.width, a.height) * 0.5) continue;
    // offset across the direction: the gap between the two spans (0 when they overlap),
    // plus a little of the centre offset to break ties
    const gap = vx ? Math.max(0, b.top - a.bottom, a.top - b.bottom) : Math.max(0, b.left - a.right, a.left - b.right);
    const across = gap + 0.1 * (vx ? Math.abs(by - ay) : Math.abs(bx - ax));
    const score = Math.max(0, along) + across * (horizontal ? 3 : 1);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  // moving only moves the focus: a choice (a language, a preset…) is made with A
  if (best) focusEl(best);
}

/**
 * Rebuild a panel's markup without losing the focused control: it is found again in the
 * new markup by its data-* attributes (and those of its group).
 */
export function keepFocus(root, rebuild) {
  const f = document.activeElement;
  let sel = null;
  if (f && f !== root && root.contains(f)) {
    const attrs = Object.entries(f.dataset).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}="${CSS.escape(v)}"]`).join('');
    const group = f.parentElement?.closest('[data-name]');
    if (attrs) sel = (group ? `[data-name="${CSS.escape(group.dataset.name)}"] ` : '') + attrs;
  }
  rebuild();
  const el = sel && root.querySelector(sel);
  if (!el) return;
  if (pad.mode === 'pad') focusEl(el); else el.focus({ preventScroll: true });
}
