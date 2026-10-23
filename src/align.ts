// Alignement des paroles connues (texte Suno) sur la transcription horodatée de Whisper.
// Whisper se trompe souvent sur du chant : on ne garde que ses temps, le texte vient des paroles.

export interface AsrWord {
  text: string;
  start: number;
  end: number;
}

export interface AlignedLine {
  /** null = ligne hors de l'extrait écouté */
  start: number | null;
  /** part des mots de la ligne retrouvés dans la transcription (0..1) */
  confidence: number;
}

export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`´]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function tokenize(text: string): string[] {
  return text.split(/[\s\-–—/]+/).map(normalizeWord).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

const MATCH_MIN = 0.6;
const GAP = -0.45;

/**
 * Aligne les mots des paroles sur les mots transcrits (Needleman-Wunsch avec similarité floue).
 * Renvoie, pour chaque mot des paroles, l'index du mot transcrit associé (ou -1).
 */
export function alignWords(lyrics: string[], asr: string[]): Int32Array {
  const m = lyrics.length;
  const n = asr.length;
  const W = n + 1;
  const score = new Float32Array((m + 1) * W);
  const move = new Uint8Array((m + 1) * W); // 0 diag, 1 haut (mot paroles ignoré), 2 gauche (mot transcrit ignoré)
  for (let i = 1; i <= m; i++) {
    score[i * W] = i * GAP;
    move[i * W] = 1;
  }
  for (let j = 1; j <= n; j++) {
    score[j] = j * GAP;
    move[j] = 2;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const sim = similarity(lyrics[i - 1], asr[j - 1]);
      const s = sim >= MATCH_MIN ? 2 * sim : -1;
      const d = score[(i - 1) * W + j - 1] + s;
      const u = score[(i - 1) * W + j] + GAP;
      const l = score[i * W + j - 1] + GAP;
      const k = i * W + j;
      if (d >= u && d >= l) {
        score[k] = d;
        move[k] = 0;
      } else if (u >= l) {
        score[k] = u;
        move[k] = 1;
      } else {
        score[k] = l;
        move[k] = 2;
      }
    }
  }
  const map = new Int32Array(m).fill(-1);
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const mv = move[i * W + j];
    if (i > 0 && j > 0 && mv === 0) {
      if (similarity(lyrics[i - 1], asr[j - 1]) >= MATCH_MIN) map[i - 1] = j - 1;
      i--;
      j--;
    } else if (i > 0 && (mv === 1 || j === 0)) i--;
    else j--;
  }
  return map;
}

const WORD_DUR = 0.32; // durée moyenne d'un mot chanté (s), pour extrapoler

/** Calcule le début de chaque ligne de paroles à partir des mots Whisper */
/**
 * @param partial true si seul un extrait du morceau a été transcrit : les lignes non retrouvées
 *   avant la première / après la dernière ligne reconnue sont laissées sans temps (null).
 */
export function alignLines(lines: string[], words: AsrWord[], duration: number, partial = false): AlignedLine[] {
  const lineWords = lines.map(tokenize);
  const flat: { line: number; idx: number; w: string }[] = [];
  lineWords.forEach((ws, line) => ws.forEach((w, idx) => flat.push({ line, idx, w })));
  const asrNorm = words.map((w) => normalizeWord(w.text));
  // on retire les mots vides (ponctuation seule) côté transcription
  const asrIdx = asrNorm.map((w, i) => (w ? i : -1)).filter((i) => i >= 0);
  const map = alignWords(
    flat.map((f) => f.w),
    asrIdx.map((i) => asrNorm[i]),
  );

  const raw: (number | null)[] = [];
  const conf: number[] = [];
  lineWords.forEach((ws, line) => {
    let first: number | null = null;
    let hits = 0;
    flat.forEach((f, k) => {
      if (f.line !== line || map[k] < 0) return;
      hits++;
      if (first === null) {
        const t = words[asrIdx[map[k]]].start;
        first = t - f.idx * WORD_DUR; // si les premiers mots manquent, on recule un peu
      }
    });
    // une ligne dont un seul mot (court) est retrouvé n'est pas fiable
    const ok = hits >= Math.min(2, ws.length);
    raw.push(ok ? first : null);
    conf.push(ws.length ? hits / ws.length : 0);
  });

  // ordre croissant : on écarte les points qui reviennent en arrière
  let last = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t === null) continue;
    if (t <= last + 0.25) raw[i] = null;
    else last = t;
  }

  // interpolation des lignes non retrouvées, au prorata du nombre de mots
  const firstHit = raw.findIndex((t) => t !== null);
  let lastHit = -1;
  raw.forEach((t, i) => t !== null && (lastHit = i));
  const out: AlignedLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    let t = raw[i];
    if (partial && (firstHit < 0 || i < firstHit || i > lastHit)) {
      out.push({ start: null, confidence: 0 });
      continue;
    }
    if (t === null) {
      let a = i - 1;
      while (a >= 0 && raw[a] === null) a--;
      let b = i + 1;
      while (b < raw.length && raw[b] === null) b++;
      const ta = a >= 0 ? raw[a]! : null;
      const tb = b < raw.length ? raw[b]! : null;
      const weight = (from: number, to: number) => {
        let s = 0;
        for (let k = from; k < to; k++) s += Math.max(1, lineWords[k].length);
        return s;
      };
      if (ta !== null && tb !== null) t = ta + ((tb - ta) * weight(a, i)) / weight(a, b);
      else if (ta !== null) t = Math.min(duration - 0.5, ta + weight(a, i) * WORD_DUR * 1.4);
      else if (tb !== null) t = Math.max(0, tb - weight(i, b) * WORD_DUR * 1.4);
      else t = (duration * i) / raw.length;
    }
    out.push({ start: Math.max(0, +t.toFixed(2)), confidence: conf[i] });
  }
  return out;
}

/** Sans paroles fournies : découpe la transcription en lignes (pause ou 8 mots max) */
export function wordsToLines(words: AsrWord[]): { text: string; start: number }[] {
  const res: { text: string; start: number }[] = [];
  let cur: AsrWord[] = [];
  const flush = () => {
    if (cur.length) res.push({ text: cur.map((w) => w.text.trim()).join(' ').trim(), start: cur[0].start });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.7 || cur.length >= 8 || /[.?!]$/.test(prev.text.trim()))) flush();
    if (w.text.trim()) cur.push(w);
  }
  flush();
  return res.filter((l) => l.text);
}

/** Devine la langue des paroles pour aider Whisper */
export function guessLanguage(text: string): string | null {
  const w = tokenize(text);
  if (w.length < 8) return null;
  const sets: Record<string, string[]> = {
    english: ['the', 'you', 'and', 'i', 'to', 'my', 'me', 'it', 'is', 'in', 'what', 'when', 'your', 'dont', 'im'],
    french: ['je', 'tu', 'le', 'la', 'les', 'et', 'de', 'des', 'un', 'une', 'pas', 'mon', 'ma', 'qui', 'que', 'dans'],
    spanish: ['yo', 'tu', 'el', 'la', 'los', 'y', 'de', 'que', 'en', 'mi', 'no', 'por', 'con', 'una'],
  };
  let best: string | null = null;
  let bestScore = 0;
  for (const [lang, list] of Object.entries(sets)) {
    const s = w.filter((x) => list.includes(x)).length / w.length;
    if (s > bestScore) {
      bestScore = s;
      best = lang;
    }
  }
  return bestScore > 0.08 ? best : null;
}
