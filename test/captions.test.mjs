// Node tests for captions.js (pure helpers only; burnCaptions needs a
// browser with video/canvas/MediaRecorder and is verified live).
// Run: node test/captions.test.mjs
import assert from "node:assert";
import {
  formatClock, segmentAtTime, captionFontPx, captionFont,
  wrapCaptionLines, DEFAULT_CAPTION_STYLE,
} from "../captions.js";

assert.equal(formatClock(0), "00:00");
assert.equal(formatClock(7000), "00:07");
assert.equal(formatClock(65000), "01:05");
assert.equal(formatClock(3723000), "62:03");
assert.equal(formatClock(-5), "00:00");

const segs = [
  { transcript: "First.", isFinal: true, fromTimestampMs: 0, toTimestampMs: 2000 },
  { transcript: "Second.", isFinal: true, fromTimestampMs: 2500, toTimestampMs: 5000 },
  { transcript: "Third.", isFinal: true, fromTimestampMs: 5000, toTimestampMs: 7500 },
];
assert.equal(segmentAtTime(segs, 0), segs[0]);
assert.equal(segmentAtTime(segs, 1999), segs[0]);
assert.equal(segmentAtTime(segs, 2000), null); // gap between segments
assert.equal(segmentAtTime(segs, 3000), segs[1]);
assert.equal(segmentAtTime(segs, 7500), null); // end is exclusive
assert.equal(segmentAtTime(segs, -100), null);
assert.equal(segmentAtTime([], 1000), null);
assert.equal(segmentAtTime([{ transcript: "No time.", isFinal: true }], 1000), null);

assert.equal(captionFontPx({ size: "small" }, 720), 29);
assert.equal(captionFontPx({ size: "medium" }, 720), 40);
assert.equal(captionFontPx({ size: "large" }, 720), 50);
assert.equal(captionFontPx({ size: "medium" }, 1080), 59);
assert.equal(captionFont("sans", 720), "600 40px sans-serif");
assert.equal(captionFont({ font: "serif", size: "large" }, 720), "600 50px serif");
assert.equal(captionFont({ font: "mono", size: "small" }, 720), "600 29px monospace");
assert.equal(captionFont({}, 720), "600 40px sans-serif"); // unknown values fall back
assert.deepEqual(
  Object.keys(DEFAULT_CAPTION_STYLE).sort(),
  ["color", "font", "position", "size"],
);

// wrapCaptionLines with a stub context: 10px per character.
const stubCtx = { measureText: (t) => ({ width: t.length * 10 }) };
assert.deepEqual(wrapCaptionLines(stubCtx, "Hello world", 200), ["Hello world"]);
assert.deepEqual(
  wrapCaptionLines(stubCtx, "one two three four", 100),
  ["one two", "three four"],
);
assert.deepEqual(wrapCaptionLines(stubCtx, "averyverylongword indeed", 100), ["averyverylongword", "indeed"]);
assert.deepEqual(wrapCaptionLines(stubCtx, "", 100), []);
assert.deepEqual(wrapCaptionLines(stubCtx, "   ", 100), []);

console.log("captions tests passed");
