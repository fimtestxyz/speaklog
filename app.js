// Speaklog — UI + orchestration. Static, no backend, no tracking.
// Camera + mic -> MediaRecorder (webm) + live MediaPipe transcription.
// Recordings are saved to IndexedDB and downloadable with transcripts.
//
// Error UI rule (learned from stickerify): the status/error lines live
// at the top of the page, outside any hidden section, so a failure is
// always visible — never silent, never hidden behind a collapsed panel.

import { createTranscriber, resampleTo16k, downmixToMono, MODEL_SIZE_MB } from "./transcriber.js";
import {
  saveRecording, listRecordings, getRecording, deleteRecording,
  estimateUsage, formatTitle, formatDuration,
} from "./storage.js";
import { segmentsToText, segmentsToSrt, finalSegments, wordCount } from "./srt.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const errorEl = $("error");
const progressBox = $("model-progress");
const progressLabel = $("model-progress-label");
const progressBar = $("model-progress-bar");
const progressText = $("model-progress-text");
const previewEl = $("preview");
const captionEl = $("caption-overlay");
const liveEl = $("live-transcript");
const startBtn = $("btn-start");
const stopBtn = $("btn-stop");
const recIndicator = $("rec-indicator");
const recTime = $("rec-time");

function setStatus(msg) { statusEl.textContent = msg; }
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  console.error(msg);
}
function clearError() { errorEl.textContent = ""; errorEl.hidden = true; }

function fmtMB(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function showProgress(label, loaded, total) {
  progressBox.hidden = false;
  progressLabel.textContent = label;
  if (total > 0) {
    progressBar.max = 100;
    progressBar.value = Math.round((loaded / total) * 100);
    progressText.textContent = `${Math.round((loaded / total) * 100)}% · ${fmtMB(loaded)} / ${fmtMB(total)}`;
  } else if (loaded > 0) {
    progressBar.removeAttribute("value");
    progressText.textContent = fmtMB(loaded);
  } else {
    progressBar.removeAttribute("value");
    progressText.textContent = "";
  }
}
function hideProgress() { progressBox.hidden = true; }

// ---------------------------------------------------------------------------
// Transcriber lifecycle (one instance, sampleRateHz 16000; all audio is
// resampled to 16 kHz before it reaches the model).
// ---------------------------------------------------------------------------
let transcriber = null;
let transcriberReady = null;

function ensureTranscriber() {
  if (transcriber) return Promise.resolve(transcriber);
  if (transcriberReady) return transcriberReady;
  transcriberReady = (async () => {
    showProgress(`First run downloads the ~${MODEL_SIZE_MB} MB transcription model once, then it is cached.`, 0, 0);
    try {
      transcriber = await createTranscriber({
        delegate: "GPU",
        sampleRateHz: 16000,
        onProgress: (loaded, total) => {
          if (loaded === -1) {
            showProgress("Transcription model cached — loading…", 0, 0);
          } else {
            showProgress("Downloading transcription model…", loaded, total);
          }
        },
      });
    } finally {
      hideProgress();
    }
    setStatus(`Transcription ready (${transcriber.delegate} delegate).`);
    return transcriber;
  })().catch((err) => {
    transcriberReady = null;
    throw err;
  });
  return transcriberReady;
}

// ---------------------------------------------------------------------------
// Live recording
// ---------------------------------------------------------------------------
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let audioCtx = null;
let workletNode = null;
let recordingStartMs = 0;
let recTimer = null;
let liveFinals = [];
let liveInterim = null;
let streamChain = Promise.resolve();
let streamErrorShown = false;

function pickMimeType() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
}

function renderLive() {
  liveEl.innerHTML = "";
  if (!liveFinals.length && !liveInterim) {
    liveEl.innerHTML = `<p class="muted">Speak — the transcript appears here as you talk.</p>`;
  }
  for (const seg of liveFinals) {
    const p = document.createElement("p");
    p.textContent = seg.transcript;
    liveEl.appendChild(p);
  }
  if (liveInterim) {
    const p = document.createElement("p");
    p.className = "interim";
    p.textContent = liveInterim.transcript;
    liveEl.appendChild(p);
  }
  const latest = liveInterim?.transcript
    || (liveFinals.length ? liveFinals[liveFinals.length - 1].transcript : "");
  captionEl.textContent = latest;
  captionEl.hidden = !latest;
  liveEl.scrollTop = liveEl.scrollHeight;
}

function updateLive(segments) {
  liveFinals = (segments || []).filter((s) => s.isFinal);
  liveInterim = (segments || []).filter((s) => !s.isFinal).pop() || null;
  renderLive();
}

async function handleChunk(chunk) {
  if (!transcriber) return;
  try {
    const res = await transcriber.transcribeStream(resampleTo16k(chunk, audioCtx.sampleRate));
    updateLive(res.segments || []);
  } catch (err) {
    console.warn("transcribeStream failed:", err);
    if (!streamErrorShown) {
      streamErrorShown = true;
      showError("Live transcription hit an error — the video keeps recording. Details in the console.");
    }
  }
}

