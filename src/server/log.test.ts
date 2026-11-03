import { afterEach, describe, expect, it, vi } from "vitest";
import { logError } from "./log";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logError", () => {
  it("redacts key-looking values in context", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("quote card", new Error("boom"), {
      apiKey: "not-a-real-key",
      status: 502,
    });
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String(errors.mock.calls[0]?.[0]);
    expect(line).toContain("[quotefinder] quote card failed: boom");
    expect(line).not.toContain("not-a-real-key");
    expect(line).toContain("[redacted]");
    expect(line).toContain("502");
  });

  it("logs a non-Error throw as a string", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("transcribe", "string-throw");
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toBe(
      "[quotefinder] transcribe failed: string-throw",
    );
  });

  it("strips the query string from messages", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("token revoke", new Error("fetch https://x.test/cb?code=abc&x=1 failed"));
    const line = String(errors.mock.calls[0]?.[0]);
    expect(line).not.toContain("code=abc");
    expect(line).toContain("[redacted]");
  });
});
