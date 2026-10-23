// Worker Whisper : transcription horodatée mot à mot, 100 % dans le navigateur.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { AsrWord } from './align';

export const MODEL_ID = 'onnx-community/whisper-base_timestamped';
const SR = 16000;
// Fenêtres de 29 s (pas 30 : bug connu des timestamps mot à mot à 30 s), recouvrement 4 s
const WIN = 29;
const STEP = 25;
const EDGE = 2;

env.allowLocalModels = false;

type InMsg = { type: 'run'; audio: Float32Array; language: string | null };

let asr: AutomaticSpeechRecognitionPipeline | null = null;

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

async function load() {
  if (asr) return asr;
  const files = new Map<string, { loaded: number; total: number }>();
  const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status === 'progress' && p.file) {
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
      let l = 0;
      let t = 0;
      files.forEach((f) => {
        l += f.loaded;
        t += f.total;
      });
      post({ type: 'download', loaded: l, total: t });
    }
  };
  try {
    asr = (await pipeline('automatic-speech-recognition', MODEL_ID, { dtype: 'q8', device: 'wasm', progress_callback })) as AutomaticSpeechRecognitionPipeline;
  } catch {
    // repli si la variante quantifiée n'est pas disponible
    asr = (await pipeline('automatic-speech-recognition', MODEL_ID, { dtype: 'fp32', device: 'wasm', progress_callback })) as AutomaticSpeechRecognitionPipeline;
  }
  return asr;
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  if (e.data.type !== 'run') return;
  try {
    const { audio, language } = e.data;
    const model = await load();
    const dur = audio.length / SR;
    const words: AsrWord[] = [];
    const windows = Math.max(1, Math.ceil(Math.max(0, dur - (WIN - STEP)) / STEP));
    for (let k = 0; k < windows; k++) {
      const s = k * STEP;
      const isLast = k === windows - 1;
      const chunk = audio.subarray(Math.floor(s * SR), Math.min(audio.length, Math.floor((s + WIN) * SR)));
      post({ type: 'transcribe', progress: k / windows });
      const out = (await model(chunk, {
        return_timestamps: 'word',
        ...(language ? { language, task: 'transcribe' } : {}),
      })) as { chunks?: { text: string; timestamp: [number, number | null] }[] };
      const keepFrom = s + (k > 0 ? EDGE : 0);
      const keepTo = isLast ? Infinity : s + STEP + EDGE;
      for (const c of out.chunks ?? []) {
        const start = s + c.timestamp[0];
        const end = s + (c.timestamp[1] ?? c.timestamp[0] + 0.3);
        if (start >= keepFrom && start < keepTo) words.push({ text: c.text, start, end });
      }
    }
    post({ type: 'done', words });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};
