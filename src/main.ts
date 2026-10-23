import '@fontsource-variable/inter';
import '@fontsource-variable/outfit';
import './style.css';

import { ALL_FORMATS, BlobSource, Input, type MetadataTags } from 'mediabunny';
import { alignLines, guessLanguage, wordsToLines, type AsrWord } from './align';
import { analyzeAudio, type Analysis } from './analysis';
import { FORMATS, X_FREE_MAX, exportVideo, type ExportJob } from './exporter';
import { formatTime, isLrc, makeLine, parseLyrics, parseTime, toLrc, toTimed, type LyricLine, type TimedLine } from './lyrics';
import { FONT_DISPLAY, FONT_UI, drawFrame, extractAccent, makeBlurred, type RenderState, type VizStyle } from './renderer';

// ------------------------------------------------------------------ DOM
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const audioEl = $<HTMLAudioElement>('audio');
const canvas = $<HTMLCanvasElement>('preview-canvas');
const ctx = canvas.getContext('2d')!;
const stage = $('preview-stage');

// ------------------------------------------------------------------ État
const PALETTES: { id: string; a: string; b: string }[] = [
  { id: 'neon', a: '#7c5cff', b: '#00e0ff' },
  { id: 'sunset', a: '#ff5e62', b: '#ffc371' },
  { id: 'aqua', a: '#00f5a0', b: '#00d9f5' },
  { id: 'rose', a: '#ff4d9d', b: '#a855f7' },
  { id: 'gold', a: '#f7b733', b: '#fc4a1a' },
  { id: 'mono', a: '#ffffff', b: '#a1a1b5' },
];

const TAP_LATENCY = 0.12; // compensation du temps de réaction humain (s)

const S = {
  audioBuffer: null as AudioBuffer | null,
  analysis: null as Analysis | null,
  audioKey: '',
  image: null as ImageBitmap | null,
  /** true si le fond vient de la pochette intégrée au MP3 (remplaçable) */
  imageFromCover: false,
  blurred: null as HTMLCanvasElement | null,
  blur: 0,
  dim: 0.15,
  kenBurns: true,
  pulse: true,
  viz: 'bars' as VizStyle,
  palette: 'neon',
  colorA: '#7c5cff',
  colorB: '#00e0ff',
  title: '',
  artist: '',
  showTitle: true,
  showProgress: true,
  karaoke: false,
  instrumental: false,
  lines: [] as LyricLine[],
  timed: [] as TimedLine[],
  formatId: '4x5',
  clipStart: 0,
  clipEnd: 0,
  premium: false,
  tapIndex: -1,
  exporting: false,
};

let dirty = true;
const invalidate = () => (dirty = true);

// ------------------------------------------------------------------ Préférences (localStorage, best effort)
const PREF_KEY = 'suno2x:prefs';
const PREF_FIELDS = ['blur', 'dim', 'kenBurns', 'pulse', 'viz', 'palette', 'colorA', 'colorB', 'artist', 'showTitle', 'showProgress', 'karaoke', 'formatId', 'premium'] as const;

