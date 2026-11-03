import { afterEach, describe, expect, it, vi } from "vitest";
import { logError, logMetaCall } from "./log";

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

describe("logMetaCall", () => {
  it("prints model, path, status, and duration on one line", () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    logMetaCall("muse-spark-1.3", "/chat/completions", 200, Date.now() - 1400);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(String(logs.mock.calls[0]?.[0])).toMatch(
      /^\[meta\] muse-spark-1\.3 \/chat\/completions 200 1\.4s$/,
    );
  });

  it("prints failed when the request never got a response", () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    logMetaCall("muse-spark-1.3", "/chat/completions", 0, Date.now());
    const line = String(logs.mock.calls[0]?.[0]);
    expect(line).toContain("failed");
    expect(line).not.toContain(" 0 ");
  });

  it("never prints the host, a query string, or a key value", () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    logMetaCall(
      "muse-spark-1.3",
      "https://meta.test/v1/chat/completions?key=not-a-real-key",
      200,
      Date.now(),
    );
    const line = String(logs.mock.calls[0]?.[0]);
    expect(line).toContain("/chat/completions");
    expect(line).not.toContain("meta.test");
    expect(line).not.toContain("?");
    expect(line).not.toContain("not-a-real-key");
  });
});
