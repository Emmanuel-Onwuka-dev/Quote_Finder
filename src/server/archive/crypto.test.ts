import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, parseTokenKey } from "./crypto";

const TEST_KEY = "ab".repeat(32);
const WRONG_KEY = "cd".repeat(32);

describe("parseTokenKey", () => {
  it("accepts 32 bytes as hex", () => {
    expect(parseTokenKey(TEST_KEY)).toHaveLength(32);
  });

  it("rejects short, long, and non-hex keys", () => {
    expect(() => parseTokenKey("ab".repeat(31))).toThrow(
      "ARCHIVE_TOKEN_KEY",
    );
    expect(() => parseTokenKey("ab".repeat(33))).toThrow(
      "ARCHIVE_TOKEN_KEY",
    );
    expect(() => parseTokenKey("zz".repeat(32))).toThrow(
      "ARCHIVE_TOKEN_KEY",
    );
    expect(() => parseTokenKey("")).toThrow("ARCHIVE_TOKEN_KEY");
  });
});

describe("encryptToken / decryptToken", () => {
  it("round-trips a refresh token", () => {
    const stored = encryptToken("1//refresh-token-value", TEST_KEY);
    expect(decryptToken(stored, TEST_KEY)).toBe("1//refresh-token-value");
  });

  it("uses a fresh iv for every encryption", () => {
    const first = encryptToken("same", TEST_KEY);
    const second = encryptToken("same", TEST_KEY);
    expect(first).not.toBe(second);
    expect(decryptToken(first, TEST_KEY)).toBe("same");
    expect(decryptToken(second, TEST_KEY)).toBe("same");
  });

  it("fails closed on the wrong key", () => {
    const stored = encryptToken("secret", TEST_KEY);
    expect(() => decryptToken(stored, WRONG_KEY)).toThrow();
  });

  it("rejects malformed stored data", () => {
    expect(() => decryptToken("not-encrypted", TEST_KEY)).toThrow(
      "not valid encrypted data",
    );
    expect(() => decryptToken("00:11", TEST_KEY)).toThrow(
      "not valid encrypted data",
    );
    expect(() => decryptToken("", TEST_KEY)).toThrow(
      "not valid encrypted data",
    );
  });

  it("rejects tampered ciphertext", () => {
    const stored = encryptToken("secret", TEST_KEY);
    const tampered = `${stored.slice(0, -2)}${stored.endsWith("00") ? "ff" : "00"}`;
    expect(() => decryptToken(tampered, TEST_KEY)).toThrow();
  });
});
