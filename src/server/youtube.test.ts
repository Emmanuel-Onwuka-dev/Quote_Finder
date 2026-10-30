import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHANNELS_LIST_COST,
  PLAYLIST_ITEMS_COST,
  SEARCH_LIST_COST,
  VIDEOS_LIST_COST,
  filterAfter,
  listUploadsPage,
  mergeShortlist,
  parseCreatorInput,
  scoreVideo,
  searchChannel,
  searchEverywhere,
  toPublishedAfter,
  type VideoMeta,
} from "./youtube";

function video(partial: Partial<VideoMeta> & { id: string }): VideoMeta {
  return {
    title: "",
    publishedAt: "2026-10-01T00:00:00Z",
    description: "",
    channelTitle: "",
    ...partial,
  };
}

describe("parseCreatorInput", () => {
  it("accepts @handles", () => {
    expect(parseCreatorInput("@mkbhd")).toEqual({
      kind: "handle",
      value: "mkbhd",
    });
  });

  it("accepts channel URLs", () => {
    expect(
      parseCreatorInput(
        "https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx",
      ),
    ).toEqual({ kind: "channelId", value: "UCxxxxxxxxxxxxxxxxxxxxxx" });
  });

  it("accepts bare channel IDs", () => {
    expect(parseCreatorInput("UCxxxxxxxxxxxxxxxxxxxxxx")).toEqual({
      kind: "channelId",
      value: "UCxxxxxxxxxxxxxxxxxxxxxx",
    });
  });

  it("accepts handle URLs", () => {
    expect(parseCreatorInput("https://www.youtube.com/@mkbhd")).toEqual({
      kind: "handle",
      value: "mkbhd",
    });
  });

  it("treats anything else as free text", () => {
    expect(parseCreatorInput("Marques Brownlee")).toEqual({
      kind: "text",
      value: "Marques Brownlee",
    });
  });
});

describe("toPublishedAfter", () => {
  it("returns undefined for any-time", () => {
    expect(toPublishedAfter(0)).toBeUndefined();
  });

  it("maps days to an ISO cutoff", () => {
    const now = new Date("2026-10-28T12:00:00Z");
    expect(toPublishedAfter(30, now)).toBe("2026-09-28T12:00:00.000Z");
    expect(toPublishedAfter(1, now)).toBe("2026-10-27T12:00:00.000Z");
  });
});

describe("filterAfter", () => {
  it("keeps only videos newer than the cutoff", () => {
    const videos = [
      video({ id: "new", publishedAt: "2026-10-20T00:00:00Z" }),
      video({ id: "old", publishedAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(filterAfter(videos, "2026-10-01T00:00:00Z").map((v) => v.id)).toEqual([
      "new",
    ]);
  });

  it("keeps everything without a cutoff", () => {
    const videos = [video({ id: "a" })];
    expect(filterAfter(videos, undefined)).toEqual(videos);
  });
});

describe("mergeShortlist", () => {
  it("dedupes by id, ranked first, capped at 12", () => {
    const ranked = Array.from({ length: 10 }, (_, i) => video({ id: `r${i}` }));
    const searched = [
      video({ id: "r0" }),
      video({ id: "s1" }),
      video({ id: "s2" }),
      video({ id: "s3" }),
    ];
    const pool = mergeShortlist(ranked, searched);
    expect(pool.map((v) => v.id)).toEqual([
      "r0", "r1", "r2", "r3", "r4",
      "r5", "r6", "r7", "r8", "r9",
      "s1", "s2",
    ]);
  });
});

describe("scoreVideo", () => {
  it("passes a title match with its matched words", () => {
    const scored = scoreVideo(
      "quantum bicycle",
      video({ id: "v", title: "My quantum bicycle build" }),
    );
    expect(scored).not.toBeNull();
    expect(scored?.matchedWords).toEqual(["quantum", "bicycle"]);
    expect(scored?.score).toBeGreaterThan(0.45);
  });

  it("rejects videos with no substance overlap", () => {
    expect(
      scoreVideo(
        "quantum bicycle",
        video({ id: "v", title: "Cooking pasta", description: "dinner" }),
      ),
    ).toBeNull();
  });

  it("lets short quotes through the coverage guard", () => {
    const scored = scoreVideo(
      "go now",
      video({ id: "v", title: "Go now, the video" }),
    );
    expect(scored).not.toBeNull();
  });
});

describe("searchEverywhere query variants", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends each Muse variant as an extra search query", async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const q = new URL(url).searchParams.get("q");
        if (q) {
          queries.push(q);
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }),
    );

    await searchEverywhere({
      quote: "the quick brown fox",
      variants: ["a fast brown fox", "quick fox jumps"],
      apiKey: "test-key",
      onProgress: () => {},
    });

    expect(queries).toEqual([
      '"the quick brown fox"',
      "the quick brown fox",
      "a fast brown fox",
      "quick fox jumps",
    ]);
  });
});

