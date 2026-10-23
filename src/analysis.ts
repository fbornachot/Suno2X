// Analyse audio hors-ligne : spectre + niveaux stéréo pré-calculés pour chaque image.
// Le même jeu de données sert à l'aperçu et à l'export → rendu identique et déterministe.

export const FPS = 30;
export const BAND_COUNT = 64;
const FFT_SIZE = 2048;
const F_MIN = 40;
const F_MAX = 16000;

export interface Analysis {
  fps: number;
  frameCount: number;
  duration: number;
  /** frameCount × BAND_COUNT, valeurs 0..1 lissées */
  bands: Float32Array;
  /** niveaux RMS lissés 0..1 */
  levelL: Float32Array;
  levelR: Float32Array;
  /** maintien de crête 0..1 */
  peakL: Float32Array;
  peakR: Float32Array;
  /** énergie des basses 0..1 (pulse du fond / radial) */
  bass: Float32Array;
}

export interface FrameData {
  bands: Float32Array;
  levelL: number;
  levelR: number;
  peakL: number;
  peakR: number;
  bass: number;
}

// FFT radix-2 itérative, en place
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * Normalisation adaptative : le 95e percentile de chaque bande ≈ 0.92.
 * Les bandes quasi vides (≥ 30 dB sous la plus forte) ne sont pas sur-amplifiées.
 * Résultat stable quel que soit le mastering du morceau.
 */
