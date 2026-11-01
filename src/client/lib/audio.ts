// Voice-input audio helpers (§9): resample captured microphone audio to
// 16 kHz mono and encode it as 16-bit PCM WAV for POST /api/transcribe.
// Pure functions over sample arrays, so they run in Node tests as well
// as in the browser.

/** §8.2 recording format: 16 kHz mono 16-bit PCM WAV. */
export const VOICE_SAMPLE_RATE = 16000;
export const VOICE_WAV_HEADER_BYTES = 44;
/** Live voice meter: bars sampled from the analyser's frequency bins. */
export const VOICE_METER_BARS = 7;

/** Reduce analyser frequency bins (0–255) to per-bar levels (0–1).
 * Bars spread over the low-mid spectrum where voice energy lives; each
 * bar shows its slice's peak, so talking bounces and silence falls flat. */
export function computeMeterLevels(
  bins: ArrayLike<number>,
  bars: number = VOICE_METER_BARS,
): number[] {
  const usable = Math.max(1, Math.floor(bins.length / 2));
  const out: number[] = [];
  for (let i = 0; i < bars; i += 1) {
    const start = Math.floor((i * usable) / bars);
    const end = Math.max(start + 1, Math.floor(((i + 1) * usable) / bars));
    let peak = 0;
    for (let j = start; j < end && j < bins.length; j += 1) {
      peak = Math.max(peak, bins[j] ?? 0);
    }
    out.push(Math.min(1, Math.max(0, peak / 255)));
  }
  return out;
}

/** Concatenate captured chunks into one sample array. */
export function concatSamples(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Live captions: at most this many interim calls per recording. The
 * final transcription on stop is separate and never capped. */
export const MAX_INTERIM_CALLS = 10;

/** Whether another interim call may be sent this recording. */
export function interimCallAllowed(sentCount: number): boolean {
  return sentCount < MAX_INTERIM_CALLS;
}

/** Append one interim transcript chunk to the dictated text so far. */
export function appendTranscriptChunk(
  previous: string,
  chunkText: string,
): string {
  const chunk = chunkText.trim();
  if (!chunk) {
    return previous;
  }
  return previous ? `${previous} ${chunk}` : chunk;
}

/** Linear-interpolation resample to `toRate`. Already-correct audio is
 * returned unchanged in content (as a copy). */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number = VOICE_SAMPLE_RATE,
): Float32Array {
  if (samples.length === 0 || fromRate === toRate) {
    return samples.slice();
  }
  const outLength = Math.max(
    1,
    Math.round((samples.length * toRate) / fromRate),
  );
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = (i * (samples.length - 1)) / Math.max(1, outLength - 1);
    const before = Math.floor(position);
    const after = Math.min(samples.length - 1, before + 1);
    const fraction = position - before;
    out[i] =
      (samples[before] ?? 0) * (1 - fraction) + (samples[after] ?? 0) * fraction;
  }
  return out;
}

/** Encode mono float samples (-1..1) as 16-bit PCM WAV bytes. */
export function encodeWavPcm16(
  samples: Float32Array,
  sampleRate: number = VOICE_SAMPLE_RATE,
): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(VOICE_WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(VOICE_WAV_HEADER_BYTES + i * 2, clamped * 32767, true);
  }
  return buffer;
}