describe("search result channel titles", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubYouTube(routes: Record<string, unknown>): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        return new Response(JSON.stringify(routes[path] ?? { items: [] }), {
          status: 200,
        });
      }),
    );
  }

  it("carries each video's channel title from the details lookup", async () => {
    stubYouTube({
      "/youtube/v3/search": { items: [{ id: { videoId: "vid1" } }] },
      "/youtube/v3/videos": {
        items: [
          {
            id: "vid1",
            snippet: {
              title: "Some film",
              description: "A film.",
              publishedAt: "2026-10-01T00:00:00Z",
              channelTitle: "Quantum Films",
            },
          },
        ],
      },
    });
    const result = await searchEverywhere({
      quote: "anything",
      variants: [],
      apiKey: "test-key",
      onProgress: () => {},
    });
    expect(result.shortlist[0]?.channelTitle).toBe("Quantum Films");
  });

  it("stamps uploads with the resolved channel title", async () => {
    stubYouTube({
      "/youtube/v3/channels": {
        items: [
          {
            id: "UCchan1",
            snippet: { title: "Test Channel" },
            contentDetails: { relatedPlaylists: { uploads: "UUchan1" } },
          },
        ],
      },
      "/youtube/v3/playlistItems": {
        items: [
          {
            snippet: {
              title: "An upload",
              description: "From the channel.",
              publishedAt: "2026-10-01T00:00:00Z",
              resourceId: { videoId: "vid9" },
            },
          },
        ],
      },
      "/youtube/v3/search": { items: [] },
      "/youtube/v3/videos": { items: [] },
    });
    const result = await searchChannel({
      quote: "anything",
      variants: [],
      creator: "@tester",
      sinceDays: 0,
      apiKey: "test-key",
      onProgress: () => {},
    });
    expect(result.shortlist.map((video) => video.id)).toEqual(["vid9"]);
    expect(result.shortlist[0]?.channelTitle).toBe("Test Channel");
  });
});

describe("listUploadsPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns one page and passes the page token through", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        const pageToken = new URL(url).searchParams.get("pageToken");
        return new Response(
          JSON.stringify(
            pageToken
              ? {
                  items: [
                    {
                      snippet: {
                        title: "Second",
                        description: "",
                        publishedAt: "2026-10-02T00:00:00Z",
                        resourceId: { videoId: "v2" },
                      },
                    },
                  ],
                }
              : {
                  nextPageToken: "tok123",
                  items: [
                    {
                      snippet: {
                        title: "First",
                        description: "",
                        publishedAt: "2026-10-01T00:00:00Z",
                        resourceId: { videoId: "v1" },
                      },
                    },
                  ],
                },
          ),
          { status: 200 },
        );
      }),
    );
    const first = await listUploadsPage("UUx", "key");
    expect(first.videos.map((video) => video.id)).toEqual(["v1"]);
    expect(first.nextPageToken).toBe("tok123");
    const second = await listUploadsPage("UUx", "key", first.nextPageToken);
    expect(second.videos.map((video) => video.id)).toEqual(["v2"]);
    expect(second.nextPageToken).toBeUndefined();
    expect(seen[1]).toContain("pageToken=tok123");
  });
});

