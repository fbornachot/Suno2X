// Rendu d'une image de la vidéo. Fonction pure : (état, temps) → canvas.
import { BAND_COUNT, getFrame, type Analysis, type FrameData } from './analysis';
import type { TimedLine } from './lyrics';

export type VizStyle = 'bars' | 'radial' | 'vu';

export interface RenderState {
  width: number;
  height: number;
  /** image d'origine (nette) */
  image: CanvasImageSource | null;
  imageW: number;
  imageH: number;
  /** version floutée pré-calculée (ou null si flou = 0) */
  blurred: CanvasImageSource | null;
  dim: number; // 0..1
  kenBurns: boolean;
  pulse: boolean;
  viz: VizStyle;
  colorA: string;
  colorB: string;
  title: string;
  artist: string;
  showTitle: boolean;
  showProgress: boolean;
  karaoke: boolean;
  lyrics: TimedLine[];
  analysis: Analysis | null;
  clipStart: number;
  clipEnd: number;
}

export const FONT_DISPLAY = '"Outfit Variable", "Outfit", system-ui, sans-serif';
export const FONT_UI = '"Inter Variable", "Inter", system-ui, sans-serif';

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (x: number) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};
const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x), 3);

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex: string, a: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Rééchantillonne les bandes vers n valeurs (interpolation linéaire) */
function resample(src: Float32Array, n: number, from = 0, to = BAND_COUNT): number[] {
  const out: number[] = [];
  const span = to - from - 1;
  for (let i = 0; i < n; i++) {
    const x = from + (i / Math.max(1, n - 1)) * span;
    const i0 = Math.floor(x);
    const i1 = Math.min(to - 1, i0 + 1);
    out.push(src[i0] + (src[i1] - src[i0]) * (x - i0));
  }
  return out;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function setSpacing(ctx: Ctx, px: number) {
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = `${px}px`;
}

// ---------------------------------------------------------------- Fond

function drawCover(ctx: Ctx, img: CanvasImageSource, iw: number, ih: number, w: number, h: number, zoom: number, dx = 0, dy = 0) {
  const s = Math.max(w / iw, h / ih) * zoom;
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, (w - dw) / 2 + dx, (h - dh) / 2 + dy, dw, dh);
}

function drawBackground(ctx: Ctx, st: RenderState, t: number, fd: FrameData) {
  const { width: w, height: h } = st;
  const prog = clamp((t - st.clipStart) / Math.max(1, st.clipEnd - st.clipStart));
  const src = st.blurred ?? st.image;

  if (src) {
    const zoom = (st.kenBurns ? 1.06 + 0.08 * prog : 1.06) + (st.pulse ? fd.bass * fd.bass * 0.035 : 0);
    const drift = st.kenBurns ? Math.sin(prog * Math.PI) * w * 0.015 : 0;
    drawCover(ctx, src, st.imageW, st.imageH, w, h, zoom, drift, 0);
  } else {
    // fond par défaut : dégradé profond + halos de couleur
    ctx.fillStyle = '#07070c';
    ctx.fillRect(0, 0, w, h);
    const m = Math.max(w, h);
    const g1 = ctx.createRadialGradient(w * 0.2, h * 0.15, 0, w * 0.2, h * 0.15, m * 0.8);
    g1.addColorStop(0, rgba(st.colorA, 0.45));
    g1.addColorStop(1, rgba(st.colorA, 0));
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, w, h);
    const g2 = ctx.createRadialGradient(w * 0.85, h * 0.9, 0, w * 0.85, h * 0.9, m * 0.75);
    g2.addColorStop(0, rgba(st.colorB, 0.35 + fd.bass * 0.15));
    g2.addColorStop(1, rgba(st.colorB, 0));
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, w, h);
  }

  // assombrissement global
  if (st.dim > 0) {
    ctx.fillStyle = `rgba(0,0,0,${st.dim})`;
    ctx.fillRect(0, 0, w, h);
  }
  // dégradés de lisibilité haut / bas
  const top = ctx.createLinearGradient(0, 0, 0, h * 0.28);
  top.addColorStop(0, 'rgba(0,0,0,0.4)');
  top.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, h * 0.28);
  const bot = ctx.createLinearGradient(0, h * 0.42, 0, h);
  bot.addColorStop(0, 'rgba(0,0,0,0)');
  bot.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = bot;
  ctx.fillRect(0, h * 0.42, w, h * 0.58);
  // vignette
  const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}

