// Creator archive HTTP routes (§4.1–§4.4): OAuth connect, status, upload
// listing, caption indexing, and disconnect. Mounted at /api/archive.
// Secrets never leave the server: the browser sees channel titles and
// counts only.

import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { listUploadsPage, resolveChannel, videosById } from "../youtube";
import { SSE_HEADERS, formatSseEvent } from "../quote-stream";
import { decryptToken, encryptToken } from "./crypto";
import { INDEX_PAUSED_MESSAGE, runIndexing } from "./indexing";
import {
  matchArchive,
  noMatchResult,
  toArchiveResult,
  type ArchiveVideoCues,
} from "./match";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  issueSession,
  verifySession,
} from "./session";
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
  videoFreshness,
  type ArchiveStore,
  type MatchableVideo,
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
/** Cap on concurrent OAuth handshakes; oldest-first eviction. Without a
 * cap, hits on /oauth/start grow the pending map without bound. */
const MAX_PENDING_OAUTH = 100;

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

const ListedSchema = z.object({
  channelId: z.string().min(1),
  listed: z.boolean(),
});

const SearchSchema = z.object({
  channelId: z.string().min(1),
  quote: z.string().trim().min(1),
  variants: z.array(z.string().trim().min(1)).max(3).optional(),
  sinceDays: z.number().int().min(0).max(3650).optional(),
});

/**
 * On-miss ASR refreshes per search (§7.4 as approved). Bounded for
 * interactive latency and quota: at most 3 videos (~750 units).
 */
const MAX_REFRESH_PER_SEARCH = 3;

