import { describe, expect, it } from "vitest";
import {
  cueWindows,
  matchArchive,
  matchVideo,
  noMatchResult,
  toArchiveResult,
  type ArchiveVideoCues,
} from "./match";
import type { CaptionCue } from "./srt";

function cue(idx: number, startSeconds: number, text: string): CaptionCue {
  return { idx, startSeconds, endSeconds: startSeconds + 2, text };
}

function video(overrides: Partial<ArchiveVideoCues> = {}): ArchiveVideoCues {
  return {
    videoId: "vid1",
    title: "Workshop rebuild",
    publishedAt: "2026-10-29T00:00:00Z",
    channelTitle: "Test Channel",
    trackKind: "standard",
    cues: [],
    ...overrides,
  };
}

const WORKSHOP = [
  cue(1, 0, "welcome back to the workshop"),
  cue(2, 5, "today we rebuild the carburetor"),
  cue(3, 9, "from absolute scratch together"),
  cue(4, 14, "grab your wrenches and follow along"),
  cue(5, 20, "first disconnect the battery cables"),
  cue(6, 26, "safety glasses on before sparks fly"),
];
const QUOTE = "today we rebuild the carburetor from absolute scratch";

describe("cueWindows", () => {
  it("returns no windows for videos without cues", () => {
    expect(cueWindows([])).toEqual([]);
  });

  it("gives short videos a single window of whatever they have", () => {
    expect(cueWindows(WORKSHOP.slice(0, 2))).toEqual([
      WORKSHOP.slice(0, 2),
    ]);
  });

  it("slides every size from 3 to 6 cues", () => {
    const windows = cueWindows(WORKSHOP);
    expect(windows.length).toBe(4 + 3 + 2 + 1);
    expect(windows[0]?.length).toBe(3);
    expect(windows[windows.length - 1]?.length).toBe(6);
  });
});

describe("matchVideo", () => {
  it("finds the best window with a verified timestamp", () => {
    const hit = matchVideo(video({ cues: WORKSHOP }), QUOTE);
    expect(hit).toMatchObject({
      videoId: "vid1",
      title: "Workshop rebuild",
      publishedAt: "2026-10-29T00:00:00Z",
      creator: "Test Channel",
      startSeconds: 5,
      trackKind: "standard",
      trackLabel: "verified from the creator's captions",
      confidence: "high",
      text: "today we rebuild the carburetor from absolute scratch together",
      url: "https://www.youtube.com/watch?v=vid1&t=5s",
    });
    expect(hit?.score).toBeGreaterThanOrEqual(0.8);
  });

  it("caps auto-generated captions at medium", () => {
    const hit = matchVideo(
      video({ cues: WORKSHOP, trackKind: "asr" }),
      QUOTE,
    );
    expect(hit?.score).toBeGreaterThanOrEqual(0.8);
    expect(hit).toMatchObject({
      confidence: "medium",
      trackKind: "asr",
      trackLabel: "verified from auto-generated captions",
    });
  });

  it("treats forced captions as standard", () => {
    const hit = matchVideo(
      video({ cues: WORKSHOP, trackKind: "forced" }),
      QUOTE,
    );
    expect(hit).toMatchObject({
      confidence: "high",
      trackKind: "standard",
      trackLabel: "verified from the creator's captions",
    });
  });

  it("rejects windows missing the distinctive words", () => {
    const garden = [
      cue(1, 0, "evening stroll through the garden"),
      cue(2, 4, "the roses smell wonderful tonight"),
      cue(3, 8, "we should visit again soon"),
    ];
    // Overlap alone is ~0.7 here; only the key-coverage guard rejects it.
    expect(
      matchVideo(video({ cues: garden }), "supercalifragilistic evening stroll"),
    ).toBeNull();
  });

  it("lets variants rescue a quote that misses", () => {
    expect(
      matchVideo(video({ cues: WORKSHOP }), "completely unrelated sentence"),
    ).toBeNull();
    const hit = matchVideo(
      video({ cues: WORKSHOP }),
      "completely unrelated sentence",
      [QUOTE],
    );
    expect(hit?.startSeconds).toBe(5);
  });

  it("matches short videos and floors the timestamp link", () => {
    const short = [
      cue(1, 61.7, "the lighthouse keeper waved"),
      cue(2, 64, "from the rocky harbor shore"),
    ];
    const hit = matchVideo(
      video({ cues: short }),
      "lighthouse keeper waved from the harbor",
    );
    expect(hit?.startSeconds).toBe(61);
    expect(hit?.url).toBe("https://www.youtube.com/watch?v=vid1&t=61s");
  });

  it("returns null when nothing is close", () => {
    expect(matchVideo(video({ cues: [] }), QUOTE)).toBeNull();
    expect(matchVideo(video({ cues: WORKSHOP }), "")).toBeNull();
    expect(
      matchVideo(video({ cues: WORKSHOP }), "zebra elephant giraffe"),
    ).toBeNull();
  });
});

describe("matchArchive", () => {
  it("keeps the best match across videos", () => {
    const garden = video({
      videoId: "v-garden",
      cues: [cue(1, 0, "they rebuild each carburetor in absolute silence")],
    });
    expect(matchVideo(garden, QUOTE)?.confidence).toBe("medium");
    const hit = matchArchive(
      [garden, video({ videoId: "v-shop", cues: WORKSHOP })],
      QUOTE,
    );
    expect(hit?.videoId).toBe("v-shop");
  });

  it("keeps the first video on ties", () => {
    const hit = matchArchive(
      [
        video({ videoId: "v1", cues: WORKSHOP }),
        video({ videoId: "v2", cues: WORKSHOP }),
      ],
      QUOTE,
    );
    expect(hit?.videoId).toBe("v1");
  });

  it("returns null for an empty archive", () => {
    expect(matchArchive([], QUOTE)).toBeNull();
  });
});

describe("archive result envelopes", () => {
  it("carries the verified timestamp and refresh note", () => {
    const hit = matchVideo(video({ cues: WORKSHOP }), QUOTE);
    expect(hit).not.toBeNull();
    if (!hit) {
      return;
    }
    expect(toArchiveResult(hit, ["old1"], false)).toEqual({
      found: true,
      confidence: "high",
      creator: "Test Channel",
      videoTitle: "Workshop rebuild",
      videoUrl: "https://www.youtube.com/watch?v=vid1&t=5s",
      publishedAt: "2026-10-29T00:00:00Z",
      startSeconds: 5,
      timestampVerified: true,
      trackKind: "standard",
      trackLabel: "verified from the creator's captions",
      text: "today we rebuild the carburetor from absolute scratch together",
      refreshed: ["old1"],
      refreshPaused: false,
      notes: [],
    });
  });

  it("reports a miss with its refresh state", () => {
    expect(noMatchResult([], true, ["budget spent"])).toEqual({
      found: false,
      confidence: null,
      creator: "",
      videoTitle: "",
      videoUrl: "",
      publishedAt: "",
      startSeconds: 0,
      timestampVerified: false,
      trackKind: null,
      trackLabel: "",
      text: "",
      refreshed: [],
      refreshPaused: true,
      notes: ["budget spent"],
    });
  });
});
