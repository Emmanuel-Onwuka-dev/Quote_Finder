import { afterEach, describe, expect, it } from "vitest";
import { INDEX_PAUSED_MESSAGE, runIndexing } from "./indexing";
import { openArchiveStore, type ArchiveStore } from "./store";

const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello there\n";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

const stores: ArchiveStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

interface ScriptedFetch {
  fetchFn: typeof fetch;
  seen: string[];
}

function scriptedFetch(handler: (href: string) => Response): ScriptedFetch {
  const seen: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    const href = String(url);
    seen.push(href);
    return handler(href);
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

function setup(): ArchiveStore {
  const store = openArchiveStore(":memory:");
  stores.push(store);
  return store;
}

describe("runIndexing", () => {
  it("indexes a video end to end and reports progress", async () => {
    const store = setup();
    const progress: Array<{ stage: string; detail: string }> = [];
    const { fetchFn, seen } = scriptedFetch((href) => {
      if (href.includes("/captions?")) {
        return jsonResponse({
          items: [
            {
              id: "t-asr",
              snippet: { language: "en", trackKind: "asr", status: "serving" },
            },
            {
              id: "t-std",
              snippet: {
                language: "en",
                trackKind: "standard",
                status: "serving",
              },
            },
          ],
        });
      }
      return { ok: true, status: 200, text: async () => SRT } as Response;
    });
    const result = await runIndexing({
      videoIds: ["vid1"],
      accessToken: "at",
      store,
      fetchFn,
      onProgress: (stage, detail) => progress.push({ stage, detail }),
    });
    expect(result.paused).toBe(false);
    expect(result.indexed).toHaveLength(1);
    expect(result.indexed[0]).toMatchObject({
      videoId: "vid1",
      trackId: "t-std",
      trackKind: "standard",
      language: "en",
    });
    expect(result.indexed[0]?.cues).toEqual([
      { idx: 1, startSeconds: 1, endSeconds: 2, text: "Hello there" },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.spentUnits).toBe(250);
    expect(seen).toHaveLength(2);
    expect(progress.map((row) => row.stage)).toEqual([
      "Indexing videos",
      "Indexing videos",
    ]);
    expect(progress[1]?.detail).toContain("1 cues");
  });

  it("skips a video with no usable track and keeps going", async () => {
    const store = setup();
    const { fetchFn } = scriptedFetch((href) => {
      if (href.includes("/captions?")) {
        return jsonResponse({ items: [] });
      }
      return { ok: true, status: 200, text: async () => SRT } as Response;
    });
    const result = await runIndexing({
      videoIds: ["bare", "vid1"],
      accessToken: "at",
      store,
      fetchFn,
    });
    expect(result.paused).toBe(false);
    expect(result.indexed.map((video) => video.videoId)).toEqual(["vid1"]);
    expect(result.skipped).toEqual([
      { videoId: "bare", reason: "no usable caption track" },
    ]);
    // Two track lists plus one download.
    expect(result.spentUnits).toBe(300);
  });

  it("skips a failed download and keeps going", async () => {
    const store = setup();
    const { fetchFn } = scriptedFetch((href) => {
      if (href.includes("/captions?")) {
        return jsonResponse({
          items: [
            {
              id: "t1",
              snippet: {
                language: "en",
                trackKind: "standard",
                status: "serving",
              },
            },
          ],
        });
      }
      return { ok: false, status: 404, text: async () => "" } as Response;
    });
    const result = await runIndexing({
      videoIds: ["v1", "v2"],
      accessToken: "at",
      store,
      fetchFn,
    });
    expect(result.indexed).toEqual([]);
    expect(result.skipped).toEqual([
      { videoId: "v1", reason: "Caption download failed (404)" },
      { videoId: "v2", reason: "Caption download failed (404)" },
    ]);
  });

  it("pauses without calling the API when the budget is spent", async () => {
    const store = setup();
    expect(store.trySpend("2026-10-30", 5000)).toBe(true);
    const { fetchFn, seen } = scriptedFetch(() => jsonResponse({}));
    const result = await runIndexing({
      videoIds: ["vid1", "vid2"],
      accessToken: "at",
      store,
      fetchFn,
      now: new Date("2026-10-30T12:00:00Z"),
    });
    expect(result.paused).toBe(true);
    expect(result.indexed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("pauses mid-run once the cap is hit", async () => {
    const store = setup();
    expect(store.trySpend("2026-10-30", 4900)).toBe(true);
    const { fetchFn, seen } = scriptedFetch((href) => {
      if (href.includes("/captions?")) {
        return jsonResponse({
          items: [
            {
              id: "t1",
              snippet: {
                language: "en",
                trackKind: "standard",
                status: "serving",
              },
            },
          ],
        });
      }
      return { ok: true, status: 200, text: async () => SRT } as Response;
    });
    const result = await runIndexing({
      videoIds: ["vid1", "vid2"],
      accessToken: "at",
      store,
      fetchFn,
      now: new Date("2026-10-30T12:00:00Z"),
    });
    // The track list fits (4900 + 50), the download does not (4950 + 200).
    expect(result.paused).toBe(true);
    expect(result.indexed).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(result.spentUnits).toBe(4950);
  });

  it("skips videos with empty captions", async () => {
    const store = setup();
    const { fetchFn } = scriptedFetch((href) => {
      if (href.includes("/captions?")) {
        return jsonResponse({
          items: [
            {
              id: "t1",
              snippet: {
                language: "en",
                trackKind: "standard",
                status: "serving",
              },
            },
          ],
        });
      }
      return { ok: true, status: 200, text: async () => "\n\n" } as Response;
    });
    const result = await runIndexing({
      videoIds: ["vid1"],
      accessToken: "at",
      store,
      fetchFn,
    });
    expect(result.indexed).toEqual([]);
    expect(result.skipped).toEqual([
      { videoId: "vid1", reason: "captions were empty" },
    ]);
  });

  it("names the paused message from the spec", () => {
    expect(INDEX_PAUSED_MESSAGE).toBe("Indexing paused until tomorrow");
  });
});
