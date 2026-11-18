# 🎙️ Speaklog

Speak to your browser. It records video of you speaking and transcribes
you live — on your device, nothing uploaded.

Open the app, allow camera + mic, hit **Start recording**. The transcript
appears as you talk (grey = still forming, normal = final). Hit **Stop**
and the recording is saved in the library with its transcript. Download
the video (`.webm`) and the transcript (`.txt` and `.srt`).

You can also transcribe an existing audio or video file — same engine,
no camera needed.

## Privacy

Video and audio never leave your device. Recording, transcription,
storage (IndexedDB) and downloads all happen in the browser. No account,
no upload, no tracking.

## How it works

- Video: `MediaRecorder` (webm, video + audio).
- Transcription: [MediaPipe Audio Transcriber](https://developers.google.com/edge/mediapipe/solutions/audio/audio_transcriber)
  running on-device — NVIDIA's Parakeet TDT 0.6B v3 model (INT8,
  ~590 MB, 25 European languages, CC-BY-4.0 — credit to NVIDIA). The
  model downloads once on first run (with a progress bar) and is cached
  in the browser; afterwards it works offline. Streaming mode with
  interim results and millisecond segment timestamps, which is what the
  `.srt` export is built from.
- Mic audio reaches the model as 16 kHz mono Float32 PCM via an
  `AudioWorklet` (see `audio-processor.js`).

## Run it locally

No build step — serve the folder as static files (module scripts need
`http(s)`, a `file://` open won't load them):

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Tests

```bash
node --check app.js && node --check transcriber.js && node --check audio-processor.js
node --check storage.js && node --check srt.js
for t in test/*.test.mjs; do node "$t"; done
```

## Paid features

Not in v1. The list lives in `TODO-PAID.md` (Pro tier, AI summary,
transcript editing, search, VTT + burned-in captions, cloud backup).
Transcription itself is never paywalled.
