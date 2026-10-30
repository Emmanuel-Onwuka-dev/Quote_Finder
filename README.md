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

Known risk (creator archive, spec §7.6): YouTube's policy text does not
address showing caption text from an authorized channel to other viewers.
Captions are only read from channels whose creator connected and listed their
archive, and only the matched lines are shown in results.

## Models and tools

- Text (query variants, ranking, fallback): Muse Spark (`muse-spark-1.3`)
  through the Meta Model API.
- Speech (voice input): Muse Voice Transcribe (`muse-voice-transcribe-1.0`)
  through the Meta Model API.
- Optional: Muse Image quote cards, Muse Glimmer query rephrasing.
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