function savePrefs() {
  try {
    const o: Record<string, unknown> = {};
    for (const k of PREF_FIELDS) o[k] = S[k];
    localStorage.setItem(PREF_KEY, JSON.stringify(o));
  } catch { /* stockage indisponible */ }
}
function loadPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    for (const k of PREF_FIELDS) if (k in o && typeof o[k] === typeof S[k]) (S as Record<string, unknown>)[k] = o[k];
  } catch { /* ignore */ }
}
function saveLyrics() {
  if (!S.audioKey) return;
  try {
    localStorage.setItem(`suno2x:lyrics:${S.audioKey}`, JSON.stringify({
      instrumental: S.instrumental,
      lines: S.lines.map((l) => [l.text, l.start]),
    }));
  } catch { /* ignore */ }
}
function loadLyrics(): boolean {
  try {
    const raw = localStorage.getItem(`suno2x:lyrics:${S.audioKey}`);
    if (!raw) return false;
    const o = JSON.parse(raw) as { instrumental: boolean; lines: [string, number | null][] };
    S.instrumental = !!o.instrumental;
    S.lines = o.lines.map(([t, s]) => makeLine(t, s));
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ Utilitaires
const fmt = (t: number) => formatTime(t, false);
const format = () => FORMATS.find((f) => f.id === S.formatId) ?? FORMATS[0];
const duration = () => S.audioBuffer?.duration ?? 0;
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'suno2x';

function renderState(width: number, height: number): RenderState {
  return {
    width, height,
    image: S.image,
    imageW: S.image?.width ?? 1,
    imageH: S.image?.height ?? 1,
    blurred: S.blurred,
    dim: S.dim,
    kenBurns: S.kenBurns,
    pulse: S.pulse,
    viz: S.viz,
    colorA: S.colorA,
    colorB: S.colorB,
    title: S.title,
    artist: S.artist,
    showTitle: S.showTitle,
    showProgress: S.showProgress,
    karaoke: S.karaoke,
    lyrics: S.instrumental ? [] : S.timed,
    analysis: S.analysis,
    clipStart: S.clipStart,
    clipEnd: S.clipEnd || duration() || 1,
  };
}

function applyAccentCss() {
  document.documentElement.style.setProperty('--color-accent', S.colorA);
  document.documentElement.style.setProperty('--color-accent-2', S.colorB);
}

// ------------------------------------------------------------------ Aperçu
function sizeCanvas() {
  const f = format();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const box = stage.getBoundingClientRect();
  const availW = Math.max(100, box.width - 32);
  const availH = Math.max(100, box.height - 32);
  const cssScale = Math.min(availW / f.width, availH / f.height);
  const k = Math.min(1, cssScale * dpr);
  canvas.width = Math.round(f.width * k);
  canvas.height = Math.round(f.height * k);
  canvas.style.aspectRatio = `${f.width} / ${f.height}`;
  invalidate();
}

function previewTime(): number {
  return audioEl.src ? audioEl.currentTime : 0;
}

function loop() {
  const playing = !audioEl.paused;
  if (playing || dirty) {
    dirty = false;
    const f = format();
    const k = canvas.width / f.width;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawFrame(ctx, renderState(f.width, f.height), previewTime());
    updateTransport();
    if (!S.instrumental) highlightActiveLine();
  }
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ Transport
const playBtn = $<HTMLButtonElement>('play-btn');
const seek = $<HTMLInputElement>('seek-input');
const timeOut = $('time-out');
let seeking = false;

function updateTransport() {
  const d = duration();
  const t = previewTime();
  if (!seeking && d) seek.value = String(Math.round((t / d) * 1000));
  timeOut.textContent = `${fmt(t)} / ${fmt(d)}`;
  playBtn.classList.toggle('is-playing', !audioEl.paused);
  playBtn.setAttribute('aria-label', audioEl.paused ? 'Lecture' : 'Pause');
}

function togglePlay() {
  if (!audioEl.src) return;
  if (audioEl.paused) void audioEl.play();
  else audioEl.pause();
}

playBtn.addEventListener('click', togglePlay);
seek.addEventListener('input', () => {
  seeking = true;
  audioEl.currentTime = (Number(seek.value) / 1000) * duration();
  invalidate();
});
seek.addEventListener('change', () => (seeking = false));
audioEl.addEventListener('seeked', invalidate);
audioEl.addEventListener('pause', invalidate);
audioEl.addEventListener('ended', invalidate);

function updateClipBand() {
  const d = duration();
  const band = $('clip-band');
  if (!d) {
    band.style.width = '0';
    return;
  }
  band.style.left = `${(S.clipStart / d) * 100}%`;
  band.style.width = `${((S.clipEnd - S.clipStart) / d) * 100}%`;
}

// ------------------------------------------------------------------ Dropzones
function setupDrop(kind: 'audio' | 'image', input: HTMLInputElement, onFile: (f: File) => void) {
  const zone = document.querySelector<HTMLElement>(`[data-drop="${kind}"]`)!;
  input.addEventListener('change', () => input.files?.[0] && onFile(input.files[0]));
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('is-dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-dragover');
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
}

// ------------------------------------------------------------------ Audio
const audioLabel = $('audio-label');
const audioMeta = $('audio-meta');
const titleInput = $<HTMLInputElement>('title-input');
const artistInput = $<HTMLInputElement>('artist-input');

async function loadAudio(file: File) {
  const zone = document.querySelector<HTMLElement>('[data-drop="audio"]')!;
  audioLabel.textContent = file.name;
  audioMeta.textContent = 'Décodage…';
  audioMeta.classList.remove('error_text');
  try {
    const buf = await file.arrayBuffer();
    const ac = new OfflineAudioContext(2, 1, 48000);
    const decoded = await ac.decodeAudioData(buf);
    audioMeta.textContent = 'Analyse du spectre… 0 %';
    const analysis = await analyzeAudio(decoded, (p) => (audioMeta.textContent = `Analyse du spectre… ${Math.round(p * 100)} %`));

    S.audioBuffer = decoded;
    S.analysis = analysis;
    S.audioKey = `${file.name}:${file.size}`;
    if (audioEl.src) URL.revokeObjectURL(audioEl.src);
    audioEl.src = URL.createObjectURL(file);
    audioEl.currentTime = 0;

    // métadonnées Suno (ID3) : titre, artiste, paroles, pochette
    const tags = await readTags(file);
    const guess = file.name.replace(/\.[^.]+$/, '').replace(/^[0-9a-f]{6,}[-_]/i, '').replace(/[_]+/g, ' ').replace(/\s*\(\d+\)$/, '').trim();
    S.title = tags.title?.trim() || guess;
    titleInput.value = S.title;
    if (tags.artist?.trim()) {
      S.artist = tags.artist.trim();
      artistInput.value = S.artist;
    }
    const cover = tags.images?.find((i) => i.kind === 'coverFront') ?? tags.images?.[0];
    if (cover && (!S.image || S.imageFromCover)) {
      await loadImage(new Blob([cover.data as BlobPart], { type: cover.mimeType }), 'Pochette Suno (intégrée au MP3)', true);
    }

    audioMeta.textContent = `${fmt(decoded.duration)} · ${decoded.numberOfChannels > 1 ? 'stéréo' : 'mono'}`;
    zone.classList.add('is-loaded');
    $('preview-empty').hidden = true;
    playBtn.disabled = false;
    seek.disabled = false;
    $<HTMLButtonElement>('export-btn').disabled = false;

    // paroles mémorisées pour ce fichier ?
    if (loadLyrics()) {
      $<HTMLInputElement>('instrumental-input').checked = S.instrumental;
      $('lyrics-wrapper').classList.toggle('is-disabled', S.instrumental);
      lyricsInput.value = S.lines.map((l) => l.text).join('\n');
    } else {
      // paroles intégrées par Suno, sinon on repart à vide
      const { text: lyr, lang } = extractLyrics(tags);
      if (lang && !langSelect.value) langSelect.value = lang;
      S.lines = [];
      lyricsInput.value = lyr;
      if (lyr) S.lines = parseLyrics(lyr);
      lyricsSource.hidden = !lyr;
    }
    resetClip();
    lyricsChanged(false);
    invalidate();
  } catch (e) {
    console.error(e);
    audioMeta.textContent = 'Impossible de lire ce fichier audio.';
    audioMeta.classList.add('error_text');
  }
}

const ISO_LANG: Record<string, string> = { eng: 'english', fra: 'french', fre: 'french', spa: 'spanish', por: 'portuguese', ita: 'italian', deu: 'german', ger: 'german' };

/** Paroles intégrées : champ standard, ou TXXX « lyrics-xxx » utilisé par Suno */
function extractLyrics(tags: MetadataTags): { text: string; lang: string | null } {
  if (tags.lyrics?.trim()) return { text: tags.lyrics.trim(), lang: null };
  const txxx = tags.raw?.TXXX;
  if (txxx && typeof txxx === 'object' && !(txxx instanceof Uint8Array)) {
    for (const [k, v] of Object.entries(txxx as Record<string, string>)) {
      const m = /^lyrics(?:[-_ ]([a-z]{3}))?$/i.exec(k.trim());
      if (m && typeof v === 'string' && v.trim()) return { text: v.trim(), lang: ISO_LANG[m[1]?.toLowerCase() ?? ''] ?? null };
    }
  }
  return { text: '', lang: null };
}

async function readTags(file: File): Promise<MetadataTags> {
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const tags = await input.getMetadataTags();
    input.dispose();
    return tags;
  } catch (e) {
    console.warn('Métadonnées illisibles', e);
    return {};
  }
}

titleInput.addEventListener('input', () => {
  S.title = titleInput.value;
  invalidate();
});
artistInput.addEventListener('input', () => {
  S.artist = artistInput.value;
  savePrefs();
  invalidate();
});

// ------------------------------------------------------------------ Image
async function loadImage(file: Blob, name = (file as File).name ?? 'image', fromCover = false) {
  const zone = document.querySelector<HTMLElement>('[data-drop="image"]')!;
  try {
    let bmp = await createImageBitmap(file);
    const max = 2400;
    if (Math.max(bmp.width, bmp.height) > max) {
      const k = max / Math.max(bmp.width, bmp.height);
      const small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
      bmp.close();
      bmp = small;
    }
    S.image?.close();
    S.image = bmp;
    rebuildBlur();
    S.imageFromCover = fromCover;
    $('image-label').textContent = name;
    const thumb = $('image-thumb');
    if (thumb.dataset.url) URL.revokeObjectURL(thumb.dataset.url);
    thumb.dataset.url = URL.createObjectURL(file);
    thumb.style.backgroundImage = `url(${thumb.dataset.url})`;
    zone.classList.add('is-loaded');
    renderPalettes();
    // couleurs auto si l'utilisateur n'a pas choisi de palette manuelle
    if (S.palette === 'auto' || S.palette === 'neon') applyPalette('auto');
    invalidate();
  } catch (e) {
    console.error(e);
    $('image-label').textContent = 'Image illisible, essaie un JPG ou PNG.';
  }
}

function rebuildBlur() {
  S.blurred = S.image ? makeBlurred(S.image, S.image.width, S.image.height, S.blur) : null;
  invalidate();
}

const blurInput = $<HTMLInputElement>('blur-input');
const dimInput = $<HTMLInputElement>('dim-input');
let blurTimer = 0;
blurInput.addEventListener('input', () => {
  S.blur = Number(blurInput.value);
  $('blur-out').textContent = String(S.blur);
  clearTimeout(blurTimer);
  blurTimer = window.setTimeout(() => {
    rebuildBlur();
    savePrefs();
  }, 60);
});
dimInput.addEventListener('input', () => {
  S.dim = Number(dimInput.value) / 100;
  $('dim-out').textContent = `${dimInput.value} %`;
  savePrefs();
  invalidate();
});

function bindToggle(id: string, key: 'kenBurns' | 'pulse' | 'showTitle' | 'showProgress' | 'karaoke' | 'premium', after?: () => void) {
  const el = $<HTMLInputElement>(id);
  el.checked = S[key];
  el.addEventListener('change', () => {
    S[key] = el.checked;
    savePrefs();
    after?.();
    invalidate();
  });
}

// ------------------------------------------------------------------ Style
function renderViz() {
  document.querySelectorAll<HTMLButtonElement>('#viz-group .segmented_item').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.value === S.viz));
  });
}
document.querySelectorAll<HTMLButtonElement>('#viz-group .segmented_item').forEach((b) =>
  b.addEventListener('click', () => {
    S.viz = b.dataset.value as VizStyle;
    renderViz();
    savePrefs();
    invalidate();
  }),
);

