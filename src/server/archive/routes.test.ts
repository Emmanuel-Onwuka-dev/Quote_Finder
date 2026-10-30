import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "./crypto";
import { createArchiveRoutes, type ArchiveDeps } from "./routes";
import { openArchiveStore, type ArchiveStore } from "./store";

const TEST_KEY = "ab".repeat(32);

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

interface GoogleScript {
  token?: { status: number; body: unknown };
  channels?: { status: number; body: unknown };
  revoke?: { status: number };
}

function makeGoogleFetch(script: GoogleScript, seen: string[]) {
  return (async (url: string | URL | Request): Promise<Response> => {
    const href = String(url);
    seen.push(href);
    const parsed = new URL(href);
    if (parsed.hostname === "oauth2.googleapis.com") {
      if (parsed.pathname === "/token") {
        const step = script.token ?? {
          status: 200,
          body: { access_token: "at", refresh_token: "rt" },
        };
        return jsonResponse(step.body, step.status);
      }
      if (parsed.pathname === "/revoke") {
        return jsonResponse({}, script.revoke?.status ?? 200);
      }
    }
    if (
      parsed.hostname === "www.googleapis.com" &&
      parsed.pathname === "/youtube/v3/channels"
    ) {
      const step = script.channels ?? {
        status: 200,
        body: { items: [{ id: "UCchan1", snippet: { title: "Test Channel" } }] },
      };
      return jsonResponse(step.body, step.status);
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;
}

const stores: ArchiveStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

function setup(
  script: GoogleScript = {},
  overrides: Partial<ArchiveDeps> = {},
): { app: Hono; store: ArchiveStore; seen: string[] } {
  const seen: string[] = [];
  const store = openArchiveStore(":memory:");
  stores.push(store);
  const app = new Hono();
  app.route(
    "/api/archive",
    createArchiveRoutes({
      googleClientId: "cid",
      googleClientSecret: "csecret",
      googleRedirectUri: "http://localhost:8787/api/archive/oauth/callback",
      archiveTokenKey: TEST_KEY,
      store,
      fetchFn: makeGoogleFetch(script, seen),
      ...overrides,
    }),
  );
  return { app, store, seen };
}

async function startFlow(app: Hono): Promise<{ state: string; cookie: string }> {
  const res = await app.request("/api/archive/oauth/start");
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  const state = new URL(location).searchParams.get("state") ?? "";
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(state).not.toBe("");
  expect(cookie).toContain("archive_oauth_state=");
  return { state, cookie };
}

describe("GET /oauth/start", () => {
  it("redirects to Google with offline access and PKCE", async () => {
    const { app } = setup();
    const res = await app.request("/api/archive/oauth/start");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("client_id")).toBe("cid");
    expect(location.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.force-ssl",
    );
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")?.length).toBeGreaterThan(0);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("fails closed when Google OAuth is not configured", async () => {
    const { app } = setup({}, { googleClientId: "", googleClientSecret: "" });
    const res = await app.request("/api/archive/oauth/start");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("not configured");
  });
});

describe("GET /oauth/callback", () => {
  it("stores the encrypted refresh token and redirects to /creator", async () => {
    const { app, store } = setup();
    const { state, cookie } = await startFlow(app);
    const res = await app.request(
      `/api/archive/oauth/callback?code=auth-code&state=${state}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/creator?connected=1");
    const row = store.getCreator("UCchan1");
    expect(row?.channel_title).toBe("Test Channel");
    expect(row?.token_enc).not.toBe("rt");
    expect(decryptToken(row?.token_enc ?? "", TEST_KEY)).toBe("rt");
    expect(await res.text()).not.toContain("rt");
  });

  it("rejects a state that was never issued", async () => {
    const { app, store } = setup();
    const res = await app.request(
      "/api/archive/oauth/callback?code=auth-code&state=nope",
      { headers: { cookie: "archive_oauth_state=nope" } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/creator?error=");
    expect(store.listCreators()).toHaveLength(0);
  });

  it("rejects a callback whose cookie does not match", async () => {
    const { app, store } = setup();
    const { state } = await startFlow(app);
    const res = await app.request(
      `/api/archive/oauth/callback?code=auth-code&state=${state}`,
      { headers: { cookie: "archive_oauth_state=other" } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/creator?error=");
    expect(store.listCreators()).toHaveLength(0);
  });

  it("rejects a callback with no code", async () => {
    const { app } = setup();
    const { state, cookie } = await startFlow(app);
    const res = await app.request(
      `/api/archive/oauth/callback?state=${state}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/creator?error=");
  });

  it("redirects with an error when the exchange fails", async () => {
    const { app, store } = setup({
      token: { status: 400, body: {} },
    });
    const { state, cookie } = await startFlow(app);
    const res = await app.request(
      `/api/archive/oauth/callback?code=auth-code&state=${state}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/creator?error=");
    expect(store.listCreators()).toHaveLength(0);
  });

  it("redirects with an error when the account has no channel", async () => {
    const { app, store } = setup({
      channels: { status: 200, body: { items: [] } },
    });
    const { state, cookie } = await startFlow(app);
    const res = await app.request(
      `/api/archive/oauth/callback?code=auth-code&state=${state}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/creator?error=");
    expect(store.listCreators()).toHaveLength(0);
  });
});

describe("GET /status", () => {
  it("lists no creators when nobody connected", async () => {
    const { app } = setup();
    const res = await app.request("/api/archive/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ creators: [] });
  });

  it("reports the connected channel without any secret", async () => {
    const { app, store } = setup();
    store.saveCreator({
      channelId: "UCchan1",
      channelTitle: "Test Channel",
      tokenEnc: "iv:body",
    });
    const res = await app.request("/api/archive/status");
    expect(await res.json()).toEqual({
      creators: [
        {
          channelId: "UCchan1",
          channelTitle: "Test Channel",
          videoCount: 0,
          listed: false,
        },
      ],
    });
  });
});

describe("POST /disconnect", () => {
  it("revokes the decrypted token and deletes the row", async () => {
    const seenBodies: string[] = [];
    const seen: string[] = [];
    const store = openArchiveStore(":memory:");
    stores.push(store);
    // Store a real encrypted token so the revoke call proves the decrypt path.
    store.saveCreator({
      channelId: "UCchan1",
      channelTitle: "Test Channel",
      tokenEnc: encryptToken("live-refresh-token", TEST_KEY),
    });
    const app = new Hono();
    app.route(
      "/api/archive",
      createArchiveRoutes({
        googleClientId: "cid",
        googleClientSecret: "csecret",
        googleRedirectUri: "http://localhost:8787/api/archive/oauth/callback",
        archiveTokenKey: TEST_KEY,
        store,
        fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
          seen.push(String(url));
          seenBodies.push(String((init as { body?: unknown })?.body ?? ""));
          return jsonResponse({});
        }) as unknown as typeof fetch,
      }),
    );
    const res = await app.request("/api/archive/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: "UCchan1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(seen.some((href) => href.includes("/revoke"))).toBe(true);
    expect(seenBodies.some((body) => body.includes("live-refresh-token"))).toBe(
      true,
    );
    expect(store.getCreator("UCchan1")).toBeUndefined();
  });

  it("still deletes the row when Google revoke fails", async () => {
    const { app, store } = setup({ revoke: { status: 400 } });
    // Valid ciphertext so only the revoke step fails.
    store.saveCreator({
      channelId: "UCchan1",
      channelTitle: "Test Channel",
      tokenEnc: encryptToken("rt", TEST_KEY),
    });
    const res = await app.request("/api/archive/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: "UCchan1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: false });
    expect(store.getCreator("UCchan1")).toBeUndefined();
  });

  it("returns 404 for a channel that is not connected", async () => {
    const { app } = setup();
    const res = await app.request("/api/archive/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: "UCmissing" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "channel is not connected" });
  });

  it("rejects invalid bodies with a 400", async () => {
    const { app } = setup();
    const notJson = await app.request("/api/archive/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    expect(notJson.status).toBe(400);
    const empty = await app.request("/api/archive/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });
});
