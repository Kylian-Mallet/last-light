// Key bindings: every game action maps to physical keys (KeyboardEvent.code), so the
// same hand position works on AZERTY (ZQSD), QWERTY (WASD) and QWERTZ alike. The first
// key of each action can be rebound from the options menu; arrows stay as a fallback
// for movement. Labels shown to the player come from keyLabel() (their own layout).

export const ACTIONS = ['forward', 'back', 'left', 'right', 'hurry', 'slide', 'call', 'interact', 'objective', 'photo', 'hideUI'];

const DEFAULTS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  hurry: ['ShiftLeft', 'ShiftRight'],
  slide: ['Space'],
  call: ['KeyR'],
  interact: ['KeyE'],
  objective: ['Tab'],
  photo: ['KeyF'],
  hideUI: ['KeyH'],
};
// keys the player may not take (menus, browser)
const RESERVED = ['Escape', 'F2', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight'];

const STORE = 'pingu.bindings';
let map = load();
const listeners = new Set();

function load() {
  const m = structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
    for (const a of ACTIONS) if (typeof saved[a] === 'string') m[a][0] = saved[a];
  } catch { /* storage unavailable */ }
  return m;
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(ACTIONS.map((a) => [a, map[a][0]])))); } catch { /* storage unavailable */ }
  listeners.forEach((fn) => fn());
}

/** The action a key triggers, or null. */
export function actionOf(code) {
  for (const a of ACTIONS) if (map[a].includes(code)) return a;
  return null;
}
/** Is any key of this action held? */
export function isDown(action, held) { return map[action].some((c) => held.has(c)); }
/** The main key of an action (what prompts and hints display). */
export function primary(action) { return map[action][0]; }
/** Rebind an action's main key; a key taken by another action is swapped onto it. */
export function rebind(action, code) {
  if (RESERVED.includes(code)) return false;
  const old = map[action][0];
  for (const a of ACTIONS) if (a !== action && map[a][0] === code) map[a][0] = old;
  map[action][0] = code;
  save();
  return true;
}
export function resetBindings() { map = structuredClone(DEFAULTS); save(); }
export function onBindingsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