function inWindow(
  publishedAt: string,
  sinceDays: number,
  now: Date,
): boolean {
  if (!sinceDays) {
    return true;
  }
  if (!publishedAt) {
    return true;
  }
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) {
    return true;
  }
  return published >= now.getTime() - sinceDays * 24 * 60 * 60 * 1000;
}

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

  const nowMs = (): number => (deps.now ?? new Date()).getTime();

  const sessionCookieAttrs = {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
    secure: deps.googleRedirectUri.startsWith("https://"),
  } as const;

  function channelsOf(cookieValue: string | undefined): string[] {
    return verifySession(cookieValue, nowMs(), deps.archiveTokenKey) ?? [];
  }

  /** Null on a match; otherwise the 401 (session missing, invalid, or
   * expired) or 403 (session does not include the channel) to return. */
  function requireChannel(
    cookieValue: string | undefined,
    channelId: string,
  ): { status: 401 | 403; message: string } | null {
    const ids = verifySession(cookieValue, nowMs(), deps.archiveTokenKey);
    if (ids === null) {
      return { status: 401, message: "creator sign-in required" };
    }
    if (!ids.includes(channelId)) {
      return { status: 403, message: "session does not include this channel" };
    }
    return null;
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
    while (pending.size >= MAX_PENDING_OAUTH) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      pending.delete(oldest);
    }
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
      setCookie(
        c,
        SESSION_COOKIE,
        issueSession(
          [...channelsOf(getCookie(c, SESSION_COOKIE)), channel.channelId],
          nowMs(),
          deps.archiveTokenKey,
        ),
        sessionCookieAttrs,
      );
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : "Sign-in failed",
        session.returnBase,
      );
    }
    return c.redirect(`${session.returnBase ?? ""}/creator?connected=1`);
  });

  app.get("/status", (c) => {
    const now = deps.now ?? new Date();
    const mine = new Set(channelsOf(getCookie(c, SESSION_COOKIE)));
    return c.json({
      creators: store
        .listCreators()
        .filter((row) => mine.has(row.channel_id))
        .map((row) => ({
        channelId: row.channel_id,
        channelTitle: row.channel_title,
        videoCount: store.countFreshVideos(row.channel_id, now),
        listed: row.listed === 1,
      })),
      budget: {
        spentUnits: store.getSpent(todayKey(now)),
        capUnits: DAILY_BUDGET_UNITS,
      },
    });
  });

  app.get("/creators", (c) => {
    const now = deps.now ?? new Date();
    return c.json({
      creators: store.listListedCreators().map((row) => ({
        channelId: row.channel_id,
        channelTitle: row.channel_title,
        videoCount: store.countFreshVideos(row.channel_id, now),
      })),
    });
  });

  app.get("/videos", async (c) => {
    const channelId = c.req.query("channelId") ?? "";
    if (!channelId) {
      return c.json({ message: "channelId is required" }, 400);
    }
    const denied = requireChannel(getCookie(c, SESSION_COOKIE), channelId);
    if (denied) {
      return c.json({ message: denied.message }, denied.status);
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
      const now = deps.now ?? new Date();
      const states = new Map(
        store
          .getIndexedVideos(channelId)
          .map((row) => [row.video_id, row] as const),
      );
      return c.json({
        videos: page.videos.map((video) => ({
          id: video.id,
          title: video.title,
          publishedAt: video.publishedAt,
          indexed: videoFreshness(states.get(video.id), now),
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
    if (!deps.youtubeApiKey) {
      return c.json({ message: "Missing server env YOUTUBE_API_KEY." }, 500);
    }
    const { channelId, videoIds } = parsed.data;
    const denied = requireChannel(getCookie(c, SESSION_COOKIE), channelId);
    if (denied) {
      return c.json({ message: denied.message }, denied.status);
    }
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
    const now = deps.now ?? new Date();
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
          const purged = store.purgeExpired(now);
          if (purged > 0) {
            send("progress", {
              stage: "Purging expired captions",
              detail: `${purged} cues`,
            });
          }
          const result = await runIndexing({
            videoIds,
            accessToken: token,
            store,
            fetchFn,
            onProgress: (stage, detail) => send("progress", { stage, detail }),
            now,
          });
          if (result.indexed.length > 0) {
            const details = await videosById(
              result.indexed.map((video) => video.videoId),
              deps.youtubeApiKey,
            );
            const byId = new Map(
              details.map((video) => [video.id, video] as const),
            );
            for (const video of result.indexed) {
              const meta = byId.get(video.videoId);
              store.saveVideoWithCues({
                channelId,
                videoId: video.videoId,
                title: meta?.title ?? "",
                publishedAt: meta?.publishedAt ?? "",
                trackKind: video.trackKind,
                fetchedAt: now.toISOString(),
                cues: video.cues,
              });
            }
          }
          send("result", {
            // Cue text stays server-side in storage; the event carries
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

  app.post("/search", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ message: "request body must be JSON" }, 400);
    }
    const parsed = SearchSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { message: "channelId and a non-empty quote are required" },
        400,
      );
    }
    const { channelId, quote } = parsed.data;
    const variants = parsed.data.variants ?? [];
    const sinceDays = parsed.data.sinceDays ?? 0;
    const creator = store.getCreator(channelId);
    if (!creator || creator.listed !== 1) {
      return c.json(
        { message: "channel is not available for search" },
        404,
      );
    }
    const now = deps.now ?? new Date();
    const channelTitle = creator.channel_title;
    const toCandidates = (videos: MatchableVideo[]): ArchiveVideoCues[] =>
      videos
        .filter((video) => inWindow(video.published_at, sinceDays, now))
        .map((video) => ({
          videoId: video.video_id,
          title: video.title,
          publishedAt: video.published_at,
          channelTitle,
          trackKind: video.track_kind,
          cues: video.cues,
        }));
    const fresh = matchArchive(
      toCandidates(store.getMatchableVideos(channelId, now)),
      quote,
      variants,
    );
    if (fresh) {
      return c.json(toArchiveResult(fresh, [], false));
    }
    // On-miss ASR refresh (§7.4 as approved): re-download expired
    // auto-generated captions so they can match. Expired standard
    // captions stay out until the creator re-indexes them.
    const stale = store
      .getStaleAsrVideos(channelId, now)
      .slice(0, MAX_REFRESH_PER_SEARCH);
    if (stale.length === 0) {
      return c.json(noMatchResult([], false));
    }
    let accessToken: string;
    try {
      const token = await accessTokenFor(channelId);
      if (!token) {
        return c.json({ message: "channel is not connected" }, 404);
      }
      accessToken = token;
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
    const run = await runIndexing({
      videoIds: stale.map((video) => video.video_id),
      accessToken,
      store,
      fetchFn,
      now,
    });
    const metaById = new Map(
      stale.map((video) => [video.video_id, video] as const),
    );
    for (const video of run.indexed) {
      const meta = metaById.get(video.videoId);
      if (!meta) {
        continue;
      }
      store.saveVideoWithCues({
        channelId,
        videoId: video.videoId,
        title: meta.title,
        publishedAt: meta.published_at,
        trackKind: video.trackKind,
        fetchedAt: now.toISOString(),
        cues: video.cues,
      });
    }
    const refreshed = run.indexed.map((video) => video.videoId);
    const retry = matchArchive(
      toCandidates(store.getMatchableVideos(channelId, now)),
      quote,
      variants,
    );
    return c.json(
      retry
        ? toArchiveResult(retry, refreshed, run.paused)
        : noMatchResult(refreshed, run.paused),
    );
  });

  app.post("/listed", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ message: "request body must be JSON" }, 400);
    }
    const parsed = ListedSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { message: "channelId and listed are required" },
        400,
      );
    }
    const denied = requireChannel(
      getCookie(c, SESSION_COOKIE),
      parsed.data.channelId,
    );
    if (denied) {
      return c.json({ message: denied.message }, denied.status);
    }
    const row = store.getCreator(parsed.data.channelId);
    if (!row) {
      return c.json({ message: "channel is not connected" }, 404);
    }
    store.setListed(row.channel_id, parsed.data.listed);
    return c.json({ ok: true, listed: parsed.data.listed });
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
    const denied = requireChannel(
      getCookie(c, SESSION_COOKIE),
      parsed.data.channelId,
    );
    if (denied) {
      return c.json({ message: denied.message }, denied.status);
    }
    const row = store.getCreator(parsed.data.channelId);
    if (!row) {
      return c.json({ message: "channel is not connected" }, 404);
    }
    // Best effort: local data — credentials, videos, and cues, in one
    // transaction — is deleted even when the revoke call fails (e.g. the
    // token was already revoked at Google), so the creator can always
    // get out.
    let revoked = true;
    try {
      await revokeToken(
        decryptToken(row.token_enc, deps.archiveTokenKey),
        fetchFn,
      );
    } catch {
      revoked = false;
    }
    store.deleteChannel(row.channel_id);
    try {
      const remaining = channelsOf(getCookie(c, SESSION_COOKIE)).filter(
        (id) => id !== row.channel_id,
      );
      if (remaining.length === 0) {
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
      } else {
        setCookie(
          c,
          SESSION_COOKIE,
          issueSession(remaining, nowMs(), deps.archiveTokenKey),
          sessionCookieAttrs,
        );
      }
    } catch {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
    }
    return c.json({ ok: true, revoked });
  });

  return app;
}
