// Node tests for transcriber.js. URL building, the model download with
// progress (through stubs — no network), and the createFromOptions call
// shape incl. the GPU -> CPU fallback. Run: node test/transcriber.test.mjs
import assert from "node:assert";
import {
  AUDIO_BUNDLE_URL, AUDIO_WASM_URL, MODEL_URL, MODEL_CACHE_NAME,
  downloadModelBlobWithProgress, createTranscriber,
  resampleTo16k, downmixToMono,
} from "../transcriber.js";

// URLs: the exact bundle, WASM dir and model file the docs name.
assert.equal(
  AUDIO_BUNDLE_URL,
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.2.3/audio_bundle.mjs",
);
assert.equal(
  AUDIO_WASM_URL,
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.2.3/wasm",
);
assert.equal(
  MODEL_URL,
  "https://huggingface.co/litert-community/parakeet-tdt-0.6b-v3/resolve/main/parakeet_tdt_0.6b_v3_5s_i8_stateful.litertlm",
);
assert.equal(MODEL_CACHE_NAME, "speaklog-v1");

// --- Stubs -----------------------------------------------------------------
function stubCache(initial = new Map()) {
  const store = initial;
  return {
    store,
    match: async (url) => store.get(url) || null,
    put: async (url, res) => { store.set(url, res); },
  };
}
function stubCaches(cache) {
  return { open: async (name) => { assert.equal(name, MODEL_CACHE_NAME); return cache; } };
}
function stubFetch(chunks, { ok = true, status = 200, total = null } = {}) {
  const bytes = chunks.reduce((n, c) => n + c.length, 0);
  return async (url) => ({
    ok,
    status,
    headers: { get: (name) => (name === "Content-Length" ? String(total ?? bytes) : null) },
    body: {
      getReader() {
        let i = 0;
        return {
          read: async () => (i < chunks.length
            ? { done: false, value: chunks[i++] }
            : { done: true, value: undefined }),
        };
      },
    },
  });
}

// --- downloadModelBlobWithProgress ------------------------------------------
{
  // Cache hit: fetch is never called, progress is (-1, -1).
  let fetched = false;
  const cache = stubCache(new Map([[
    MODEL_URL, { blob: async () => new Blob([new Uint8Array([1, 2, 3, 4, 5])]) },
  ]]));
  const progress = [];
  const dl = await downloadModelBlobWithProgress(
    MODEL_URL, (l, t) => progress.push([l, t]),
    { fetchFn: async () => { fetched = true; throw new Error("must not fetch"); }, cachesImpl: stubCaches(cache) },
  );
  assert.equal(dl.cached, true);
  assert.equal(dl.bytes, 5);
  assert.equal(fetched, false);
  assert.deepEqual(progress, [[-1, -1]]);
  assert.ok(dl.blobUrl.startsWith("blob:"));
}

{
  // Download: progress per chunk, blob assembled, put into the cache.
  const cache = stubCache();
  const progress = [];
  const dl = await downloadModelBlobWithProgress(
    MODEL_URL, (l, t) => progress.push([l, t]),
    { fetchFn: stubFetch([new Uint8Array([1, 2, 3]), new Uint8Array(7)]), cachesImpl: stubCaches(cache) },
  );
  assert.equal(dl.cached, false);
  assert.equal(dl.bytes, 10);
  assert.deepEqual(progress, [[3, 10], [10, 10]]);
  assert.ok(cache.store.has(MODEL_URL));
}

{
  // HTTP error surfaces.
  await assert.rejects(
    downloadModelBlobWithProgress(MODEL_URL, () => {}, { fetchFn: stubFetch([], { ok: false, status: 404 }), cachesImpl: stubCaches(stubCache()) }),
    /HTTP 404/,
  );
}

{
  // A failing cache.put is non-fatal: the download still returns.
  const cache = stubCache();
  cache.put = async () => { throw new Error("quota"); };
  const dl = await downloadModelBlobWithProgress(
    MODEL_URL, () => {},
    { fetchFn: stubFetch([new Uint8Array([9])]), cachesImpl: stubCaches(cache) },
  );
  assert.equal(dl.bytes, 1);
}

