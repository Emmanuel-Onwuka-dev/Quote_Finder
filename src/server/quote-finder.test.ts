import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "./llm-client";
import {
  fallbackAnswer,
  locateQuote,
  queryVariants,
  rankShortlist,
  stamp,
  urlExists,
  verifyUrls,
  windowLabel,
  youtubeWatchUrl,
  type PromptContext,
} from "./quote-finder";

// --- Mock HTTP layer: YouTube API, Meta API, oEmbed, plain web ---

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
  channelTitle: "Quantum Films",
};

const VID2 = {
  title: "Cooking pasta for dinner",
  description: "An evening of Italian cooking.",
  publishedAt: "2026-09-01T00:00:00Z",
  channelTitle: "Pasta Night",
};

const VID3 = {
  title: "Gardening tips for autumn",
  description: "Preparing the vegetable beds for winter.",
  publishedAt: "2026-10-10T00:00:00Z",
  channelTitle: "Garden Hour",
};

const PLAYLIST_PAYLOAD = {
  items: [
    {
      snippet: {
        ...VID1,
        resourceId: { videoId: "vid1" },
      },
    },
    {
      snippet: {
        ...VID2,
        resourceId: { videoId: "vid2" },
      },
    },
    {
      snippet: {
        ...VID3,
        resourceId: { videoId: "vid3" },
      },
    },
  ],
};

const VIDEO_DETAILS: Record<string, typeof VID1> = {
  vid1: VID1,
  vid2: VID2,
  vid3: VID3,
};

