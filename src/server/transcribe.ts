// §8.2 transcribe: POST endpoint. Accepts a voice recording as
// multipart form data, validates size and duration, forwards it to the
// Meta transcription API, and returns the text. The use-voice-input
// client hook consumes this.

import type { Context } from "hono";
import { logError } from "./log";

export interface TranscribeDeps {
  modelApiKey: string;
  metaBaseUrl: string;
  transcriptionModel: string;
  fetchFn?: typeof fetch;
  /** Injected so tests don't wait out the retry backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock for the daily budget (tests pin the UTC date). */
  now?: () => Date;
}

/** §8.2 size bounds: reject under 2 KB or over 32 MB. */
export const TRANSCRIBE_MIN_BYTES = 2 * 1024;
export const TRANSCRIBE_MAX_BYTES = 32 * 1024 * 1024;
/** §8.2 duration bound: reject recordings longer than 10 minutes. */
export const TRANSCRIBE_MAX_SECONDS = 10 * 60;
/** §8.2 retry rule: on 429, back off exponentially, then give up. */
const RETRY_429_DELAYS_MS = [500, 1000, 2000];
/** §8.2 retry rule: on 500, retry once. */
const RETRY_500_ATTEMPTS = 2;
/** §8.2 daily call budget: at most this many paid Meta calls per UTC day. */
export const TRANSCRIBE_DAILY_CALL_LIMIT = 2000;

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Declared PCM data bytes (the data chunk size). */
  dataBytes: number;
}

/** Read a WAV header (RIFF/WAVE, PCM). Scans subchunks so extra chunks
 * (JUNK, LIST, bext, …) don't break parsing. Null when the bytes are
 * not a WAV file. */
export function parseWavHeader(buffer: Uint8Array): WavInfo | null {
  const ascii = (offset: number, length: number): string => {
    let text = "";
    for (let i = 0; i < length; i += 1) {
      text += String.fromCharCode(buffer[offset + i] ?? 0);
    }
    return text;
  };
  const u16 = (offset: number): number =>
    (buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8);
  const u32 = (offset: number): number =>
    (buffer[offset] ?? 0) |
    ((buffer[offset + 1] ?? 0) << 8) |
    ((buffer[offset + 2] ?? 0) << 16) |
    ((buffer[offset + 3] ?? 0) << 24);
  if (buffer.length < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") {
    return null;
  }
  let fmt: { channels: number; sampleRate: number; bits: number } | null =
    null;
  let dataBytes: number | null = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = ascii(offset, 4);
    const size = u32(offset + 4);
    if (id === "fmt " && size >= 16 && offset + 8 + 16 <= buffer.length) {
      const audioFormat = u16(offset + 8);
      if (audioFormat !== 1) {
        return null;
      }
      fmt = {
        channels: u16(offset + 10),
        sampleRate: u32(offset + 12),
        bits: u16(offset + 22),
      };
    } else if (id === "data") {
      dataBytes = size;
    }
    // Subchunks are word-aligned: odd sizes pad by one byte.
    offset += 8 + size + (size % 2);
  }
  if (!fmt || dataBytes === null) {
    return null;
  }
  if (fmt.channels < 1 || fmt.sampleRate < 1 || fmt.bits < 1) {
    return null;
  }
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bits,
    dataBytes,
  };
}

function wavDurationSeconds(info: WavInfo): number {
  const bytesPerSecond =
    (info.sampleRate * info.channels * info.bitsPerSample) / 8;
  return info.dataBytes / bytesPerSecond;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createTranscribeHandler(deps: TranscribeDeps) {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const clock = deps.now ?? (() => new Date());
  // Daily call counter, keyed by UTC date. Kept in memory: it resets on
  // server restart and is per process, so this is a cost guard, not a
  // security control.
  const budget = { day: "", count: 0 };
  // True (and counted) when a Meta call may proceed; resets the count
  // when the UTC date rolls over.
  const takeBudget = (): boolean => {
    const day = clock().toISOString().slice(0, 10);
    if (budget.day !== day) {
      budget.day = day;
      budget.count = 0;
    }
    if (budget.count >= TRANSCRIBE_DAILY_CALL_LIMIT) {
      return false;
    }
    budget.count += 1;
    return true;
  };
  return async (c: Context): Promise<Response> => {
    let body: Record<string, string | File>;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json({ message: "request must be multipart form data" }, 400);
    }
    const audio = body.audio;
    if (!(audio instanceof Blob)) {
      return c.json({ message: "an audio file is required" }, 400);
    }
    if (audio.size < TRANSCRIBE_MIN_BYTES) {
      return c.json({ message: "audio is too small (under 2 KB)" }, 400);
    }
    if (audio.size > TRANSCRIBE_MAX_BYTES) {
      return c.json({ message: "audio is too large (over 32 MB)" }, 400);
    }
    const info = parseWavHeader(new Uint8Array(await audio.arrayBuffer()));
    if (!info) {
      return c.json({ message: "audio must be a WAV file" }, 400);
    }
    if (wavDurationSeconds(info) > TRANSCRIBE_MAX_SECONDS) {
      return c.json({ message: "audio is longer than 10 minutes" }, 400);
    }
    if (!deps.modelApiKey) {
      return c.json({ message: "Missing server env MODEL_API_KEY." }, 500);
    }
    const form = new FormData();
    form.append(
      "request",
      JSON.stringify({
        mode: "PUSH_TO_TALK",
        model: deps.transcriptionModel,
        audioEncoding: "WAV",
      }),
    );
    form.append("audio", audio, "audio.wav");
    const url = `${deps.metaBaseUrl}/asr/transcribe`;
    let rateLimitedAttempts = 0;
    let serverErrorAttempts = 0;
    for (;;) {
      if (!takeBudget()) {
        return c.json(
          { message: "Voice input is busy today, type the line instead." },
          429,
        );
      }
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${deps.modelApiKey}` },
          body: form,
        });
      } catch (error) {
        logError("transcribe", error);
        return c.json({ message: "transcription request failed" }, 502);
      }
      if (res.status === 429) {
        const delay = RETRY_429_DELAYS_MS[rateLimitedAttempts];
        if (delay === undefined) {
          return c.json(
            { message: "transcription is rate limited, try again" },
            429,
          );
        }
        rateLimitedAttempts += 1;
        await sleep(delay);
        continue;
      }
      if (res.status === 500 && serverErrorAttempts + 1 < RETRY_500_ATTEMPTS) {
        serverErrorAttempts += 1;
        continue;
      }
      if (!res.ok) {
        return c.json(
          { message: `transcription failed (${res.status})` },
          502,
        );
      }
      let transcript: unknown;
      try {
        transcript = ((await res.json()) as { transcript?: unknown })
          .transcript;
      } catch (error) {
        logError("transcribe", error, { status: res.status });
        return c.json(
          { message: "transcription returned no text" },
          502,
        );
      }
      if (typeof transcript !== "string" || transcript.trim() === "") {
        return c.json({ message: "transcription returned no text" }, 502);
      }
      return c.json({ text: transcript });
    }
  };
}
