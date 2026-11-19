// Speaklog — UI + orchestration. Static, no backend, no tracking.
// Camera + mic -> MediaRecorder (webm) + live MediaPipe transcription.
// Recordings are saved to IndexedDB and downloadable with transcripts.
//
// Error UI rule (learned from stickerify): the status/error lines live
// at the top of the page, outside any hidden section, so a failure is
// always visible — never silent, never hidden behind a collapsed panel.

import { createTranscriber, isModelCached, resampleTo16k, downmixToMono, MODEL_SIZE_MB } from "./transcriber.js";
import {
  saveRecording, listRecordings, getRecording, deleteRecording,
  estimateUsage, formatTitle, formatDuration,
} from "./storage.js";
import { segmentsToText, segmentsToSrt, segmentsToVtt, finalSegments, wordCount, mergeFinalSegments } from "./srt.js";
import { segmentAtTime, formatClock, captionFont, burnCaptions } from "./captions.js";

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

// Model status on page open: Start recording stays disabled until the
// model is loaded and ready — the user loads it explicitly with the
// Load model button (first run downloads ~590 MB once, then it is
// cached; later runs only initialise from the cache).
function setModelReadyState() {
  const status = $("model-status");
  status.textContent = `Transcription model ready ✓ (${transcriber?.delegate || "CPU"} delegate).`;
  status.classList.add("ready");
  $("btn-load-model").hidden = true;
  startBtn.disabled = false;
  setStatus(`Transcription ready (${transcriber?.delegate || "CPU"} delegate).`);
}

async function refreshModelStatus() {
  const status = $("model-status");
  const loadBtn = $("btn-load-model");
  if (transcriber) { setModelReadyState(); return; }
  status.textContent = "Checking transcription model…";
  let cached = false;
  try { cached = await isModelCached(); } catch { cached = false; }
  if (transcriber) { setModelReadyState(); return; } // loaded meanwhile
  if (cached) {
    status.textContent = `Transcription model downloaded ✓ (cached, ~${MODEL_SIZE_MB} MB) — tap Load model to get it ready.`;
    loadBtn.textContent = "Load model (already downloaded)";
  } else {
    status.textContent = `Transcription model not downloaded yet (~${MODEL_SIZE_MB} MB) — tap Load model to download it once; it stays cached in this browser.`;
    loadBtn.textContent = "Load transcription model";
  }
  loadBtn.hidden = false;
  startBtn.disabled = true;
}

$("btn-load-model").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  clearError();
  try {
    await ensureTranscriber();
    // setModelReadyState runs inside ensureTranscriber.
  } catch (err) {
    showError(`Could not load the transcription model: ${err?.message || err}. Check your connection and try again.`);
    btn.disabled = false;
  }
});

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
    setModelReadyState();
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
    if (typeof seg.fromTimestampMs === "number") {
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = `[${formatClock(seg.fromTimestampMs)}] `;
      p.appendChild(ts);
    }
    p.appendChild(document.createTextNode(seg.transcript));
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
  // Each transcribeStream() result carries only the latest segment(s),
  // so finals accumulate across results — replacing the list would drop
  // everything but the last sentence.
  liveFinals = mergeFinalSegments(liveFinals, (segments || []).filter((s) => s.isFinal));
  const interim = (segments || []).filter((s) => !s.isFinal).pop() || null;
  // An interim hypothesis for a segment that just finalised must not
  // render twice.
  liveInterim = interim && typeof interim.fromTimestampMs === "number"
    && liveFinals.some((f) => f.fromTimestampMs === interim.fromTimestampMs)
    ? null : interim;
  renderLive();
}

// Copy helper: the live panel re-renders as words arrive, which wipes
// any text selection, so copying goes through the data model, not the
// selection. Falls back to a hidden textarea where the Clipboard API
// is unavailable.
async function copyText(text, button) {
  const label = button.textContent;
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    ok = true;
  } catch (err) {
    console.warn("copy failed:", err);
  }
  button.textContent = ok ? "Copied ✓" : "Copy failed";
  setTimeout(() => { button.textContent = label; }, 2000);
  return ok;
}

$("btn-copy-live").addEventListener("click", (e) => {
  const text = segmentsToText(liveFinals);
  if (!text) {
    setStatus("Nothing to copy yet — the transcript is empty.");
    return;
  }
  copyText(text, e.currentTarget);
});

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
      // finishStream() may return only the final chunk, not the whole
      // history — the same trap the live panel hit — so merge it into
      // the finals accumulated live. Merging dedupes by start
      // timestamp, so a full-history result is safe too; either way
      // the saved recording keeps the complete transcript.
      segments = mergeFinalSegments(liveFinals, finalSegments(fin.segments || []));
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

// Synced playback in the detail view: the row spoken at the current
// playback time is highlighted and scrolled into view; tapping a row
// seeks the media to it.
let detailMedia = null;
let detailSegments = [];
let lastActiveFrom = -1;
const detailCaptionEl = $("detail-caption-overlay");

function detailCaptionStyle() {
  return {
    font: $("cap-font").value,
    size: $("cap-size").value,
    color: $("cap-color").value,
    position: $("cap-position").value,
  };
}

