// Creator archive HTTP routes (§4.1, §4.2, §4.4): OAuth connect, status,
// upload listing, caption indexing, and disconnect. Mounted at
// /api/archive. Secrets never leave the server: the browser sees channel
// titles and counts only.

import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { listUploadsPage, resolveChannel } from "../youtube";
import { SSE_HEADERS, formatSseEvent } from "../quote-stream";
import { decryptToken, encryptToken } from "./crypto";
import { INDEX_PAUSED_MESSAGE, runIndexing } from "./indexing";
import {
  buildAuthUrl,
  codeChallenge,
  createCodeVerifier,
  createState,
  exchangeCode,
  fetchOwnChannel,
  refreshAccessToken,
  revokeToken,
} from "./oauth";
import {
  DAILY_BUDGET_UNITS,
  openArchiveStore,
  todayKey,
  type ArchiveStore,
} from "./store";

export interface ArchiveDeps {
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  archiveTokenKey: string;
  youtubeApiKey: string;
  archiveDbPath?: string;
  store?: ArchiveStore;
  fetchFn?: typeof fetch;
  now?: Date;
}

const STATE_COOKIE = "archive_oauth_state";
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Where to send the browser after OAuth: the origin that started the flow
 * (the client page), so dev (split ports) and prod (single origin) both
 * land correctly. Null falls back to a same-origin relative redirect.
 */
