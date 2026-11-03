import { describe, expect, it } from "vitest";
import { shouldKeepTurn } from "./turns";

describe("shouldKeepTurn", () => {
  it("drops a cancelled turn", () => {
    expect(shouldKeepTurn({ status: "cancelled" })).toBe(false);
  });

  it("keeps live and finished turns", () => {
    for (const status of ["streaming", "done", "error"]) {
      expect(shouldKeepTurn({ status })).toBe(true);
    }
  });

  it("removes cancelled turns from a list", () => {
    const turns = [
      { status: "done" },
      { status: "cancelled" },
      { status: "error" },
    ];
    expect(turns.filter(shouldKeepTurn)).toEqual([
      { status: "done" },
      { status: "error" },
    ]);
  });
});
