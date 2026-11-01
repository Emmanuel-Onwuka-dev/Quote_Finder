import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptToken, encryptToken } from "./crypto";
import { createArchiveRoutes, type ArchiveDeps } from "./routes";
import { SESSION_COOKIE, issueSession, verifySession } from "./session";
import { openArchiveStore, todayKey, type ArchiveStore } from "./store";

const TEST_KEY = "ab".repeat(32);
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello there\n";

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
  tracks?: { status: number; body: unknown };
  srt?: { status: number; body: string };
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
    if (parsed.hostname === "www.googleapis.com") {
      if (parsed.pathname === "/youtube/v3/captions") {
        const step = script.tracks ?? {
          status: 200,
          body: {
            items: [
              {
                id: "t1",
                snippet: {
                  language: "en",
                  trackKind: "standard",
                  status: "serving",
                },
              },
            ],
          },
        };
        return jsonResponse(step.body, step.status);
      }
      if (parsed.pathname.startsWith("/youtube/v3/captions/")) {
        const step = script.srt ?? { status: 200, body: SRT };
        return {
          ok: step.status >= 200 && step.status < 300,
          status: step.status,
          text: async () => step.body,
        } as Response;
      }
      if (parsed.pathname === "/youtube/v3/channels") {
        const step = script.channels ?? {
          status: 200,
          body: {
            items: [{ id: "UCchan1", snippet: { title: "Test Channel" } }],
          },
        };
        return jsonResponse(step.body, step.status);
      }
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;
}

const stores: ArchiveStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  vi.unstubAllGlobals();
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
      youtubeApiKey: "yt-key",
      store,
      fetchFn: makeGoogleFetch(script, seen),
      ...overrides,
    }),
  );
  return { app, store, seen };
}

function saveConnectedChannel(store: ArchiveStore): void {
  store.saveCreator({
    channelId: "UCchan1",
    channelTitle: "Test Channel",
    tokenEnc: encryptToken("rt", TEST_KEY),
  });
}

function sessionCookie(
  channelIds: string | string[],
  nowMs = Date.now(),
): string {
  const ids = Array.isArray(channelIds) ? channelIds : [channelIds];
  return `${SESSION_COOKIE}=${issueSession(ids, nowMs, TEST_KEY)}`;
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

function parseSseEvents(
  text: string,
): Array<{ event: string; data: string }> {
  return text
    .split("\n\n")
    .filter((block) => block.includes("event:"))
    .map((block) => {
      const lines = block.split("\n");
      const event =
        lines
          .find((line) => line.startsWith("event:"))
          ?.slice("event:".length)
          .trim() ?? "";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      return { event, data };
    });
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
    expect(await res.json()).toEqual({
      creators: [],
      budget: { spentUnits: 0, capUnits: 5000 },
    });
  });

  it("reports the connected channel without any secret", async () => {
    const { app, store } = setup();
    store.saveCreator({
      channelId: "UCchan1",
      channelTitle: "Test Channel",
      tokenEnc: "iv:body",
    });
    const res = await app.request("/api/archive/status", {
      headers: { Cookie: sessionCookie("UCchan1") },
    });
    expect(await res.json()).toEqual({
      creators: [
        {
          channelId: "UCchan1",
          channelTitle: "Test Channel",
          videoCount: 0,
        },
      ],
      budget: { spentUnits: 0, capUnits: 5000 },
    });
  });

  it("reports today's budget spend", async () => {
    const { app, store } = setup();
    expect(store.trySpend(todayKey(), 300)).toBe(true);
    const res = await app.request("/api/archive/status");
    expect(await res.json()).toEqual({
      creators: [],
      budget: { spentUnits: 300, capUnits: 5000 },
    });
  });

  it("purges expired cue text", async () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const { app, store } = setup({}, { now });
    saveConnectedChannel(store);
    store.saveVideoWithCues({
      channelId: "UCchan1",
      videoId: "vid1",
      title: "Old vid",
      publishedAt: "",
      trackKind: "standard",
      fetchedAt: "2026-09-01T00:00:00Z",
      cues: [{ idx: 1, startSeconds: 1, endSeconds: 2, text: "hi" }],
    });
    const res = await app.request("/api/archive/status", {
      headers: { Cookie: sessionCookie("UCchan1", now.getTime()) },
    });
    expect(res.status).toBe(200);
    expect(store.getIndexedVideos("UCchan1")).toEqual([
      expect.objectContaining({ video_id: "vid1", cue_count: 0 }),
    ]);
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
        youtubeApiKey: "yt-key",
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
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie("UCchan1"),
      },
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
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie("UCchan1"),
      },
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
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie("UCmissing"),
      },
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