// ---------------------------------------------------------------- Vumètres

interface Layout {
  s: number; // échelle (1 = 1080 px sur le petit côté)
  pad: number;
  landscape: boolean;
  lyricsY: number;
  vizTop: number;
  vizBottom: number;
  radialCY: number;
  radialR: number;
  progressY: number;
}

function layout(st: RenderState): Layout {
  const { width: w, height: h } = st;
  const s = Math.min(w, h) / 1080;
  const landscape = w > h * 1.2;
  const pad = Math.round(Math.min(w, h) * 0.065);
  const progressY = h - pad;
  const hasLyrics = st.lyrics.length > 0;
  const L: Layout = {
    s, pad, landscape, progressY,
    lyricsY: h * 0.5,
    vizTop: 0, vizBottom: 0,
    radialCY: h * 0.5,
    radialR: Math.min(w, h) * 0.17,
  };
  if (st.viz === 'bars') {
    L.vizBottom = progressY - (st.showProgress ? 70 : 20) * s;
    L.vizTop = L.vizBottom - h * (landscape ? 0.22 : 0.15);
    L.lyricsY = (L.vizTop + (st.showTitle ? h * 0.18 : 0)) / 2 + h * 0.04;
  } else if (st.viz === 'vu') {
    L.vizBottom = progressY - (st.showProgress ? 80 : 30) * s;
    L.vizTop = L.vizBottom - 150 * s;
    L.lyricsY = (L.vizTop + (st.showTitle ? h * 0.18 : 0)) / 2 + h * 0.03;
  } else {
    if (landscape) {
      L.radialCY = h * 0.47;
      L.radialR = h * 0.16;
      L.lyricsY = h * 0.84 - (st.showProgress ? 30 * s : 0);
    } else if (!hasLyrics) {
      L.radialCY = h * 0.5;
      L.radialR = w * Math.min(0.26, 0.2 + (h / w - 1) * 0.08);
    } else {
      // portrait / carré : vinyle en haut, paroles dans l'espace restant
      const aspect = h / w;
      L.radialR = w * clamp(0.135 + (aspect - 1) * 0.14, 0.135, 0.24);
      L.radialCY = h * (aspect < 1.1 ? 0.37 : 0.38);
      const top = L.radialCY + L.radialR * 1.9;
      const bottom = progressY - (st.showProgress ? 60 : 10) * s;
      L.lyricsY = top + (bottom - top) * 0.4;
    }
  }
  return L;
}

