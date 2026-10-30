// Signed channel sessions: after OAuth connect, the browser holds a cookie
// listing the channel IDs it connected. Creator routes require the cookie
// and a channel match; viewer routes stay public. Stateless HMAC-SHA256,
// keyed by ARCHIVE_TOKEN_KEY. Unit tested in session.test.ts.

import { createHmac, timingSafeEqual } from "node:crypto";
import { parseTokenKey } from "./crypto";

/** Session lifetime: 30 days, re-issued on every connect. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "archive_session";

interface SessionPayload {
  ids: string[];
  exp: number;
}

function sign(body: string, keyHex: string): string {
  return createHmac("sha256", parseTokenKey(keyHex))
    .update(body)
    .digest("hex");
}

/** Serialize and sign channel IDs. `nowMs` is injectable for tests. */
export function issueSession(
  channelIds: string[],
  nowMs: number,
  keyHex: string,
): string {
  const payload: SessionPayload = {
    ids: [...new Set(channelIds.filter((id) => id !== ""))].sort(),
    exp: nowMs + SESSION_TTL_MS,
  };
  const body = `v1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return `${body}.${sign(body, keyHex)}`;
}

/** Verify a cookie value. Returns the channel IDs, or null when the
 * signature is bad, the shape is wrong, or the session expired. Fails
 * closed: never throws. */
export function verifySession(
  value: string | undefined,
  nowMs: number,
  keyHex: string,
): string[] | null {
  if (!value) {
    return null;
  }
  try {
    const [version, encoded, signature] = value.split(".");
    if (version !== "v1" || !encoded || !signature) {
      return null;
    }
    const body = `${version}.${encoded}`;
    const expected = sign(body, keyHex);
    const actual = Buffer.from(signature, "utf8");
    const wanted = Buffer.from(expected, "utf8");
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
      return null;
    }
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>;
    if (!Array.isArray(payload.ids) || typeof payload.exp !== "number") {
      return null;
    }
    if (!(payload.exp > nowMs)) {
      return null;
    }
    return payload.ids.filter(
      (id): id is string => typeof id === "string" && id !== "",
    );
  } catch {
    return null;
  }
}
