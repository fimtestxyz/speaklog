# Speaklog — spec (draft for discussion)

## What it is

A static web app. Open it in the browser, allow camera + mic, and speak.
The camera records video of you speaking while a live transcript appears
in real time. When you stop, the video and its transcript are saved in the
browser and can be downloaded (video file + transcript file).

Repo (proposed): `fimtestxyz/speaklog`, public, hosted on Vercel
(primary) + GitHub Pages (backup), same setup as stickerify.

## User flow (v1)

1. Open the app → camera preview, one big "Start recording" button.
2. Grant camera + mic (browser permission prompt).
3. Tap Start → video records; the transcript appears line by line next
   to / under the preview (interim words in grey, finalised words in
   normal text).
4. Tap Stop → the recording finalises; an entry appears in the library
   (title = date + time, duration, word count).
5. Open an entry → play the video with the transcript alongside.
6. Download → video file (`.webm`) + transcript (`.txt` and `.srt`).

## Features (v1)

- Camera + mic capture via `getUserMedia`, live preview.
- Video recording via `MediaRecorder` (webm, video + audio).
- Real-time transcription (engine: see Decisions).
- Live caption overlay on the preview + transcript panel.
- Save to IndexedDB: video blob + transcript + metadata. Survives reload.
- Library: newest first, play, delete, storage-used indicator.
- Download video (`.webm`) + transcript (`.txt`, `.srt` with timestamps).
- Desktop + mobile browsers. (Engine choice affects which browsers get
  live transcription — see Decisions.)

## Decisions (locked 2026-11-18)

### 1. Transcription engine — MediaPipe Audio Transcriber (locked)

On-device speech-to-text, streaming with interim results and
millisecond segment timestamps. Verified 2026-11-18 against the
official docs:

- Web SDK `@mediapipe/tasks-audio@1.2.3` — bundle
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.2.3/audio_bundle.mjs`,
  WASM at `.../wasm/`. API: `FilesetResolver.forAudioTasks`,
  `AudioTranscriber.createFromOptions`, `transcribeStream(pcmChunk)`,
  `finishStream()`, `enableInterimResults: true`, `prewarm()`.
- Model: NVIDIA Parakeet TDT 0.6B v3, INT8, **~590 MB**, 25 European
  languages, punctuated + capitalized output, CC-BY-4.0 (credit NVIDIA).
  File `parakeet_tdt_0.6b_v3_5s_i8_stateful.litertlm` at
  `https://huggingface.co/litert-community/parakeet-tdt-0.6b-v3/resolve/main/parakeet_tdt_0.6b_v3_5s_i8_stateful.litertlm`
  (verified to resolve; first run downloads it with a progress bar and
  caches it in the Cache API, same pattern as stickerify's model).
- Input: 16 kHz mono Float32 PCM (mic via AudioWorklet; other rates
  are resampled by the task). Delegate: GPU by default on web, CPU
  fallback — test both; stickerify learned the GPU delegate can
  misbehave on iOS Safari, so CPU must remain a working fallback.
- **Primary language: English.** The model covers 25 European
  languages; Mandarin is not supported. Non-European languages are
  out of scope for v1.
- Web Speech API and cloud APIs are NOT used in v1. Audio never
  leaves the device — this is the product's privacy story and the
  reason transcription itself stays free forever (see TODO-PAID.md).

### 2. Name

`speaklog`. Repo `fimtestxyz/speaklog` (public).

### 3. Hosting

Vercel + GitHub Pages, like stickerify. Static only — no backend server.

## Free features (v1 — build and verify first)

- Camera + mic capture via `getUserMedia`, live preview.
- Video recording via `MediaRecorder` (webm, video + audio).
- Real-time transcription via MediaPipe (above): live caption overlay
  on the preview + transcript panel (interim grey, final normal).
- Save to IndexedDB: video blob + transcript segments + metadata.
  Survives reload.
- Library: newest first, play, delete, storage-used indicator.
- Download video (`.webm`) + transcript (`.txt` and `.srt` — both free;
  `.vtt` and burned-in captions are Pro, see TODO-PAID.md).
- **Transcribe an existing audio/video file** (clip mode,
  `transcriber.transcribe()`): same engine, no camera needed. Small
  addition, and it is the end-to-end test path for real speech.
- Desktop + mobile browsers (Chrome/Edge best; Safari/Firefox need
  WebGPU or CPU fallback for the model — verify in E2E).

## Paid features

Not built in v1. The list lives in `TODO-PAID.md` (Pro tier, AI summary,
transcript editing, search, VTT + burned-in captions, cloud backup).
Transcription itself is never paywalled.

## Privacy

- Video and audio never leave the device: recorded, transcribed
  on-device (MediaPipe), stored (IndexedDB), and downloaded locally.
  No account, no upload, no tracking. The only network traffic is
  downloading the app files and the transcription model on first run.

## Acceptance criteria (v1 is done when…)

- Start → camera preview live, recording indicator on, transcript
  updates within ~1s of speaking.
- Stop → entry saved, appears in the library, plays back with sound.
- Download → the `.webm` plays in a standard player; the `.txt`
  matches the on-screen transcript; the `.srt` timestamps line up with
  the video.
- Reload the page → library entries are still there.
- No video/audio is uploaded anywhere.
- All checks green in CI; live end-to-end test on Vercel before calling
  it done.

## Out of scope (v1)

- Speaker diarization ("who said what"), editing the transcript,
  searching across recordings, cloud sync / accounts, share links,
  captions burned into the video file, summarising the transcript.
  (Transcript summarising is a natural v2 — it fits the thought-ledger
  habit of condensing what was said.)
