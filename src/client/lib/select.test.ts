import { describe, expect, it } from "vitest";
import { selectAllLoaded, selectAllNeedingIndex } from "./select";

describe("selectAllNeedingIndex", () => {
  it("excludes fresh videos", () => {
    const videos = [
      { id: "fresh1", indexed: "fresh" as const },
      { id: "never1", indexed: "never" as const },
      { id: "expired1", indexed: "expired" as const },
    ];
    expect(selectAllNeedingIndex(videos)).toEqual(["never1", "expired1"]);
  });

  it("returns an empty array for an empty list", () => {
    expect(selectAllNeedingIndex([])).toEqual([]);
  });

  it("returns all 250 IDs when 250 videos need indexing", () => {
    const videos = Array.from({ length: 250 }, (_, i) => ({
      id: `video-${i}`,
      indexed: "never" as const,
    }));
    const ids = selectAllNeedingIndex(videos);
    expect(ids).toHaveLength(250);
    expect(ids[0]).toBe("video-0");
    expect(ids[249]).toBe("video-249");
  });
});

describe("selectAllLoaded", () => {
  it("returns every ID in list order, including indexed ones", () => {
    const videos = [
      { id: "fresh1", indexed: "fresh" as const },
      { id: "never1", indexed: "never" as const },
      { id: "expired1", indexed: "expired" as const },
    ];
    expect(selectAllLoaded(videos)).toEqual([
      "fresh1",
      "never1",
      "expired1",
    ]);
  });

  it("returns an empty array for an empty list", () => {
    expect(selectAllLoaded([])).toEqual([]);
  });
});
