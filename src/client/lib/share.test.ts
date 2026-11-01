import { describe, expect, it } from "vitest";
import { shareText } from "./share";

describe("shareText", () => {
  it("puts the sentence in curly quotes above the URL", () => {
    expect(shareText("never give up", "https://www.youtube.com/watch?v=vid1")).toBe(
      "“never give up”\nhttps://www.youtube.com/watch?v=vid1",
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
});
