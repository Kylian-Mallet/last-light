// Full screen: one switch shared by the title screen, the pause menu and the options.
// Entering needs a click (browsers require a user gesture); Esc or F11 leave it too,
// so every control follows the 'fullscreenchange' event rather than its own state.

const doc = document;
const root = doc.documentElement;

export const fullscreenSupported = !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);

export function isFullscreen() {
  return !!(doc.fullscreenElement || doc.webkitFullscreenElement);
}

export function setFullscreen(on) {
  if (on === isFullscreen()) return;
  try {
    const p = on
      ? (root.requestFullscreen ? root.requestFullscreen({ navigationUI: 'hide' }) : root.webkitRequestFullscreen?.())
      : (doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.());
    p?.catch?.(() => { /* refused (no gesture, or not allowed here) */ });
  } catch { /* unsupported */ }
}

export function toggleFullscreen() { setFullscreen(!isFullscreen()); }

export function onFullscreenChange(fn) {
  doc.addEventListener('fullscreenchange', fn);
  doc.addEventListener('webkitfullscreenchange', fn);
}
