// Minimal i18n: EN-US and FR-FR string tables, browser-language detection,
// persisted choice, and {placeholder} interpolation.

const STRINGS = {
  'en-US': {
    'eyebrow': 'Antarctica · late summer',
    'title': 'Last light',
    'subtitle': 'An emperor penguin chick, the day its parents leave for the sea.',
    'start': 'Begin',
    'loading': 'Loading…',
    'loading.chick': 'Loading the chick… {p}%',
    'loading.colony': 'Gathering the colony…',
    'loading.shaders': 'Compiling shaders…',
    'headphones': 'Best with headphones',
    'error.start': 'Failed to start:',
    'aria.language': 'Language',
    'aria.mouse': 'mouse',
    'aria.github': 'Source code on GitHub',
    'skip': 'Hold {key} to skip',

    'chapter.1': 'I · The colony',
    'chapter.2': 'II · The departure',
    'chapter.3': 'III · Alone',
    'chapter.4': 'IV · The storm',
    'chapter.5': 'V · First light',

    'obj.findParent': 'Find your parent',
    'obj.eat': 'Take the fish',
    'obj.creche': 'Rejoin the crèche',
    'obj.follow': 'Follow the colony to the edge',
    'obj.watch': '…',
    'obj.new': 'New objective',
    'obj.friend': 'Another chick is calling. Go to it',
    'obj.explore': 'Explore the floe together',
    'obj.shelter': 'Find shelter behind the ridge',
    'obj.huddle': 'Huddle with the others',
    'obj.sea': 'Walk toward the sea',

    'act.call': 'Call',
    'act.eat': 'Eat',
    'act.huddle': 'Huddle',
    'act.nudge': 'Nudge',
    'act.huddleHold': 'Hold to huddle',

    'hint.move': 'move',
    'hint.camera': 'camera',
    'hint.hurry': 'hurry',
    'hint.slide': 'belly slide',
    'hint.call': 'call',
    'hint.interact': 'interact',
    'hint.objective': 'objective',
    'hint.photo': 'photo mode',
    'hint.menu': 'menu',
    'cam.move': 'move',
    'cam.updown': 'up / down',
    'cam.fast': 'fast',
    'cam.look': 'drag to look',
    'cam.lookPad': 'look',
    'cam.settings': 'settings',
    'cam.shoot': 'shoot',
    'cam.leave': 'leave',
    'cam.quit': 'quit',

    'echo.reply': 'reply',
    'mark.creche': 'Crèche',
    'mark.shelter': 'Shelter',
    'mark.sea': 'The sea',
    'mark.parent': 'Your parent',
    'mark.friend': 'A lone chick',
    'mark.ridge': 'The ridge',
    'warmth': 'Warmth',

    'moment.friend': 'Another chick, alone too.',
    'moment.ridge': 'From up here, the colony is gone.',
    'moment.slide': 'Faster on the belly.',

    'end.title': 'Last light',
    'end.line': 'In a few weeks, the down will be gone. Then, the sea.',
    'end.credits': 'Penguins and fish modelled with Meshy · original score composed with ElevenLabs Music · calls: stevestevens, iNaturalist (CC0) · ambiences: al.barbosa, cobratronik, newagesoup, xkeril (CC0) and “Blizzard” by kevp888 (CC BY 4.0), freesound.org',
    'pause.title': 'Paused',
    'pause.resume': 'Resume',
    'pause.restart': 'Start over',
    'pause.photo': 'Photo mode',
    'fs.enter': 'Full screen',
    'fs.exit': 'Exit full screen',
    'opt.fullscreen': 'Full screen',
    'pause.quality': 'Graphics',
    'pause.sound': 'Sound',
    'pause.on': 'On',
    'pause.off': 'Off',
    'pause.hint': '{key} to resume',
    'end.again': 'Play again',
    'end.free': 'Keep exploring',

    'menu.language': 'Language',
    'ph.title': 'Photo mode',
    'ph.focal': 'Focal length',
    'ph.fstop': 'Aperture',
    'ph.focus': 'Focus',
    'ph.af': 'Auto',
    'ph.mf': 'Manual',
    'ph.ev': 'Exposure',
    'ph.roll': 'Tilt',
    'ph.look': 'Look',
    'ph.look.natural': 'Natural',
    'ph.look.bw': 'B&W',
    'ph.look.warm': 'Warm',
    'ph.look.cool': 'Cool',
    'ph.extras': 'Extras',
    'ph.grain': 'Grain',
    'ph.vignette': 'Vignette',
    'ph.grid': 'Grid',
    'ph.shoot': 'Take photo',
    'ph.develop': 'Developing',
    'ph.saved': 'Photo saved',
    'opt.title': 'Options',
    'opt.tab.graphics': 'Graphics',
    'opt.tab.sound': 'Sound',
    'opt.tab.controls': 'Controls',
    'opt.tab.display': 'Display',
    'opt.preset': 'Quality',
    'opt.presetNote': 'Lower the quality if the image stutters; changes apply instantly.',
    'opt.dof': 'Depth of field',
    'opt.lens': 'Lens effects',
    'opt.master': 'Overall volume',
    'opt.music': 'Music',
    'opt.world': 'Ambience',
    'opt.voice': 'Narrator',
    'opt.mouseLock': 'Mouse look',
    'opt.mouseSens': 'Sensitivity (play)',
    'opt.photoSens': 'Sensitivity (photo)',
    'opt.invertX': 'Invert horizontal look',
    'opt.invertY': 'Invert vertical look',
    'opt.vibration': 'Vibration',
    'opt.pressKey': 'Press a key…',
    'opt.bindNote': 'Click an action, then press the key to use. Arrow keys always move too. Controller buttons are fixed (shown beside each key when a controller is connected).',
    'opt.reset': 'Restore defaults',
    'opt.back': 'Back',
    'opt.subtitles': 'Subtitles',
    'bind.forward': 'Walk forward',
    'bind.back': 'Turn round, come back',
    'bind.left': 'Turn left',
    'bind.right': 'Turn right',
    'bind.hurry': 'Hurry',
    'bind.slide': 'Belly slide / skip',
    'bind.call': 'Call',
    'bind.interact': 'Interact',
    'bind.objective': 'Show objective',
    'bind.photo': 'Photo mode',
    'bind.hideUI': 'Hide interface',
    'q.low': 'Low',
    'q.medium': 'Medium',
    'q.high': 'High',
    'q.ultra': 'Ultra',
  },
  'fr-FR': {
    'eyebrow': 'Antarctique · fin de l’été',
    'title': 'Dernière lumière',
    'subtitle': 'Un poussin de manchot empereur, le jour où ses parents partent vers la mer.',
    'start': 'Commencer',
    'loading': 'Chargement…',
    'loading.chick': 'Chargement du poussin… {p} %',
    'loading.colony': 'La colonie se rassemble…',
    'loading.shaders': 'Compilation des shaders…',
    'headphones': 'À vivre avec un casque',
    'error.start': 'Impossible de démarrer :',
    'aria.language': 'Langue',
    'aria.mouse': 'souris',
    'aria.github': 'Code source sur GitHub',
    'skip': 'Maintenir {key} pour passer',

    'chapter.1': 'I · La colonie',
    'chapter.2': 'II · Le départ',
    'chapter.3': 'III · Seul',
    'chapter.4': 'IV · La tempête',
    'chapter.5': 'V · Première lumière',

    'obj.findParent': 'Retrouver ton parent',
    'obj.eat': 'Prendre le poisson',
    'obj.creche': 'Rejoindre la crèche',
    'obj.follow': 'Suivre la colonie jusqu’au bord',
    'obj.watch': '…',
    'obj.new': 'Nouvel objectif',
    'obj.friend': 'Un autre poussin appelle. Va le rejoindre',
    'obj.explore': 'Explorer la banquise ensemble',
    'obj.shelter': 'S’abriter derrière la crête',
    'obj.huddle': 'Se serrer contre les autres',
    'obj.sea': 'Marcher vers la mer',

    'act.call': 'Appeler',
    'act.eat': 'Manger',
    'act.huddle': 'Se blottir',
    'act.nudge': 'Approcher',
    'act.huddleHold': 'Maintenir pour se blottir',

    'hint.move': 'marcher',
    'hint.camera': 'caméra',
    'hint.hurry': 'presser le pas',
    'hint.slide': 'glisser',
    'hint.call': 'appeler',
    'hint.interact': 'interagir',
    'hint.objective': 'objectif',
    'hint.photo': 'mode photo',
    'hint.menu': 'menu',
    'cam.move': 'se déplacer',
    'cam.updown': 'monter / descendre',
    'cam.fast': 'rapide',
    'cam.look': 'glisser pour regarder',
    'cam.lookPad': 'regarder',
    'cam.settings': 'réglages',
    'cam.shoot': 'déclencher',
    'cam.leave': 'sortir',
    'cam.quit': 'quitter',

    'echo.reply': 'réponse',
    'mark.creche': 'Crèche',
    'mark.shelter': 'Abri',
    'mark.sea': 'La mer',
    'mark.parent': 'Ton parent',
    'mark.friend': 'Un poussin seul',
    'mark.ridge': 'La crête',
    'warmth': 'Chaleur',

    'moment.friend': 'Un autre poussin, seul lui aussi.',
    'moment.ridge': 'D’ici, la colonie a disparu.',
    'moment.slide': 'Plus vite sur le ventre.',

    'end.title': 'Dernière lumière',
    'end.line': 'Dans quelques semaines, le duvet sera tombé. Ensuite, la mer.',
    'end.credits': 'Manchots et poissons modélisés avec Meshy · musique originale composée avec ElevenLabs Music · cris : stevestevens, iNaturalist (CC0) · ambiances : al.barbosa, cobratronik, newagesoup, xkeril (CC0) et « Blizzard » de kevp888 (CC BY 4.0), freesound.org',
    'pause.title': 'Pause',
    'pause.resume': 'Reprendre',
    'pause.restart': 'Recommencer',
    'pause.photo': 'Mode photo',
    'fs.enter': 'Plein écran',
    'fs.exit': 'Quitter le plein écran',
    'opt.fullscreen': 'Plein écran',
    'pause.quality': 'Graphismes',
    'pause.sound': 'Son',
    'pause.on': 'Activé',
    'pause.off': 'Coupé',
    'pause.hint': '{key} pour reprendre',
    'end.again': 'Recommencer',
    'end.free': 'Continuer à explorer',

    'menu.language': 'Langue',
    'ph.title': 'Mode photo',
    'ph.focal': 'Focale',
    'ph.fstop': 'Ouverture',
    'ph.focus': 'Mise au point',
    'ph.af': 'Auto',
    'ph.mf': 'Manuelle',
    'ph.ev': 'Exposition',
    'ph.roll': 'Inclinaison',
    'ph.look': 'Rendu',
    'ph.look.natural': 'Naturel',
    'ph.look.bw': 'N&B',
    'ph.look.warm': 'Chaud',
    'ph.look.cool': 'Froid',
    'ph.extras': 'Options',
    'ph.grain': 'Grain',
    'ph.vignette': 'Vignettage',
    'ph.grid': 'Grille',
    'ph.shoot': 'Prendre la photo',
    'ph.develop': 'Développement',
    'ph.saved': 'Photo enregistrée',
    'opt.title': 'Options',
    'opt.tab.graphics': 'Graphismes',
    'opt.tab.sound': 'Son',
    'opt.tab.controls': 'Commandes',
    'opt.tab.display': 'Affichage',
    'opt.preset': 'Qualité',
    'opt.presetNote': 'Baisse la qualité si l’image saccade ; les changements s’appliquent tout de suite.',
    'opt.dof': 'Profondeur de champ',
    'opt.lens': 'Effets d’objectif',
    'opt.master': 'Volume général',
    'opt.music': 'Musique',
    'opt.world': 'Ambiance',
    'opt.voice': 'Narrateur',
    'opt.mouseLock': 'Caméra à la souris',
    'opt.mouseSens': 'Sensibilité (jeu)',
    'opt.photoSens': 'Sensibilité (photo)',
    'opt.invertX': 'Inverser l’axe horizontal',
    'opt.invertY': 'Inverser l’axe vertical',
    'opt.vibration': 'Vibrations',
    'opt.pressKey': 'Appuie sur une touche…',
    'opt.bindNote': 'Clique sur une action puis appuie sur la touche voulue. Les flèches déplacent toujours aussi. Les boutons de la manette sont fixes (affichés à côté de chaque touche quand une manette est branchée).',
    'opt.reset': 'Rétablir par défaut',
    'opt.back': 'Retour',
    'opt.subtitles': 'Sous-titres',
    'bind.forward': 'Avancer',
    'bind.back': 'Faire demi-tour',
    'bind.left': 'Tourner à gauche',
    'bind.right': 'Tourner à droite',
    'bind.hurry': 'Presser le pas',
    'bind.slide': 'Glisser / passer',
    'bind.call': 'Appeler',
    'bind.interact': 'Interagir',
    'bind.objective': 'Voir l’objectif',
    'bind.photo': 'Mode photo',
    'bind.hideUI': 'Masquer l’interface',
    'q.low': 'Basse',
    'q.medium': 'Moyenne',
    'q.high': 'Haute',
    'q.ultra': 'Ultra',
  },
};