async function startRecording() {
  clearError();
  if (!window.MediaRecorder) {
    showError("This browser cannot record video (MediaRecorder is not supported). Try Chrome or Edge.");
    return;
  }
  startBtn.disabled = true;
  setStatus("Requesting camera and microphone…");
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    startBtn.disabled = false;
    showError("Camera/microphone access was denied or unavailable. Allow access and try again.");
    console.warn(err);
    return;
  }
  previewEl.srcObject = mediaStream;
  try {
    await previewEl.play();
  } catch { /* autoplay of a muted preview is best-effort */ }

  setStatus("Loading transcription model…");
  try {
    await ensureTranscriber();
  } catch (err) {
    startBtn.disabled = false;
    stopMediaTracks();
    showError(`Could not load the transcription model: ${err?.message || err}. Check your connection and try again.`);
    return;
  }

  // Mic PCM via AudioWorklet. The node feeds a zero-gain sink so the
  // audio graph is pulled without audible feedback.
  audioCtx = new AudioContext({ sampleRate: 16000 });
  await audioCtx.resume();
  await audioCtx.audioWorklet.addModule("audio-processor.js");
  const source = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, "speaklog-capture");
  const sink = audioCtx.createGain();
  sink.gain.value = 0;
  source.connect(workletNode);
  workletNode.connect(sink);
  sink.connect(audioCtx.destination);
  let drainResolve;
  const drained = new Promise((resolve) => { drainResolve = resolve; });
  streamChain = Promise.resolve();
  streamErrorShown = false;
  workletNode.port.onmessage = (event) => {
    const data = event.data;
    if (data instanceof Float32Array) {
      streamChain = streamChain.then(() => handleChunk(data));
    } else if (data && data.type === "flushed") {
      drainResolve();
    }
  };

  recordedChunks = [];
  const mimeType = pickMimeType();
  mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
  const recorderStopped = new Promise((resolve) => { mediaRecorder.onstop = resolve; });
  mediaRecorder.start(500);

  liveFinals = [];
  liveInterim = null;
  renderLive();
  recordingStartMs = Date.now();
  recIndicator.hidden = false;
  recTimer = setInterval(() => { recTime.textContent = formatDuration(Date.now() - recordingStartMs); }, 500);
  stopBtn.disabled = false;
  setStatus("Recording — speak, and the transcript appears live.");
  $("btn-stop").focus();

  // Stash the stop promise so stopRecording can await the recorder.
  mediaRecorder._stopped = recorderStopped;
  mediaRecorder._drained = drained;
}

function stopMediaTracks() {
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  previewEl.srcObject = null;
}

async function stopRecording() {
  stopBtn.disabled = true;
  clearInterval(recTimer);
  setStatus("Finishing up…");
  try {
    workletNode?.port.postMessage({ type: "flush" });
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    await mediaRecorder?._drained;
    await streamChain;
    await mediaRecorder?._stopped; // onstop: final dataavailable has landed
    const videoBlob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || "video/webm" });
    const durationMs = Date.now() - recordingStartMs;

    let segments = [];
    try {
      const fin = await transcriber.finishStream();
      segments = finalSegments(fin.segments || []);
    } catch (err) {
      console.warn("finishStream failed:", err);
      segments = liveFinals;
    }
    const text = segmentsToText(segments);

    const id = await saveRecording({
      title: formatTitle(new Date()),
      durationMs,
      kind: "camera",
      mediaBlob: videoBlob,
      segments,
      text,
    });
    stopMediaTracks();
    if (audioCtx) { await audioCtx.close().catch(() => {}); audioCtx = null; }
    workletNode = null;
    recIndicator.hidden = true;
    recTime.textContent = "";
    liveFinals = [];
    liveInterim = null;
    renderLive();
    captionEl.hidden = true;
    startBtn.disabled = false;
    if (!text) {
      setStatus("Saved, but no speech was detected — try speaking closer to the mic.");
    } else {
      setStatus(`Saved — ${wordCount(text)} words transcribed.`);
    }
    await refreshLibrary();
    await openDetail(id);
  } catch (err) {
    console.error(err);
    showError(`Could not save the recording: ${err?.message || err}`);
    startBtn.disabled = false;
  }
}

startBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);

// ---------------------------------------------------------------------------
// Transcribe an existing file (clip mode, same engine, no camera)
// ---------------------------------------------------------------------------
const fileInput = $("file-input");
const transcribeFileBtn = $("btn-transcribe-file");
let detailUrl = null;

fileInput.addEventListener("change", () => {
  transcribeFileBtn.disabled = !fileInput.files.length;
});

