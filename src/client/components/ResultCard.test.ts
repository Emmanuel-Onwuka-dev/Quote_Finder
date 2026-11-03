import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LocateResult } from "../hooks/useQuoteStream";
import { ResultCard, selectedMain } from "./ResultCard";

function candidate(index: number) {
  return {
    url: `https://www.youtube.com/watch?v=video${index}`,
    title: `Match ${index}`,
    creator: `Creator ${index}`,
    publishedAt: `2026-11-0${index}T00:00:00Z`,
    reason: `Reason ${index}`,
  };
}

function foundResult(count: number): LocateResult {
  return {
    found: true,
    confidence: "medium",
    creator: "Main Creator",
    videoTitle: "Main video",
    videoUrl: "https://www.youtube.com/watch?v=mainvideo0",
    publishedAt: "2026-10-01T00:00:00Z",
    startTime: 0,
    startEstimate: false,
    timestampVerified: false,
    fullSentence: "A remembered line.",
    context: [],
    notes: [],
    candidates: Array.from({ length: count }, (_, i) => candidate(i + 1)),
    engine: { scanned: 1, channelTitle: "", channelId: "", videoCount: 1 },
  };
}

function render(count: number): string {
  return renderToStaticMarkup(
    createElement(ResultCard, {
      result: foundResult(count),
      timeWindow: "any time",
    }),
  );
}

describe("ResultCard other matches", () => {
  it("shows up to 4 more matches with title, creator, window, and note", () => {
    const html = render(5);
    expect(html).toContain("Other matches");
    expect(html).toContain("Match 1");
    expect(html).toContain("Match 4");
    expect(html).not.toContain("Match 5");
    expect(html).toContain("Creator 1 · any time");
    expect(html).toContain(
      "The exact moment this line is said has not been verified.",
    );
  });

  it("hides the heading when there is only one result", () => {
    const html = render(0);
    expect(html).toContain("Main video");
    expect(html).not.toContain("Other matches");
  });

  it("shows a single other match", () => {
    const html = render(1);
    expect(html).toContain("Other matches");
    expect(html).toContain("Match 1");
  });
});

describe("selectedMain", () => {
  it("uses the selected runner-up's own date, never the main video's", () => {
    const result = foundResult(2);
    const main = selectedMain(result, 0);
    expect(main.videoTitle).toBe("Match 1");
    expect(main.publishedAt).toBe("2026-11-01T00:00:00Z");
    expect(main.publishedAt).not.toBe(result.publishedAt);
  });

  it("shows no date when the selected runner-up has none", () => {
    const result = foundResult(1);
    const undated = {
      ...result.candidates[0]!,
      publishedAt: "",
    };
    const main = selectedMain(
      { ...result, candidates: [undated] },
      0,
    );
    expect(main.publishedAt).toBe("");
  });

  it("keeps the original result when nothing is selected", () => {
    const result = foundResult(2);
    expect(selectedMain(result, null)).toBe(result);
  });
});
