import { getLocale } from './i18n.js';
import { subtitlesOn } from './options.js';

// The narrator: an old polar explorer remembering the evening he watched a chick he
// called Mumble (script and timing: docs/narration.md). Lines play once each, never
// over one another; the score and the world dip while he speaks; subtitles follow
// the game language and the Options › Display setting.

const LINES = {
  open1: { en: 'I was young then. The ice was older than any of us.', fr: 'J’étais jeune, alors. La glace était plus vieille que nous tous.' },
  open2: { en: 'In the last week of summer, the sun no longer set. It only bowed, and turned the whole world to amber.', fr: 'La dernière semaine de l’été, le soleil ne se couchait plus. Il s’inclinait seulement, et le monde entier virait à l’ambre.' },
  open3: { en: 'That is where I first saw him. Grey as fog, smaller than my boot. I called him Mumble, for the small sounds he made to no one in particular.', fr: 'C’est là que je l’ai vu pour la première fois. Gris comme le brouillard, plus petit que ma botte. Je l’ai appelé Mumble, pour les petits sons qu’il faisait à personne en particulier.' },
  call: { en: 'Among ten thousand voices, every chick knows one. He only had to call.', fr: 'Parmi dix mille voix, chaque poussin en connaît une. Il n’avait qu’à appeler.' },
  feed: { en: 'His parent had walked a hundred miles of ice to bring him that fish. It would be the last.', fr: 'Son parent avait marché des dizaines de kilomètres sur la glace pour lui rapporter ce poisson. Ce serait le dernier.' },
  creche: { en: 'The young keep together. A crèche, we call it. A nursery with no walls, and no one left to mind it.', fr: 'Les petits restent ensemble. Une crèche, on appelle ça. Une nurserie sans murs, et bientôt plus personne pour la garder.' },
  depart1: { en: 'Then, one evening, without ceremony, the adults turned toward the sea.', fr: 'Puis, un soir, sans cérémonie, les adultes se sont tournés vers la mer.' },
  depart2: { en: 'Their work was done. Ours was only to keep still.', fr: 'Leur travail était fini. Le nôtre était seulement de ne pas bouger.' },
  noanswer: { en: 'No one answered. No one ever does, that day.', fr: 'Personne n’a répondu. Personne ne répond jamais, ce jour-là.' },
  alone: { en: 'What was left was a great deal of white, and a small grey bird learning what it means to be alone.', fr: 'Il ne restait que beaucoup de blanc, et un petit oiseau gris qui apprenait ce que c’est, d’être seul.' },
  friend: { en: 'He was not the only one.', fr: 'Il n’était pas le seul.' },
  ridge: { en: 'From the ridge you could see how large the world had become overnight.', fr: 'Depuis la crête, on voyait combien le monde était devenu grand, en une seule nuit.' },
  storm: { en: 'Weather down there does not arrive. It simply decides.', fr: 'Là-bas, le mauvais temps n’arrive pas. Il décide.' },
  shelter: { en: 'The only warmth left in the world was each other.', fr: 'La seule chaleur qui restait au monde, c’était les uns contre les autres.' },
  huddle: { en: 'The wind screamed for most of the night. I could not see them. I could only hope.', fr: 'Le vent a hurlé presque toute la nuit. Je ne les voyais plus. Je ne pouvais qu’espérer.' },
  dawn: { en: 'And then, first light.', fr: 'Et puis, la première lumière.' },
  tracks: { en: 'The storm had swept every track away, as if the ice had been handed back to them, unwritten.', fr: 'La tempête avait effacé toutes les traces, comme si la glace leur avait été rendue, vierge.' },
  end1: { en: 'In a few weeks his down would fall, and the sea would take him, as it took his parents.', fr: 'Dans quelques semaines, son duvet tomberait, et la mer le prendrait, comme elle avait pris ses parents.' },
  end2: { en: 'I have crossed that ice many times since. I still look for him.', fr: 'J’ai traversé cette glace bien des fois depuis. Je le cherche encore.' },
};

/** Spoken length when a recording fails to load (slow narration, ~2.4 words/s). */
const estimate = (text) => 1.2 + text.split(/\s+/).length / 2.4;

export class Narrator {
  constructor({ sound, hud }) {
    this.sound = sound;
    this.hud = hud;
    this.said = new Set();
    this.queue = [];
    this.speaking = null; // { id, until }
    this.buffers = {};
    this.time = 0;
  }

  /** Decode the recorded lines (audio/voice/<id>.mp3); files that fail to load fall back to subtitles only. */
  async load() {
    if (!this.sound.ctx) return;
    await Promise.all(Object.keys(LINES).map(async (id) => {
      if (this.buffers[id]) return;
      try {
        const r = await fetch(`audio/voice/${id}.mp3`);
        if (!r.ok) return;
        this.buffers[id] = await this.sound.ctx.decodeAudioData(await r.arrayBuffer());
      } catch { /* failed to load: subtitles only */ }
    }));
  }

  /**
   * Say a line once. opts.queue: wait behind the current line (default) or drop it if
   * something is already being said (queue: false, for optional in-game remarks).
   * Resolves when the line has finished.
   */
  say(id, { queue = true } = {}) {
    if (this.said.has(id) || !LINES[id]) return Promise.resolve();
    if (this.speaking && !queue) return Promise.resolve();
    this.said.add(id);
    return new Promise((done) => {
      this.queue.push({ id, done });
      this.pump();
    });
  }

  pump() {
    if (this.speaking || !this.queue.length) return;
    const { id, done } = this.queue.shift();
    const line = LINES[id];
    const buf = this.buffers[id];
    const dur = buf ? buf.duration : estimate(line.en);
    this.speaking = { id, until: this.time + dur + 0.35, done };
    this.src = buf ? this.sound.playVoice(buf) : null;
    this.sound.setNarrating(true);
    if (subtitlesOn()) this.hud.subtitle(getLocale() === 'fr-FR' ? line.fr : line.en);
  }

  /** Game-time tick (pauses with the game). */
  update(dt) {
    this.time += dt;
    if (this.speaking && this.time >= this.speaking.until) {
      const { done } = this.speaking;
      this.speaking = null;
      this.hud.subtitle('');
      if (!this.queue.length) this.sound.setNarrating(false);
      done();
      this.pump();
    }
  }

  /** Stop at once (skipped cinematic): silence, clear the queue and the subtitle. */
  cancel() {
    try { this.src?.stop(); } catch { /* already ended */ }
    this.src = null;
    const pending = [...this.queue, ...(this.speaking ? [this.speaking] : [])];
    this.queue.length = 0;
    this.speaking = null;
    this.sound.setNarrating(false);
    this.hud.subtitle('');
    pending.forEach((p) => p.done?.());
  }
}
