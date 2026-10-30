import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatStamp,
  timeWindowLabel,
  videoIdFromUrl,
  youtubeEmbedUrl,
} from "./format";

describe("timeWindowLabel", () => {
  it("labels the preset windows", () => {
    const cases: [number, string][] = [
      [0, "any time"],
      [1, "24 hours"],
      [7, "7 days"],
      [30, "30 days"],
      [60, "2 months"],
      [180, "6 months"],
      [365, "1 year"],
    ];
    for (const [days, label] of cases) {
      expect(timeWindowLabel(days)).toBe(label);
    }
  });

  it("labels custom day counts", () => {
    expect(timeWindowLabel(45)).toBe("45 days");
  });
});

describe("videoIdFromUrl", () => {
  it("reads watch URLs", () => {
    expect(
      videoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toBe("dQw4w9WgXcQ");
  });

  it("reads youtu.be, embed, shorts, and live URLs", () => {
    expect(videoIdFromUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(
      videoIdFromUrl("https://www.youtube.com/embed/dQw4w9WgXcQ"),
    ).toBe("dQw4w9WgXcQ");
    expect(
      videoIdFromUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
    ).toBe("dQw4w9WgXcQ");
    expect(videoIdFromUrl("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("ignores extra query parameters", () => {
    expect(
      videoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"),
    ).toBe("dQw4w9WgXcQ");
  });

  it("returns empty for non-YouTube and malformed URLs", () => {
    expect(videoIdFromUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBe(
      "",
    );
    expect(videoIdFromUrl("https://www.youtube.com/watch")).toBe("");
    expect(videoIdFromUrl("not a url")).toBe("");
    expect(videoIdFromUrl("")).toBe("");
  });
});

describe("youtubeEmbedUrl", () => {
  it("builds the nocookie embed URL without a start time", () => {
    expect(youtubeEmbedUrl("dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1",
    );
  });

  it("starts the embed at the verified second", () => {
    expect(youtubeEmbedUrl("dQw4w9WgXcQ", 61)).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&start=61",
    );
    expect(youtubeEmbedUrl("dQw4w9WgXcQ", 61.7)).toContain("&start=61");
    expect(youtubeEmbedUrl("dQw4w9WgXcQ", 0)).not.toContain("start=");
    expect(youtubeEmbedUrl("dQw4w9WgXcQ", -5)).not.toContain("start=");
  });
});

describe("formatStamp", () => {
  it("formats whole seconds as M:SS", () => {
    expect(formatStamp(0)).toBe("0:00");
    expect(formatStamp(5)).toBe("0:05");
    expect(formatStamp(61)).toBe("1:01");
    expect(formatStamp(61.7)).toBe("1:01");
    expect(formatStamp(-3)).toBe("0:00");
  });
});

describe("formatDate", () => {
  it("trims ISO timestamps to the date", () => {
    expect(formatDate("2026-10-01T14:22:31Z")).toBe("2026-10-01");
    expect(formatDate("2026-10-01")).toBe("2026-10-01");
  });

  it("returns empty for missing or unparseable input", () => {
    expect(formatDate("")).toBe("");
    expect(formatDate("yesterday")).toBe("");
  });
});
