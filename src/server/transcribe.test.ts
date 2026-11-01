import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  createTranscribeHandler,
  parseWavHeader,
  type TranscribeDeps,
} from "./transcribe";

type ScriptStep =
  | { status: number; body?: unknown; jsonThrows?: boolean }
  | "throw";

function setup(
  script: ScriptStep[] = [{ status: 200, body: { transcript: "hello world" } }],
  overrides: Partial<TranscribeDeps> = {},
): {
  app: Hono;
  seen: Array<{ url: string; init: RequestInit }>;
  sleeps: number[];
} {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  let calls = 0;
  const fetchFn = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const step = script[Math.min(calls, script.length - 1)] as ScriptStep;
    calls += 1;
    seen.push({ url: String(url), init: init ?? {} });
    if (step === "throw") {
      throw new Error("boom");
    }
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: step.jsonThrows
        ? async (): Promise<unknown> => {
            throw new Error("bad json");
          }
        : async () => step.body,
    } as Response;
  }) as unknown as typeof fetch;
  const app = new Hono();
  app.post(
    "/api/transcribe",
    createTranscribeHandler({
      modelApiKey: "meta-key",
      metaBaseUrl: "https://meta.test/v1",
      transcriptionModel: "test-model",
      fetchFn,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      ...overrides,
    }),
  );
  return { app, seen, sleeps };
}

/** Real 16-bit mono WAV bytes. `declaredSeconds` overrides the data
 * chunk size without generating the PCM, so the 10-minute bound can be
 * tested without a 20 MB fixture. */
function makeWavFile(
  options: {
    seconds?: number;
    sampleRate?: number;
    declaredSeconds?: number;
  } = {},
): File {
  const seconds = options.seconds ?? 0.2;
  const sampleRate = options.sampleRate ?? 16000;
  const channels = 1;
  const bits = 16;
  const actualBytes = Math.floor((seconds * sampleRate * channels * bits) / 8);
  const declaredSeconds = options.declaredSeconds ?? seconds;
  const declaredBytes = Math.floor(
    (declaredSeconds * sampleRate * channels * bits) / 8,
  );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + declaredBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(declaredBytes, 40);
  return new File([header, Buffer.alloc(actualBytes)], "audio.wav", {
    type: "audio/wav",
  });
}

async function postAudio(app: Hono, audio?: Blob): Promise<Response> {
  const form = new FormData();
  if (audio) {
    form.append("audio", audio, "audio.wav");
  }
  return app.request("/api/transcribe", { method: "POST", body: form });
}

