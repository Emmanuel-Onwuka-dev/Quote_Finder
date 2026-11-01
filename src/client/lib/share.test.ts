import { describe, expect, it } from "vitest";
import { cardActions, shareText } from "./share";

describe("shareText", () => {
  it("labels the sentence as a remembered, unverified line above the URL", () => {
    expect(shareText("never give up", "https://www.youtube.com/watch?v=vid1")).toBe(
      "Remembered line: “never give up” (not verified)\nhttps://www.youtube.com/watch?v=vid1",
    );
  });

  it("returns only the URL when the sentence is empty", () => {
    expect(shareText("", "https://www.youtube.com/watch?v=vid1")).toBe(
      "https://www.youtube.com/watch?v=vid1",
    );
    expect(shareText("   ", "https://www.youtube.com/watch?v=vid1")).toBe(
      "https://www.youtube.com/watch?v=vid1",
    );
  });

  it("always includes the URL", () => {
    const url = "https://www.youtube.com/watch?v=vid9";
    expect(shareText("some line", url)).toContain(url);
    expect(shareText("", url)).toContain(url);
  });

  it("marks the output as not verified", () => {
    expect(shareText("some line", "https://www.youtube.com/watch?v=vid1")).toContain(
      "(not verified)",
    );
  });
});

describe("cardActions", () => {
  it("shows every action for a found result with a loaded image", () => {
    expect(cardActions({ found: true }, true)).toEqual({
      share: true,
      download: true,
      copyLink: true,
    });
  });

  it("hides download for a found result without a loaded image", () => {
    expect(cardActions({ found: true }, false)).toEqual({
      share: true,
      download: false,
      copyLink: true,
    });
  });

  it("hides share and download for a not-found result", () => {
    expect(cardActions({ found: false }, false)).toEqual({
      share: false,
      download: false,
      copyLink: true,
    });
    expect(cardActions({ found: false }, true)).toEqual({
      share: false,
      download: false,
      copyLink: true,
    });
  });
});
