import { describe, expect, it } from "vitest";
import { createDailyCallBudget } from "./daily-budget";

describe("createDailyCallBudget", () => {
  it("reaches the cap after the limit", () => {
    const budget = createDailyCallBudget(
      3,
      () => new Date("2026-10-30T12:00:00Z"),
    );
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    expect(budget.take()).toBe(false);
  });

  it("resets the counter on the next UTC day", () => {
    let now = new Date("2026-10-30T12:00:00Z");
    const budget = createDailyCallBudget(1, () => now);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    now = new Date("2026-10-31T00:00:01Z");
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });

  it("returns false only after the limit is reached", () => {
    const budget = createDailyCallBudget(
      2,
      () => new Date("2026-10-30T12:00:00Z"),
    );
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });
});
