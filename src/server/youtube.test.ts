import { describe, expect, it } from "vitest";
import {
  filterAfter,
  mergeShortlist,
  parseCreatorInput,
  scoreVideo,
  toPublishedAfter,
  type VideoMeta,
} from "./youtube";

function video(partial: Partial<VideoMeta> & { id: string }): VideoMeta {
  return {
    title: "",
    publishedAt: "2026-10-01T00:00:00Z",
    description: "",
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