function returnBaseFromReferer(referer: string | undefined): string | null {
  if (!referer) {
    return null;
  }
  try {
    const url = new URL(referer);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

const DisconnectSchema = z.object({ channelId: z.string().min(1) });

const IndexSchema = z.object({
  channelId: z.string().min(1),
  videoIds: z.array(z.string().min(1)).min(1).max(200),
});

export function createArchiveRoutes(deps: ArchiveDeps) {
  const app = new Hono();
  const store =
    deps.store ?? openArchiveStore(deps.archiveDbPath ?? "./archive.db");
  const fetchFn = deps.fetchFn ?? fetch;
  const pending = new Map<
    string,
    { verifier: string; returnBase: string | null; createdAt: number }
  >();

  function prunePending(now: number): void {
    for (const [state, session] of pending) {
      if (now - session.createdAt > PENDING_TTL_MS) {
        pending.delete(state);
      }
    }
  }

  function configured(): boolean {
    return Boolean(
      deps.googleClientId && deps.googleClientSecret && deps.googleRedirectUri,
    );
  }

  // Null when the channel is not connected; throws when its token is
  // missing or Google refuses the refresh.
  async function accessTokenFor(channelId: string): Promise<string | null> {
    const row = store.getCreator(channelId);
    if (!row) {
      return null;
    }
    return refreshAccessToken(
      {
        refreshToken: decryptToken(row.token_enc, deps.archiveTokenKey),
        clientId: deps.googleClientId,
        clientSecret: deps.googleClientSecret,
      },
      fetchFn,
    );
  }

  app.get("/oauth/start", (c) => {
    if (!configured()) {
      return c.text(
        "Creator archive is not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI).",
        500,
      );
    }
    const state = createState();
    const verifier = createCodeVerifier();
    prunePending(Date.now());
    pending.set(state, {
      verifier,
      returnBase: returnBaseFromReferer(c.req.header("referer")),
      createdAt: Date.now(),
    });
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
      secure: deps.googleRedirectUri.startsWith("https://"),
    });
    return c.redirect(
      buildAuthUrl({
        clientId: deps.googleClientId,
        redirectUri: deps.googleRedirectUri,
        state,
        challenge: codeChallenge(verifier),
      }),
    );
  });

  app.get("/oauth/callback", async (c) => {
    const fail = (message: string, base: string | null) =>
      c.redirect(`${base ?? ""}/creator?error=${encodeURIComponent(message)}`);
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    prunePending(Date.now());
    const session = pending.get(state);
    if (!state || !code || !session || getCookie(c, STATE_COOKIE) !== state) {
      return fail(
        "Sign-in expired or was opened in another tab. Please try again.",
        null,
      );
    }
    pending.delete(state);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    try {
      const tokens = await exchangeCode(
        {
          code,
          clientId: deps.googleClientId,
          clientSecret: deps.googleClientSecret,
          redirectUri: deps.googleRedirectUri,
          verifier: session.verifier,
        },
        fetchFn,
      );
      const channel = await fetchOwnChannel(tokens.accessToken, fetchFn);
      store.saveCreator({
        channelId: channel.channelId,
        channelTitle: channel.channelTitle,
        tokenEnc: encryptToken(tokens.refreshToken, deps.archiveTokenKey),
      });
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : "Sign-in failed",
        session.returnBase,
      );
    }
    return c.redirect(`${session.returnBase ?? ""}/creator?connected=1`);
  });

  app.get("/status", (c) => {
    return c.json({
      creators: store.listCreators().map((row) => ({
        channelId: row.channel_id,
        channelTitle: row.channel_title,
        // Indexed-video count arrives with caption storage in A3.
        videoCount: 0,
        listed: row.listed === 1,
      })),
      budget: {
        spentUnits: store.getSpent(todayKey(deps.now ?? new Date())),
        capUnits: DAILY_BUDGET_UNITS,
      },
    });
  });

  app.get("/videos", async (c) => {
    const channelId = c.req.query("channelId") ?? "";
    if (!channelId) {
      return c.json({ message: "channelId is required" }, 400);
    }
    if (!store.getCreator(channelId)) {
      return c.json({ message: "channel is not connected" }, 404);
    }
    if (!deps.youtubeApiKey) {
      return c.json({ message: "Missing server env YOUTUBE_API_KEY." }, 500);
    }
    try {
      const header = await resolveChannel(channelId, deps.youtubeApiKey);
      const page = await listUploadsPage(
        header.uploadsPlaylistId,
        deps.youtubeApiKey,
        c.req.query("pageToken") ?? undefined,
      );
      return c.json({
        videos: page.videos.map((video) => ({
          id: video.id,
          title: video.title,
          publishedAt: video.publishedAt,
        })),
        ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      });
    } catch (error) {
      return c.json(
        {
          message:
            error instanceof Error ? error.message : "Video list failed",
        },
        502,
      );
    }
  });

  app.post("/index", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ message: "request body must be JSON" }, 400);
    }
    const parsed = IndexSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { message: "channelId and at least one videoId are required" },
        400,
      );
    }
    const { channelId, videoIds } = parsed.data;
    let accessToken: string | null;
    try {
      accessToken = await accessTokenFor(channelId);
    } catch (error) {
      return c.json(
        {
          message:
            error instanceof Error
              ? error.message
              : "Could not refresh YouTube access",
        },
        502,
      );
    }
    if (!accessToken) {
      return c.json({ message: "channel is not connected" }, 404);
    }
    const token = accessToken;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          if (!closed) {
            controller.enqueue(encoder.encode(formatSseEvent(event, data)));
          }
        };
        try {
          const result = await runIndexing({
            videoIds,
            accessToken: token,
            store,
            fetchFn,
            onProgress: (stage, detail) => send("progress", { stage, detail }),
            now: deps.now,
          });
          send("result", {
            // Cue text stays server-side for A3 storage; the event carries
            // counts so the creator page can summarize the run.
            indexed: result.indexed.map((video) => ({
              videoId: video.videoId,
              trackKind: video.trackKind,
              language: video.language,
              cueCount: video.cues.length,
            })),
            skipped: result.skipped,
            paused: result.paused,
            message: result.paused ? INDEX_PAUSED_MESSAGE : "",
            spentUnits: result.spentUnits,
          });
        } catch (error) {
          send("error", {
            message:
              error instanceof Error ? error.message : "Indexing failed",
          });
        } finally {
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      },
      cancel() {
        closed = true;
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  });

  app.post("/disconnect", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ message: "request body must be JSON" }, 400);
    }
    const parsed = DisconnectSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ message: "channelId must not be empty" }, 400);
    }
    const row = store.getCreator(parsed.data.channelId);
    if (!row) {
      return c.json({ message: "channel is not connected" }, 404);
    }
    // Best effort: local data is deleted even when the revoke call fails
    // (e.g. the token was already revoked at Google), so the creator can
    // always get out. Video/caption rows join this delete in A3.
    let revoked = true;
    try {
      await revokeToken(
        decryptToken(row.token_enc, deps.archiveTokenKey),
        fetchFn,
      );
    } catch {
      revoked = false;
    }
    store.deleteCreator(row.channel_id);
    return c.json({ ok: true, revoked });
  });

  return app;
}
