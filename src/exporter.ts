// Export MP4 H.264 + AAC, encodé dans le navigateur (WebCodecs via Mediabunny)
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny';
import { FPS } from './analysis';
import { drawFrame, type RenderState } from './renderer';

export interface ExportFormat {
  id: string;
  label: string;
  hint: string;
  width: number;
  height: number;
}

// Contraintes X (doc officielle) : H.264 High + AAC LC, ratio 1:2.39 à 2.39:1,
// max 1920×1200 (paysage) / 1200×1900 (portrait), 512 Mo, ≤ 2:20 hors Premium.
export const FORMATS: ExportFormat[] = [
  { id: '4x5', label: '4:5', hint: 'Fil X mobile · recommandé', width: 1080, height: 1350 },
  { id: '1x1', label: '1:1', hint: 'Carré · universel', width: 1080, height: 1080 },
  { id: '16x9', label: '16:9', hint: 'Desktop · plein écran', width: 1920, height: 1080 },
  { id: '9x16', label: '9:16', hint: 'Plein écran vertical', width: 1080, height: 1900 },
];

export const X_FREE_MAX = 140; // secondes

export type Weight = 'light' | 'balanced' | 'max';

// Débit vidéo cible en bits par pixel et par image (référence 1080×1350 à 30 i/s) :
// léger ≈ 2,5 Mbit/s, équilibré ≈ 5 Mbit/s, max ≈ 8 Mbit/s. Débit variable : un contenu
// peu animé descend souvent bien en dessous de la cible.
const BPP: Record<Weight, number> = { light: 0.057, balanced: 0.114, max: 0.18 };
export const AUDIO_BITRATE = 192_000;

export function videoBitrate(width: number, height: number, weight: Weight): number {
  return Math.round((width * height * FPS * BPP[weight]) / 100_000) * 100_000;
}

/** Taille maximale estimée (Mo) : le fichier réel est souvent plus léger */
export function estimateMb(width: number, height: number, weight: Weight, seconds: number): number {
  return ((videoBitrate(width, height, weight) + AUDIO_BITRATE) * seconds) / 8 / 1_000_000;
}

export interface ExportProgress {
  phase: 'prepare' | 'encode' | 'finalize';
  progress: number; // 0..1
  eta?: number; // secondes restantes
}

export interface ExportJob {
  promise: Promise<Blob>;
  cancel: () => void;
}

let aacRegistered = false;

async function ensureAac() {
  if (aacRegistered) return;
  if (!(await canEncodeAudio('aac'))) {
    // repli WASM (Firefox, Chromium Linux…)
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
  }
  aacRegistered = true;
}

/** Extrait [start, end] de l'audio, avec fondus si l'extrait est coupé */
function sliceAudio(buf: AudioBuffer, start: number, end: number): AudioBuffer {
  const sr = buf.sampleRate;
  const s0 = Math.max(0, Math.floor(start * sr));
  const s1 = Math.min(buf.length, Math.floor(end * sr));
  const len = Math.max(1, s1 - s0);
  const out = new AudioBuffer({ length: len, numberOfChannels: Math.min(2, buf.numberOfChannels), sampleRate: sr });
  const fadeIn = start > 0.05 ? Math.floor(0.25 * sr) : 0;
  const fadeOut = end < buf.duration - 0.05 ? Math.floor(1.2 * sr) : 0;
  for (let c = 0; c < out.numberOfChannels; c++) {
    const src = buf.getChannelData(c).subarray(s0, s1);
    const dst = out.getChannelData(c);
    dst.set(src);
    for (let i = 0; i < fadeIn && i < len; i++) dst[i] *= i / fadeIn;
    for (let i = 0; i < fadeOut && i < len; i++) dst[len - 1 - i] *= Math.pow(i / fadeOut, 1.5);
  }
  return out;
}

export function exportVideo(
  base: RenderState,
  audio: AudioBuffer,
  onProgress: (p: ExportProgress) => void,
  weight: Weight = 'balanced',
): ExportJob {
  let cancelled = false;
  let output: Output | null = null;

  const promise = (async () => {
    onProgress({ phase: 'prepare', progress: 0 });
    const { width, height } = base;
    const bitrate = videoBitrate(width, height, weight);

    if (!(await canEncodeVideo('avc', { width, height, bitrate }))) {
      throw new Error("Ton navigateur ne sait pas encoder en H.264. Utilise Chrome, Edge ou Safari récent sur ordinateur.");
    }
    await ensureAac();

    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

    output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });
    const video = new CanvasSource(canvas, {
      codec: 'avc',
      bitrate,
      keyFrameInterval: 2,
      latencyMode: 'quality',
    });
    const sound = new AudioBufferSource({ codec: 'aac', bitrate: AUDIO_BITRATE });
    output.addVideoTrack(video, { frameRate: FPS });
    output.addAudioTrack(sound);
    await output.start();

    const clip = sliceAudio(audio, base.clipStart, base.clipEnd);
    await sound.add(clip);
    sound.close();

    const total = Math.ceil(clip.duration * FPS);
    const t0 = performance.now();
    for (let i = 0; i < total; i++) {
      if (cancelled) throw new DOMException('Export annulé', 'AbortError');
      const t = base.clipStart + i / FPS;
      drawFrame(ctx, base, t);
      // fondu au noir sur la dernière demi-seconde
      const remain = clip.duration - i / FPS;
      if (remain < 0.5) {
        ctx.fillStyle = `rgba(0,0,0,${1 - remain / 0.5})`;
        ctx.fillRect(0, 0, width, height);
      }
      await video.add(i / FPS, 1 / FPS);
      if (i % 10 === 0) {
        const el = (performance.now() - t0) / 1000;
        const p = (i + 1) / total;
        onProgress({ phase: 'encode', progress: p, eta: p > 0.02 ? (el / p) * (1 - p) : undefined });
      }
    }
    video.close();
    onProgress({ phase: 'finalize', progress: 1 });
    await output.finalize();
    const buf = (output.target as BufferTarget).buffer!;
    return new Blob([buf], { type: 'video/mp4' });
  })();

  return {
    promise: promise.catch(async (e) => {
      if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
      throw e;
    }),
    cancel: () => {
      cancelled = true;
    },
  };
}
