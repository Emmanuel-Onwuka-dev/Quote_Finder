// Creator archive HTTP routes (§4.1, §4.4): OAuth connect, status, and
// disconnect. Mounted at /api/archive. Secrets never leave the server:
// the browser sees channel titles and counts only.

import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { decryptToken, encryptToken } from "./crypto";
import {
  buildAuthUrl,
  codeChallenge,
  createCodeVerifier,
  createState,
  exchangeCode,
  fetchOwnChannel,
  revokeToken,
} from "./oauth";
import { openArchiveStore, type ArchiveStore } from "./store";

export interface ArchiveDeps {
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  archiveTokenKey: string;
  archiveDbPath?: string;
  store?: ArchiveStore;
  fetchFn?: typeof fetch;
}

const STATE_COOKIE = "archive_oauth_state";
const PENDING_TTL_MS = 10 * 60 * 1000;

const DisconnectSchema = z.object({ channelId: z.string().min(1) });

export function createArchiveRoutes(deps: ArchiveDeps) {
  const app = new Hono();
  const store =
    deps.store ?? openArchiveStore(deps.archiveDbPath ?? "./archive.db");
  const fetchFn = deps.fetchFn ?? fetch;
  const pending = new Map<string, { verifier: string; createdAt: number }>();

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
    pending.set(state, { verifier, createdAt: Date.now() });
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
    const fail = (message: string) =>
      c.redirect(`/creator?error=${encodeURIComponent(message)}`);
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    prunePending(Date.now());
    const session = pending.get(state);
    if (!state || !code || !session || getCookie(c, STATE_COOKIE) !== state) {
      return fail(
        "Sign-in expired or was opened in another tab. Please try again.",
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
      return fail(error instanceof Error ? error.message : "Sign-in failed");
    }
    return c.redirect("/creator?connected=1");
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
    });
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
