# Speaklog — agent notes

Static web app: speak to the browser, it records video and transcribes
live with on-device MediaPipe, saves both to IndexedDB, and downloads
video + transcript. No build step, no server, no dependencies to install —
plain ES modules served as static files.

## Hard rules

- **Video and audio never leave the device.** Recording, transcription,
  storage and downloads all happen in the browser. Never add an upload,
  a backend call, tracking, or analytics.
- **No identification.** The app transcribes speech only. Never add
  speaker identification or face recognition.
- **Transcription is never paywalled.** The engine is free and on-device;
  paid features (see `TODO-PAID.md`) charge for what surrounds it.
  Never put live transcription behind a paywall.

## Layout

| File | What it does |
| --- | --- |
| `index.html` | Page structure: record, live transcript, file transcribe, library, detail |
| `app.js` | UI + orchestration: MediaRecorder, worklet wiring, library, downloads, model status + Load model + Start gating |
| `transcriber.js` | MediaPipe wrapper: model download/progress/cache, GPU→CPU fallback, resampling, `isModelCached` (page-open status check) |
| `audio-processor.js` | AudioWorkletProcessor: buffers mic PCM, posts 3200-sample Float32 chunks |
| `storage.js` | IndexedDB wrapper: save/list/get/delete recordings, usage estimate |
| `srt.js` | Transcript formatting: plain text + SRT + VTT from segments |
| `captions.js` | Caption display/sync/burn-in: `formatClock`, `segmentAtTime`, `captionFont`, `wrapCaptionLines`, `burnCaptions` (canvas re-record) |
| `test/*.test.mjs` | Node unit tests, one per module |
| `spec.md` | Product spec (source of truth for scope) |
| `TODO-PAID.md` | Paid features — not built in v1 |

## Models (verified live)

- Runtime `@mediapipe/tasks-audio@1.2.3` via jsDelivr
  (`audio_bundle.mjs`, WASM at `.../wasm/`).
- Model: NVIDIA Parakeet TDT 0.6B v3, INT8, **~590 MB** (measured
  586.1 MB on first live download), 25 European languages, punctuated
  + capitalized output, CC-BY-4.0 (credit NVIDIA in the UI and README).
  First run downloads it with a progress bar and caches it in the
  Cache API (`speaklog-v1`).
- **GPU delegate by default on web, CPU fallback** — `createTranscriber`
  retries on CPU when GPU creation fails.
- Audio is always resampled to 16 kHz mono Float32 in JS before it
  reaches the model (`resampleTo16k` in `transcriber.js`); the
  transcriber is always created with `sampleRateHz: 16000`.

## How to test

```bash
node --check app.js && node --check transcriber.js && node --check audio-processor.js
node --check storage.js && node --check srt.js && node --check captions.js
for t in test/*.test.mjs; do node "$t"; done
```

Every change gets: unit tests first, then a live end-to-end check on
the deployed site (Vercel auto-deploys on push to `main`; the repo and
hosting are set up by the parent agent — this workspace is local-only
until then). CI runs the same checks on every push — a red run blocks
the change, it does not get "fixed later".

## Lessons already paid for

- **Errors must be visible.** The status/error lines live at the top
  of the page, outside any hidden section. Stickerify once hid a
  failure message inside a collapsed workbench and the user saw
  nothing at all — same bug class, fixed here by construction.
- **Test the real call shape.** A test once passed while the app was
  broken, because the test sorted bare defs while the app sorts
  `{def, rec}` wrappers. Tests here use the data shape the call site
  actually passes (real segment objects, the real
  `createFromOptions` options, a fake IndexedDB behind the real
  storage calls).
- **A fallback that is never live-tested is not a fallback.**
  Stickerify's CORS fix shipped with two proxy fallbacks that were
  both down the same day; it only worked once verified live. Same
  applies to the CPU delegate fallback here — verify it in E2E,
  don't just trust the code path.
- **Streaming results carry only the latest segment(s).** Each
  `transcribeStream()` result does not repeat the whole history, so
  replacing the finals list drops everything but the last sentence.
  Accumulate finals with `mergeFinalSegments` (keyed by
  `fromTimestampMs`, dedupes replays, later corrections overwrite).
  This applies to the SAVED transcript too: `stopRecording` merges the
  `finishStream()` result into the live-accumulated finals instead of
  trusting it alone, because whether `finishStream()` returns the full
  history or only the final chunk was never verified live (the cloud
  browser has no camera, so no camera recording has ever been
  end-to-end tested) — the merge is correct under either behaviour.
  An earlier version of this note claimed the saved transcript was
  never affected; that was an assumption, not a verified fact.
- **A live panel that re-renders wipes text selection.** The live
  transcript re-renders on every audio chunk, so selecting text in it
  never survives. Copy goes through the data model (Copy button +
  Clipboard API with a textarea fallback), not the selection; the
  transcript areas also carry explicit `user-select: text`.
- **Burn-in export runs in real time.** `burnCaptions` replays the
  video through a canvas and re-records it, so a 1-minute video takes
  about 1 minute; the UI says so and shows progress. Audio comes from
  the video element's own `captureStream()` — the element is not
  muted during export, so the user hears it playing (that is the
  feedback that it is working). Only video entries get the button;
  audio-only file entries cannot burn captions onto nothing.
- **Playback needs its own caption overlay.** The burn-in export
  alone does not put subtitles on the video you play in the app — the
  detail player wraps the video and overlays the active segment while
  it plays, styled by the same caption controls the export uses, so
  what you see on playback matches what the export burns in.
- **A segment without an end timestamp is not a gap.** The model
  does not always stamp `toTimestampMs`; `segmentAtTime` treats such
  a segment as running until the next one starts (5s grace for the
  last), otherwise the caption, the row highlight and the burn-in all
  silently show nothing for it.