function normalizeBands(db: Float32Array, frameCount: number) {
  const RANGE = 38;
  const ref = new Float32Array(BAND_COUNT);
  const col = new Float32Array(frameCount);
  for (let b = 0; b < BAND_COUNT; b++) {
    for (let f = 0; f < frameCount; f++) col[f] = db[f * BAND_COUNT + b];
    const sorted = col.slice().sort();
    ref[b] = sorted[Math.floor(frameCount * 0.95)];
  }
  const top = Math.max(...ref);
  for (let b = 0; b < BAND_COUNT; b++) {
    const r = Math.max(ref[b], top - 30);
    for (let f = 0; f < frameCount; f++) {
      const i = f * BAND_COUNT + b;
      db[i] = Math.min(1, Math.max(0, ((db[i] - (r - RANGE)) / RANGE) * 0.92));
    }
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function analyzeAudio(
  buffer: AudioBuffer,
  onProgress?: (p: number) => void,
): Promise<Analysis> {
  const sr = buffer.sampleRate;
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const duration = buffer.duration;
  const frameCount = Math.ceil(duration * FPS) + 1;

  // Fenêtre de Hann
  const win = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));

  // Bandes logarithmiques → plages de bins
  const binHz = sr / FFT_SIZE;
  const bandLo = new Int32Array(BAND_COUNT);
  const bandHi = new Int32Array(BAND_COUNT);
  const bandTilt = new Float32Array(BAND_COUNT);
  for (let b = 0; b < BAND_COUNT; b++) {
    const f0 = F_MIN * Math.pow(F_MAX / F_MIN, b / BAND_COUNT);
    const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (b + 1) / BAND_COUNT);
    bandLo[b] = Math.max(1, Math.floor(f0 / binHz));
    bandHi[b] = Math.max(bandLo[b] + 1, Math.ceil(f1 / binHz));
    // compensation de pente (~ +4.5 dB/octave) pour que les aigus restent visibles
    const fc = Math.sqrt(f0 * f1);
    bandTilt[b] = 4.5 * Math.log2(fc / 1000);
  }

  const rawBands = new Float32Array(frameCount * BAND_COUNT);
  const rawL = new Float32Array(frameCount);
  const rawR = new Float32Array(frameCount);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const norm = FFT_SIZE / 4;
  const rmsWin = Math.round(sr / FPS) * 2;

  for (let f = 0; f < frameCount; f++) {
    const center = Math.round((f / FPS) * sr);
    const start = center - FFT_SIZE / 2;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = start + i;
      const v = idx >= 0 && idx < L.length ? (L[idx] + R[idx]) * 0.5 : 0;
      re[i] = v * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < BAND_COUNT; b++) {
      let sum = 0;
      let peak = 0;
      for (let k = bandLo[b]; k < bandHi[b]; k++) {
        const m = Math.hypot(re[k], im[k]);
        sum += m;
        if (m > peak) peak = m;
      }
      const mag = (sum / (bandHi[b] - bandLo[b])) * 0.5 + peak * 0.5;
      rawBands[f * BAND_COUNT + b] = 20 * Math.log10(mag / norm + 1e-9) + bandTilt[b];
    }

    // RMS stéréo
    let sl = 0;
    let sR = 0;
    let n = 0;
    for (let i = center - rmsWin / 2; i < center + rmsWin / 2; i++) {
      if (i < 0 || i >= L.length) continue;
      sl += L[i] * L[i];
      sR += R[i] * R[i];
      n++;
    }
    const toLevel = (s: number) => {
      const db = 20 * Math.log10(Math.sqrt(s / Math.max(1, n)) + 1e-9);
      return Math.min(1, Math.max(0, (db + 42) / 42));
    };
    rawL[f] = toLevel(sl);
    rawR[f] = toLevel(sR);

    if (f % 400 === 0) {
      onProgress?.(f / frameCount);
      await tick();
    }
  }

  normalizeBands(rawBands, frameCount);

  // Lissage attaque/relâchement (séquentiel, donc identique aperçu/export)
  const bands = new Float32Array(rawBands.length);
  const ATK = 0.65;
  const REL = 0.16;
  for (let b = 0; b < BAND_COUNT; b++) {
    let v = 0;
    for (let f = 0; f < frameCount; f++) {
      const x = rawBands[f * BAND_COUNT + b];
      v += (x - v) * (x > v ? ATK : REL);
      bands[f * BAND_COUNT + b] = v;
    }
  }
  // petit flou spatial entre bandes voisines pour un rendu plus fluide
  const tmp = new Float32Array(BAND_COUNT);
  for (let f = 0; f < frameCount; f++) {
    const o = f * BAND_COUNT;
    for (let b = 0; b < BAND_COUNT; b++) {
      const a = bands[o + Math.max(0, b - 1)];
      const c = bands[o + Math.min(BAND_COUNT - 1, b + 1)];
      tmp[b] = bands[o + b] * 0.6 + (a + c) * 0.2;
    }
    bands.set(tmp, o);
  }

  const smoothLevel = (raw: Float32Array) => {
    const lv = new Float32Array(frameCount);
    const pk = new Float32Array(frameCount);
    let v = 0;
    let p = 0;
    let hold = 0;
    for (let f = 0; f < frameCount; f++) {
      const x = raw[f];
      v += (x - v) * (x > v ? 0.7 : 0.18);
      lv[f] = v;
      if (v >= p) {
        p = v;
        hold = Math.round(FPS * 0.8);
      } else if (hold > 0) hold--;
      else p = Math.max(v, p - 0.012);
      pk[f] = p;
    }
    return [lv, pk] as const;
  };
  const [levelL, peakL] = smoothLevel(rawL);
  const [levelR, peakR] = smoothLevel(rawR);

  const bass = new Float32Array(frameCount);
  let bv = 0;
  for (let f = 0; f < frameCount; f++) {
    let s = 0;
    for (let b = 0; b < 8; b++) s += rawBands[f * BAND_COUNT + b];
    const x = s / 8;
    bv += (x - bv) * (x > bv ? 0.6 : 0.12);
    bass[f] = bv;
  }

  onProgress?.(1);
  return { fps: FPS, frameCount, duration, bands, levelL, levelR, peakL, peakR, bass };
}

const emptyBands = new Float32Array(BAND_COUNT);

export function getFrame(a: Analysis | null, t: number): FrameData {
  if (!a) return { bands: emptyBands, levelL: 0, levelR: 0, peakL: 0, peakR: 0, bass: 0 };
  const f = Math.min(a.frameCount - 1, Math.max(0, Math.round(t * a.fps)));
  return {
    bands: a.bands.subarray(f * BAND_COUNT, (f + 1) * BAND_COUNT),
    levelL: a.levelL[f],
    levelR: a.levelR[f],
    peakL: a.peakL[f],
    peakR: a.peakR[f],
    bass: a.bass[f],
  };
}
