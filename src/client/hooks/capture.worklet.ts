// AudioWorklet capture node (§9): forwards the microphone's first
// channel to the main thread, chunk by chunk. Loaded by the
// use-voice-input hook with audioWorklet.addModule(); never imported
// directly by UI code.

// Minimal local worklet types: the DOM lib this project compiles
// against does not declare the AudioWorklet global scope.
interface WorkletProcessor {
  readonly port: MessagePort;
}

declare const AudioWorkletProcessor: {
  prototype: WorkletProcessor;
  new (): WorkletProcessor;
};

declare function registerProcessor(name: string, ctor: unknown): void;

class QuotefinderCapture extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor("quotefinder-capture", QuotefinderCapture);
