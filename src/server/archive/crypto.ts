// Refresh-token encryption (AES-256-GCM). The key comes from
// ARCHIVE_TOKEN_KEY (32 bytes as 64 hex chars) and is never stored.
// Unit tested in crypto.test.ts.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function parseTokenKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "ARCHIVE_TOKEN_KEY must be 32 bytes as 64 hex characters",
    );
  }
  return Buffer.from(hex, "hex");
}

export function encryptToken(plaintext: string, keyHex: string): string {
  const key = parseTokenKey(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${Buffer.concat([ciphertext, tag]).toString("hex")}`;
}

export function decryptToken(stored: string, keyHex: string): string {
  const key = parseTokenKey(keyHex);
  const [ivHex = "", bodyHex = ""] = stored.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const body = Buffer.from(bodyHex, "hex");
  if (iv.length !== 12 || body.length < 16) {
    throw new Error("stored token is not valid encrypted data");
  }
  const tag = body.subarray(body.length - 16);
  const ciphertext = body.subarray(0, body.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
