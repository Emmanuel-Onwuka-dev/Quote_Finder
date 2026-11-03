import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import type { ErrorEvent, EventHint } from "@sentry/node";
import { captureAlert, initAlerts } from "./alerts";

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

// Fake DSN (.test host): proves the plumbing without pointing anywhere real.
const FAKE_DSN = "https://publickey@sentry.test/123";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("captureAlert", () => {
  it("does nothing when init was never called", async () => {
    vi.resetModules();
    const fresh = await import("./alerts");
    const freshSentry = await import("@sentry/node");
    fresh.captureAlert("ranking", new Error("boom"), { shortlistSize: 3 });
    expect(freshSentry.captureException).not.toHaveBeenCalled();
  });

  it("stays off when no DSN is set", () => {
    initAlerts("");
    initAlerts(undefined);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("sends the step tag and context once initialised", () => {
    initAlerts(FAKE_DSN);
    const error = new Error("boom");
    captureAlert("ranking", error, { shortlistSize: 3 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { step: "ranking" },
      extra: { shortlistSize: 3 },
    });
  });
});

describe("beforeSend", () => {
  async function scrubbed(event: ErrorEvent): Promise<ErrorEvent | null> {
    initAlerts(FAKE_DSN);
    const calls = vi.mocked(Sentry.init).mock.calls;
    const beforeSend = calls[calls.length - 1]?.[0]?.beforeSend;
    expect(typeof beforeSend).toBe("function");
    return beforeSend!(event, {} as EventHint);
  }

  it("removes request and user data and redacts secrets", async () => {
    const out = await scrubbed({
      type: undefined,
      message: "fetch https://x.test/cb?code=abc123 failed",
      request: {
        url: "https://app.test/api?q=remembered+line",
        headers: { authorization: "Bearer secret" },
        cookies: { session: "abc" },
        data: { quote: "remembered line" },
        query_string: "q=remembered+line",
      },
      user: { id: "user-1" },
      extra: { apiKey: "not-a-real-key", status: 502, quoteLength: 15 },
      exception: {
        values: [
          {
            type: "Error",
            value: "boom ?token=placeholder-token-value",
          },
        ],
      },
      breadcrumbs: [
        {
          message:
            "GET https://www.googleapis.com/youtube/v3/search?q=test&key=FAKE_TEST_KEY_NOT_REAL",
          data: {
            url: "https://www.googleapis.com/youtube/v3/search?q=test&key=FAKE_TEST_KEY_NOT_REAL",
            status_code: 200,
          },
        },
      ],
    });
    expect(out).not.toBeNull();
    expect(out?.request).toBeUndefined();
    expect(out?.user).toBeUndefined();
    expect(String(out?.message)).not.toContain("code=abc123");
    expect(String(out?.message)).toContain("[redacted]");
    expect(out?.extra?.["apiKey"]).toBe("[redacted]");
    expect(out?.extra?.["status"]).toBe(502);
    expect(out?.extra?.["quoteLength"]).toBe(15);
    const excValue = String(out?.exception?.values?.[0]?.value ?? "");
    expect(excValue).not.toContain("token=placeholder-token-value");
    expect(excValue).toContain("[redacted]");
    const crumb = out?.breadcrumbs?.[0];
    expect(String(crumb?.message)).not.toContain("key=FAKE_TEST_KEY_NOT_REAL");
    expect(String(crumb?.message)).not.toContain("q=test");
    expect(String(crumb?.message)).toContain("[redacted]");
    expect(String((crumb?.data as Record<string, unknown> | undefined)?.["url"] ?? "")).not.toContain(
      "key=FAKE_TEST_KEY_NOT_REAL",
    );
    expect((crumb?.data as Record<string, unknown> | undefined)?.["status_code"]).toBe(200);
  });
});
