// MediaPipe Audio Transcriber wrapper. DOM-free: the SDK is dynamically
// imported (or injected in tests) and every browser global is passed in
// through `deps`, so the pure parts are unit-testable without network.
//
// Verified facts (2026-11-18, official MediaPipe docs):
// - SDK @mediapipe/tasks-audio@1.2.3, bundle audio_bundle.mjs, WASM at
//   .../wasm/. API: FilesetResolver.forAudioTasks(wasmUrl),
//   AudioTranscriber.createFromOptions(fileset, { baseOptions:
//   { modelAssetPath, delegate }, sampleRateHz, enableInterimResults }),
//   prewarm(), transcribeStream(Float32Array) -> { text, segments },
//   finishStream(), transcribe(samples, endOfStream).
// - Model: NVIDIA Parakeet TDT 0.6B v3, INT8, ~615 MB, 25 European
//   languages, CC-BY-4.0 (credit NVIDIA in the UI/README).
// - Delegate: GPU by default on web, CPU fallback. The GPU delegate can
//   misbehave on iOS Safari (stickerify learned this with segmentation),
//   so CPU must remain a working fallback — create() retries on CPU
//   when GPU creation fails.

export const TASKS_AUDIO_VERSION = "1.2.3";
export const AUDIO_BUNDLE_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@${TASKS_AUDIO_VERSION}/audio_bundle.mjs`;
export const AUDIO_WASM_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@${TASKS_AUDIO_VERSION}/wasm`;
export const MODEL_URL =
  "https://huggingface.co/litert-community/parakeet-tdt-0.6b-v3/resolve/main/parakeet_tdt_0.6b_v3_5s_i8_stateful.litertlm";
export const MODEL_CACHE_NAME = "speaklog-v1";
export const MODEL_SIZE_MB = 615;

/**
 * Linear-interpolation resample of mono PCM to 16 kHz. The transcriber
 * is always created with sampleRateHz 16000, so callers resample first
 * (mic chunks at the AudioContext rate, decoded files at their native
 * rate). A 16 kHz input is returned unchanged.
 */
export function resampleTo16k(samples, fromRate) {
  if (fromRate === 16000) return samples;
  if (!fromRate || fromRate <= 0) throw new Error("Invalid sample rate");
  const ratio = fromRate / 16000;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[idx];
    const b = idx + 1 < samples.length ? samples[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Average channel arrays into one mono Float32Array. */
export function downmixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Download a blob with live progress, caching it so repeat visits skip
 * the download. Returns { blobUrl, cached, bytes, ms }.
 * onProgress(loaded, total) is called per chunk; (-1, -1) means a cache
 * hit (no download). deps: { fetchFn, cachesImpl } (defaults: globals).
 */
export async function downloadModelBlobWithProgress(url, onProgress, deps = {}) {
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const cachesImpl = deps.cachesImpl || globalThis.caches;
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const done = (blobUrl, cached, bytes) => ({
    blobUrl,
    cached,
    bytes,
    ms: (typeof performance !== "undefined" ? performance.now() : Date.now()) - started,
  });
  let cache = null;
  try { cache = cachesImpl ? await cachesImpl.open(MODEL_CACHE_NAME) : null; } catch { /* Cache API unavailable — download directly. */ }
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      onProgress(-1, -1); // cached: no download needed
      const blob = await hit.blob();
      return done(URL.createObjectURL(blob), true, blob.size);
    }
  }
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Model download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("Content-Length") || 0);
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const blob = new Blob(chunks);
  if (cache) { try { await cache.put(url, new Response(blob)); } catch { /* non-fatal */ } }
  return done(URL.createObjectURL(blob), false, blob.size);
}

/**
 * Load the model (cached after the first download) and create an
 * AudioTranscriber. Tries the requested delegate first, then CPU.
 * Returns { transcribeStream, finishStream, transcribeClip, close,
 * delegate, model }.
 * deps: { sdk, fetchFn, cachesImpl, modelUrl } — sdk is
 * { FilesetResolver, AudioTranscriber }; when omitted the CDN bundle is
 * dynamically imported (browser only).
 */
export async function createTranscriber({
  onProgress = () => {},
  delegate = "GPU",
  sampleRateHz = 16000,
  sdk = null,
  fetchFn,
  cachesImpl,
  modelUrl = MODEL_URL,
} = {}) {
  const dl = await downloadModelBlobWithProgress(modelUrl, onProgress, { fetchFn, cachesImpl });
  const { FilesetResolver, AudioTranscriber } = sdk || await import(AUDIO_BUNDLE_URL);
  const fileset = await FilesetResolver.forAudioTasks(AUDIO_WASM_URL);
  let transcriber = null;
  let usedDelegate = delegate;
  try {
    transcriber = await AudioTranscriber.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: dl.blobUrl, delegate },
      sampleRateHz,
      enableInterimResults: true,
    });
  } catch (err) {
    if (delegate === "CPU") throw err;
    // GPU creation failed (e.g. no WebGPU) — fall back to CPU.
    usedDelegate = "CPU";
    transcriber = await AudioTranscriber.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: dl.blobUrl, delegate: "CPU" },
      sampleRateHz,
      enableInterimResults: true,
    });
  }
  await transcriber.prewarm();
  return {
    delegate: usedDelegate,
    model: { cached: dl.cached, bytes: dl.bytes, ms: dl.ms },
    transcribeStream: (pcmChunk) => transcriber.transcribeStream(pcmChunk),
    finishStream: () => transcriber.finishStream(),
    transcribeClip: (samples) => transcriber.transcribe(samples, true),
    close: () => {
      if (typeof transcriber.close === "function") transcriber.close();
      URL.revokeObjectURL(dl.blobUrl);
    },
  };
}
