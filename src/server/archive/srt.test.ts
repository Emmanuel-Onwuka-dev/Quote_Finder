import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSrt } from "./srt";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

describe("parseSrt", () => {
  it("parses cue indexes, times, and text", () => {
    expect(parseSrt(fixture("basic.srt"))).toEqual([
      {
        idx: 1,
        startSeconds: 1,
        endSeconds: 4.5,
        text: "Welcome back to the workshop",
      },
      {
        idx: 2,
        startSeconds: 5,
        endSeconds: 8.25,
        text: "Today we restore a rusty bicycle frame\nstarting with the rear wheel",
      },
      {
        idx: 3,
        startSeconds: 70.75,
        endSeconds: 74,
        text: "And that is how the gears align",
      },
    ]);
  });

  it("accepts dot decimals, strips tags, and skips bad blocks", () => {
    expect(parseSrt(fixture("edge.srt"))).toEqual([
      {
        idx: 1,
        startSeconds: 1,
        endSeconds: 2,
        text: "Dot decimals still parse",
      },
      { idx: 3, startSeconds: 5, endSeconds: 6, text: "Tags are stripped" },
      { idx: 6, startSeconds: 11, endSeconds: 12.5, text: "Kept after the gaps" },
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(
      parseSrt("1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n"),
    ).toEqual([{ idx: 1, startSeconds: 1, endSeconds: 2, text: "Hi" }]);
  });

  it("returns no cues for empty input", () => {
    expect(parseSrt("")).toEqual([]);
    expect(parseSrt("\n\n")).toEqual([]);
  });
});
