// Key lists (bottom left) always sit on one line: when a list is wider than the window
// (a narrow window, a long language, a rebound key with a long name), it is scaled down
// as a whole instead of wrapping onto a second line.

const lists = new Set();

/** Fit `el` (a .hud-hints row) to the window width, keeping a 28 px margin each side. */
export function fitLine(el) {
  lists.add(el);
  el.style.transform = '';
  const natural = el.scrollWidth;
  if (!natural) return;
  const room = window.innerWidth - 56;
  el.style.transform = natural > room ? `scale(${(room / natural).toFixed(4)})` : '';
}

window.addEventListener('resize', () => lists.forEach(fitLine));