const listeners = new Set();

function detect() {
  try {
    const saved = localStorage.getItem('pingu.locale');
    if (saved && STRINGS[saved]) return saved;
  } catch { /* storage unavailable */ }
  const nav = (navigator.languages || [navigator.language || 'en-US']).map((l) => l.toLowerCase());
  return nav.some((l) => l.startsWith('fr')) ? 'fr-FR' : 'en-US';
}

let locale = detect();
document.documentElement.lang = locale;

export function getLocale() { return locale; }

export function setLocale(l) {
  if (!STRINGS[l] || l === locale) return;
  locale = l;
  document.documentElement.lang = l;
  try { localStorage.setItem('pingu.locale', l); } catch { /* storage unavailable */ }
  listeners.forEach((fn) => fn(l));
}

export function onLocaleChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function t(key, vars) {
  let s = STRINGS[locale][key] ?? STRINGS['en-US'][key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

/** Apply translations to elements carrying data-i18n="key" (text) or data-i18n-aria (label). */
export function translateDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
}

// Physical key codes → label printed on the user's keyboard (AZERTY shows Z/Q, QWERTY W/A).
let layoutMap = null;
export async function loadKeyboardLayout() {
  try { layoutMap = await navigator.keyboard?.getLayoutMap?.(); } catch { layoutMap = null; }
}
const FALLBACK_FR = { KeyW: 'Z', KeyA: 'Q', KeyS: 'S', KeyD: 'D', KeyQ: 'A', KeyZ: 'W', KeyE: 'E', KeyR: 'R', KeyF: 'F', KeyH: 'H' };
// what the player's own keys print, learned from their keystrokes (browsers without
// the Keyboard Map API: Firefox, Safari)
const learned = {};
let layoutKnown = false;
/** Feed every keydown: once a letter key reveals the layout, labels follow it. */
export function learnKey(e) {
  if (!/^Key[A-Z]$/.test(e.code) || typeof e.key !== 'string' || e.key.length !== 1) return false;
  const k = e.key.toUpperCase();
  if (!/^[A-ZÀ-Ý]$/.test(k) || learned[e.code] === k) return false;
  learned[e.code] = k;
  layoutKnown = true;
  return true;
}
/** Guess the rest of the layout from what was learned (AZERTY / QWERTZ / QWERTY). */
function guess(code) {
  if (learned[code]) return learned[code];
  const azerty = learned.KeyQ === 'A' || learned.KeyW === 'Z' || learned.KeyA === 'Q' || learned.KeyZ === 'W';
  const qwertz = learned.KeyY === 'Z' || learned.KeyZ === 'Y';
  if (azerty) return FALLBACK_FR[code];
  if (qwertz) return { KeyY: 'Z', KeyZ: 'Y' }[code];
  if (layoutKnown) return undefined; // QWERTY-like: the code letter is right
  return locale === 'fr-FR' ? FALLBACK_FR[code] : undefined;
}
const NAMED = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Tab: 'Tab', Enter: '↵', Backspace: '⌫', Escape: 'Esc' };
export function keyLabel(code) {
  if (!code) return '';
  if (code === 'Space') return locale === 'fr-FR' ? 'Espace' : 'Space';
  if (code.startsWith('Shift')) return locale === 'fr-FR' ? 'Maj' : 'Shift';
  if (code.startsWith('Control')) return 'Ctrl';
  if (code.startsWith('Alt')) return 'Alt';
  if (NAMED[code]) return NAMED[code];
  const v = layoutMap?.get(code);
  if (v) return v.toUpperCase();
  const g = guess(code);
  if (g) return g;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}
