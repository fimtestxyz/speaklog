// Transcript formatting: plain text and SRT from MediaPipe
// AudioTranscriber segments. DOM-free so it is unit-testable.
// A segment is { transcript, isFinal, fromTimestampMs, toTimestampMs }.
// Only finalised segments go into saved files; interim hypotheses are
// live-display only and are dropped here (isFinal === false).

/** "HH:MM:SS,mmm" for SRT. */
export function formatSrtTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const rem = total % 1000;
  const pad = (n, w) => String(n).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(rem, 3)}`;
}

/** Final segments only, in order. */
export function finalSegments(segments) {
  return (segments || []).filter(
    (seg) => seg && typeof seg.transcript === "string"
      && seg.transcript.trim() !== "" && seg.isFinal !== false,
  );
}

/** Plain-text transcript: final segments joined with spaces. */
export function segmentsToText(segments) {
  return finalSegments(segments).map((seg) => seg.transcript.trim()).join(" ");
}

/**
 * SRT from segments. Segments without timestamps fall back to running
 * sequentially from the previous segment's end (or 0), each at least
 * 1s long, so the file is always well-formed.
 */
export function segmentsToSrt(segments) {
  const finals = finalSegments(segments);
  const blocks = [];
  let cursor = 0;
  for (const seg of finals) {
    const from = typeof seg.fromTimestampMs === "number" ? seg.fromTimestampMs : cursor;
    let to = typeof seg.toTimestampMs === "number" ? seg.toTimestampMs : from + 1000;
    if (to <= from) to = from + 1000;
    blocks.push(`${blocks.length + 1}\n${formatSrtTime(from)} --> ${formatSrtTime(to)}\n${seg.transcript.trim()}`);
    cursor = to;
  }
  return blocks.length ? blocks.join("\n\n") + "\n" : "";
}

/** Word count of a transcript string. */
export function wordCount(text) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  return text && text.trim() ? words.length : 0;
}

/**
 * Merge final segments from a new streaming result into the finals seen
 * so far, in start-time order. Each transcribeStream() result carries
 * only the most recent segment(s), so replacing the list would drop
 * everything before it and the live panel would show just the last
 * sentence; merging keeps the full transcript. A result that repeats
 * the whole history dedupes by start timestamp, and a later segment
 * with the same start timestamp overwrites the earlier one (the model
 * correcting itself). Segments without a timestamp fall back to their
 * text as the key. Interim segments are never merged.
 */
export function mergeFinalSegments(existing, incoming) {
  const byKey = new Map();
  const keyOf = (seg) =>
    typeof seg.fromTimestampMs === "number"
      ? `t:${seg.fromTimestampMs}`
      : `x:${(seg.transcript || "").trim()}`;
  for (const seg of [...(existing || []), ...(incoming || [])]) {
    if (!seg || typeof seg.transcript !== "string" || seg.transcript.trim() === "") continue;
    if (seg.isFinal === false) continue;
    byKey.set(keyOf(seg), seg);
  }
  return [...byKey.values()].sort(
    (a, b) => (a.fromTimestampMs ?? Infinity) - (b.fromTimestampMs ?? Infinity),
  );
}
