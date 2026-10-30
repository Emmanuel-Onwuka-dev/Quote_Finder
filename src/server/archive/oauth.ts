// Google OAuth for the creator archive (§4.1): PKCE helpers, consent URL,
// code exchange, channel lookup, and token revocation. Only the
// youtube.force-ssl scope is ever requested. Unit tested in oauth.test.ts
// with mocked Google endpoints.

import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const YOUTUBE_CHANNELS_URL =
  "https://www.googleapis.com/youtube/v3/channels";
export const YOUTUBE_SCOPE =
  "https://www.googleapis.com/auth/youtube.force-ssl";

const OAUTH_TIMEOUT_MS = 15000;

export function createCodeVerifier(): string {
  return randomBytes(64).toString("base64url");
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createState(): string {
  return randomBytes(32).toString("hex");
}

export function buildAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: args.state,
    code_challenge: args.challenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
}

interface TokenPayload {
  access_token?: string;
  refresh_token?: string;
}

export async function exchangeCode(
  args: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    verifier: string;
  },
  fetchFn: typeof fetch = fetch,
): Promise<TokenResult> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
      grant_type: "authorization_code",
      code_verifier: args.verifier,
    }).toString(),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status})`);
  }
  const data = (await res.json()) as TokenPayload;
  if (!data.access_token || !data.refresh_token) {
    throw new Error(
      "Google did not return a refresh token (consent may have been skipped)",
    );
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

interface ChannelsMinePayload {
  items?: Array<{ id?: string; snippet?: { title?: string } }>;
}

export async function fetchOwnChannel(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ channelId: string; channelTitle: string }> {
  const res = await fetchFn(`${YOUTUBE_CHANNELS_URL}?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Google channel lookup failed (${res.status})`);
  }
  const item = ((await res.json()) as ChannelsMinePayload).items?.[0];
  if (!item?.id) {
    throw new Error("Google account has no YouTube channel");
  }
  return { channelId: item.id, channelTitle: item.snippet?.title ?? "" };
}

export async function revokeToken(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Google token revoke failed (${res.status})`);
  }
}

export async function refreshAccessToken(
  args: { refreshToken: string; clientId: string; clientSecret: string },
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: args.clientId,
      client_secret: args.clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status})`);
  }
  const data = (await res.json()) as TokenPayload;
  if (!data.access_token) {
    throw new Error("Google did not return an access token");
  }
  return data.access_token;
}
