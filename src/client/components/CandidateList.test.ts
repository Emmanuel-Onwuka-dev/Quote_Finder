import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CandidateList } from "./CandidateList";

describe("CandidateList", () => {
  it("renders only the notes when the list is empty", () => {
    const html = renderToStaticMarkup(
      createElement(CandidateList, {
        candidates: [],
        notes: [
          "The search limit for today is reached.",
          "No verified links were found.",
        ],
        publishedAt: "",
        timeWindow: "",
      }),
    );
    expect(html).toContain("The search limit for today is reached.");
    expect(html).toContain("No verified links were found.");
    expect(html).not.toContain("Possible matches");
  });

  it("renders the heading, candidates, and notes together", () => {
    const html = renderToStaticMarkup(
      createElement(CandidateList, {
        candidates: [
          { url: "", title: "A video", creator: "Someone", reason: "" },
        ],
        notes: ["Matched the title and description."],
        publishedAt: "",
        timeWindow: "any time",
      }),
    );
    expect(html).toContain("Possible matches");
    expect(html).toContain("A video");
    expect(html).toContain("Matched the title and description.");
  });

  it("renders nothing with no candidates and no notes", () => {
    const html = renderToStaticMarkup(
      createElement(CandidateList, {
        candidates: [],
        notes: [],
        publishedAt: "",
        timeWindow: "",
      }),
    );
    expect(html).toBe("");
  });
});