function chatBody(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

interface MetaCanned {
  status: number;
  body: unknown;
}

interface MockState {
  metaQueue: MetaCanned[];
  seen: string[];
}

function makeFetch(state: MockState): typeof fetch {
  return (async (
    url: string | URL | Request,
    init?: { method?: string },
  ): Promise<Response> => {
    const href = String(url);
    state.seen.push(`${init?.method ?? "GET"} ${href}`);
    const parsed = new URL(href);
    if (parsed.hostname === "www.youtube.com" && parsed.pathname === "/oembed") {
      return jsonResponse({}, href.includes("dead") ? 404 : 200);
    }
    if (parsed.hostname === "example.com") {
      if (parsed.pathname === "/retry") {
        const method = init?.method ?? "GET";
        return jsonResponse({}, method === "HEAD" ? 405 : 200);
      }
      if (parsed.pathname === "/missing") {
        return jsonResponse({}, 404);
      }
      return jsonResponse({}, 200);
    }
    if (parsed.hostname === "meta.test") {
      const next = state.metaQueue.shift();
      if (!next) {
        throw new Error(`unexpected Meta call: ${href}`);
      }
      return jsonResponse(next.body, next.status);
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
        const ids = (parsed.searchParams.get("id") ?? "").split(",");
        return jsonResponse({
          items: ids
            .filter((id) => VIDEO_DETAILS[id])
            .map((id) => ({ id, snippet: VIDEO_DETAILS[id] })),
        });
      }
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;
}

const TEST_LLM: LlmClient = {
  baseUrl: "https://meta.test/v1",
  apiKey: "test-key",
  textModel: "muse-spark-test",
};

function setup(metaQueue: MetaCanned[] = []): MockState {
  const state: MockState = { metaQueue: [...metaQueue], seen: [] };
  const fetchMock = makeFetch(state);
  vi.stubGlobal("fetch", fetchMock);
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const VARIANTS_REPLY = JSON.stringify([
  "quantum bike",
  "bicycle built with quantum parts",
  "my quantum cycle project",
]);

const RANK_VID1_REPLY = JSON.stringify({
  picks: [{ url: youtubeWatchUrl("vid1"), reason: "Title names the build" }],
});

function fallbackReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    found: false,
    confidence: "low",
    videoUrl: "",
    videoTitle: "",
    publishedAt: "",
    startTime: 0,
    endTime: 0,
    fullSentence: "",
    context: "nothing confident",
    notes: "",
    candidates: [],
    ...overrides,
  });
}

function contextWith(shortlistTitles: string[] = []): PromptContext {
  return {
    quote: "quantum bicycle",
    creatorLine: "@tester",
    sceneLine: "",
    whenLine: "any time",
    variants: [],
    shortlist: shortlistTitles.map((title, index) => ({
      id: `vid${index + 1}`,
      title,
      publishedAt: "2026-10-01T00:00:00Z",
      description: "",
      channelTitle: "Test Channel",
    })),
  };
}

describe("stamp", () => {
  it("formats seconds as mm:ss", () => {
    expect(stamp(0)).toBe("0:00");
    expect(stamp(65)).toBe("1:05");
    expect(stamp(3661)).toBe("61:01");
  });
});

describe("windowLabel", () => {
  it("maps the spec labels", () => {
    expect(windowLabel(0)).toBe("any time");
    expect(windowLabel(1)).toBe("the last 24 hours");
    expect(windowLabel(7)).toBe("7 days");
    expect(windowLabel(30)).toBe("30 days");
    expect(windowLabel(60)).toBe("2 months");
    expect(windowLabel(180)).toBe("6 months");
    expect(windowLabel(365)).toBe("the last year");
    expect(windowLabel(45)).toBe("last 45 days");
  });
});

describe("queryVariants", () => {
  it("parses the JSON array", async () => {
    setup([{ status: 200, body: chatBody(VARIANTS_REPLY) }]);
    await expect(
      queryVariants("quantum bicycle", TEST_LLM, fetch),
    ).resolves.toEqual([
      "quantum bike",
      "bicycle built with quantum parts",
      "my quantum cycle project",
    ]);
  });

  it("returns [] when the model call fails", async () => {
    setup([{ status: 500, body: {} }]);
    await expect(queryVariants("quantum bicycle", TEST_LLM, fetch)).resolves.toEqual(
      [],
    );
  });
});

describe("rankShortlist", () => {
  it("parses picks", async () => {
    setup([{ status: 200, body: chatBody(RANK_VID1_REPLY) }]);
    await expect(
      rankShortlist(contextWith(["My quantum bicycle build"]), TEST_LLM, fetch),
    ).resolves.toEqual([
      { url: youtubeWatchUrl("vid1"), reason: "Title names the build" },
    ]);
  });
});

describe("fallbackAnswer", () => {
  it("normalizes a missing candidate url to empty string", async () => {
    setup([
      {
        status: 200,
        body: chatBody(
          fallbackReply({ candidates: [{ title: "No link here" }] }),
        ),
      },
    ]);
    const answer = await fallbackAnswer(
      contextWith([]),
      TEST_LLM,
      fetch,
    );
    expect(answer.candidates).toEqual([
      { url: "", title: "No link here", reason: "" },
    ]);
  });
});

describe("urlExists", () => {
  it("checks YouTube URLs with oEmbed", async () => {
    setup();
    await expect(
      urlExists(youtubeWatchUrl("vid1"), fetch),
    ).resolves.toBe(true);
    await expect(
      urlExists(youtubeWatchUrl("dead1"), fetch),
    ).resolves.toBe(false);
  });

  it("retries HEAD 405 with GET", async () => {
    setup();
    await expect(
      urlExists("https://example.com/retry", fetch),
    ).resolves.toBe(true);
    await expect(
      urlExists("https://example.com/missing", fetch),
    ).resolves.toBe(false);
  });
});

describe("verifyUrls", () => {
  it("maps results back to input order", async () => {
    setup();
    await expect(
      verifyUrls(
        [
          youtubeWatchUrl("vid1"),
          youtubeWatchUrl("dead1"),
          "https://example.com/ok",
        ],
        fetch,
        2,
      ),
    ).resolves.toEqual([true, false, true]);
  });
});

describe("locateQuote", () => {
  it("finds a title match, capped at medium, timestamp unverified", async () => {
    const state = setup([
      { status: 200, body: chatBody(VARIANTS_REPLY) },
      { status: 200, body: chatBody(RANK_VID1_REPLY) },
    ]);
    const result = await locateQuote(
      { quote: "quantum bicycle", creator: "@tester", scene: "", sinceDays: 0 },
      { llm: TEST_LLM, youtubeApiKey: "yt-key", fetchFn: fetch },
    );
    expect(result.found).toBe(true);
    expect(result.confidence).toBe("medium");
    expect(result.videoUrl).toBe(youtubeWatchUrl("vid1"));
    expect(result.creator).toBe("Test Channel");
    expect(result.timestampVerified).toBe(false);
    expect(result.startTime).toBe(0);
    expect(result.startEstimate).toBe(false);
    expect(result.fullSentence).toBe("quantum bicycle");
    expect(result.context).toEqual(["Title names the build"]);
    expect(
      result.notes.some((note) => note.includes("not verified")),
    ).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.engine.channelId).toBe("UCchan1");
    expect(state.metaQueue).toHaveLength(0);
  });

  it("routes a blank creator to searchEverywhere", async () => {
    const state = setup([
      { status: 200, body: chatBody(VARIANTS_REPLY) },
      { status: 200, body: chatBody(RANK_VID1_REPLY) },
    ]);
    const result = await locateQuote(
      { quote: "quantum bicycle", creator: "  ", scene: "", sinceDays: 0 },
      { llm: TEST_LLM, youtubeApiKey: "yt-key", fetchFn: fetch },
    );
    expect(result.found).toBe(true);
    const searches = state.seen.filter((line) => line.includes("/youtube/v3/search"));
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((line) => !line.includes("channelId="))).toBe(true);
    expect(searches.some((line) => line.includes("q=%22"))).toBe(true);
  });

  it("drops ranking picks that are not on the shortlist", async () => {
    setup([
      { status: 200, body: chatBody(VARIANTS_REPLY) },
      {
        status: 200,
        body: chatBody(
          JSON.stringify({
            picks: [
              { url: youtubeWatchUrl("evil"), reason: "Hallucinated" },
              { url: youtubeWatchUrl("vid1"), reason: "Real one" },
            ],
          }),
        ),
      },
    ]);
    const result = await locateQuote(
      { quote: "quantum bicycle", creator: "@tester", scene: "", sinceDays: 0 },
      { llm: TEST_LLM, youtubeApiKey: "yt-key", fetchFn: fetch },
    );
    expect(result.found).toBe(true);
    expect(result.videoUrl).toBe(youtubeWatchUrl("vid1"));
    expect(result.context).toEqual(["Real one"]);
  });

  it("survives a variants failure and still searches", async () => {
    setup([
      { status: 500, body: {} },
      { status: 200, body: chatBody(RANK_VID1_REPLY) },
    ]);
    const result = await locateQuote(
      { quote: "quantum bicycle", creator: "@tester", scene: "", sinceDays: 0 },
      { llm: TEST_LLM, youtubeApiKey: "yt-key", fetchFn: fetch },
    );
    expect(result.found).toBe(true);
    expect(result.videoUrl).toBe(youtubeWatchUrl("vid1"));
  });

  it("falls back to 10 verified candidates, dropping dead links", async () => {
    const aiCandidates = [
      ...Array.from({ length: 7 }, (_, index) => ({
        url: youtubeWatchUrl(`c${index + 1}`),
        title: `Candidate ${index + 1}`,
        reason: "AI suggestion",
      })),
      {
        url: "https://example.com/ok",
        title: "Web candidate",
        reason: "AI suggestion",
      },
      { url: youtubeWatchUrl("dead1"), title: "Dead 1", reason: "AI suggestion" },
      { url: youtubeWatchUrl("dead2"), title: "Dead 2", reason: "AI suggestion" },
    ];
    setup([
      { status: 200, body: chatBody(VARIANTS_REPLY) },
      { status: 200, body: chatBody(RANK_VID1_REPLY) },
      {
        status: 200,
        body: chatBody(fallbackReply({ candidates: aiCandidates })),
      },
    ]);
    const result = await locateQuote(
      {
        quote: "xylophone zephyr nebula",
        creator: "@tester",
        scene: "",
        sinceDays: 3650,
      },
      { llm: TEST_LLM, youtubeApiKey: "yt-key", fetchFn: fetch },
    );
    expect(result.found).toBe(false);
    expect(result.candidates).toHaveLength(10);
    expect(
      result.candidates.some((candidate) => candidate.url.includes("dead")),
    ).toBe(false);
    expect(
      result.notes.some((note) => note.includes("dropped 2 dead links")),
    ).toBe(true);
    expect(
      result.candidates.some((candidate) =>
        candidate.reason.startsWith("Possible match"),
      ),
    ).toBe(true);
    expect(
      result.notes.some((note) => note.includes("estimate from memory")),
    ).toBe(true);
  });

  it("caps a confident fallback answer at medium and marks the estimate", async () => {
    setup([
      { status: 200, body: chatBody(VARIANTS_REPLY) },
      { status: 200, body: chatBody(RANK_VID1_REPLY) },
      {
        status: 200,
        body: chatBody(
          fallbackReply({
            found: true,
            confidence: "high",
            videoUrl: youtubeWatchUrl("c1"),
            videoTitle: "Remembered film",
            publishedAt: "2026-05-01T00:00:00Z",
            startTime: 95,
            context: "crowd scene",
            candidates: [],
          }),
        ),
      },
    ]);
    const result = await locateQuote(
      {
        quote: "xylophone zephyr nebula",
        creator: "",
        scene: "crowd scene",
        sinceDays: 0,
      },
      { llm: TEST_LLM, youtubeApiKey: "yt-key", fetchFn: fetch },
    );
    expect(result.found).toBe(true);
    expect(result.confidence).toBe("medium");
    expect(result.startTime).toBe(95);
    expect(result.startEstimate).toBe(true);
    expect(result.timestampVerified).toBe(false);
  });

  it("clears the answer when the AI main link is dead", async () => {
    setup([
      { status: 200, body: chatBody(VARIANTS_REPLY) },
      { status: 200, body: chatBody(RANK_VID1_REPLY) },
      {
        status: 200,
        body: chatBody(
          fallbackReply({
            found: true,
            confidence: "medium",
            videoUrl: youtubeWatchUrl("dead1"),
            videoTitle: "Ghost video",
            candidates: [],
          }),
        ),
      },
    ]);
    const result = await locateQuote(
      {
        quote: "xylophone zephyr nebula",
        creator: "@tester",
        scene: "",
        sinceDays: 0,
      },
      { llm: TEST_LLM, youtubeApiKey: "yt-key", fetchFn: fetch },
    );
    expect(result.found).toBe(false);
    expect(result.videoUrl).toBe("");
    expect(
      result.notes.some((note) => note.includes("main link was dead")),
    ).toBe(true);
  });

  it("degrades to engine-only candidates when the fallback fails", async () => {
    setup([
      { status: 200, body: chatBody(VARIANTS_REPLY) },
      { status: 200, body: chatBody(RANK_VID1_REPLY) },
      { status: 500, body: {} },
    ]);
    const result = await locateQuote(
      {
        quote: "xylophone zephyr nebula",
        creator: "@tester",
        scene: "",
        sinceDays: 0,
      },
      { llm: TEST_LLM, youtubeApiKey: "yt-key", fetchFn: fetch },
    );
    expect(result.found).toBe(false);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(
      result.notes.some((note) => note.includes("fallback was unavailable")),
    ).toBe(true);
    expect(
      result.notes.some((note) =>
        note.includes("trusted candidates were available"),
      ),
    ).toBe(true);
  });

  it("still answers from memory when the YouTube search fails", async () => {
    const state = setup([
      { status: 200, body: chatBody(VARIANTS_REPLY) },
      { status: 200, body: chatBody(fallbackReply({ found: false })) },
    ]);
    const healthyFetch = fetch;
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL | Request, init?: { method?: string }) =>
        String(url).includes("googleapis.com")
          ? jsonResponse({}, 500)
          : healthyFetch(url, init)) as unknown as typeof fetch,
    );
    const result = await locateQuote(
      {
        quote: "xylophone zephyr nebula",
        creator: "@tester",
        scene: "",
        sinceDays: 0,
      },
      { llm: TEST_LLM, youtubeApiKey: "yt-key", fetchFn: healthyFetch },
    );
    expect(result.found).toBe(false);
    expect(
      result.notes.some((note) => note.includes("YouTube search failed")),
    ).toBe(true);
    expect(state.metaQueue).toHaveLength(0);
  });

  it("rejects an empty quote", async () => {
    setup();
    await expect(
      locateQuote(
        { quote: "   ", creator: "", scene: "", sinceDays: 0 },
        { llm: TEST_LLM, youtubeApiKey: "yt-key", fetchFn: fetch },
      ),
    ).rejects.toThrow("quote must not be empty");
  });

  it("uses the video's channel for a found result with no creator", async () => {
    const state = setup([
      { status: 200, body: chatBody(VARIANTS_REPLY) },
      { status: 200, body: chatBody(RANK_VID1_REPLY) },
    ]);
    const result = await locateQuote(
      { quote: "quantum bicycle", creator: "  ", scene: "", sinceDays: 0 },
      { llm: TEST_LLM, youtubeApiKey: "yt-key", fetchFn: fetch },
    );
    expect(result.found).toBe(true);
    expect(result.videoUrl).toBe(youtubeWatchUrl("vid1"));
    expect(result.creator).toBe("Quantum Films");
    expect(state.metaQueue).toHaveLength(0);
  });

  it("pads candidates with each video's channel title", async () => {
    setup([
      { status: 200, body: chatBody(VARIANTS_REPLY) },
      { status: 200, body: chatBody(RANK_VID1_REPLY) },
      { status: 500, body: {} },
    ]);
    const result = await locateQuote(
      {
        quote: "xylophone zephyr nebula",
        creator: "",
        scene: "",
        sinceDays: 0,
      },
      { llm: TEST_LLM, youtubeApiKey: "yt-key", fetchFn: fetch },
    );
    expect(result.found).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.creator).toBe("Quantum Films");
    expect(result.candidates[0]?.reason.startsWith("Possible match")).toBe(
      true,
    );
  });
});