describe("POST /api/transcribe", () => {
  it("forwards the recording and returns the transcript", async () => {
    const { app, seen } = setup();
    const res = await postAudio(app, makeWavFile());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello world" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://meta.test/v1/asr/transcribe");
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.headers).toEqual({
      Authorization: "Bearer meta-key",
    });
    const forwarded = seen[0]?.init.body as FormData;
    expect(JSON.parse(String(forwarded.get("request")))).toEqual({
      mode: "PUSH_TO_TALK",
      model: "test-model",
      audioEncoding: "WAV",
    });
    const part = forwarded.get("audio");
    expect(part instanceof Blob).toBe(true);
    expect((part as Blob).size).toBeGreaterThan(2048);
  });

  it("rejects a missing audio part", async () => {
    const { app, seen } = setup();
    const res = await postAudio(app);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "an audio file is required" });
    expect(seen).toHaveLength(0);
  });

  it("rejects audio under 2 KB", async () => {
    const { app, seen } = setup();
    const res = await postAudio(app, makeWavFile({ seconds: 0.002 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      message: "audio is too small (under 2 KB)",
    });
    expect(seen).toHaveLength(0);
  });

  it("rejects audio over 32 MB", async () => {
    const { app, seen } = setup();
    const big = new File([Buffer.alloc(33 * 1024 * 1024)], "audio.wav", {
      type: "audio/wav",
    });
    const res = await postAudio(app, big);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      message: "audio is too large (over 32 MB)",
    });
    expect(seen).toHaveLength(0);
  });

  it("rejects a file that is not a WAV", async () => {
    const { app, seen } = setup();
    const fake = new File(["x".repeat(3000)], "audio.wav", {
      type: "audio/wav",
    });
    const res = await postAudio(app, fake);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "audio must be a WAV file" });
    expect(seen).toHaveLength(0);
  });

  it("rejects audio longer than 10 minutes", async () => {
    const { app, seen } = setup();
    const res = await postAudio(
      app,
      makeWavFile({ seconds: 0.2, declaredSeconds: 660 }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      message: "audio is longer than 10 minutes",
    });
    expect(seen).toHaveLength(0);
  });

  it("retries 429 with exponential backoff", async () => {
    const { app, seen, sleeps } = setup([
      { status: 429 },
      { status: 429 },
      { status: 200, body: { transcript: "hello world" } },
    ]);
    const res = await postAudio(app, makeWavFile());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello world" });
    expect(seen).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("gives up after three 429 retries", async () => {
    const { app, seen, sleeps } = setup([
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 429 },
    ]);
    const res = await postAudio(app, makeWavFile());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      message: "transcription is rate limited, try again",
    });
    expect(seen).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it("retries 500 once", async () => {
    const { app, seen, sleeps } = setup([
      { status: 500 },
      { status: 200, body: { transcript: "hello world" } },
    ]);
    const res = await postAudio(app, makeWavFile());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello world" });
    expect(seen).toHaveLength(2);
    expect(sleeps).toHaveLength(0);
  });

  it("fails closed after a second 500", async () => {
    const { app, seen } = setup([{ status: 500 }, { status: 500 }]);
    const res = await postAudio(app, makeWavFile());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      message: "transcription failed (500)",
    });
    expect(seen).toHaveLength(2);
  });

  it("returns 502 when the upstream request throws", async () => {
    const { app } = setup(["throw"]);
    const res = await postAudio(app, makeWavFile());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      message: "transcription request failed",
    });
  });

  it("returns 502 on other upstream errors", async () => {
    const { app } = setup([{ status: 503 }]);
    const res = await postAudio(app, makeWavFile());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ message: "transcription failed (503)" });
  });

  it("returns 500 without a key", async () => {
    const { app, seen } = setup(
      [{ status: 200, body: { transcript: "hello world" } }],
      { modelApiKey: "" },
    );
    const res = await postAudio(app, makeWavFile());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      message: "Missing server env MODEL_API_KEY.",
    });
    expect(seen).toHaveLength(0);
  });

  it("returns 502 when the transcript is missing or unreadable", async () => {
    const { app } = setup([{ status: 200, body: {} }]);
    const missing = await postAudio(app, makeWavFile());
    expect(missing.status).toBe(502);
    expect(await missing.json()).toEqual({
      message: "transcription returned no text",
    });
    const { app: badApp } = setup([{ status: 200, jsonThrows: true }]);
    const unreadable = await postAudio(badApp, makeWavFile());
    expect(unreadable.status).toBe(502);
    expect(await unreadable.json()).toEqual({
      message: "transcription returned no text",
    });
  });
});

describe("daily call budget", () => {
  it("refuses the 2001st call of the day without calling Meta", async () => {
    const { app, seen } = setup([
      { status: 200, body: { transcript: "hi" } },
    ]);
    const wav = makeWavFile();
    for (let i = 0; i < 2000; i += 1) {
      expect((await postAudio(app, wav)).status).toBe(200);
    }
    expect(seen).toHaveLength(2000);
    const refused = await postAudio(app, wav);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      message: "Voice input is busy today, type the line instead.",
    });
    expect(seen).toHaveLength(2000);
  }, 60000);

  it("resets the budget on the next UTC day", async () => {
    let now = new Date("2026-10-30T12:00:00Z");
    const { app, seen } = setup(
      [{ status: 200, body: { transcript: "hi" } }],
      { now: () => now },
    );
    const wav = makeWavFile();
    for (let i = 0; i < 2000; i += 1) {
      expect((await postAudio(app, wav)).status).toBe(200);
    }
    expect((await postAudio(app, wav)).status).toBe(429);
    now = new Date("2026-10-31T00:00:01Z");
    const res = await postAudio(app, wav);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hi" });
    expect(seen).toHaveLength(2001);
  }, 60000);

  it("counts retries toward the budget", async () => {
    const { app, seen } = setup([
      { status: 500 },
      { status: 200, body: { transcript: "hi" } },
    ]);
    const wav = makeWavFile();
    expect((await postAudio(app, wav)).status).toBe(200);
    expect(seen).toHaveLength(2);
    for (let i = 0; i < 1998; i += 1) {
      expect((await postAudio(app, wav)).status).toBe(200);
    }
    expect(seen).toHaveLength(2000);
    const refused = await postAudio(app, wav);
    expect(refused.status).toBe(429);
    expect(seen).toHaveLength(2000);
  }, 60000);
});

describe("parseWavHeader", () => {
  it("reads sample rate, channels, bits, and data size", async () => {
    const bytes = new Uint8Array(await makeWavFile().arrayBuffer());
    expect(parseWavHeader(bytes)).toEqual({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 6400,
    });
  });

  it("rejects non-WAV bytes", () => {
    expect(parseWavHeader(new Uint8Array([1, 2, 3]))).toBeNull();
    const bytes = new Uint8Array(64);
    bytes.fill("x".charCodeAt(0));
    expect(parseWavHeader(bytes)).toBeNull();
  });
});
