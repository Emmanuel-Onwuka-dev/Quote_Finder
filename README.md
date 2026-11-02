# Quotefinder

Type or speak a line you remember from a video. Quotefinder searches the
creator's real YouTube uploads (or the wider YouTube catalogue when no creator
is given), matches the line against titles and descriptions, and returns the
matching video with an embedded player. Timestamps are not verified in this
version — the app does not read transcripts.

Built for the **Build for Your World** hackathon. All work on this project,
including code, README, and spec, starts on Oct 27, 2026 and finishes by the
Nov 4 deadline.

## Platform policy

This version does not scrape any platform and does not download any video or
audio. It uses only official APIs (YouTube Data API v3), oEmbed, the YouTube
embedded player, and Meta's models. No transcript fetching, no scrapers, no
downloads.

Known risk (creator archive, spec §13A): YouTube's policy text does not
clearly cover showing caption text from an authorized channel to other people.
Caption text is shown only to the signed-in creator who owns the channel, so
this version does not depend on that answer.

## Models and tools

- Text (query variants, ranking, fallback): Muse Spark (`muse-spark-1.3`)
  through the Meta Model API.
- Speech (voice input): Muse Voice Transcribe (`muse-voice-transcribe-1.0`)
  through the Meta Model API.
- Optional: Muse Image quote cards, Muse Glimmer query rephrasing
  (off on the hosted version: it needs a local Glimmer server reachable
  at OPEN_MODEL_URL). Glimmer's model name comes from OPEN_MODEL_NAME
  (default glimmer).
- Coding agent: built with **Muse Code**.

## Original work (built during the hackathon)

- P0: Vite + React + TypeScript scaffold, Tailwind semantic tokens, fonts, SEO
  tags, server config, Meta API client stub, health endpoint.
- P1: YouTube engine (channel resolution, upload index, in-channel and
  everywhere search) with fuzzy title/description matching and unit tests.
- P2: `locateQuote` orchestrator — Muse query variants, shortlist-only
  ranking, memory fallback with verified links (oEmbed/HEAD), found
  thresholds, medium confidence cap, and time-window handling, with mocked
  unit tests.
- P3a: `POST /api/quote-stream` — zod body validation, `locateQuote`
  progress streamed as SSE stages, `result`/`error` events, with endpoint
  tests.
- P3b: chat UI — session-only turns, live SSE progress, result card
  (nocookie embed, unverified notice), candidate list, `openExternal`
  links, original SVG brand, SEO tags, and lib unit tests.
- A1: creator archive foundation — Google OAuth (PKCE) connect/disconnect
  for creators, encrypted refresh-token storage in SQLite, `/creator`
  page, and endpoint tests with mocked Google responses.
- A2: caption indexing pipeline — SRT parser, captions API client, daily
  budget counter, token refresh, videos/index routes, and creator
  indexing UI with live progress.
- A3: archive storage — videos/cues tables, purge of expired cue text,
  indexed states, real video counts, and transactional revoke-and-delete.
- A4: caption-window matching — 3-to-6-cue windows scored with the shared
  fuzzy overlap, ASR confidence cap, archive search endpoint with on-miss
  ASR refresh, listed-creators scope, and the verified-timestamp result.
- A5 (removed): viewer archive UI — creator picker on the search page,
  archive result card there, and miss/retry states. Removed when the archive
  went creator-only; caption text is shown only to the signed-in creator.
- P4: voice input — `POST /api/transcribe` (WAV validation, Meta ASR
  forward with 429/500 retries), `use-voice-input` hook (AudioWorklet
  capture, 16 kHz mono WAV), mic button with recording/transcribing
  states, and endpoint plus audio unit tests.
- P5: Glimmer variant integration — optional second-model rephrasings
  from `OPEN_MODEL_URL` appended to the Spark variants, never fatal.
  Glimmer takes one of the three search slots, with a 5-second timeout;
  the model name comes from OPEN_MODEL_NAME. Off on the hosted version:
  it needs a local Glimmer server reachable at OPEN_MODEL_URL.
- P5: Image quote cards — `POST /api/quote-card` renders a shareable
  card for each found result, shown in the result card, hidden on
  failure.
- P6: result card sharing — Share button (browser share sheet, copy
  fallback) on found results, Download card button, and share text
  marking the remembered line as not verified.
- P7: creator archive share link — video title and link only; caption
  text is never shared.
- P8: voice input errors — silent interim chunks, plain "We didn't hear
  any speech" message on stop, and start and final errors still shown.
- P9: fallback reliability — nullable and clock-string fields accepted
  from the model, empty or non-web URLs skipped before fetch.
- P10: server error logging with step names and redaction; Sentry
  alerts when SENTRY_DSN is set.
- P11: honest no-result when the search quota is spent and nothing
  verifies, plus plain-language notes.
- P12: quote-card daily cap of 500 per process, with the AI-generated
  label.

## External services and libraries

- YouTube Data API v3, YouTube oEmbed, YouTube embedded player.
- Meta Model API (Muse Spark, Muse Voice Transcribe; optionally Muse Image,
  Muse Glimmer).
- React, Vite, Tailwind CSS, Hono, Zod, Vitest, tsx.

## Development

```sh
cp .env.example .env   # fill in real keys; never commit .env
npm install
npm run dev:server     # API on :8787 (one terminal)
npm run dev:client     # UI with /api proxy (another terminal)
npm run typecheck
npm test
```

Keys go in `.env` on your machine or the platform secret store — never in chat,
source files, or the browser.

Heavy testing day? Raise the daily search quota for the server session
(default 3000 units, resets at UTC midnight):

```powershell
$env:SEARCH_BUDGET_UNITS="10000"   # same terminal, before npm run dev:server
```

Errors are logged to the server console with the step name. If
SENTRY_DSN is set, they are also sent to Sentry, with request bodies,
headers, cookies, query strings, and keys removed. Leave SENTRY_DSN
empty to turn this off.
