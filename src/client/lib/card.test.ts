import { describe, expect, it } from "vitest";
import { cardTextSize, wrapSentence } from "./card";

describe("wrapSentence", () => {
  it("keeps a short sentence on one line", () => {
    expect(wrapSentence("never give up", 34)).toEqual(["never give up"]);
  });

  it("wraps a long sentence without splitting words", () => {
    const lines = wrapSentence("the quick brown fox jumps over", 10);
    expect(lines).toEqual(["the quick", "brown fox", "jumps over"]);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(10);
    }
  });

  it("ends an overlong sentence with an ellipsis after 8 lines", () => {
    const sentence = Array.from({ length: 20 }, (_, i) => `w${i + 1}`).join(
      " ",
    );
    const lines = wrapSentence(sentence, 5);
    expect(lines).toHaveLength(8);
    expect(lines[7]?.endsWith("…")).toBe(true);
    for (const line of lines.slice(0, 7)) {
      expect(line.endsWith("…")).toBe(false);
    }
  });
});

describe("cardTextSize", () => {
  it("steps down as lines increase", () => {
    expect(cardTextSize(1)).toBe(56);
    expect(cardTextSize(3)).toBe(56);
    expect(cardTextSize(4)).toBe(48);
    expect(cardTextSize(5)).toBe(48);
    expect(cardTextSize(6)).toBe(40);
    expect(cardTextSize(8)).toBe(40);
  });
});
