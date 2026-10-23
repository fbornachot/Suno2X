// Paroles : parsing texte brut Suno / LRC, timing, export LRC

export interface LyricLine {
  id: number;
  text: string;
  /** début en secondes, null = pas encore synchronisée */
  start: number | null;
  /** calage automatique peu fiable → à vérifier */
  uncertain?: boolean;
}

export interface TimedLine {
  text: string;
  start: number;
  end: number;
}

let nextId = 1;
export const makeLine = (text: string, start: number | null = null): LyricLine => ({ id: nextId++, text, start });

const LRC_TIME = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const SECTION_TAG = /^\s*[[(][^\])]*[\])]\s*$/; // [Verse 1], [Chorus], (Instrumental)…

export function isLrc(text: string): boolean {
  return /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(text);
}

/** Texte brut copié depuis Suno : on retire balises de section et lignes vides */
export function parsePlain(text: string): LyricLine[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !SECTION_TAG.test(l))
    .map((l) => makeLine(l));
}

export function parseLrc(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const times: number[] = [];
    LRC_TIME.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LRC_TIME.exec(raw))) times.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.')));
    const txt = raw.replace(LRC_TIME, '').trim();
    if (!times.length || !txt || SECTION_TAG.test(txt)) continue;
    for (const t of times) out.push(makeLine(txt, t));
  }
  return out.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

export function parseLyrics(text: string): LyricLine[] {
  return isLrc(text) ? parseLrc(text) : parsePlain(text);
}

export function formatTime(t: number, withCs = true): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  if (!withCs) return `${m}:${String(Math.floor(sec)).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

/** "1:23.4", "01:23.45", "83.4" → secondes ; null si invalide */
export function parseTime(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  const m = /^(\d+):(\d+(?:[.,]\d+)?)$/.exec(s);
  if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(',', '.'));
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function toLrc(lines: LyricLine[], meta: { title?: string; artist?: string }): string {
  const head: string[] = [];
  if (meta.title) head.push(`[ti:${meta.title}]`);
  if (meta.artist) head.push(`[ar:${meta.artist}]`);
  const body = lines.filter((l) => l.start !== null).map((l) => `[${formatTime(l.start!)}]${l.text}`);
  return [...head, ...body].join('\n') + '\n';
}

/** Durée max d'affichage d'une ligne si la suivante tarde (pont instrumental…) */
const MAX_LINE = 9;

export function toTimed(lines: LyricLine[], songEnd: number): TimedLine[] {
  const timed = lines
    .filter((l) => l.start !== null && l.text.trim())
    .map((l) => ({ text: l.text.trim(), start: l.start! }))
    .sort((a, b) => a.start - b.start);
  return timed.map((l, i) => {
    const next = timed[i + 1]?.start ?? songEnd;
    return { ...l, end: Math.min(next, l.start + MAX_LINE) };
  });
}
