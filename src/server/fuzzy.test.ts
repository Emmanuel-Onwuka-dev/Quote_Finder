import { describe, expect, it } from "vitest";
import {
  analyzeOverlap,
  close,
  keyCoverage,
  overlapScore,
  stem,
  tokens,
} from "./fuzzy";

describe("tokens", () => {
  it("lowercases and strips punctuation", () => {
    expect(tokens("Hello, WORLD!")).toEqual(["hello", "world"]);
  });

  it("drops stop words", () => {
    expect(tokens("the cat and the dog")).toEqual(["cat", "dog"]);
  });

  it("stems suffixes", () => {
    expect(tokens("remembered cats stories")).toEqual([
      "remember",
      "cat",
      "story",
    ]);
  });

  it("dedupes to a word set", () => {
    expect(tokens("go go go")).toEqual(["go"]);
  });
});

describe("stem", () => {
  it("handles common suffixes", () => {
    expect(stem("running")).toBe("runn");
    expect(stem("remembered")).toBe("remember");
    expect(stem("watches")).toBe("watch");
    expect(stem("cats")).toBe("cat");
    expect(stem("stories")).toBe("story");
    expect(stem("tried")).toBe("try");
    expect(stem("nearly")).toBe("near");
  });

  it("leaves short words alone", () => {
    expect(stem("run")).toBe("run");
    expect(stem("go")).toBe("go");
    expect(stem("is")).toBe("is");
  });
});

describe("close", () => {
  it("matches identical and distance-1 words", () => {
    expect(close("cat", "cat")).toBe(true);
    expect(close("cat", "bat")).toBe(true);
    expect(close("colour", "color")).toBe(true);
  });

  it("rejects distance beyond max", () => {
    expect(close("cat", "dog")).toBe(false);
    expect(close("kitten", "sitting")).toBe(false);
    expect(close("kitten", "sitting", 3)).toBe(true);
  });
});

describe("overlapScore", () => {
  it("scores an exact match at 1", () => {
    expect(overlapScore("red bicycle", "a red bicycle")).toBe(1);
  });

  it("scores nothing at 0", () => {
    expect(overlapScore("quantum bicycle", "cooking pasta dinner")).toBe(0);
  });

  it("weights rare words more than common ones", () => {
    const rare = overlapScore("bicycle", "shiny bicycle");
    const common = overlapScore("red", "shiny red car");
    expect(rare).toBe(1);
    expect(common).toBe(1);
    const partialRare = overlapScore("red bicycle", "bicycle shop");
    const partialCommon = overlapScore("red bicycle", "red shop");
    expect(partialRare).toBeGreaterThan(partialCommon);
  });

  it("counts near-misses at 80%", () => {
    const exact = overlapScore("color", "the color red");
    const near = overlapScore("colour", "the color red");
    expect(exact).toBe(1);
    expect(near).toBeCloseTo(0.8, 5);
  });

  it("rewards remembered word order", () => {
    const ordered = overlapScore("alpha beta delta", "alpha beta gamma");
    const reversed = overlapScore("alpha beta delta", "beta gamma alpha");
    expect(ordered).toBeGreaterThan(reversed);
    expect(ordered - reversed).toBeCloseTo(0.12, 5);
  });

  it("returns 0 for an empty needle", () => {
    expect(overlapScore("the and", "anything here")).toBe(0);
  });
});

describe("analyzeOverlap", () => {
  it("reports the matched words", () => {
    const result = analyzeOverlap("red bicycle day", "a red bicycle");
    expect(result.matchedWords).toEqual(["red", "bicycle"]);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(1);
  });
});

describe("keyCoverage", () => {
  it("measures the fraction of distinctive words present", () => {
    expect(keyCoverage("quantum bicycle", "a quantum leap")).toBe(0.5);
    expect(keyCoverage("quantum bicycle", "quantum bicycle")).toBe(1);
  });

  it("counts near-misses", () => {
    expect(keyCoverage("bicycle", "bicycles for sale")).toBe(1);
  });

  it("passes vacuously when there is nothing distinctive to guard", () => {
    expect(keyCoverage("go now", "something else entirely")).toBe(1);
  });
});