const colorA = $<HTMLInputElement>('color-a');
const colorB = $<HTMLInputElement>('color-b');

function applyPalette(id: string) {
  if (id === 'auto') {
    if (!S.image) return;
    [S.colorA, S.colorB] = extractAccent(S.image);
  } else {
    const p = PALETTES.find((x) => x.id === id);
    if (!p) return;
    S.colorA = p.a;
    S.colorB = p.b;
  }
  S.palette = id;
  colorA.value = S.colorA;
  colorB.value = S.colorB;
  applyAccentCss();
  renderPalettes();
  savePrefs();
  invalidate();
}

function renderPalettes() {
  const box = $('palette-group');
  box.innerHTML = '';
  if (S.image) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'palette_item is-auto';
    b.title = "Couleurs extraites de l'image";
    b.textContent = 'AUTO';
    b.style.backgroundImage = $('image-thumb').style.backgroundImage;
    b.setAttribute('aria-pressed', String(S.palette === 'auto'));
    b.addEventListener('click', () => applyPalette('auto'));
    box.append(b);
  }
  for (const p of PALETTES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'palette_item';
    b.title = p.id;
    b.style.background = `linear-gradient(135deg, ${p.a}, ${p.b})`;
    b.setAttribute('aria-pressed', String(S.palette === p.id));
    b.addEventListener('click', () => applyPalette(p.id));
    box.append(b);
  }
}

