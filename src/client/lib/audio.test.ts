import { describe, expect, it } from "vitest";
import {
  appendTranscriptChunk,
  computeMeterLevels,
  concatSamples,
  encodeWavPcm16,
  interimCallAllowed,
  resampleLinear,
  VOICE_METER_BARS,
  VOICE_SAMPLE_RATE,
  VOICE_WAV_HEADER_BYTES,
} from "./audio";

describe("concatSamples", () => {
  it("joins chunks in order", () => {
    expect(
      concatSamples([
        new Float32Array([1, 2]),
        new Float32Array([]),
        new Float32Array([3]),
      ]),
    ).toEqual(new Float32Array([1, 2, 3]));
  });

  it("handles no chunks", () => {
    expect(concatSamples([])).toEqual(new Float32Array([]));
  });
});

describe("resampleLinear", () => {
  it("downsamples 48 kHz capture to 16 kHz", () => {
    const oneSecond = new Float32Array(48000);
    for (let i = 0; i < oneSecond.length; i += 1) {
      oneSecond[i] = Math.sin((i / 48000) * Math.PI * 2 * 440);
    }
    const out = resampleLinear(oneSecond, 48000, VOICE_SAMPLE_RATE);
    expect(out.length).toBe(16000);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(Math.max(...out)).toBeGreaterThan(0.9);
  });

  it("keeps already-correct audio unchanged in content", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    expect(resampleLinear(samples, 16000, 16000)).toEqual(samples);
  });

  it("handles empty input", () => {
    expect(resampleLinear(new Float32Array([]), 48000, 16000)).toEqual(
      new Float32Array([]),
    );
  });
});

describe("encodeWavPcm16", () => {
  function headerText(buffer: ArrayBuffer, offset: number): string {
    const view = new DataView(buffer);
    return String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  }

  it("writes a 16 kHz mono 16-bit PCM header", () => {
    const buffer = encodeWavPcm16(new Float32Array(160), 16000);
    const view = new DataView(buffer);
    expect(buffer.byteLength).toBe(VOICE_WAV_HEADER_BYTES + 320);
    expect(headerText(buffer, 0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 320);
    expect(headerText(buffer, 8)).toBe("WAVE");
    expect(headerText(buffer, 12)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(headerText(buffer, 36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(320);
  });

  it("round-trips sample values through int16", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const view = new DataView(encodeWavPcm16(samples, 16000));
    expect(view.getInt16(VOICE_WAV_HEADER_BYTES, true)).toBe(0);
    expect(view.getInt16(VOICE_WAV_HEADER_BYTES + 2, true)).toBe(16383);
    expect(view.getInt16(VOICE_WAV_HEADER_BYTES + 4, true)).toBe(-16383);
    expect(view.getInt16(VOICE_WAV_HEADER_BYTES + 6, true)).toBe(32767);
    expect(view.getInt16(VOICE_WAV_HEADER_BYTES + 8, true)).toBe(-32767);
  });

  it("clamps out-of-range samples instead of wrapping", () => {
    const view = new DataView(
      encodeWavPcm16(new Float32Array([2, -2]), 16000),
    );
    expect(view.getInt16(VOICE_WAV_HEADER_BYTES, true)).toBe(32767);
    expect(view.getInt16(VOICE_WAV_HEADER_BYTES + 2, true)).toBe(-32767);
  });
});

describe("interimCallAllowed", () => {
  it("allows the first 10 interim calls", () => {
    for (let sent = 0; sent < 10; sent += 1) {
      expect(interimCallAllowed(sent)).toBe(true);
    }
  });

  it("caps interim calls at 10 per recording", () => {
    expect(interimCallAllowed(10)).toBe(false);
    expect(interimCallAllowed(11)).toBe(false);
  });
});

describe("appendTranscriptChunk", () => {
  it("starts with the first chunk", () => {
    expect(appendTranscriptChunk("", "hello world")).toBe("hello world");
  });

  it("joins later chunks with a space", () => {
    expect(appendTranscriptChunk("hello", "world")).toBe("hello world");
  });

  it("trims chunk text and ignores empty chunks", () => {
    expect(appendTranscriptChunk("hello", "  world  ")).toBe("hello world");
    expect(appendTranscriptChunk("hello", "   ")).toBe("hello");
  });
});

describe("computeMeterLevels", () => {
  it("maps silence to flat zeros", () => {
    expect(computeMeterLevels(new Uint8Array(128))).toEqual(
      new Array(VOICE_METER_BARS).fill(0),
    );
  });

  it("maps full-scale bins to ones", () => {
    const bins = new Uint8Array(128);
    bins.fill(255);
    expect(computeMeterLevels(bins)).toEqual(
      new Array(VOICE_METER_BARS).fill(1),
    );
  });

  it("places energy in the matching bar", () => {
    const bins = new Uint8Array(128);
    bins[0] = 255;
    const levels = computeMeterLevels(bins);
    expect(levels).toHaveLength(VOICE_METER_BARS);
    expect(levels[0]).toBe(1);
    expect(levels.slice(1)).toEqual(
      new Array(VOICE_METER_BARS - 1).fill(0),
    );
  });

  it("normalizes peaks to 0–1", () => {
    const bins = new Uint8Array(128);
    bins.fill(128);
    for (const level of computeMeterLevels(bins)) {
      expect(level).toBeCloseTo(128 / 255, 5);
    }
  });
});
