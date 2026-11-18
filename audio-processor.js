// AudioWorkletProcessor for live capture: buffers mono PCM from the mic
// and posts fixed-size Float32 chunks to the main thread, where the
// MediaPipe Audio Transcriber consumes them via transcribeStream().
// Loaded via audioCtx.audioWorklet.addModule("audio-processor.js").
// The task resamples other rates to 16 kHz, so the chunk size is just a
// latency/throughput trade-off: 3200 samples = 200 ms at 16 kHz.

const CHUNK_SAMPLES = 3200;

class SpeaklogCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK_SAMPLES);
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "flush") {
        this.flush();
        // Ack after the chunk (port messages stay in order), so the main
        // thread knows no more chunks are coming.
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  flush() {
    if (this.filled === 0) return;
    const out = this.buffer.slice(0, this.filled);
    this.port.postMessage(out, [out.buffer]);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    let offset = 0;
    while (offset < channel.length) {
      const space = CHUNK_SAMPLES - this.filled;
      const n = Math.min(space, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + n), this.filled);
      this.filled += n;
      offset += n;
      if (this.filled === CHUNK_SAMPLES) this.flush();
    }
    return true;
  }
}

registerProcessor("speaklog-capture", SpeaklogCapture);