for (const [el, key] of [[colorA, 'colorA'], [colorB, 'colorB']] as const) {
  el.addEventListener('input', () => {
    S[key] = el.value;
    S.palette = 'custom';
    applyAccentCss();
    renderPalettes();
    savePrefs();
    invalidate();
  });
}

// ------------------------------------------------------------------ Format & extrait
function renderFormats() {
  const box = $('format-group');
  box.innerHTML = '';
  for (const f of FORMATS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'format_item';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(f.id === S.formatId));
    const k = 26 / Math.max(f.width, f.height);
    b.innerHTML = `<span class="format_shape" style="width:${Math.round(f.width * k)}px;height:${Math.round(f.height * k)}px"></span>
      <span class="format_label">${f.label}</span><span class="format_hint">${f.hint}</span>`;
    b.title = `${f.width} × ${f.height}`;
    b.addEventListener('click', () => {
      S.formatId = f.id;
      renderFormats();
      sizeCanvas();
      savePrefs();
    });
    box.append(b);
  }
}

const clipStartInput = $<HTMLInputElement>('clip-start');
const clipEndInput = $<HTMLInputElement>('clip-end');

function maxLen() {
  return S.premium ? Infinity : X_FREE_MAX;
}

function resetClip() {
  const d = duration();
  S.clipStart = 0;
  S.clipEnd = Math.min(d, maxLen());
  syncClipUi();
}