transcribeFileBtn.addEventListener("click", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  clearError();
  transcribeFileBtn.disabled = true;
  setStatus("Loading transcription model…");
  try {
    await ensureTranscriber();
  } catch (err) {
    transcribeFileBtn.disabled = false;
    showError(`Could not load the transcription model: ${err?.message || err}. Check your connection and try again.`);
    return;
  }
  setStatus("Transcribing file… (on-device; long files take a while.)");
  try {
    const decodeCtx = new AudioContext();
    const buf = await decodeCtx.decodeAudioData(await file.arrayBuffer());
    const channels = [];
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
    const mono = resampleTo16k(downmixToMono(channels), buf.sampleRate);
    const res = await transcriber.transcribeClip(mono);
    await decodeCtx.close();
    const segments = finalSegments(res.segments || []);
    const text = segmentsToText(segments);
    const id = await saveRecording({
      title: formatTitle(new Date()),
      durationMs: Math.round(buf.duration * 1000),
      kind: "file",
      mediaBlob: file,
      segments,
      text,
      fileName: file.name,
    });
    fileInput.value = "";
    transcribeFileBtn.disabled = true;
    if (!text) {
      setStatus("Transcribed, but no speech was detected in this file.");
    } else {
      setStatus(`Transcribed — ${wordCount(text)} words.`);
    }
    await refreshLibrary();
    await openDetail(id);
  } catch (err) {
    console.error(err);
    showError(`Could not transcribe that file: ${err?.message || err}`);
    transcribeFileBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Library + detail
// ---------------------------------------------------------------------------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function slugTitle(title) {
  return title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function refreshLibrary() {
  const list = $("library-list");
  let entries;
  try {
    entries = await listRecordings();
  } catch (err) {
    showError(`Could not load the library: ${err?.message || err}`);
    return;
  }
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `<p class="muted">No recordings yet. Record one above, or transcribe a file.</p>`;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "entry-row";
    const words = wordCount(entry.text || "");
    row.innerHTML = `
      <button type="button" class="entry-open" data-id="${entry.id}">
        <span class="entry-title">${escapeHtml(entry.title)}</span>
        <span class="entry-meta">${entry.kind === "file" ? "file" : "camera"} · ${formatDuration(entry.durationMs)} · ${words} words</span>
      </button>
      <button type="button" class="danger entry-delete" data-id="${entry.id}">Delete</button>`;
    list.appendChild(row);
  }
  const usage = await estimateUsage();
  $("storage-info").textContent = usage
    ? `Using about ${usage.usedMB.toFixed(1)} MB of browser storage.`
    : "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("library-list").addEventListener("click", async (e) => {
  const openBtn = e.target.closest(".entry-open");
  const delBtn = e.target.closest(".entry-delete");
  if (openBtn) await openDetail(Number(openBtn.dataset.id));
  if (delBtn) {
    const id = Number(delBtn.dataset.id);
    if (confirm("Delete this recording? The video and transcript are gone for good.")) {
      await deleteRecording(id);
      if (Number($("detail").dataset.id) === id) $("detail").hidden = true;
      await refreshLibrary();
      setStatus("Recording deleted.");
    }
  }
});

async function openDetail(id) {
  const entry = await getRecording(id);
  if (!entry) return;
  const detail = $("detail");
  detail.dataset.id = String(entry.id);
  detail.hidden = false;
  $("detail-title").textContent = entry.title;
  const player = $("detail-player");
  const audio = $("detail-audio");
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = URL.createObjectURL(entry.mediaBlob);
  const url = detailUrl;
  if (entry.kind === "camera") {
    player.hidden = false;
    audio.hidden = true;
    player.src = url;
    $("dl-video").hidden = false;
  } else {
    player.hidden = true;
    audio.hidden = false;
    audio.src = url;
    $("dl-video").hidden = true;
  }
  $("detail-transcript").textContent = entry.text || "No speech was detected in this recording.";
  $("detail-meta").textContent =
    `${entry.kind === "file" ? "File" : "Camera"} · ${formatDuration(entry.durationMs)} · ${wordCount(entry.text || "")} words`;
  const slug = slugTitle(entry.title);
  $("dl-video").onclick = () => downloadBlob(entry.mediaBlob, `speaklog-${slug}.webm`);
  $("dl-txt").onclick = () => downloadBlob(
    new Blob([entry.text || ""], { type: "text/plain" }), `speaklog-${slug}.txt`);
  $("dl-srt").onclick = () => downloadBlob(
    new Blob([segmentsToSrt(entry.segments || [])], { type: "text/plain" }), `speaklog-${slug}.srt`);
  $("btn-delete-detail").onclick = async () => {
    if (confirm("Delete this recording? The video and transcript are gone for good.")) {
      await deleteRecording(entry.id);
      detail.hidden = true;
      await refreshLibrary();
      setStatus("Recording deleted.");
    }
  };
  detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("btn-back").addEventListener("click", () => { $("detail").hidden = true; });

renderLive();
refreshLibrary();
