import { describe, expect, it } from "vitest";
import {
  buildAuthUrl,
  codeChallenge,
  createCodeVerifier,
  createState,
  exchangeCode,
  fetchOwnChannel,
  GOOGLE_AUTH_URL,
  revokeToken,
  YOUTUBE_SCOPE,
} from "./oauth";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  return (async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init)) as unknown as typeof fetch;
}

describe("PKCE helpers", () => {
  it("creates a verifier in the 43-128 char range", () => {
    const verifier = createCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createCodeVerifier()).not.toBe(verifier);
  });

  it("derives a deterministic base64url challenge", () => {
    expect(codeChallenge("test-verifier")).toBe(
      codeChallenge("test-verifier"),
    );
    expect(codeChallenge("test-verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallenge("other-verifier")).not.toBe(
      codeChallenge("test-verifier"),
    );
  });

  it("creates a hex state token", () => {
    expect(createState()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildAuthUrl", () => {
  it("requests offline access with consent and PKCE", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "cid",
        redirectUri: "http://localhost:8787/api/archive/oauth/callback",
        state: "state123",
        challenge: "challenge123",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(YOUTUBE_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state123");
    expect(url.searchParams.get("code_challenge")).toBe("challenge123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("exchangeCode", () => {
  const args = {
    code: "auth-code",
    clientId: "cid",
    clientSecret: "csecret",
    redirectUri: "http://localhost:8787/api/archive/oauth/callback",
    verifier: "verifier",
  };

  it("returns both tokens on success", async () => {
    const seen: string[] = [];
    const fetchFn = stubFetch((url, init) => {
      seen.push(`${url} ${init?.method} ${init?.body}`);
      return jsonResponse({ access_token: "at", refresh_token: "rt" });
    });
    await expect(exchangeCode(args, fetchFn)).resolves.toEqual({
      accessToken: "at",
      refreshToken: "rt",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("oauth2.googleapis.com/token");
    expect(seen[0]).toContain("grant_type=authorization_code");
    expect(seen[0]).toContain("code_verifier=verifier");
  });

  it("throws on an HTTP error", async () => {
    const fetchFn = stubFetch(() => jsonResponse({}, 400));
    await expect(exchangeCode(args, fetchFn)).rejects.toThrow(
      "token exchange failed (400)",
    );
  });

  it("throws when Google omits the refresh token", async () => {
    const fetchFn = stubFetch(() =>
      jsonResponse({ access_token: "at", refresh_token: "" }),
    );
    await expect(exchangeCode(args, fetchFn)).rejects.toThrow(
      "did not return a refresh token",
    );
  });
});

describe("fetchOwnChannel", () => {
  it("returns the channel id and title", async () => {
    const seen: Array<{ url: string; auth: unknown }> = [];
    const fetchFn = stubFetch((url, init) => {
      seen.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization });
      return jsonResponse({
        items: [{ id: "UCchan1", snippet: { title: "Test Channel" } }],
      });
    });
    await expect(fetchOwnChannel("at", fetchFn)).resolves.toEqual({
      channelId: "UCchan1",
      channelTitle: "Test Channel",
    });
    expect(seen[0]?.url).toContain("mine=true");
    expect(seen[0]?.auth).toBe("Bearer at");
  });

  it("throws when the account has no channel", async () => {
    const fetchFn = stubFetch(() => jsonResponse({ items: [] }));
    await expect(fetchOwnChannel("at", fetchFn)).rejects.toThrow(
      "has no YouTube channel",
    );
  });

  it("throws on an HTTP error", async () => {
    const fetchFn = stubFetch(() => jsonResponse({}, 401));
    await expect(fetchOwnChannel("at", fetchFn)).rejects.toThrow(
      "channel lookup failed (401)",
    );
  });
});

describe("revokeToken", () => {
  it("posts the token to the revoke endpoint", async () => {
    const seen: string[] = [];
    const fetchFn = stubFetch((url, init) => {
      seen.push(`${url} ${init?.method} ${init?.body}`);
      return jsonResponse({});
    });
    await expect(revokeToken("rt", fetchFn)).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("oauth2.googleapis.com/revoke");
    expect(seen[0]).toContain("token=rt");
  });

  it("throws on an HTTP error", async () => {
    const fetchFn = stubFetch(() => jsonResponse({}, 400));
    await expect(revokeToken("rt", fetchFn)).rejects.toThrow(
      "token revoke failed (400)",
    );
  });
});