function syncClipUi() {
  const d = duration();
  clipStartInput.value = fmt(S.clipStart);
  clipEndInput.value = fmt(S.clipEnd);
  const notice = $('clip-notice');
  const len = S.clipEnd - S.clipStart;
  if (!S.premium && d > X_FREE_MAX) {
    notice.hidden = false;
    notice.textContent = `Le morceau dure ${fmt(d)} : sans X Premium, une vidéo est limitée à 2:20. Extrait retenu : ${fmt(S.clipStart)} → ${fmt(S.clipEnd)} (fondu de sortie automatique). Règle « Début » sur ton meilleur passage.`;
  } else if (d && len < d - 0.5) {
    notice.hidden = false;
    notice.textContent = `Extrait de ${fmt(len)} sur ${fmt(d)}.`;
  } else notice.hidden = true;
  updateClipBand();
  invalidate();
}

function applyClip(start: number, end: number) {
  const d = duration();
  if (!d) return;
  let s = Math.min(Math.max(0, start), Math.max(0, d - 1));
  let e = Math.min(d, Math.max(s + 1, end));
  if (e - s > maxLen()) e = s + maxLen();
  S.clipStart = s;
  S.clipEnd = e;
  syncClipUi();
}

clipStartInput.addEventListener('change', () => {
  const v = parseTime(clipStartInput.value);
  if (v === null) return syncClipUi();
  const keepLen = S.clipEnd - S.clipStart;
  applyClip(v, S.premium ? S.clipEnd : v + keepLen);
});
clipEndInput.addEventListener('change', () => {
  const v = parseTime(clipEndInput.value);
  if (v === null) return syncClipUi();
  applyClip(S.clipStart, v);
});
$('clip-here-btn').addEventListener('click', () => {
  const t = previewTime();
  applyClip(t, S.premium ? duration() : t + X_FREE_MAX);
});

// ------------------------------------------------------------------ Paroles
const lyricsInput = $<HTMLTextAreaElement>('lyrics-input');
const lyricsSource = $('lyrics-source');
const linesList = $<HTMLOListElement>('lines-list');
const syncComp = $('sync-component');
let lyricsTimer = 0;

function lyricsChanged(save = true) {
  S.timed = toTimed(S.lines, duration() || 1e9);
  renderLines();
  if (save) saveLyrics();
  invalidate();
}

function onLyricsText() {
  let text = lyricsInput.value;
  if (isLrc(text)) {
    S.lines = parseLyrics(text);
    // on affiche le texte brut, les temps vivent dans la liste
    text = S.lines.map((l) => l.text).join('\n');
    lyricsInput.value = text;
  } else {
    const prev = S.lines;
    const next = parseLyrics(text);
    // conserve les timings existants quand c'est possible
    const sameCount = prev.length === next.length;
    next.forEach((l, i) => {
      if (prev[i] && (sameCount || prev[i].text === l.text)) l.start = prev[i].start;
    });
    S.lines = next;
  }
  lyricsChanged();
}
lyricsInput.addEventListener('input', () => {
  lyricsSource.hidden = true;
  clearTimeout(lyricsTimer);
  lyricsTimer = window.setTimeout(onLyricsText, 250);
});

$('instrumental-input').addEventListener('change', (e) => {
  S.instrumental = (e.target as HTMLInputElement).checked;
  $('lyrics-wrapper').classList.toggle('is-disabled', S.instrumental);
  if (S.instrumental) stopTap();
  saveLyrics();
  invalidate();
});

