// AudioWorklet capture node (§9): forwards the microphone's first
// channel to the main thread, chunk by chunk. Loaded by the
// use-voice-input hook with audioWorklet.addModule(). Lives in public/
// so Vite copies it into dist/ as-is; a .ts file would not be emitted.

class QuotefinderCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor("quotefinder-capture", QuotefinderCapture);
