import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CandidateList } from "./CandidateList";

describe("CandidateList", () => {
  it("renders nothing when the list is empty", () => {
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

  it("shows the heading when candidates exist", () => {
    const html = renderToStaticMarkup(
      createElement(CandidateList, {
        candidates: [
          { url: "", title: "A video", creator: "Someone", reason: "" },
        ],
        notes: [],
        publishedAt: "",
        timeWindow: "any time",
      }),
    );
    expect(html).toContain("Possible matches");
  });
});