function renderLines() {
  syncComp.hidden = S.lines.length === 0;
  const synced = S.lines.filter((l) => l.start !== null).length;
  $('sync-status').textContent = `${synced} / ${S.lines.length} lignes synchronisées`;
  $<HTMLButtonElement>('lrc-export-btn').disabled = synced === 0;
  $('tap-start-btn').textContent = synced ? 'Ajuster au tap' : 'Synchroniser au tap';
  updateAutoBtn();

  linesList.innerHTML = '';
  S.lines.forEach((l, i) => {
    const li = document.createElement('li');
    li.className = 'lines_item';
    li.dataset.idx = String(i);
    if (l.uncertain) {
      li.classList.add('is-uncertain');
      li.title = 'Calage automatique incertain : vérifie ce temps';
    }
    if (i === S.tapIndex) li.classList.add('is-next');
    const inp = document.createElement('input');
    inp.className = 'lines_time' + (l.start === null ? ' is-empty' : '');
    inp.value = l.start === null ? '' : formatTime(l.start);
    inp.placeholder = '--:--.--';
    inp.setAttribute('aria-label', `Début de la ligne ${i + 1}`);
    inp.addEventListener('change', () => {
      l.start = parseTime(inp.value);
      l.uncertain = false;
      lyricsChanged();
    });
    const txt = document.createElement('span');
    txt.className = 'lines_text';
    txt.textContent = l.text;
    txt.title = l.start !== null ? 'Aller à cette ligne' : l.text;
    txt.addEventListener('click', () => {
      if (l.start === null) return;
      audioEl.currentTime = Math.max(0, l.start - 0.5);
      invalidate();
    });
    li.append(inp, txt);
    linesList.append(li);
  });
  lastActive = -2;
}

let lastActive = -2;
function highlightActiveLine() {
  const t = previewTime();
  let idx = -1;
  S.lines.forEach((l, i) => {
    if (l.start !== null && l.start <= t && (idx < 0 || l.start >= (S.lines[idx].start ?? 0))) idx = i;
  });
  if (idx === lastActive) return;
  linesList.querySelector('.is-active')?.classList.remove('is-active');
  const el = linesList.children[idx] as HTMLElement | undefined;
  if (el) {
    el.classList.add('is-active');
    if (!audioEl.paused) el.scrollIntoView({ block: 'nearest' });
  }
  lastActive = idx;
}

document.querySelectorAll<HTMLButtonElement>('[data-offset]').forEach((b) =>
  b.addEventListener('click', () => {
    const d = Number(b.dataset.offset);
    S.lines.forEach((l) => {
      if (l.start !== null) l.start = Math.max(0, +(l.start + d).toFixed(3));
    });
    lyricsChanged();
  }),
);

// --- Calage automatique (Whisper)
const autoBtn = $<HTMLButtonElement>('auto-sync-btn');
const langSelect = $<HTMLSelectElement>('lang-select');
let worker: Worker | null = null;

function updateAutoBtn() {
  autoBtn.disabled = !S.audioBuffer || !!worker;
  autoBtn.textContent = S.lines.length ? '✦ Caler automatiquement' : '✦ Transcrire et caler';
}

/** Mono 16 kHz pour Whisper */
async function to16k(buf: AudioBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return out.getChannelData(0);
}

function stopWorker() {
  worker?.terminate();
  worker = null;
  $('auto-progress').hidden = true;
  $('auto-hint').hidden = false;
  updateAutoBtn();
}

