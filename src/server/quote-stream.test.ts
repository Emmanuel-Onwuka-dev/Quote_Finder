import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  openArchiveStore,
  todayKey,
  type ArchiveStore,
} from "./archive/store";
import type { LlmClient } from "./llm-client";
import { youtubeWatchUrl } from "./quote-finder";
import {
  QuoteStreamBodySchema,
  createQuoteStreamHandler,
} from "./quote-stream";

// --- Compact mock HTTP layer (mirrors quote-finder.test.ts) ---

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

const CHANNEL_PAYLOAD = {
  items: [
    {
      id: "UCchan1",
      snippet: { title: "Test Channel" },
      contentDetails: { relatedPlaylists: { uploads: "UUchan1" } },
    },
  ],
};

const VID1 = {
  title: "My quantum bicycle build",
  description: "A film about restoring a quantum bicycle frame.",
  publishedAt: "2026-10-01T00:00:00Z",
};

const PLAYLIST_PAYLOAD = {
  items: [{ snippet: { ...VID1, resourceId: { videoId: "vid1" } } }],
};

function chatBody(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

const VARIANTS_REPLY = JSON.stringify(["quantum bike", "bicycle build"]);

const RANK_VID1_REPLY = JSON.stringify({
  picks: [{ url: youtubeWatchUrl("vid1"), reason: "Title names the build" }],
});

function makeFetch(metaQueue: unknown[]): typeof fetch {
  let metaCalls = 0;
  return (async (url: string | URL | Request): Promise<Response> => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "meta.test") {
      metaCalls += 1;
      const body = metaQueue[metaCalls - 1] ?? metaQueue[metaQueue.length - 1];
      return jsonResponse(body);
    }
    if (parsed.hostname === "www.googleapis.com") {
      if (parsed.pathname === "/youtube/v3/channels") {
        return jsonResponse(CHANNEL_PAYLOAD);
      }
      if (parsed.pathname === "/youtube/v3/playlistItems") {
        return jsonResponse(PLAYLIST_PAYLOAD);
      }
      if (parsed.pathname === "/youtube/v3/search") {
        return jsonResponse({ items: [{ id: { videoId: "vid1" } }] });
      }
      if (parsed.pathname === "/youtube/v3/videos") {
        return jsonResponse({ items: [{ id: "vid1", snippet: VID1 }] });
      }
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  }) as unknown as typeof fetch;
}

const TEST_LLM: LlmClient = {
  baseUrl: "https://meta.test/v1",
  apiKey: "test-key",
  textModel: "muse-spark-test",
};

function testApp(): Hono {
  // One mock instance: locateQuote routes LLM calls through fetchFn but the
  // YouTube engine uses the global fetch, so the same mock serves both.
  const fetchMock = makeFetch([
    chatBody(VARIANTS_REPLY),
    chatBody(RANK_VID1_REPLY),
  ]);
  vi.stubGlobal("fetch", fetchMock);
  const app = new Hono();
  app.post(
    "/api/quote-stream",
    createQuoteStreamHandler({
      llm: TEST_LLM,
      youtubeApiKey: "yt-key",
      fetchFn: fetchMock,
    }),
  );
  return app;
}

interface SseEvent {
  event: string;
  data: unknown;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const eventLine = block
        .split("\n")
        .find((line) => line.startsWith("event:"));
      const dataLine = block
        .split("\n")
        .find((line) => line.startsWith("data:"));
      return {
        event: (eventLine ?? "").slice("event:".length).trim(),
        data: JSON.parse((dataLine ?? "data:null").slice("data:".length)),
      };
    });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QuoteStreamBodySchema", () => {
  it("requires a non-empty quote and defaults the rest", () => {
    expect(QuoteStreamBodySchema.parse({ quote: "  hello  " })).toEqual({
      quote: "hello",
      creator: "",
      scene: "",
      sinceDays: 0,
    });
    expect(() =>
      QuoteStreamBodySchema.parse({ quote: "   " }),
    ).toThrowError();
    expect(() =>
      QuoteStreamBodySchema.parse({ quote: "x", sinceDays: 3651 }),
    ).toThrowError();
    expect(() =>
      QuoteStreamBodySchema.parse({ quote: "x", sinceDays: -1 }),
    ).toThrowError();
    expect(() =>
      QuoteStreamBodySchema.parse({ quote: "x", sinceDays: 1.5 }),
    ).toThrowError();
  });
});

describe("POST /api/quote-stream", () => {
  it("streams progress stages then a result, with SSE headers", async () => {
    const res = await testApp().request("/api/quote-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quote: "quantum bicycle",
        creator: "@tester",
        scene: "",
        sinceDays: 0,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("connection")).toBe("keep-alive");

    const events = parseSse(await res.text());
    const progress = events.filter((entry) => entry.event === "progress");
    expect(progress.length).toBeGreaterThan(0);
    for (const entry of progress) {
      expect(entry.data).toMatchObject({ stage: expect.any(String) });
    }
    const stages = progress.map(
      (entry) => (entry.data as { stage: string }).stage,
    );
    expect(stages).toContain("Resolving channel");
    expect(stages).toContain("Ranking candidates");

    const results = events.filter((entry) => entry.event === "result");
    expect(results).toHaveLength(1);
    expect(results[0]?.data).toMatchObject({
      found: true,
      videoUrl: youtubeWatchUrl("vid1"),
      timestampVerified: false,
    });
    expect(events.at(-1)?.event).toBe("result");
    expect(events.some((entry) => entry.event === "error")).toBe(false);
  });

  it("rejects an empty quote with 400", async () => {
    const res = await testApp().request("/api/quote-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote: "  " }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.any(String) });
  });

  it("rejects an out-of-range window with 400", async () => {
    const res = await testApp().request("/api/quote-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote: "hello", sinceDays: 9999 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.any(String) });
  });

  it("rejects a non-JSON body with 400", async () => {
    const res = await testApp().request("/api/quote-stream", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.any(String) });
  });

  it("streams an error event when the run fails", async () => {
    const savedModelKey = process.env.MODEL_API_KEY;
    const savedYtKey = process.env.YOUTUBE_API_KEY;
    delete process.env.MODEL_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    try {
      const app = new Hono();
      app.post("/api/quote-stream", createQuoteStreamHandler());
      const res = await app.request("/api/quote-stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote: "quantum bicycle" }),
      });
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      expect(events).toHaveLength(1);
      expect(events[0]?.event).toBe("error");
      expect(events[0]?.data).toMatchObject({
        message: expect.stringContaining("Missing server env"),
      });
    } finally {
      if (savedModelKey !== undefined) {
        process.env.MODEL_API_KEY = savedModelKey;
      }
      if (savedYtKey !== undefined) {
        process.env.YOUTUBE_API_KEY = savedYtKey;
      }
    }
  });
});