describe("client-origin redirects", () => {
  async function startWithReferer(
    app: Hono,
    referer: string,
  ): Promise<{ state: string; cookie: string }> {
    const res = await app.request("/api/archive/oauth/start", {
      headers: { referer },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    return {
      state: new URL(location).searchParams.get("state") ?? "",
      cookie: res.headers.get("set-cookie") ?? "",
    };
  }

  it("returns to the client's origin after connect", async () => {
    const { app } = setup();
    const { state, cookie } = await startWithReferer(
      app,
      "http://localhost:5173/creator",
    );
    const res = await app.request(
      `/api/archive/oauth/callback?code=auth-code&state=${state}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "http://localhost:5173/creator?connected=1",
    );
  });

  it("keeps the client origin on error redirects", async () => {
    const { app } = setup({ token: { status: 400, body: {} } });
    const { state, cookie } = await startWithReferer(
      app,
      "http://localhost:5173/creator",
    );
    const res = await app.request(
      `/api/archive/oauth/callback?code=auth-code&state=${state}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "http://localhost:5173/creator?error=",
    );
  });

  it("ignores a non-http referer", async () => {
    const { app } = setup();
    const { state, cookie } = await startWithReferer(
      app,
      "javascript:alert(1)",
    );
    const res = await app.request(
      `/api/archive/oauth/callback?code=auth-code&state=${state}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/creator?connected=1");
  });
});

describe("GET /videos", () => {
  function stubUploads(seen: string[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        const parsed = new URL(url);
        // The fixture id is short, so channel resolution takes the
        // free-text path; real 24-char ids go straight to /channels.
        if (parsed.pathname === "/youtube/v3/search") {
          return jsonResponse({ items: [{ id: { channelId: "UCchan1" } }] });
        }
        if (parsed.pathname === "/youtube/v3/channels") {
          return jsonResponse({
            items: [
              {
                id: "UCchan1",
                snippet: { title: "Test Channel" },
                contentDetails: { relatedPlaylists: { uploads: "UUchan1" } },
              },
            ],
          });
        }
        if (parsed.pathname === "/youtube/v3/playlistItems") {
          const pageToken = parsed.searchParams.get("pageToken");
          return jsonResponse(
            pageToken
              ? {
                  items: [
                    {
                      snippet: {
                        title: "Second",
                        description: "",
                        publishedAt: "2026-10-02T00:00:00Z",
                        resourceId: { videoId: "v2" },
                      },
                    },
                  ],
                }
              : {
                  nextPageToken: "tok123",
                  items: [
                    {
                      snippet: {
                        title: "First",
                        description: "",
                        publishedAt: "2026-10-01T00:00:00Z",
                        resourceId: { videoId: "v1" },
                      },
                    },
                  ],
                },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it("lists the channel's uploads for a connected channel", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    stubUploads([]);
    const res = await app.request("/api/archive/videos?channelId=UCchan1", {
      headers: { Cookie: sessionCookie("UCchan1") },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      videos: [
        {
          id: "v1",
          title: "First",
          publishedAt: "2026-10-01T00:00:00Z",
          indexed: "never",
        },
      ],
      nextPageToken: "tok123",
    });
  });

  it("passes the page token through", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    const seen: string[] = [];
    stubUploads(seen);
    const res = await app.request(
      "/api/archive/videos?channelId=UCchan1&pageToken=tok123",
      { headers: { Cookie: sessionCookie("UCchan1") } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      videos: [
        {
          id: "v2",
          title: "Second",
          publishedAt: "2026-10-02T00:00:00Z",
          indexed: "never",
        },
      ],
    });
    expect(seen.some((href) => href.includes("pageToken=tok123"))).toBe(true);
  });

  it("returns 404 for a channel that is not connected", async () => {
    const { app } = setup();
    const res = await app.request("/api/archive/videos?channelId=UCmissing", {
      headers: { Cookie: sessionCookie("UCmissing") },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "channel is not connected" });
  });

  it("requires a channelId", async () => {
    const { app } = setup();
    const res = await app.request("/api/archive/videos");
    expect(res.status).toBe(400);
  });

  it("returns 502 when the YouTube call fails", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 500)));
    const res = await app.request("/api/archive/videos?channelId=UCchan1", {
      headers: { Cookie: sessionCookie("UCchan1") },
    });
    expect(res.status).toBe(502);
  });
});

describe("POST /index", () => {
  async function postIndex(
    app: Hono,
    body: unknown,
    channelId = "UCchan1",
  ): Promise<Response> {
    return app.request("/api/archive/index", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie(channelId),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("streams progress then a result summary", async () => {
    const { app, store, seen } = setup();
    saveConnectedChannel(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          items: [
            {
              id: "vid1",
              snippet: {
                title: "Vid one",
                description: "",
                publishedAt: "2026-10-01T00:00:00Z",
                channelTitle: "Test Channel",
              },
            },
          ],
        }),
      ),
    );
    const res = await postIndex(app, {
      channelId: "UCchan1",
      videoIds: ["vid1"],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSseEvents(await res.text());
    const kinds = events.map((event) => event.event);
    expect(kinds[0]).toBe("progress");
    expect(kinds[kinds.length - 1]).toBe("result");
    const result = JSON.parse(events[kinds.length - 1]?.data ?? "{}") as {
      indexed: unknown[];
      skipped: unknown[];
      paused: boolean;
      message: string;
      spentUnits: number;
    };
    expect(result).toEqual({
      indexed: [
        {
          videoId: "vid1",
          trackKind: "standard",
          language: "en",
          cueCount: 1,
        },
      ],
      skipped: [],
      paused: false,
      message: "",
      spentUnits: 250,
    });
    expect(seen.some((href) => href.includes("oauth2.googleapis.com/token"))).toBe(
      true,
    );
  });

  it("pauses with the spec message when the budget is spent", async () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const { app, store, seen } = setup({}, { now });
    saveConnectedChannel(store);
    expect(store.trySpend("2026-10-30", 5000)).toBe(true);
    const res = await postIndex(app, {
      channelId: "UCchan1",
      videoIds: ["vid1"],
    });
    const events = parseSseEvents(await res.text());
    const result = JSON.parse(events[events.length - 1]?.data ?? "{}") as {
      paused: boolean;
      message: string;
      indexed: unknown[];
    };
    expect(result.paused).toBe(true);
    expect(result.message).toBe("Indexing paused until tomorrow");
    expect(result.indexed).toEqual([]);
    // Only the pre-stream token refresh ran; no captions calls.
    expect(seen.every((href) => href.includes("/token"))).toBe(true);
  });

  it("reports skipped videos in the result", async () => {
    const { app, store } = setup({
      tracks: { status: 200, body: { items: [] } },
    });
    saveConnectedChannel(store);
    const res = await postIndex(app, {
      channelId: "UCchan1",
      videoIds: ["bare"],
    });
    const events = parseSseEvents(await res.text());
    const result = JSON.parse(events[events.length - 1]?.data ?? "{}") as {
      indexed: unknown[];
      skipped: unknown[];
      paused: boolean;
    };
    expect(result.indexed).toEqual([]);
    expect(result.skipped).toEqual([
      { videoId: "bare", reason: "no usable caption track" },
    ]);
    expect(result.paused).toBe(false);
  });

  it("rejects invalid bodies with a 400", async () => {
    const { app } = setup();
    expect((await postIndex(app, "not json{")).status).toBe(400);
    expect((await postIndex(app, {})).status).toBe(400);
    expect(
      (await postIndex(app, { channelId: "UCchan1", videoIds: [] })).status,
    ).toBe(400);
    expect(
      (await postIndex(app, { channelId: "", videoIds: ["v1"] })).status,
    ).toBe(400);
  });

  it("returns 404 for a channel that is not connected", async () => {
    const { app } = setup();
    const res = await postIndex(
      app,
      {
        channelId: "UCmissing",
        videoIds: ["v1"],
      },
      "UCmissing",
    );
    expect(res.status).toBe(404);
  });

  it("returns 502 when the token refresh fails", async () => {
    const { app, store } = setup({ token: { status: 400, body: {} } });
    saveConnectedChannel(store);
    const res = await postIndex(app, {
      channelId: "UCchan1",
      videoIds: ["v1"],
    });
    expect(res.status).toBe(502);
  });
});

describe("archive storage", () => {
  function stubChannelUploads(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/youtube/v3/search") {
          return jsonResponse({ items: [{ id: { channelId: "UCchan1" } }] });
        }
        if (parsed.pathname === "/youtube/v3/channels") {
          return jsonResponse({
            items: [
              {
                id: "UCchan1",
                snippet: { title: "Test Channel" },
                contentDetails: { relatedPlaylists: { uploads: "UUchan1" } },
              },
            ],
          });
        }
        if (parsed.pathname === "/youtube/v3/playlistItems") {
          return jsonResponse({
            items: [
              {
                snippet: {
                  title: "Fresh vid",
                  description: "",
                  publishedAt: "2026-10-01T00:00:00Z",
                  resourceId: { videoId: "fresh" },
                },
              },
              {
                snippet: {
                  title: "Old vid",
                  description: "",
                  publishedAt: "2026-09-01T00:00:00Z",
                  resourceId: { videoId: "old" },
                },
              },
              {
                snippet: {
                  title: "New vid",
                  description: "",
                  publishedAt: "2026-10-29T00:00:00Z",
                  resourceId: { videoId: "unseen" },
                },
              },
            ],
          });
        }
        if (parsed.pathname === "/youtube/v3/videos") {
          return jsonResponse({
            items: [
              {
                id: "vid1",
                snippet: {
                  title: "Vid one",
                  description: "",
                  publishedAt: "2026-10-01T00:00:00Z",
                  channelTitle: "Test Channel",
                },
              },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it("marks uploads fresh, expired, or never", async () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const { app, store } = setup({}, { now });
    saveConnectedChannel(store);
    store.saveVideoWithCues({
      channelId: "UCchan1",
      videoId: "fresh",
      title: "Fresh vid",
      publishedAt: "",
      trackKind: "standard",
      fetchedAt: "2026-10-29T00:00:00Z",
      cues: [{ idx: 1, startSeconds: 1, endSeconds: 2, text: "hi" }],
    });
    store.saveVideoWithCues({
      channelId: "UCchan1",
      videoId: "old",
      title: "Old vid",
      publishedAt: "",
      trackKind: "asr",
      fetchedAt: "2026-09-01T00:00:00Z",
      cues: [{ idx: 1, startSeconds: 1, endSeconds: 2, text: "hi" }],
    });
    stubChannelUploads();
    const res = await app.request("/api/archive/videos?channelId=UCchan1", {
      headers: { Cookie: sessionCookie("UCchan1") },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      videos: [
        {
          id: "fresh",
          title: "Fresh vid",
          publishedAt: "2026-10-01T00:00:00Z",
          indexed: "fresh",
        },
        {
          id: "old",
          title: "Old vid",
          publishedAt: "2026-09-01T00:00:00Z",
          indexed: "expired",
        },
        {
          id: "unseen",
          title: "New vid",
          publishedAt: "2026-10-29T00:00:00Z",
          indexed: "never",
        },
      ],
    });
  });

  it("stores index runs and counts them in status", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    stubChannelUploads();
    const res = await app.request("/api/archive/index", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie("UCchan1"),
      },
      body: JSON.stringify({ channelId: "UCchan1", videoIds: ["vid1"] }),
    });
    expect(res.status).toBe(200);
    // Drain the stream: the run saves its results only as the body is
    // consumed, so asserting storage before this races the pump.
    const events = parseSseEvents(await res.text());
    const kinds = events.map((event) => event.event);
    expect(kinds[kinds.length - 1]).toBe("result");
    const result = JSON.parse(events[events.length - 1]?.data ?? "{}") as {
      indexed: unknown[];
      paused: boolean;
    };
    expect(result.paused).toBe(false);
    expect(result.indexed).toEqual([
      { videoId: "vid1", trackKind: "standard", language: "en", cueCount: 1 },
    ]);
    const status = await app.request("/api/archive/status", {
      headers: { Cookie: sessionCookie("UCchan1") },
    });
    expect((await status.json()) as unknown).toEqual({
      creators: [
        {
          channelId: "UCchan1",
          channelTitle: "Test Channel",
          videoCount: 1,
        },
      ],
      budget: { spentUnits: 250, capUnits: 5000 },
    });
    expect(store.getIndexedVideos("UCchan1")).toEqual([
      expect.objectContaining({
        video_id: "vid1",
        title: "Vid one",
        track_kind: "standard",
        cue_count: 1,
      }),
    ]);
  });

  it("purges expired cues at the start of a run", async () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const { app, store } = setup({}, { now });
    saveConnectedChannel(store);
    store.saveVideoWithCues({
      channelId: "UCchan1",
      videoId: "old",
      title: "Old vid",
      publishedAt: "",
      trackKind: "asr",
      fetchedAt: "2026-09-01T00:00:00Z",
      cues: [
        { idx: 1, startSeconds: 1, endSeconds: 2, text: "a" },
        { idx: 2, startSeconds: 3, endSeconds: 4, text: "b" },
      ],
    });
    stubChannelUploads();
    const res = await app.request("/api/archive/index", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie("UCchan1"),
      },
      body: JSON.stringify({ channelId: "UCchan1", videoIds: ["vid1"] }),
    });
    const events = parseSseEvents(await res.text());
    expect(events[0]).toEqual({
      event: "progress",
      data: JSON.stringify({
        stage: "Purging expired captions",
        detail: "2 cues",
      }),
    });
    const byId = new Map(
      store.getIndexedVideos("UCchan1").map((video) => [video.video_id, video]),
    );
    expect(byId.get("old")).toMatchObject({ title: "Old vid", cue_count: 0 });
    expect(byId.get("vid1")).toMatchObject({ cue_count: 1 });
  });

  it("disconnect deletes videos and cues", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    store.saveVideoWithCues({
      channelId: "UCchan1",
      videoId: "vid1",
      title: "Vid one",
      publishedAt: "",
      trackKind: "standard",
      fetchedAt: "2026-10-30T00:00:00Z",
      cues: [{ idx: 1, startSeconds: 1, endSeconds: 2, text: "hi" }],
    });
    const res = await app.request("/api/archive/disconnect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie("UCchan1"),
      },
      body: JSON.stringify({ channelId: "UCchan1" }),
    });
    expect(res.status).toBe(200);
    expect(store.getCreator("UCchan1")).toBeUndefined();
    expect(store.getIndexedVideos("UCchan1")).toEqual([]);
  });
});

describe("GET /creators", () => {
  it("lists only the caller's own channels with fresh counts", async () => {
    const { app, store } = setup(
      {},
      { now: new Date("2026-10-30T12:00:00Z") },
    );
    saveConnectedChannel(store);
    store.saveVideoWithCues({
      channelId: "UCchan1",
      videoId: "vid1",
      title: "Workshop rebuild",
      publishedAt: "2026-10-29T00:00:00Z",
      trackKind: "standard",
      fetchedAt: "2026-10-29T00:00:00Z",
      cues: [{ idx: 1, startSeconds: 1, endSeconds: 2, text: "hi" }],
    });
    store.saveCreator({
      channelId: "UCchan2",
      channelTitle: "Other",
      tokenEnc: encryptToken("rt2", TEST_KEY),
    });
    store.saveVideoWithCues({
      channelId: "UCchan2",
      videoId: "v2",
      title: "Hidden",
      publishedAt: "",
      trackKind: "standard",
      fetchedAt: "2026-10-29T00:00:00Z",
      cues: [{ idx: 1, startSeconds: 1, endSeconds: 2, text: "hi" }],
    });
    const res = await app.request("/api/archive/creators", {
      headers: { Cookie: sessionCookie("UCchan1") },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({
      creators: [
        {
          channelId: "UCchan1",
          channelTitle: "Test Channel",
          videoCount: 1,
        },
      ],
    });
  });

  it("requires a session (401)", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    const res = await app.request("/api/archive/creators");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "creator sign-in required" });
  });
});

describe("POST /search", () => {
  const searchCues = [
    {
      idx: 1,
      startSeconds: 0,
      endSeconds: 2,
      text: "welcome back to the workshop",
    },
    {
      idx: 2,
      startSeconds: 5,
      endSeconds: 7,
      text: "today we rebuild the carburetor",
    },
    {
      idx: 3,
      startSeconds: 9,
      endSeconds: 11,
      text: "from absolute scratch together",
    },
  ];
  const searchQuery = "rebuild the carburetor from absolute scratch";

  function saveSearchVideo(
    store: ArchiveStore,
    channelId = "UCchan1",
    videoId = "vid1",
    fetchedAt: string = new Date().toISOString(),
  ): void {
    store.saveVideoWithCues({
      channelId,
      videoId,
      title: "Workshop rebuild",
      publishedAt: "2026-10-29T00:00:00Z",
      trackKind: "standard",
      fetchedAt,
      cues: searchCues,
    });
  }

  async function postSearch(
    app: Hono,
    body: unknown,
    cookie?: string,
  ): Promise<Response> {
    return app.request("/api/archive/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("returns the channel's own matches", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    saveSearchVideo(store);
    store.saveCreator({
      channelId: "UCchan2",
      channelTitle: "Other",
      tokenEnc: encryptToken("rt2", TEST_KEY),
    });
    saveSearchVideo(store, "UCchan2", "v2");
    const res = await postSearch(
      app,
      { channelId: "UCchan1", query: searchQuery },
      sessionCookie("UCchan1"),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      matches: Array<Record<string, unknown>>;
    };
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]).toMatchObject({
      videoTitle: "Workshop rebuild",
      creator: "Test Channel",
      startSeconds: 5,
      timestampVerified: true,
      trackKind: "standard",
      confidence: "high",
    });
    expect(String(data.matches[0]?.text)).toContain("carburetor");
    expect(String(data.matches[0]?.videoUrl)).toContain("v=vid1");
    expect(String(data.matches[0]?.videoUrl)).toContain("t=5s");
  });

  it("rejects a session for another channel (403)", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    saveSearchVideo(store);
    const res = await postSearch(
      app,
      { channelId: "UCchan1", query: searchQuery },
      sessionCookie("UCother"),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: "session does not include this channel",
    });
  });

  it("requires a session (401)", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    saveSearchVideo(store);
    const res = await postSearch(app, {
      channelId: "UCchan1",
      query: searchQuery,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "creator sign-in required" });
  });

  it("returns an empty result for a channel with no indexed videos", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    const res = await postSearch(
      app,
      { channelId: "UCchan1", query: searchQuery },
      sessionCookie("UCchan1"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matches: [] });
  });

  it("drops cues older than 30 days and purges their text", async () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const { app, store } = setup({}, { now });
    saveConnectedChannel(store);
    saveSearchVideo(store, "UCchan1", "vid1", "2026-09-01T00:00:00Z");
    expect(store.getIndexedVideos("UCchan1")).toEqual([
      expect.objectContaining({ video_id: "vid1", cue_count: 3 }),
    ]);
    const res = await postSearch(
      app,
      { channelId: "UCchan1", query: searchQuery },
      sessionCookie("UCchan1", now.getTime()),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matches: [] });
    expect(store.getIndexedVideos("UCchan1")).toEqual([
      expect.objectContaining({ video_id: "vid1", cue_count: 0 }),
    ]);
  });

  it("still returns cues within 30 days", async () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const { app, store } = setup({}, { now });
    saveConnectedChannel(store);
    saveSearchVideo(store, "UCchan1", "vid1", "2026-10-29T00:00:00Z");
    const res = await postSearch(
      app,
      { channelId: "UCchan1", query: searchQuery },
      sessionCookie("UCchan1", now.getTime()),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      matches: Array<Record<string, unknown>>;
    };
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]).toMatchObject({ startSeconds: 5 });
    expect(store.getIndexedVideos("UCchan1")).toEqual([
      expect.objectContaining({ video_id: "vid1", cue_count: 3 }),
    ]);
  });

  it("rejects invalid bodies with a 400", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    const cookie = sessionCookie("UCchan1");
    expect((await postSearch(app, "not json{", cookie)).status).toBe(400);
    expect((await postSearch(app, {}, cookie)).status).toBe(400);
    expect(
      (await postSearch(app, { channelId: "UCchan1" }, cookie)).status,
    ).toBe(400);
    expect(
      (await postSearch(app, { channelId: "UCchan1", query: "  " }, cookie))
        .status,
    ).toBe(400);
  });
});

describe("channel sessions", () => {
  const postAuthed = async (
    app: Hono,
    path: string,
    body: unknown,
    cookie?: string,
  ): Promise<Response> =>
    app.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });

  const getAuthed = async (
    app: Hono,
    path: string,
    cookie?: string,
  ): Promise<Response> =>
    app.request(path, cookie ? { headers: { Cookie: cookie } } : undefined);

  function sessionValue(res: Response): string {
    const header = res.headers.get("set-cookie") ?? "";
    return header.split(`${SESSION_COOKIE}=`)[1]?.split(";")[0] ?? "";
  }

  const matrix: Array<{
    name: string;
    call: (app: Hono, cookie?: string) => Promise<Response>;
  }> = [
    {
      name: "GET /videos",
      call: (app, cookie) =>
        getAuthed(app, "/api/archive/videos?channelId=UCchan1", cookie),
    },
    {
      name: "POST /index",
      call: (app, cookie) =>
        postAuthed(
          app,
          "/api/archive/index",
          { channelId: "UCchan1", videoIds: ["v1"] },
          cookie,
        ),
    },
    {
      name: "POST /disconnect",
      call: (app, cookie) =>
        postAuthed(
          app,
          "/api/archive/disconnect",
          { channelId: "UCchan1" },
          cookie,
        ),
    },
  ];

  it.each(matrix)("$name requires a session (401)", async ({ call }) => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    const res = await call(app, undefined);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "creator sign-in required" });
  });

  it.each(matrix)(
    "$name rejects a session for another channel (403)",
    async ({ call }) => {
      const { app, store } = setup();
      saveConnectedChannel(store);
      const res = await call(app, sessionCookie("UCother"));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        message: "session does not include this channel",
      });
    },
  );

  it("refuses a request for another channel's archive (403)", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    store.saveCreator({
      channelId: "UCchan2",
      channelTitle: "Other",
      tokenEnc: encryptToken("rt2", TEST_KEY),
    });
    store.saveVideoWithCues({
      channelId: "UCchan2",
      videoId: "v2",
      title: "Other upload",
      publishedAt: "",
      trackKind: "standard",
      fetchedAt: new Date().toISOString(),
      cues: [{ idx: 1, startSeconds: 1, endSeconds: 2, text: "secret line" }],
    });
    const res = await getAuthed(
      app,
      "/api/archive/videos?channelId=UCchan2",
      sessionCookie("UCchan1"),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: "session does not include this channel",
    });
  });

  it("rejects an expired session", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    const stale = sessionCookie(
      "UCchan1",
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    );
    const res = await getAuthed(
      app,
      "/api/archive/videos?channelId=UCchan1",
      stale,
    );
    expect(res.status).toBe(401);
  });

  it("limits /status to the caller's own creators", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    store.saveCreator({
      channelId: "UCchan2",
      channelTitle: "Other",
      tokenEnc: encryptToken("rt2", TEST_KEY),
    });
    const mine = await app.request("/api/archive/status", {
      headers: { Cookie: sessionCookie("UCchan1") },
    });
    expect((await mine.json()) as unknown).toMatchObject({
      creators: [{ channelId: "UCchan1", channelTitle: "Test Channel" }],
    });
    const none = await app.request("/api/archive/status");
    expect((await none.json()) as unknown).toMatchObject({ creators: [] });
  });

  it("issues a session cookie on connect", async () => {
    const { app } = setup();
    const { state, cookie } = await startFlow(app);
    const res = await app.request(
      `/api/archive/oauth/callback?code=auth-code&state=${state}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(verifySession(sessionValue(res), Date.now(), TEST_KEY)).toEqual([
      "UCchan1",
    ]);
  });

  it("merges a second channel into the session", async () => {
    const seen: string[] = [];
    const inner = makeGoogleFetch({}, seen);
    let channelCalls = 0;
    const fetchFn = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      if (String(url).includes("/youtube/v3/channels")) {
        channelCalls += 1;
        if (channelCalls === 2) {
          return jsonResponse({
            items: [{ id: "UCchan2", snippet: { title: "Second" } }],
          });
        }
      }
      return inner(url);
    };
    const { app } = setup({}, { fetchFn });
    const first = await startFlow(app);
    const one = await app.request(
      `/api/archive/oauth/callback?code=a&state=${first.state}`,
      { headers: { Cookie: first.cookie } },
    );
    expect(one.status).toBe(302);
    const session1 = sessionValue(one);
    expect(verifySession(session1, Date.now(), TEST_KEY)).toEqual(["UCchan1"]);
    const second = await startFlow(app);
    const two = await app.request(
      `/api/archive/oauth/callback?code=b&state=${second.state}`,
      {
        headers: { Cookie: `${second.cookie}; ${SESSION_COOKIE}=${session1}` },
      },
    );
    expect(two.status).toBe(302);
    expect(verifySession(sessionValue(two), Date.now(), TEST_KEY)).toEqual([
      "UCchan1",
      "UCchan2",
    ]);
  });

  it("drops the channel from the session on disconnect", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    const res = await postAuthed(
      app,
      "/api/archive/disconnect",
      { channelId: "UCchan1" },
      sessionCookie(["UCchan1", "UCchan2"]),
    );
    expect(res.status).toBe(200);
    expect(verifySession(sessionValue(res), Date.now(), TEST_KEY)).toEqual([
      "UCchan2",
    ]);
  });

  it("clears the session when the last channel disconnects", async () => {
    const { app, store } = setup();
    saveConnectedChannel(store);
    const cookie = sessionCookie("UCchan1");
    const res = await postAuthed(
      app,
      "/api/archive/disconnect",
      { channelId: "UCchan1" },
      cookie,
    );
    expect(res.status).toBe(200);
    expect(sessionValue(res)).toBe("");
    const videos = await getAuthed(
      app,
      "/api/archive/videos?channelId=UCchan1",
      cookie,
    );
    expect(videos.status).toBe(404);
  });

  it("evicts the oldest pending OAuth session past the cap", async () => {
    const { app, seen } = setup();
    const first = await startFlow(app);
    for (let i = 0; i < 100; i += 1) {
      await app.request("/api/archive/oauth/start");
    }
    const evicted = await app.request(
      `/api/archive/oauth/callback?code=auth-code&state=${first.state}`,
      { headers: { Cookie: first.cookie } },
    );
    expect(evicted.status).toBe(302);
    expect(evicted.headers.get("location")).toContain("error=");
    expect(seen).toEqual([]);
    const fresh = await startFlow(app);
    const ok = await app.request(
      `/api/archive/oauth/callback?code=auth-code&state=${fresh.state}`,
      { headers: { Cookie: fresh.cookie } },
    );
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/creator?connected=1");
  });
});