// Subtitles on the saved video itself while it plays in the app —
// the burn-in export alone does not put captions on in-app playback,
// so the detail player overlays the active segment, styled by the
// same caption controls the export uses.
function updateDetailCaption(timeMs) {
  if (!detailMedia || detailMedia.tagName !== "VIDEO") { detailCaptionEl.hidden = true; return; }
  const seg = segmentAtTime(detailSegments, timeMs);
  if (!seg) { detailCaptionEl.hidden = true; return; }
  const style = detailCaptionStyle();
  detailCaptionEl.style.font = captionFont(style, detailMedia.videoHeight || 720);
  detailCaptionEl.style.color = style.color || "#ffffff";
  if (style.position === "top") {
    detailCaptionEl.style.top = "12px";
    detailCaptionEl.style.bottom = "auto";
  } else {
    detailCaptionEl.style.top = "auto";
    detailCaptionEl.style.bottom = "12px";
  }
  detailCaptionEl.textContent = seg.transcript;
  detailCaptionEl.hidden = false;
}

function highlightSegment(timeMs) {
  updateDetailCaption(timeMs);
  const rows = $("detail-transcript").querySelectorAll(".seg-row");
  if (!rows.length) return;
  const active = segmentAtTime(detailSegments, timeMs);
  const from = active ? (active.fromTimestampMs ?? -1) : -1;
  if (from === lastActiveFrom) return;
  lastActiveFrom = from;
  for (const row of rows) {
    const isActive = from !== -1 && Number(row.dataset.from) === from;
    row.classList.toggle("active", isActive);
    if (isActive) row.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

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
  // A file entry can itself be a video (the file input accepts
  // video/*), so video-ness comes from the media type, not the kind.
  const isVideo = entry.kind === "camera"
    || (entry.mediaBlob && entry.mediaBlob.type && entry.mediaBlob.type.startsWith("video/"));
  if (isVideo) {
    $("detail-player-wrap").hidden = false;
    audio.hidden = true;
    player.src = url;
    detailMedia = player;
  } else {
    $("detail-player-wrap").hidden = true;
    audio.hidden = false;
    audio.src = url;
    detailMedia = audio;
  }
  $("dl-video").hidden = entry.kind !== "camera";
  $("dl-video-hint").hidden = entry.kind !== "camera";
  detailSegments = entry.segments || [];
  lastActiveFrom = -1;
  detailMedia.ontimeupdate = () => highlightSegment(detailMedia.currentTime * 1000);
  detailMedia.onseeked = () => highlightSegment(detailMedia.currentTime * 1000);

  const transcriptEl = $("detail-transcript");
  transcriptEl.innerHTML = "";
  if (!detailSegments.length) {
    transcriptEl.textContent = "No speech was detected in this recording.";
  } else {
    for (const seg of detailSegments) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "seg-row";
      row.dataset.from = String(seg.fromTimestampMs ?? 0);
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = `[${formatClock(seg.fromTimestampMs ?? 0)}] `;
      row.append(ts, document.createTextNode(seg.transcript));
      row.addEventListener("click", () => {
        detailMedia.currentTime = (seg.fromTimestampMs ?? 0) / 1000;
        detailMedia.play().catch(() => {});
      });
      transcriptEl.appendChild(row);
    }
  }
  highlightSegment(0);
  $("detail-meta").textContent =
    `${entry.kind === "file" ? "File" : "Camera"} · ${formatDuration(entry.durationMs)} · ${wordCount(entry.text || "")} words`;
  const slug = slugTitle(entry.title);
  $("dl-video").onclick = () => downloadBlob(entry.mediaBlob, `speaklog-${slug}.webm`);
  $("dl-txt").onclick = () => downloadBlob(
    new Blob([entry.text || ""], { type: "text/plain" }), `speaklog-${slug}.txt`);
  $("dl-srt").onclick = () => downloadBlob(
    new Blob([segmentsToSrt(entry.segments || [])], { type: "text/plain" }), `speaklog-${slug}.srt`);
  $("dl-vtt").onclick = () => downloadBlob(
    new Blob([segmentsToVtt(entry.segments || [])], { type: "text/vtt" }), `speaklog-${slug}.vtt`);
  // Caption burn-in is only offered for video with something to burn.
  $("caption-export").hidden = !(isVideo && detailSegments.length);
  // A style change re-renders the on-video caption at once.
  for (const id of ["cap-font", "cap-size", "cap-color", "cap-position"]) {
    $(id).onchange = () => updateDetailCaption((detailMedia?.currentTime || 0) * 1000);
  }
  $("burn-status").textContent = "";
  $("btn-burn").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const style = {
      font: $("cap-font").value,
      size: $("cap-size").value,
      color: $("cap-color").value,
      position: $("cap-position").value,
    };
    setStatus("Exporting video with captions — playing through in real time…");
    try {
      const blob = await burnCaptions(entry.mediaBlob, entry.segments, style, (cur, total) => {
        $("burn-status").textContent = total > 0
          ? `Exporting… ${Math.round((cur / total) * 100)}%`
          : "Exporting…";
      });
      downloadBlob(blob, `speaklog-${slug}-captioned.webm`);
      setStatus("Captioned video downloaded.");
      $("burn-status").textContent = "";
    } catch (err) {
      console.error(err);
      showError(`Caption export failed: ${err?.message || err}`);
    } finally {
      btn.disabled = false;
    }
  };
  $("btn-copy-detail").onclick = (e) => {
    if (!entry.text) {
      setStatus("Nothing to copy — no speech was detected in this recording.");
      return;
    }
    copyText(entry.text, e.currentTarget);
  };
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
refreshModelStatus();
