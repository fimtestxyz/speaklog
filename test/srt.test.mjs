// Node tests for srt.js. Formatting from real MediaPipe segment objects.
// Run: node test/srt.test.mjs
import assert from "node:assert";
import { formatSrtTime, finalSegments, segmentsToText, segmentsToSrt, wordCount, mergeFinalSegments } from "../srt.js";

// The example payload from the MediaPipe Audio Transcriber docs: one final
// segment, one interim hypothesis.
const docsSegments = [
  { transcript: "Turn on the kitchen lights", isFinal: true, fromTimestampMs: 0, toTimestampMs: 1840 },
  { transcript: "and set a timer for", isFinal: false, fromTimestampMs: 1840, toTimestampMs: 2600 },
];

assert.equal(formatSrtTime(0), "00:00:00,000");
assert.equal(formatSrtTime(1840), "00:00:01,840");
assert.equal(formatSrtTime(61000), "00:01:01,000");
assert.equal(formatSrtTime(3661001), "01:01:01,001");
assert.equal(formatSrtTime(-5), "00:00:00,000");

// Interim segments are dropped from saved output.
assert.deepEqual(finalSegments(docsSegments), [docsSegments[0]]);
assert.equal(segmentsToText(docsSegments), "Turn on the kitchen lights");
assert.equal(
  segmentsToSrt(docsSegments),
  "1\n00:00:00,000 --> 00:00:01,840\nTurn on the kitchen lights\n",
);

// Multiple finals, text joined with spaces, SRT numbered in order.
const multi = [
  { transcript: "Hello world.", isFinal: true, fromTimestampMs: 500, toTimestampMs: 1500 },
  { transcript: "This is a test.", isFinal: true, fromTimestampMs: 2000, toTimestampMs: 3500 },
];
assert.equal(segmentsToText(multi), "Hello world. This is a test.");
assert.equal(
  segmentsToSrt(multi),
  "1\n00:00:00,500 --> 00:00:01,500\nHello world.\n\n"
  + "2\n00:00:02,000 --> 00:00:03,500\nThis is a test.\n",
);

// Segments without timestamps run sequentially, 1s each, from 0.
assert.equal(
  segmentsToSrt([
    { transcript: "First.", isFinal: true },
    { transcript: "Second.", isFinal: true },
  ]),
  "1\n00:00:00,000 --> 00:00:01,000\nFirst.\n\n2\n00:00:01,000 --> 00:00:02,000\nSecond.\n",
);

// An end before its start is stretched to 1s; empty/blank segments skipped.
assert.equal(
  segmentsToSrt([
    { transcript: "   ", isFinal: true, fromTimestampMs: 0, toTimestampMs: 500 },
    { transcript: "Ok.", isFinal: true, fromTimestampMs: 9000, toTimestampMs: 8000 },
  ]),
  "1\n00:00:09,000 --> 00:00:10,000\nOk.\n",
);

// Empty input, empty output. Clip-mode segments without isFinal count as final.
assert.equal(segmentsToText([]), "");
assert.equal(segmentsToSrt([]), "");
assert.equal(
  segmentsToText([{ transcript: "No flag.", fromTimestampMs: 0, toTimestampMs: 1000 }]),
  "No flag.",
);

assert.equal(wordCount("Turn on the kitchen lights"), 5);
assert.equal(wordCount(""), 0);
assert.equal(wordCount("   "), 0);
assert.equal(wordCount("one  two\nthree"), 3);

// Streaming merge: each transcribeStream() result carries only the latest
// segment(s), so finals accumulate across results instead of replacing.
const first = { transcript: "First sentence.", isFinal: true, fromTimestampMs: 0, toTimestampMs: 2000 };
const second = { transcript: "Second sentence.", isFinal: true, fromTimestampMs: 2000, toTimestampMs: 4000 };
assert.deepEqual(mergeFinalSegments([], [first]), [first]);
assert.deepEqual(mergeFinalSegments([first], [second]), [first, second]);

// A result that repeats the whole history dedupes — no doubled sentences.
assert.deepEqual(mergeFinalSegments([first, second], [first, second]), [first, second]);

// A later segment with the same start timestamp overwrites the earlier
// one (the model correcting itself); out-of-order arrivals sort by time.
const corrected = { transcript: "First sentence, corrected.", isFinal: true, fromTimestampMs: 0, toTimestampMs: 2000 };
assert.deepEqual(mergeFinalSegments([first, second], [corrected]), [corrected, second]);
const third = { transcript: "Third sentence.", isFinal: true, fromTimestampMs: 4000, toTimestampMs: 6000 };
assert.deepEqual(mergeFinalSegments([first, third], [second]), [first, second, third]);

// Interim segments are never merged; segments without timestamps key by text.
assert.deepEqual(
  mergeFinalSegments([first], [{ transcript: "half a", isFinal: false, fromTimestampMs: 2000 }]),
  [first],
);
const noTsA = { transcript: "No time.", isFinal: true };
const noTsB = { transcript: "Still no time.", isFinal: true };
assert.deepEqual(mergeFinalSegments([noTsA], [noTsA, noTsB]), [noTsA, noTsB]);

console.log("srt tests passed");