// --- createTranscriber (fake SDK, real call shape) ---------------------------
function fakeSdk({ failGpu = false } = {}) {
  const calls = { forAudioTasks: [], create: [], prewarm: 0, stream: [], finish: 0, clip: [], closed: 0 };
  const fakeTranscriber = {
    prewarm: async () => { calls.prewarm += 1; },
    transcribeStream: async (chunk) => {
      calls.stream.push(chunk);
      return { text: "hello", segments: [{ transcript: "hello", isFinal: true, fromTimestampMs: 0, toTimestampMs: 500 }] };
    },
    finishStream: async () => {
      calls.finish += 1;
      return { text: "hello world", segments: [{ transcript: "hello world", isFinal: true, fromTimestampMs: 0, toTimestampMs: 1000 }] };
    },
    transcribe: async (samples, endOfStream) => {
      calls.clip.push([samples, endOfStream]);
      return { text: "clip", segments: [{ transcript: "clip", isFinal: true, fromTimestampMs: 0, toTimestampMs: 800 }] };
    },
    close: () => { calls.closed += 1; },
  };
  return {
    calls,
    sdk: {
      FilesetResolver: {
        forAudioTasks: async (wasmUrl) => { calls.forAudioTasks.push(wasmUrl); return { fileset: true }; },
      },
      AudioTranscriber: {
        createFromOptions: async (fileset, options) => {
          calls.create.push([fileset, options]);
          if (failGpu && options.baseOptions.delegate === "GPU") throw new Error("GPU unavailable");
          return fakeTranscriber;
        },
      },
    },
  };
}

{
  // GPU requested, GPU creation fails -> retried on CPU, prewarm called.
  const { calls, sdk } = fakeSdk({ failGpu: true });
  const cache = stubCache();
  const t = await createTranscriber({
    delegate: "GPU", sampleRateHz: 16000, sdk,
    fetchFn: stubFetch([new Uint8Array([1])]), cachesImpl: stubCaches(cache),
  });
  assert.equal(t.delegate, "CPU");
  assert.equal(calls.forAudioTasks.length, 1);
  assert.equal(calls.forAudioTasks[0], AUDIO_WASM_URL);
  assert.equal(calls.create.length, 2);
  assert.equal(calls.create[0][1].baseOptions.delegate, "GPU");
  assert.equal(calls.create[1][1].baseOptions.delegate, "CPU");
  assert.equal(calls.create[1][1].sampleRateHz, 16000);
  assert.equal(calls.create[1][1].enableInterimResults, true);
  assert.ok(calls.create[1][1].baseOptions.modelAssetPath.startsWith("blob:"));
  assert.equal(calls.prewarm, 1);

  // Stream + clip use the real call shape.
  const chunk = new Float32Array([0.1, -0.2, 0.3]);
  const res = await t.transcribeStream(chunk);
  assert.equal(calls.stream[0], chunk);
  assert.equal(res.segments[0].transcript, "hello");
  const fin = await t.finishStream();
  assert.equal(calls.finish, 1);
  assert.equal(fin.text, "hello world");
  const clipSamples = new Float32Array([0.5, 0.5]);
  await t.transcribeClip(clipSamples);
  assert.equal(calls.clip[0][0], clipSamples);
  assert.equal(calls.clip[0][1], true); // endOfStream = true
  t.close();
  assert.equal(calls.closed, 1);
}

{
  // GPU works: no CPU retry.
  const { calls, sdk } = fakeSdk({ failGpu: false });
  const t = await createTranscriber({
    delegate: "GPU", sdk,
    fetchFn: stubFetch([new Uint8Array([1])]), cachesImpl: stubCaches(stubCache()),
  });
  assert.equal(t.delegate, "GPU");
  assert.equal(calls.create.length, 1);
}

console.log("transcriber tests passed");

// --- resampleTo16k / downmixToMono -------------------------------------------
{
  // 16 kHz input passes through unchanged.
  const samples = new Float32Array([0.1, 0.2, 0.3]);
  assert.equal(resampleTo16k(samples, 16000), samples);
}

{
  // 48 kHz -> 16 kHz: a constant signal stays constant, length is 1/3.
  const samples = new Float32Array(4800).fill(0.5);
  const out = resampleTo16k(samples, 48000);
  assert.equal(out.length, 1600);
  assert.ok(out.every((v) => v === 0.5));
}

{
  // 48 kHz sine at 1 kHz survives the resample: still ~1 kHz, same length.
  const rate = 48000;
  const samples = new Float32Array(rate);
  for (let i = 0; i < rate; i++) samples[i] = Math.sin((2 * Math.PI * 1000 * i) / rate);
  const out = resampleTo16k(samples, rate);
  assert.equal(out.length, 16000);
  // Zero crossings: ~2000 per second for a 1 kHz sine.
  let crossings = 0;
  for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 !== out[i] < 0) crossings++;
  assert.ok(crossings > 1800 && crossings < 2200, `crossings=${crossings}`);
}

{
  // 8 kHz -> 16 kHz upsamples 2x.
  const out = resampleTo16k(new Float32Array([0, 1, 0, -1]), 8000);
  assert.equal(out.length, 8);
  assert.ok(Math.abs(out[1] - 0.5) < 1e-6);
}

assert.throws(() => resampleTo16k(new Float32Array([1]), 0), /Invalid sample rate/);

{
  const mono = downmixToMono([new Float32Array([1, 2]), new Float32Array([3, 4])]);
  assert.deepEqual([...mono], [2, 3]);
  const single = new Float32Array([5]);
  assert.equal(downmixToMono([single]), single);
}

console.log("resample tests passed");
