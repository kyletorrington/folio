// Voice typing for Ask AI, recorded the way the devbox console's laptop dictation records (web/app.js, PAGE_MIC):
// the browser's MediaRecorder (Opus in WebM), one recording at a time, ten minutes at most, its loudness sampled for
// the button's glow. The desktop shell turns the recording into words (electron/dictation.cjs).

export const DICTATION_LIMIT_MS = 10 * 60_000;

interface Recording {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  at: number;
  context: AudioContext | null;
  analyser: AnalyserNode | null;
  peak: number;
  mic: string;
}

let current: Recording | null = null;

const release = (x: Pick<Recording, "stream" | "context">) => {
  try { x.stream.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ }
  try { void x.context?.close(); } catch { /* already closed */ }
};

export const canRecord = () => !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

export async function startRecording(): Promise<{ ok: true } | { error: string }> {
  if (current) return { error: "Already recording." };
  let stream: MediaStream;
  try {
    // No echo cancelling or noise suppression: they are for calls, and on Windows Chrome asks the sound driver for its
    // "communications" processing to do them, which once left the microphone silent for every app until a restart
    // (devbox console, 15 Oct 2026). Plain sound is what transcription wants.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
  } catch (error) {
    const name = (error as Error)?.name;
    return { error: name === "NotAllowedError" ? "Folio isn't allowed to use the microphone. Allow it in your system's privacy settings."
      : name === "NotFoundError" ? "No microphone was found." : `The microphone wouldn't start: ${(error as Error)?.message ?? error}` };
  }
  const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  let recorder: MediaRecorder;
  try { recorder = new MediaRecorder(stream, type ? { mimeType: type } : {}); }
  catch (error) { release({ stream, context: null }); return { error: `The recorder wouldn't start: ${(error as Error)?.message ?? error}` }; }
  const x: Recording = { stream, recorder, chunks: [], at: Date.now(), context: null, analyser: null, peak: 0, mic: stream.getAudioTracks()[0]?.label ?? "" };
  recorder.ondataavailable = (e) => { if (e.data?.size) x.chunks.push(e.data); };
  try {
    x.context = new AudioContext();
    void x.context.resume().catch(() => {});
    x.analyser = x.context.createAnalyser();
    x.analyser.fftSize = 1024;
    x.context.createMediaStreamSource(stream).connect(x.analyser);
  } catch { /* no glow; it still records */ }
  try { recorder.start(1000); }
  catch (error) { release(x); return { error: `The recorder wouldn't start: ${(error as Error)?.message ?? error}` }; }
  current = x;
  return { ok: true };
}

/** How loud it is now (0 to 1), and whether it is still recording (it stops itself at the limit). */
export function recordingState() {
  const x = current;
  if (!x) return { recording: false, level: 0 };
  let level = 0;
  if (x.analyser) {
    const samples = new Uint8Array(x.analyser.fftSize);
    x.analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += ((v - 128) / 128) ** 2;
    level = Math.min(1, Math.sqrt(sum / samples.length) * 5);
    x.peak = Math.max(x.peak, level);
  }
  return { recording: x.recorder.state === "recording" && Date.now() - x.at < DICTATION_LIMIT_MS, level };
}

export async function stopRecording(): Promise<{ ms: number; mime: string; bytes: Uint8Array; peak: number; mic: string } | { error: string }> {
  const x = current;
  current = null;
  if (!x) return { error: "Nothing was recorded." };
  // The microphone is let go whatever happens: a recorder that never says it stopped mustn't keep it open.
  try {
    if (x.recorder.state !== "inactive") await new Promise<void>((done) => { x.recorder.onstop = () => done(); setTimeout(done, 4000); x.recorder.stop(); });
  } catch { /* released below */ }
  release(x);
  const mime = (x.recorder.mimeType || "audio/webm").split(";")[0];
  const bytes = new Uint8Array(await new Blob(x.chunks, { type: mime }).arrayBuffer());
  return { ms: Date.now() - x.at, mime, bytes, peak: x.peak, mic: x.mic };
}

export function cancelRecording() {
  const x = current;
  current = null;
  if (!x) return;
  try { if (x.recorder.state !== "inactive") x.recorder.stop(); } catch { /* released below */ }
  release(x);
}

/** Dictated words go at the end of what is in the box, after a space, as in the devbox console. */
export function appendWords(box: string, words: string) {
  const text = words.trim();
  if (!text) return box;
  return box && !/\s$/.test(box) ? `${box} ${text}` : box + text;
}