describe("API call reporting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubCalls(routes: Record<string, unknown>): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        return new Response(JSON.stringify(routes[path] ?? { items: [] }), {
          status: 200,
        });
      }),
    );
  }

  const VIDEO_DETAILS = {
    items: [
      {
        id: "vid1",
        snippet: {
          title: "Some film",
          description: "A film.",
          publishedAt: "2026-10-01T00:00:00Z",
          channelTitle: "Quantum Films",
        },
      },
    ],
  };

  it("reports every search.list and videos.list call in order", async () => {
    expect(SEARCH_LIST_COST).toBe(100);
    expect(VIDEOS_LIST_COST).toBe(1);
    expect(CHANNELS_LIST_COST).toBe(1);
    expect(PLAYLIST_ITEMS_COST).toBe(1);
    stubCalls({
      "/youtube/v3/search": { items: [{ id: { videoId: "vid1" } }] },
      "/youtube/v3/videos": VIDEO_DETAILS,
    });
    const calls: string[] = [];
    await searchEverywhere({
      quote: "anything",
      variants: ["variant one", "variant two"],
      apiKey: "test-key",
      onProgress: () => {},
      reserveQuota: (endpoint) => calls.push(endpoint),
    });
    expect(calls).toEqual([
      "search.list",
      "videos.list",
      "search.list",
      "videos.list",
      "search.list",
      "videos.list",
      "search.list",
      "videos.list",
    ]);
  });

  it("counts calls made on the in-channel fallback path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/youtube/v3/playlistItems") {
          return new Response("error", { status: 500 });
        }
        const routes: Record<string, unknown> = {
          "/youtube/v3/channels": {
            items: [
              {
                id: "UCchan1",
                snippet: { title: "Test Channel" },
                contentDetails: {
                  relatedPlaylists: { uploads: "UUchan1" },
                },
              },
            ],
          },
          "/youtube/v3/search": { items: [{ id: { videoId: "vid1" } }] },
          "/youtube/v3/videos": VIDEO_DETAILS,
        };
        return new Response(
          JSON.stringify(routes[path] ?? { items: [] }),
          { status: 200 },
        );
      }),
    );
    const calls: string[] = [];
    const result = await searchChannel({
      quote: "anything",
      variants: ["variant one"],
      creator: "@tester",
      sinceDays: 0,
      apiKey: "test-key",
      onProgress: () => {},
      reserveQuota: (endpoint) => calls.push(endpoint),
    });
    expect(result.videoCount).toBe(0);
    // Handle lookup + channel header + uploads page, then the in-channel
    // quote search and its variant, each with a details lookup.
    expect(calls).toEqual([
      "channels.list",
      "channels.list",
      "playlistItems.list",
      "search.list",
      "videos.list",
      "search.list",
      "videos.list",
    ]);
  });

  it("counts channel resolution by name as a search call", async () => {
    stubCalls({
      "/youtube/v3/channels": {
        items: [
          {
            id: "UCchan1",
            snippet: { title: "Test Channel" },
            contentDetails: { relatedPlaylists: { uploads: "UUchan1" } },
          },
        ],
      },
      "/youtube/v3/search": { items: [{ id: { channelId: "UCchan1" } }] },
      "/youtube/v3/playlistItems": { items: [] },
    });
    const calls: string[] = [];
    await searchChannel({
      quote: "anything",
      variants: [],
      creator: "Some Creator",
      sinceDays: 0,
      apiKey: "test-key",
      onProgress: () => {},
      reserveQuota: (endpoint) => calls.push(endpoint),
    });
    // Resolve-by-name search, channel header, and uploads page, plus the
    // quote search; the quote search finds no videos, so no details
    // lookup runs.
    expect(calls).toEqual([
      "search.list",
      "channels.list",
      "playlistItems.list",
      "search.list",
    ]);
  });

  it("never makes a call whose reservation throws", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(new URL(url).pathname);
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }),
    );
    const calls: string[] = [];
    await expect(
      searchEverywhere({
        quote: "anything",
        variants: [],
        apiKey: "test-key",
        onProgress: () => {},
        reserveQuota: (endpoint) => {
          calls.push(endpoint);
          throw new Error("quota spent");
        },
      }),
    ).rejects.toThrow("quota spent");
    expect(calls).toEqual(["search.list"]);
    expect(seen).toEqual([]);
  });
});