describe("search quota", () => {
  const FALLBACK_MISS_REPLY = JSON.stringify({
    found: false,
    candidates: [
      {
        url: "https://www.youtube.com/watch?v=vid9",
        title: "Memory pick",
        reason: "AI suggestion",
      },
    ],
  });

  function quotaApp(
    metaQueue: unknown[],
    store: ArchiveStore,
  ): { app: Hono; seen: string[] } {
    const seen: string[] = [];
    const base = makeFetch(metaQueue);
    const fetchMock = (async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const href = String(url);
      seen.push(href);
      if (new URL(href).hostname === "www.youtube.com") {
        return jsonResponse({ title: "Memory pick" });
      }
      return base(url);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.post(
      "/api/quote-stream",
      createQuoteStreamHandler({
        llm: TEST_LLM,
        youtubeApiKey: "yt-key",
        fetchFn: fetchMock,
        archiveStore: store,
      }),
    );
    return { app, seen };
  }

  function postQuote(app: Hono, body: unknown): Promise<Response> {
    return app.request("/api/quote-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("answers from memory with a note when the search quota is spent", async () => {
    const store = openArchiveStore(":memory:");
    try {
      expect(store.trySpend(todayKey(), 3000, "search")).toBe(true);
      const { app, seen } = quotaApp(
        [chatBody(VARIANTS_REPLY), chatBody(FALLBACK_MISS_REPLY)],
        store,
      );
      const res = await postQuote(app, {
        quote: "quantum bicycle",
        creator: "@tester",
        scene: "",
        sinceDays: 0,
      });
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      const results = events.filter((entry) => entry.event === "result");
      expect(results).toHaveLength(1);
      expect(results[0]?.data).toMatchObject({ found: false });
      const notes = (results[0]?.data as { notes: string[] }).notes;
      expect(notes).toContain(
        "search quota spent for today — answering from memory",
      );
      expect(notes).toContain(
        "the AI's answer is an estimate from memory, not a verified match",
      );
      const candidates = (results[0]?.data as { candidates: unknown[] })
        .candidates;
      expect(candidates).toHaveLength(1);
      expect(seen.some((href) => href.includes("www.googleapis.com"))).toBe(
        false,
      );
      const stages = events
        .filter((entry) => entry.event === "progress")
        .map((entry) => (entry.data as { stage: string }).stage);
      expect(stages).not.toContain("Resolving channel");
      expect(stages).toContain("Asking the model");
    } finally {
      store.close();
    }
  });

  it("streams a quota error when Meta is also unavailable", async () => {
    const store = openArchiveStore(":memory:");
    try {
      expect(store.trySpend(todayKey(), 3000, "search")).toBe(true);
      let metaCalls = 0;
      const fetchMock = (async (
        url: string | URL | Request,
      ): Promise<Response> => {
        const parsed = new URL(String(url));
        if (parsed.hostname === "meta.test") {
          metaCalls += 1;
          if (metaCalls > 1) {
            return jsonResponse({}, 500);
          }
          return jsonResponse(chatBody(VARIANTS_REPLY));
        }
        throw new Error(`unexpected fetch: ${String(url)}`);
      }) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchMock);
      const app = new Hono();
      app.post(
        "/api/quote-stream",
        createQuoteStreamHandler({
          llm: TEST_LLM,
          youtubeApiKey: "yt-key",
          fetchFn: fetchMock,
          archiveStore: store,
        }),
      );
      const res = await postQuote(app, {
        quote: "quantum bicycle",
        creator: "",
        scene: "",
        sinceDays: 0,
      });
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      expect(events.some((entry) => entry.event === "result")).toBe(false);
      expect(events.at(-1)?.event).toBe("error");
      expect(events.at(-1)?.data).toEqual({
        message: "search quota spent for today",
      });
    } finally {
      store.close();
    }
  });

  it("records YouTube spend against the search budget", async () => {
    const store = openArchiveStore(":memory:");
    try {
      const { app } = quotaApp(
        [chatBody(VARIANTS_REPLY), chatBody(RANK_VID1_REPLY)],
        store,
      );
      const res = await postQuote(app, {
        quote: "quantum bicycle",
        creator: "@tester",
        scene: "",
        sinceDays: 0,
      });
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      expect(events.at(-1)?.event).toBe("result");
      // @tester: 2 channels.list (uncounted) + 1 playlist (uncounted) +
      // 3 searches x (100 + 1 details).
      expect(store.getSpent(todayKey(), "search")).toBe(303);
      expect(store.getSpent(todayKey(), "creator")).toBe(0);
      expect(store.getSpent(todayKey(), "viewer")).toBe(0);
    } finally {
      store.close();
    }
  });
});
