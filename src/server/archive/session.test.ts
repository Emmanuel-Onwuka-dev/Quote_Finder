import { describe, expect, it } from "vitest";
import { SESSION_TTL_MS, issueSession, verifySession } from "./session";

const TEST_KEY = "ab".repeat(32);
const OTHER_KEY = "cd".repeat(32);
const NOW = new Date("2026-10-30T12:00:00Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe("channel sessions", () => {
  it("round-trips channel IDs, deduplicated and sorted", () => {
    const value = issueSession(["UCb", "UCa", "UCb", ""], NOW, TEST_KEY);
    expect(verifySession(value, NOW, TEST_KEY)).toEqual(["UCa", "UCb"]);
  });

  it("rejects tampered bodies and signatures", () => {
    const value = issueSession(["UCchan1"], NOW, TEST_KEY);
    const [version, encoded, signature] = value.split(".");
    const flipped = (s: string) =>
      s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
    expect(
      verifySession(`${version}.${flipped(encoded ?? "")}.${signature}`, NOW, TEST_KEY),
    ).toBeNull();
    expect(
      verifySession(`${version}.${encoded}.${flipped(signature ?? "")}`, NOW, TEST_KEY),
    ).toBeNull();
    expect(verifySession("v1.bogus", NOW, TEST_KEY)).toBeNull();
    expect(verifySession("garbage", NOW, TEST_KEY)).toBeNull();
    expect(verifySession("", NOW, TEST_KEY)).toBeNull();
    expect(verifySession(undefined, NOW, TEST_KEY)).toBeNull();
  });

  it("rejects expired sessions but accepts fresh ones", () => {
    const value = issueSession(["UCchan1"], NOW, TEST_KEY);
    expect(verifySession(value, NOW + 29 * DAY_MS, TEST_KEY)).toEqual([
      "UCchan1",
    ]);
    expect(verifySession(value, NOW + 31 * DAY_MS, TEST_KEY)).toBeNull();
  });

  it("expires 30 days after issue", () => {
    expect(SESSION_TTL_MS).toBe(30 * DAY_MS);
    const value = issueSession(["UCchan1"], NOW, TEST_KEY);
    expect(verifySession(value, NOW + SESSION_TTL_MS - 1, TEST_KEY)).toEqual([
      "UCchan1",
    ]);
    expect(verifySession(value, NOW + SESSION_TTL_MS, TEST_KEY)).toBeNull();
  });

  it("rejects sessions signed with another key", () => {
    const value = issueSession(["UCchan1"], NOW, OTHER_KEY);
    expect(verifySession(value, NOW, TEST_KEY)).toBeNull();
  });

  it("fails closed on a misconfigured key", () => {
    expect(() => issueSession(["UCchan1"], NOW, "short")).toThrow();
    const value = issueSession(["UCchan1"], NOW, TEST_KEY);
    expect(verifySession(value, NOW, "short")).toBeNull();
  });
});