autoBtn.addEventListener('click', async () => {
  if (!S.audioBuffer || worker) return;
  const synced = S.lines.some((l) => l.start !== null);
  if (synced && !confirm('Remplacer les temps déjà calés par le calage automatique ?')) return;
  stopTap();
  const fill = $('auto-fill');
  const status = $('auto-status');
  status.classList.remove('error_text');
  $('auto-progress').hidden = false;
  $('auto-hint').hidden = true;
  fill.style.width = '0%';
  status.textContent = 'Préparation de l’audio…';

  const lang = langSelect.value || guessLanguage(S.lines.map((l) => l.text).join(' ')) || null;
  const audio = await to16k(S.audioBuffer);
  worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  updateAutoBtn();
  const t0 = performance.now();

  worker.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.type === 'download') {
      const p = m.total ? m.loaded / m.total : 0;
      fill.style.width = `${Math.round(p * 30)}%`;
      status.textContent = `Téléchargement du modèle… ${(m.loaded / 1048576).toFixed(0)} / ${(m.total / 1048576).toFixed(0)} Mo`;
    } else if (m.type === 'transcribe') {
      fill.style.width = `${Math.round(30 + m.progress * 70)}%`;
      status.textContent = `Écoute du chant… ${Math.round(m.progress * 100)} %`;
    } else if (m.type === 'done') {
      applyAsr(m.words as AsrWord[]);
      stopWorker();
      console.info(`Calage auto : ${(m.words as AsrWord[]).length} mots en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    } else if (m.type === 'error') {
      stopWorker();
      $('auto-progress').hidden = false;
      status.textContent = /fetch|network|load/i.test(m.message)
        ? 'Impossible de télécharger le modèle Whisper (huggingface.co inaccessible). Vérifie ta connexion ou cale au tap.'
        : `Échec du calage auto : ${m.message}`;
      status.classList.add('error_text');
      $('auto-cancel').hidden = true;
    }
  };
  $('auto-cancel').hidden = false;
  worker.postMessage({ type: 'run', audio, language: lang }, [audio.buffer]);
});
$('auto-cancel').addEventListener('click', stopWorker);

function applyAsr(words: AsrWord[]) {
  const d = duration();
  if (!words.length) {
    alert('Aucune voix détectée. Si le morceau est instrumental, coche « Morceau instrumental ».');
    return;
  }
  if (S.lines.length) {
    const res = alignLines(S.lines.map((l) => l.text), words, d);
    S.lines.forEach((l, i) => {
      l.start = res[i].start;
      l.uncertain = res[i].confidence < 0.34;
    });
  } else {
    // pas de paroles fournies : on prend la transcription brute
    S.lines = wordsToLines(words).map((w) => ({ ...makeLine(w.text, +w.start.toFixed(2)), uncertain: false }));
    lyricsInput.value = S.lines.map((l) => l.text).join('\n');
  }
  lyricsChanged();
}

// --- Import / export LRC
const lrcInput = $<HTMLInputElement>('lrc-input');
$('lrc-import-btn').addEventListener('click', () => lrcInput.click());
lrcInput.addEventListener('change', async () => {
  const f = lrcInput.files?.[0];
  if (!f) return;
  lyricsInput.value = await f.text();
  lrcInput.value = '';
  onLyricsText();
});
$('lrc-export-btn').addEventListener('click', () => {
  const blob = new Blob([toLrc(S.lines, { title: S.title, artist: S.artist })], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slug(S.title)}.lrc`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// --- Synchro au tap
const tapComp = $('tap-component');
const tapNext = $('tap-next');

function updateTapUi() {
  const l = S.lines[S.tapIndex];
  tapNext.textContent = l ? `→ ${l.text}` : 'Terminé ✓';
  linesList.querySelector('.is-next')?.classList.remove('is-next');
  const el = linesList.children[S.tapIndex] as HTMLElement | undefined;
  el?.classList.add('is-next');
  el?.scrollIntoView({ block: 'nearest' });
}

function startTap() {
  if (!audioEl.src || !S.lines.length) return;
  let i = S.lines.findIndex((l) => l.start === null);
  if (i < 0) i = 0;
  S.tapIndex = i;
  const prevStart = i > 0 ? S.lines[i - 1].start : null;
  audioEl.currentTime = prevStart !== null ? Math.max(0, prevStart) : 0;
  tapComp.hidden = false;
  $('tap-start-btn').hidden = true;
  updateTapUi();
  void audioEl.play();
}

function stopTap() {
  S.tapIndex = -1;
  tapComp.hidden = true;
  $('tap-start-btn').hidden = false;
  renderLines();
}

function tap() {
  if (S.tapIndex < 0 || S.tapIndex >= S.lines.length) return;
  if (audioEl.paused) void audioEl.play();
  const t = Math.max(0, audioEl.currentTime - TAP_LATENCY);
  const line = S.lines[S.tapIndex];
  line.start = +t.toFixed(2);
  // les lignes suivantes déjà calées avant ce point deviennent incohérentes → on les efface
  for (let j = S.tapIndex + 1; j < S.lines.length; j++) {
    const s = S.lines[j].start;
    if (s !== null && s <= t) S.lines[j].start = null;
  }
  S.tapIndex++;
  lyricsChanged();
  if (S.tapIndex >= S.lines.length) {
    updateTapUi();
    setTimeout(stopTap, 800);
  } else updateTapUi();
}

function undoTap() {
  if (S.tapIndex <= 0) return;
  S.tapIndex--;
  S.lines[S.tapIndex].start = null;
  const prev = S.tapIndex > 0 ? S.lines[S.tapIndex - 1].start : 0;
  audioEl.currentTime = Math.max(0, (prev ?? 0) - 0.5);
  lyricsChanged();
  updateTapUi();
}

$('tap-start-btn').addEventListener('click', startTap);
$('tap-btn').addEventListener('click', tap);
$('tap-undo-btn').addEventListener('click', undoTap);
$('tap-stop-btn').addEventListener('click', () => {
  audioEl.pause();
  stopTap();
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';
  if (typing && !(e.target as HTMLInputElement).matches('[type=range],[type=checkbox]')) return;
  if (S.exporting) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (S.tapIndex >= 0) tap();
    else togglePlay();
  } else if (e.code === 'Backspace' && S.tapIndex >= 0) {
    e.preventDefault();
    undoTap();
  }
});

// ------------------------------------------------------------------ Export
let job: ExportJob | null = null;
let lastUrl = '';
const exportBtn = $<HTMLButtonElement>('export-btn');

exportBtn.addEventListener('click', async () => {
  if (!S.audioBuffer || S.exporting) return;
  const unsynced = !S.instrumental && S.lines.length > 0 && S.timed.length === 0;
  if (unsynced && !confirm("Les paroles ne sont pas synchronisées : elles n'apparaîtront pas dans la vidéo. Continuer ?")) return;

  audioEl.pause();
  S.exporting = true;
  exportBtn.disabled = true;
  $('export-result').hidden = true;
  $('export-progress').hidden = false;
  const fill = $('export-fill');
  const status = $('export-status');
  status.classList.remove('error_text');
  fill.style.width = '0%';

  await ensureFonts();
  const f = format();
  job = exportVideo(renderState(f.width, f.height), S.audioBuffer, (p) => {
    fill.style.width = `${Math.round(p.progress * 100)}%`;
    if (p.phase === 'prepare') status.textContent = 'Préparation de l’encodeur…';
    else if (p.phase === 'finalize') status.textContent = 'Finalisation du MP4…';
    else status.textContent = `Encodage ${Math.round(p.progress * 100)} %${p.eta !== undefined ? ` · reste ~${Math.ceil(p.eta)} s` : ''}`;
  });

  try {
    const blob = await job.promise;
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    const name = `${slug(S.title)}-${f.id}.mp4`;
    const video = $<HTMLVideoElement>('export-video');
    video.src = lastUrl;
    const link = $<HTMLAnchorElement>('download-link');
    link.href = lastUrl;
    link.download = name;
    const len = S.clipEnd - S.clipStart;
    $('export-info').textContent = `${f.width}×${f.height} · ${fmt(len)} · ${(blob.size / 1048576).toFixed(1)} Mo · H.264/AAC — prêt pour X`;

    const shareBtn = $<HTMLButtonElement>('share-btn');
    const file = new File([blob], name, { type: 'video/mp4' });
    const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
    shareBtn.hidden = !canShare;
    shareBtn.onclick = () => navigator.share({ files: [file], title: S.title }).catch(() => {});

    $('export-progress').hidden = true;
    $('export-result').hidden = false;
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    status.textContent = aborted ? 'Export annulé.' : `Échec de l’export : ${(e as Error).message}`;
    if (!aborted) {
      status.classList.add('error_text');
      console.error(e);
    }
  } finally {
    S.exporting = false;
    exportBtn.disabled = false;
    job = null;
  }
});
$('export-cancel').addEventListener('click', () => job?.cancel());

// ------------------------------------------------------------------ Init
async function ensureFonts() {
  await Promise.all([
    document.fonts.load(`650 64px ${FONT_DISPLAY}`),
    document.fonts.load(`700 46px ${FONT_DISPLAY}`),
    document.fonts.load(`500 36px ${FONT_DISPLAY}`),
    document.fonts.load(`600 21px ${FONT_UI}`),
    document.fonts.load(`500 19px ${FONT_UI}`),
  ]).catch(() => {});
}

function init() {
  loadPrefs();
  applyAccentCss();
  artistInput.value = S.artist;
  blurInput.value = String(S.blur);
  $('blur-out').textContent = String(S.blur);
  dimInput.value = String(Math.round(S.dim * 100));
  $('dim-out').textContent = `${dimInput.value} %`;
  colorA.value = S.colorA;
  colorB.value = S.colorB;
  bindToggle('kenburns-input', 'kenBurns');
  bindToggle('pulse-input', 'pulse');
  bindToggle('title-toggle', 'showTitle');
  bindToggle('progress-toggle', 'showProgress');
  bindToggle('karaoke-toggle', 'karaoke');
  bindToggle('premium-input', 'premium', () => applyClip(S.clipStart, S.premium ? duration() : S.clipStart + X_FREE_MAX));

  setupDrop('audio', $<HTMLInputElement>('audio-input'), loadAudio);
  setupDrop('image', $<HTMLInputElement>('image-input'), loadImage);
  renderViz();
  renderPalettes();
  renderFormats();
  sizeCanvas();
  new ResizeObserver(sizeCanvas).observe(stage);
  void ensureFonts().then(invalidate);
  requestAnimationFrame(loop);
}

init();
