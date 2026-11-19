// Captions: timestamped display, playback sync, and burned-in export.
// Pure helpers are unit-tested; burnCaptions needs a browser
// (video element, canvas, MediaRecorder).
//
// Export flow: the recorded video plays once through an offscreen
// <video>, each frame is drawn to a <canvas> with the active caption,
// and the canvas stream (+ the video's audio track) is re-recorded
// with MediaRecorder. It runs in real time — a 1-minute video takes
// about 1 minute to export. No server, nothing uploaded.

export const DEFAULT_CAPTION_STYLE = {
  font: "sans",
  size: "medium",
  color: "#ffffff",
  position: "bottom",
};

const FONT_FAMILIES = { sans: "sans-serif", serif: "serif", mono: "monospace" };
const FONT_SCALES = { small: 0.04, medium: 0.055, large: 0.07 };

/** "mm:ss" for on-screen timestamps. Hours roll into minutes. */
export function formatClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** The segment spoken at timeMs, or null (gaps, before the first, after the last). */
export function segmentAtTime(segments, timeMs) {
  const list = segments || [];
  for (let i = 0; i < list.length; i++) {
    const seg = list[i];
    if (typeof seg.fromTimestampMs !== "number") continue;
    // A segment without an end timestamp runs until the next segment
    // starts (or 5s past its start for the last one) — the model does
    // not always stamp an end, and without this the caption, the
    // highlight and the burn-in all silently show nothing for it.
    const next = list[i + 1];
    const to = typeof seg.toTimestampMs === "number"
      ? seg.toTimestampMs
      : (typeof next?.fromTimestampMs === "number" ? next.fromTimestampMs : seg.fromTimestampMs + 5000);
    if (timeMs >= seg.fromTimestampMs && timeMs < to) return seg;
  }
  return null;
}

/** Caption font size in px for a style at a given video height. */
export function captionFontPx(style, videoHeight) {
  const scale = FONT_SCALES[style.size] ?? FONT_SCALES.medium;
  return Math.max(16, Math.round(videoHeight * scale));
}

/** Canvas font string for a style at a given video height. */
export function captionFont(style, videoHeight) {
  const family = FONT_FAMILIES[style.font] ?? FONT_FAMILIES.sans;
  return `600 ${captionFontPx(style, videoHeight)}px ${family}`;
}

/** Wrap text into lines that fit maxWidth (ctx is a canvas 2d context). */
export function wrapCaptionLines(ctx, text, maxWidth) {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCaption(ctx, text, style, width, height) {
  const px = captionFontPx(style, height);
  ctx.font = captionFont(style, height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxWidth = width * 0.9;
  const lines = wrapCaptionLines(ctx, text, maxWidth);
  if (!lines.length) return;
  const lineHeight = Math.round(px * 1.35);
  const padX = 16;
  const padY = 10;
  const blockW = Math.min(
    width * 0.92,
    Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2,
  );
  const blockH = lines.length * lineHeight + padY * 2;
  const x = (width - blockW) / 2;
  const margin = Math.round(height * 0.05);
  const y = style.position === "top" ? margin : height - margin - blockH;
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, blockW, blockH, 10);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, blockW, blockH);
  }
  ctx.fillStyle = style.color || "#ffffff";
  lines.forEach((line, i) => {
    ctx.fillText(line, width / 2, y + padY + lineHeight * (i + 0.5));
  });
}

function pickBurnMimeType() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
}

/**
 * Render captions onto a copy of the video and return it as a .webm
 * Blob. Plays the video through once in real time; onProgress(current,
 * duration) reports seconds. Throws with a plain message when the
 * video cannot load or play.
 */
export async function burnCaptions(mediaBlob, segments, style, onProgress) {
  const finals = (segments || []).filter(
    (s) => s && s.isFinal !== false && typeof s.transcript === "string" && s.transcript.trim() !== "",
  );
  const url = URL.createObjectURL(mediaBlob);
  const video = document.createElement("video");
  video.src = url;
  video.playsInline = true;
  video.preload = "auto";
  let recorder = null;
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("Could not load the video for caption export."));
      video.load();
    });
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const canvasStream = canvas.captureStream(30);
    const tracks = [...canvasStream.getVideoTracks()];
    if (typeof video.captureStream === "function") {
      tracks.push(...video.captureStream().getAudioTracks());
    }
    const mimeType = pickBurnMimeType();
    recorder = mimeType
      ? new MediaRecorder(new MediaStream(tracks), { mimeType })
      : new MediaRecorder(new MediaStream(tracks));
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    const ended = new Promise((resolve) => { video.onended = resolve; });
    const draw = () => {
      ctx.drawImage(video, 0, 0, width, height);
      const seg = segmentAtTime(finals, video.currentTime * 1000);
      if (seg) drawCaption(ctx, seg.transcript, style, width, height);
      if (!video.ended) requestAnimationFrame(draw);
    };
    recorder.start(500);
    draw();
    try {
      await video.play();
    } catch (err) {
      throw new Error("Could not play the video for caption export. Tap the video once, then try again.");
    }
    onProgress?.(0, video.duration);
    const tick = setInterval(() => onProgress?.(video.currentTime, video.duration), 500);
    await ended;
    clearInterval(tick);
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    return new Blob(chunks, { type: recorder.mimeType || "video/webm" });
  } finally {
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* already stopping */ }
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
