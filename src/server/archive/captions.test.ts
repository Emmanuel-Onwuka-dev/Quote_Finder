import { describe, expect, it } from "vitest";
import {
  CAPTIONS_DOWNLOAD_COST,
  CAPTIONS_LIST_COST,
  downloadCaptions,
  listCaptionTracks,
  pickTrack,
  type CaptionTrack,
} from "./captions";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

function track(partial: Partial<CaptionTrack> & { id: string }): CaptionTrack {
  return {
    language: "en",
    name: "",
    trackKind: "standard",
    status: "serving",
    ...partial,
  };
}

describe("quota costs", () => {
  it("matches the documented unit costs", () => {
    expect(CAPTIONS_LIST_COST).toBe(50);
    expect(CAPTIONS_DOWNLOAD_COST).toBe(200);
  });
});

describe("listCaptionTracks", () => {
  it("sends the video id with the OAuth token", async () => {
    const seen: Array<{ url: string; auth: unknown }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: (init?.headers as Record<string, string>)?.Authorization,
      });
      return jsonResponse({ items: [] });
    }) as unknown as typeof fetch;
    await expect(listCaptionTracks("vid1", "at", fetchFn)).resolves.toEqual(
      [],
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain("/youtube/v3/captions");
    expect(seen[0]?.url).toContain("videoId=vid1");
    expect(seen[0]?.auth).toBe("Bearer at");
  });

  it("maps tracks and skips items without an id", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        items: [
          {
            id: "t1",
            snippet: {
              language: "en",
              name: "English",
              trackKind: "asr",
              status: "serving",
            },
          },
          { snippet: { language: "en" } },
        ],
      })) as unknown as typeof fetch;
    await expect(listCaptionTracks("vid1", "at", fetchFn)).resolves.toEqual([
      {
        id: "t1",
        language: "en",
        name: "English",
        trackKind: "asr",
        status: "serving",
      },
    ]);
  });

  it("throws on an HTTP error", async () => {
    const fetchFn = (async () => jsonResponse({}, 401)) as unknown as typeof fetch;
    await expect(listCaptionTracks("vid1", "at", fetchFn)).rejects.toThrow(
      "track list failed (401)",
    );
  });
});

describe("pickTrack", () => {
  it("prefers standard, then forced, then asr, then anything else", () => {
    const tracks = [
      track({ id: "mystery", trackKind: "future-kind" }),
      track({ id: "auto", trackKind: "asr" }),
      track({ id: "forced", trackKind: "forced" }),
      track({ id: "human", trackKind: "standard" }),
    ];
    expect(pickTrack(tracks)?.id).toBe("human");
    expect(
      pickTrack(tracks.filter((item) => item.id !== "human"))?.id,
    ).toBe("forced");
    expect(
      pickTrack(
        tracks.filter((item) => item.id === "auto" || item.id === "mystery"),
      )?.id,
    ).toBe("auto");
    expect(pickTrack([track({ id: "mystery", trackKind: "future-kind" })])?.id).toBe(
      "mystery",
    );
  });

  it("excludes failed tracks and returns undefined when nothing is usable", () => {
    expect(
      pickTrack([
        track({ id: "bad", trackKind: "standard", status: "failed" }),
        track({ id: "good", trackKind: "asr" }),
      ])?.id,
    ).toBe("good");
    expect(pickTrack([])).toBeUndefined();
    expect(
      pickTrack([track({ id: "bad", status: "failed" })]),
    ).toBeUndefined();
  });
});

describe("downloadCaptions", () => {
  it("requests SRT with the OAuth token", async () => {
    const seen: Array<{ url: string; auth: unknown }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        text: async () => {
          seen.push({
            url: String(url),
            auth: (init?.headers as Record<string, string>)?.Authorization,
          });
          return "1\n00:00:01,000 --> 00:00:02,000\nHi\n";
        },
      }) as Response) as unknown as typeof fetch;
    await expect(downloadCaptions("t1", "at", fetchFn)).resolves.toContain(
      "Hi",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain("/youtube/v3/captions/t1");
    expect(seen[0]?.url).toContain("tfmt=srt");
    expect(seen[0]?.auth).toBe("Bearer at");
  });

  it("throws on an HTTP error", async () => {
    const fetchFn = (async () =>
      ({ ok: false, status: 404, text: async () => "" }) as Response) as unknown as typeof fetch;
    await expect(downloadCaptions("t1", "at", fetchFn)).rejects.toThrow(
      "download failed (404)",
    );
  });
});