function drawBars(ctx: Ctx, st: RenderState, L: Layout, fd: FrameData) {
  const { width: w } = st;
  const n = L.landscape ? 72 : 48;
  const vals = resample(fd.bands, n, 0, BAND_COUNT - 4);
  const x0 = L.pad;
  const span = w - L.pad * 2;
  const slot = span / n;
  const bw = slot * 0.58;
  const maxH = L.vizBottom - L.vizTop;
  const base = L.vizBottom;

  const grad = ctx.createLinearGradient(0, base - maxH, 0, base);
  grad.addColorStop(0, st.colorB);
  grad.addColorStop(1, st.colorA);
  const reflH = Math.min(maxH * 0.3, 34 * L.s);
  const refl = ctx.createLinearGradient(0, base, 0, base + reflH);
  refl.addColorStop(0, rgba(st.colorA, 0.35));
  refl.addColorStop(1, rgba(st.colorA, 0));

  ctx.save();
  ctx.shadowColor = rgba(st.colorA, 0.55);
  ctx.shadowBlur = 22 * L.s;
  ctx.fillStyle = grad;
  for (let i = 0; i < n; i++) {
    const v = Math.pow(vals[i], 1.35);
    const bh = Math.max(bw, v * maxH);
    roundRect(ctx, x0 + i * slot + (slot - bw) / 2, base - bh, bw, bh, bw / 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.fillStyle = refl;
  const gap = 6 * L.s;
  for (let i = 0; i < n; i++) {
    const v = Math.pow(vals[i], 1.35);
    const bh = Math.min(reflH, Math.max(bw, v * maxH) * 0.3);
    roundRect(ctx, x0 + i * slot + (slot - bw) / 2, base + gap, bw, bh, bw / 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawRadial(ctx: Ctx, st: RenderState, L: Layout, fd: FrameData, t: number) {
  const cx = st.width / 2;
  const cy = L.radialCY;
  const r = L.radialR * (1 + fd.bass * fd.bass * 0.05);
  const half = 60;
  const vals = resample(fd.bands, half, 0, BAND_COUNT - 6);
  const total = half * 2;
  const maxLen = L.radialR * 0.85;
  const bw = ((2 * Math.PI * r) / total) * 0.5;

  // halo
  const halo = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 2.2);
  halo.addColorStop(0, rgba(st.colorA, 0.28 + fd.bass * 0.25));
  halo.addColorStop(1, rgba(st.colorA, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.2, 0, Math.PI * 2);
  ctx.fill();

  // barres symétriques (graves en bas, aigus en haut)
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = 'round';
  ctx.lineWidth = bw;
  ctx.shadowColor = rgba(st.colorA, 0.6);
  ctx.shadowBlur = 16 * L.s;
  for (let i = 0; i < total; i++) {
    const k = i < half ? i : total - 1 - i;
    const v = Math.pow(vals[k], 1.3);
    const ang = Math.PI / 2 + (i / total) * Math.PI * 2;
    const len = 4 * L.s + v * maxLen;
    const r0 = r + 10 * L.s;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    const g = ctx.createLinearGradient(c * r0, sn * r0, c * (r0 + len), sn * (r0 + len));
    g.addColorStop(0, st.colorA);
    g.addColorStop(1, st.colorB);
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.moveTo(c * r0, sn * r0);
    ctx.lineTo(c * (r0 + len), sn * (r0 + len));
    ctx.stroke();
  }
  ctx.restore();

  // disque central : visuel net qui tourne lentement (effet vinyle)
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  if (st.image) {
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.12);
    const sc = Math.max((r * 2) / st.imageW, (r * 2) / st.imageH);
    ctx.drawImage(st.image, (-st.imageW * sc) / 2, (-st.imageH * sc) / 2, st.imageW * sc, st.imageH * sc);
  } else {
    const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, st.colorA);
    g.addColorStop(1, st.colorB);
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();
  // liseré + trou central
  ctx.save();
  ctx.lineWidth = 3 * L.s;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(8,8,12,0.85)';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawVu(ctx: Ctx, st: RenderState, L: Layout, fd: FrameData) {
  const w = st.width;
  const x0 = L.pad + 44 * L.s;
  const span = w - L.pad * 2 - 44 * L.s;
  const segs = L.landscape ? 56 : 36;
  const gap = span * 0.006;
  const sw = (span - gap * (segs - 1)) / segs;
  const sh = 34 * L.s;
  const rows: [string, number, number, number][] = [
    ['L', fd.levelL, fd.peakL, L.vizTop + 10 * L.s],
    ['R', fd.levelR, fd.peakR, L.vizTop + 10 * L.s + sh + 26 * L.s],
  ];
  const [ar, ag, ab] = hexToRgb(st.colorA);
  const [br, bg, bb] = hexToRgb(st.colorB);
  const hot = [255, 77, 109];

  ctx.save();
  for (const [label, lv, pk, y] of rows) {
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = `600 ${22 * L.s}px ${FONT_UI}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(label, L.pad, y + sh / 2);
    const lit = Math.round(lv * segs);
    const peakSeg = Math.min(segs - 1, Math.round(pk * segs));
    for (let i = 0; i < segs; i++) {
      const p = i / (segs - 1);
      let c: number[];
      if (p > 0.86) c = hot;
      else {
        const q = p / 0.86;
        c = [ar + (br - ar) * q, ag + (bg - ag) * q, ab + (bb - ab) * q];
      }
      const on = i < lit || i === peakSeg;
      const x = x0 + i * (sw + gap);
      ctx.shadowBlur = on ? 14 * L.s : 0;
      ctx.shadowColor = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0.7)`;
      ctx.fillStyle = on ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : 'rgba(255,255,255,0.09)';
      roundRect(ctx, x, y, sw, sh, Math.min(sw, sh) * 0.3);
      ctx.fill();
    }
  }
  ctx.shadowBlur = 0;
  // graduation dB
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = `500 ${16 * L.s}px ${FONT_UI}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const yScale = rows[1][3] + sh + 12 * L.s;
  for (const db of [-36, -24, -12, -6, -3, 0]) {
    const p = (db + 42) / 42;
    ctx.fillText(String(db), x0 + p * span - sw / 2, yScale);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- Textes

function wrap(ctx: Ctx, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const wd of words) {
    const test = cur ? `${cur} ${wd}` : wd;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = wd;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

function fitLines(ctx: Ctx, text: string, maxW: number, size: number, weight: number, maxLines: number) {
  let sz = size;
  for (let i = 0; i < 8; i++) {
    ctx.font = `${weight} ${sz}px ${FONT_DISPLAY}`;
    const lines = wrap(ctx, text, maxW);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxW)) return { lines, size: sz };
    sz *= 0.88;
  }
  ctx.font = `${weight} ${sz}px ${FONT_DISPLAY}`;
  return { lines: wrap(ctx, text, maxW), size: sz };
}

function findLine(lyrics: TimedLine[], t: number): number {
  let lo = 0;
  let hi = lyrics.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lyrics[mid].start <= t) {
      res = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return res;
}

function drawLyrics(ctx: Ctx, st: RenderState, L: Layout, t: number) {
  if (!st.lyrics.length) return;
  const w = st.width;
  const idx = findLine(st.lyrics, t);
  const maxW = w * (L.landscape ? 0.72 : 0.84);
  const aspect = st.height / st.width;
  const baseSize = (L.landscape ? 60 : st.viz === 'radial' && aspect < 1.1 ? 54 : aspect > 1.6 ? 74 : 66) * L.s;
  const FADE = 0.28;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const cur = idx >= 0 ? st.lyrics[idx] : null;
  const visible = cur && t < cur.end;
  let blockBottom = L.lyricsY;

  if (cur && visible) {
    const inP = easeOut((t - cur.start) / FADE);
    const contiguous = st.lyrics[idx + 1] && st.lyrics[idx + 1].start - cur.end < 0.05;
    const outP = contiguous ? 1 : smooth((cur.end - t) / FADE);
    const alpha = Math.min(inP, outP);
    const { lines, size } = fitLines(ctx, cur.text, maxW, baseSize, 650, 3);
    const lh = size * 1.18;
    const totalH = lh * lines.length;
    const y0 = L.lyricsY - totalH / 2 + lh / 2 + (1 - inP) * 22 * L.s;
    blockBottom = L.lyricsY + totalH / 2;

    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 28 * L.s;
    ctx.shadowOffsetY = 2 * L.s;

    if (st.karaoke) {
      // remplissage progressif sur la durée de la ligne
      const p = clamp((t - cur.start) / Math.max(0.4, cur.end - cur.start - 0.25));
      const widths = lines.map((l) => ctx.measureText(l).width);
      const sum = widths.reduce((a, b) => a + b, 0);
      let budget = p * sum;
      lines.forEach((ln, i) => {
        const y = y0 + i * lh;
        ctx.fillStyle = 'rgba(255,255,255,0.42)';
        ctx.fillText(ln, w / 2, y);
        const fw = Math.min(widths[i], Math.max(0, budget));
        budget -= widths[i];
        if (fw <= 0) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(w / 2 - widths[i] / 2, y - lh / 2, fw, lh);
        ctx.clip();
        ctx.shadowBlur = 0;
        const g = ctx.createLinearGradient(w / 2 - widths[i] / 2, 0, w / 2 + widths[i] / 2, 0);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(1, mixWhite(st.colorB, 0.55));
        ctx.fillStyle = g;
        ctx.fillText(ln, w / 2, y);
        ctx.restore();
      });
    } else {
      ctx.fillStyle = '#ffffff';
      lines.forEach((ln, i) => ctx.fillText(ln, w / 2, y0 + i * lh));
    }
  }

  // ligne suivante, discrète
  const nxt = st.lyrics[idx + 1];
  if (nxt && nxt.start - t < 6) {
    const appear = visible ? 1 : smooth(1 - (nxt.start - t - 1.5) / 2);
    const leaving = smooth((nxt.start - t) / 0.25);
    ctx.shadowBlur = 16 * L.s;
    ctx.shadowOffsetY = 0;
    const { lines, size } = fitLines(ctx, nxt.text, maxW, baseSize * 0.56, 500, 2);
    ctx.globalAlpha = 0.5 * appear * leaving;
    ctx.fillStyle = '#ffffff';
    const lh = size * 1.2;
    const y0 = (visible ? blockBottom : L.lyricsY) + 26 * L.s + lh / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, w / 2, y0 + i * lh));
  }
  ctx.restore();
}

function mixWhite(hex: string, k: number) {
  const [r, g, b] = hexToRgb(hex);
  const m = (c: number) => Math.round(c + (255 - c) * (1 - k));
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

function drawTitle(ctx: Ctx, st: RenderState, L: Layout) {
  if (!st.showTitle || (!st.title && !st.artist)) return;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 18 * L.s;
  let y = L.pad + 8 * L.s;
  const maxW = st.width - L.pad * 2;
  if (st.artist) {
    ctx.font = `600 ${21 * L.s}px ${FONT_UI}`;
    setSpacing(ctx, 4 * L.s);
    // pastille accent
    ctx.fillStyle = st.colorA;
    ctx.beginPath();
    ctx.arc(L.pad + 6 * L.s, y + 13 * L.s, 6 * L.s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.fillText(st.artist.toUpperCase(), L.pad + 22 * L.s, y + 21 * L.s, maxW - 22 * L.s);
    y += 36 * L.s;
  }
  if (st.title) {
    setSpacing(ctx, 0);
    const { lines, size } = fitLines(ctx, st.title, maxW, 46 * L.s, 700, 2);
    ctx.fillStyle = '#ffffff';
    lines.forEach((ln, i) => ctx.fillText(ln, L.pad, y + size + i * size * 1.1));
  }
  ctx.restore();
}

function drawProgress(ctx: Ctx, st: RenderState, L: Layout, t: number) {
  if (!st.showProgress) return;
  const len = Math.max(0.01, st.clipEnd - st.clipStart);
  const rel = clamp(t - st.clipStart, 0, len);
  const p = rel / len;
  const x0 = L.pad;
  const bw = st.width - L.pad * 2;
  const bh = 5 * L.s;
  const y = L.progressY - bh;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  roundRect(ctx, x0, y, bw, bh, bh / 2);
  ctx.fill();
  const g = ctx.createLinearGradient(x0, 0, x0 + bw, 0);
  g.addColorStop(0, st.colorA);
  g.addColorStop(1, st.colorB);
  ctx.fillStyle = g;
  ctx.shadowColor = rgba(st.colorA, 0.7);
  ctx.shadowBlur = 12 * L.s;
  roundRect(ctx, x0, y, Math.max(bh, bw * p), bh, bh / 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x0 + bw * p, y + bh / 2, bh * 1.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = `500 ${19 * L.s}px ${FONT_UI}`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.textBaseline = 'bottom';
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  ctx.textAlign = 'left';
  ctx.fillText(fmt(rel), x0, y - 14 * L.s);
  ctx.textAlign = 'right';
  ctx.fillText(`-${fmt(len - rel)}`, x0 + bw, y - 14 * L.s);
  ctx.restore();
}

// ---------------------------------------------------------------- Entrée

export function drawFrame(ctx: Ctx, st: RenderState, t: number) {
  const fd = getFrame(st.analysis, t);
  const L = layout(st);
  ctx.save();
  ctx.clearRect(0, 0, st.width, st.height);
  drawBackground(ctx, st, t, fd);
  if (st.viz === 'bars') drawBars(ctx, st, L, fd);
  else if (st.viz === 'radial') drawRadial(ctx, st, L, fd, t);
  else drawVu(ctx, st, L, fd);
  drawTitle(ctx, st, L);
  drawLyrics(ctx, st, L, t);
  drawProgress(ctx, st, L, t);
  ctx.restore();
}

// ---------------------------------------------------------------- Utilitaires image

/** Pré-calcule une version floutée de l'image (une seule fois, pas à chaque image) */
export function makeBlurred(img: CanvasImageSource, iw: number, ih: number, blurPx: number): HTMLCanvasElement | null {
  if (blurPx <= 0) return null;
  const maxSide = 1600;
  const k = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.round(iw * k);
  const h = Math.round(ih * k);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  const px = blurPx * k * 1.5;
  if (supportsFilter()) {
    // marge pour éviter les bords transparents du flou
    ctx.filter = `blur(${px}px)`;
    const m = px * 2;
    ctx.drawImage(img, -m, -m, w + m * 2, h + m * 2);
    ctx.filter = 'none';
  } else {
    // repli (Safari ancien) : réduction / agrandissement successifs
    const f = Math.max(2, Math.round(px / 2));
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(w / f));
    small.height = Math.max(1, Math.round(h / f));
    const sc = small.getContext('2d')!;
    sc.imageSmoothingQuality = 'high';
    sc.drawImage(img, 0, 0, small.width, small.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, w, h);
  }
  return out;
}

let filterOk: boolean | null = null;
function supportsFilter(): boolean {
  if (filterOk !== null) return filterOk;
  const c = document.createElement('canvas');
  c.width = c.height = 9;
  const x = c.getContext('2d')!;
  x.filter = 'blur(2px)';
  x.fillStyle = '#fff';
  x.fillRect(4, 4, 1, 1);
  filterOk = x.getImageData(2, 4, 1, 1).data[3] > 0;
  return filterOk;
}

/** Couleurs d'accent extraites de l'image (teinte saturée dominante) */
export function extractAccent(img: CanvasImageSource): [string, string] {
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(img, 0, 0, 48, 48);
  const d = x.getImageData(0, 0, 48, 48).data;
  const bins = new Float32Array(36);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    if (sat < 0.25 || mx < 0.2) continue;
    let hue = 0;
    if (mx === r) hue = ((g - b) / (mx - mn)) % 6;
    else if (mx === g) hue = (b - r) / (mx - mn) + 2;
    else hue = (r - g) / (mx - mn) + 4;
    hue = (hue * 60 + 360) % 360;
    bins[Math.floor(hue / 10) % 36] += sat * sat * mx * mx; // favorise les couleurs vives
  }
  let best = 0;
  for (let i = 1; i < 36; i++) if (bins[i] > bins[best]) best = i;
  const total = bins.reduce((a, b) => a + b, 0);
  const h = total < 1 ? 265 : best * 10 + 5;
  return [hsl(h, 0.9, 0.62), hsl((h + 45) % 360, 0.95, 0.66)];
}

function hsl(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hx = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${hx(f(0))}${hx(f(8))}${hx(f(4))}`;
}
