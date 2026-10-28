# Quotefinder: Build Specification

Use this document to build Quotefinder with any stack, tool, or AI coding assistant. It describes behavior, data flow, external services, and configuration. It does not depend on a particular framework, hosting platform, or code generator. Where the original implementation used a specific tool, this spec names the requirement and leaves the choice open.

---

## Hackathon rules for the build

- **Problem statement:** Build for Your World.
- **Built during the hackathon.** All work on this project, including the code, the README, and this spec, starts on Oct 27, 2026 and is finished by the Nov 4 deadline. The README must say so.
- **Public repository.** The repo must be public. Never commit API keys. Commit only `.env.example`, never `.env`.
- **Meta models used.** AI features must use Meta models through the Meta Model API: Muse Spark (`TEXT_MODEL`) for text, and Muse Voice Transcribe (`TRANSCRIPTION_MODEL`) for speech. Muse Image (section 7.7) and Muse Glimmer (section 7.7) are optional. Name Muse Code in the README as the coding agent used to build the project.
- **Original contributions.** The README must list what was built during the hackathon, separately from external services and libraries.
- **Platform policy.** The README must state that this version does not scrape any platform and does not download any video or audio. It uses only official APIs (YouTube Data API), oEmbed, the YouTube embedded player, and Meta's models. Do not add scraping, transcript fetching, or downloads without first checking the platform's terms.

---

## 1. Product summary

Quotefinder is a web app. A user types or speaks a line they remember from a video. They optionally name the creator, choose a time window, and optionally describe the scene. The app then:

1. Searches the creator's real uploads (or the wider web, if no creator is given) using YouTube's official API.
2. Matches the remembered line against each video's title and description.
3. Returns the matching video, an embedded player for it, and the full remembered sentence as the user typed or spoke it. It also says plainly that the exact timestamp was not verified, because the app does not read transcripts.

If nothing matches confidently, the app still returns at least 10 real, verified candidate links. It never ends in a dead end.

---

## 2. Technical requirements

- **Frontend:** any modern component-based UI library or plain JavaScript/TypeScript. The UI needs a streaming-capable HTTP client (`fetch` with a `ReadableStream` reader works).
- **Backend:** any server runtime that can run HTTP endpoints, stream responses, and make outbound HTTP requests. The original used Node/Bun-style TypeScript with a Vite-based build, file-based routing under `src/routes`, and Tailwind CSS v4. None of this is required.
- **Persistence:** none. No database and no user accounts. All state lives in the browser session.
- **Styling:** any CSS approach. Colors must be defined as semantic tokens (for example `--background`, `--foreground`, `--accent`, `--destructive`), not hardcoded in components.
- **Type checking:** the project should type-check cleanly after every change, using whatever checker the stack provides.
- **SEO:** every public page has its own title, description, and Open Graph and Twitter card tags. Use `og:type = website` and `twitter:card = summary_large_image`.

### Fonts

Use one display font for headings, one body font, and one monospace font for timestamps and code. The original used:

- Headings: Space Grotesk (weights 500, 700)
- Body: DM Sans (weights 400, 500)
- Timestamps and code: JetBrains Mono (weights 400, 500)

Load them in the document head through Google Fonts or self-hosted files.

---

## 3. Secrets and configuration

Set these as server-side environment variables. Browser code must never read them.

| Variable | Purpose |
|---|---|
| `MODEL_API_KEY` | Meta Model API key (create it in the Model API dashboard). Used for Muse Spark and Muse Voice Transcribe. |
| `META_BASE_URL` | `https://api.meta.ai/v1` (OpenAI SDK compatible). Pass the key to the SDK explicitly; the OpenAI SDK does not read `MODEL_API_KEY` on its own. |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key. Used for channel resolution, uploads, and search. |

Also configure these model names. Keep them in config rather than in code so you can swap versions:

| Setting | Value |
|---|---|
| `TEXT_MODEL` | `muse-spark-1.3` |
| `TRANSCRIPTION_MODEL` | `muse-voice-transcribe-1.0` |
| `IMAGE_MODEL` | `muse-image-1.0` (optional: shareable quote cards) |
| `OPEN_MODEL_URL` | URL of a locally served Muse Glimmer endpoint (optional: extra query rephrasing, added to Muse Spark's variants; see section 7.7) |

**Notes on credentials:**

- Enter every key through your platform's secret store or environment settings. Never paste keys into chat, source files, or the browser.
- Rotate any key that has ever been exposed in a chat, log, or repository.

---

## 4. Architecture

Create these modules. Names are suggestions; keep the separation of responsibilities.

| Module | Responsibility |
|---|---|
| `llm-client` (server) | Creates the client for the Meta Model API. Base URL from `META_BASE_URL`, auth via `Authorization: Bearer ${MODEL_API_KEY}`. |
| `youtube-index` (server) | YouTube engine: channel resolution, upload index, in-channel search, title and description matching. |
| `quote-finder` (server) | Orchestrator: picks the search path, asks Muse Spark for query variants and ranking, verifies links. |
| `quote-stream` endpoint | `POST` endpoint that streams progress and results as Server-Sent Events (SSE). The UI uses this. |
| `transcribe` endpoint | `POST` endpoint that accepts a voice recording and returns text. |
| `use-voice-input` (client) | Browser hook: records microphone audio, converts it, and posts it to `transcribe`. |
| Main page | The entire UI: a chat-style, session-only interface. |

**Optional:** a typed RPC wrapper around the orchestrator. The UI uses the SSE endpoint, so this is not required.

### LLM client details

- Use any OpenAI-compatible client library, or plain HTTP.
- Base URL: `META_BASE_URL`.
- Auth header: `Authorization: Bearer ${MODEL_API_KEY}`.
- Muse Spark supports the Responses API and Chat Completions. Use whichever fits your SDK.
- All AI calls must go to Meta models through the Meta Model API. Do not add other model providers or gateways.

---

## 5. YouTube engine

### 5.1 Channel resolution

- Given a creator string, find the channel ID through the YouTube Data API. Search for the name and take the top channel.
- Accept `@handle`, channel URLs, or free text.
- If the full index cannot be built, fall back to in-channel search.

### 5.2 Live index

- Fetch up to about 300 of the channel's uploads. Use the uploads playlist and paginate.
- Store for each video: `id`, `title`, `publishedAt`, `description`.
- Keep the index in memory for the duration of one request. Do not persist it.

### 5.3 Transcripts (removed)

This version does not fetch captions or transcripts. Do not call InnerTube, the timedtext endpoints, or any third-party transcript service. Matching uses only the title and description returned by the official API (section 5.5).

### 5.4 Search flow

Before any search, ask `TEXT_MODEL` for 3 to 5 alternative wordings of the quote (section 7.3). Use them as extra query strings in both paths below.

**With a creator:**

1. Build the upload index.
2. If a time window is set, keep only videos published after the cutoff (`publishedAfter`).
3. Rank videos by title and description relevance (section 5.5).
4. Run a YouTube Data API in-channel search (`maxResults = 15`, query = the quoted line).
5. Merge those results with the ranked videos into one deduplicated pool, capped at 12. This is the **shortlist**.
6. Score each shortlist entry on its title and description. Report progress per video.

**Without a creator (blank creator field), `searchEverywhere`:**

1. Run two YouTube search queries: the quote in double quotes, then the bare quote.
2. Deduplicate and build a pool of 12.
3. Score the pool the same way as above.

This path finds videos whose title or description matches the line. It cannot find a line that is spoken but not written in the title or description.

### 5.5 Fuzzy matching

Users will misremember wording. Implement these helpers:

- **`tokens(text)`**: lowercase, strip punctuation, drop stop words, stem.
- **`close(a, b, max = 1)`**: bounded edit distance. Returns true if the distance is at most `max`.
- **`overlapScore(needle, haystack)`**: weighted overlap of word sets.
  - Weight rare words more: length ≥ 7 gets 1.6×; length ≥ 5 gets 1.25×.
  - Count a near-miss (edit distance ≤ 1) at 80% of the word's weight.
  - Add up to +0.12 when matched words appear in the remembered order.
- **`keyCoverage(needle, haystack)`**: the fraction of distinctive words (6+ characters) that appear in the haystack, counting near-misses. This is a guard. It keeps substance matching even when wording does not.

### 5.6 Metadata scoring (replaces `scanVideo`)

- Score each video with `overlapScore(quote, title + " " + description)`.
- Require `keyCoverage >= 0.6` on the title and description.
- Return: video, score, and the matched words.
- A metadata match can never produce a `high` confidence label (section 7.2). It can reach `medium` at most. The Muse ranking step (section 7.3) follows the same cap.

### 5.7 Playback

- The app embeds the whole video using the YouTube embedded player. It does not download anything.
- Without a verified timestamp, the embed starts at the beginning of the video. Do not invent a start time.
- If the user supplies a timestamp from their own memory, you may use it as `start`, and the UI must label it "your estimate".

### 5.8 Engine output

Return:

```
{
  shortlist,      // the pool, up to 12
  hits,           // top 10, sorted by score
  scanned,        // number of videos scored
  channelTitle,
  channelId,
  videoCount
}
```

---

## 6. Other platforms (removed)

Instagram, TikTok, and Facebook are not supported in this version. Do not scrape their posts, do not download their media, and do not use search-engine scrapers to find their posts. Only YouTube is searched. See section 13.

---

## 7. Orchestrator: `locateQuote`

**Input:** `{ quote, creator, scene, sinceDays }`

Only YouTube is searched.

### 7.1 Routing

| Creator | Path |
|---|---|
| given | `searchChannel` |
| blank | `searchEverywhere` |

The order is fixed:

1. Muse Spark proposes query variants (section 7.3, step 1).
2. The search path runs and scores the shortlist (sections 5.4 to 5.6).
3. If the shortlist is non-empty, Muse Spark ranks it (section 7.3, step 2).
4. If no candidate reaches the found threshold (section 7.2), the fallback answers from memory (section 7.3, step 3).

### 7.2 Confidence thresholds

- **Found:** score ≥ 0.45.
- **Confidence label:** `high` at ≥ 0.8, `medium` at ≥ 0.55. Metadata-only matches cap at `medium` (section 5.6).

A found result contains:

- `creator`, `videoTitle`, `videoUrl`, `publishedAt`
- `startTime`: `0` unless the user supplied an estimate (section 5.7), formatted as `mm:ss` with a `stamp()` helper
- `timestampVerified`: always `false` for this version
- `fullSentence` (the remembered line as the user typed it, cleaned up), `context`, `confidence`
- `notes`: plain-language description of what was searched, for example:
  - "matched the title and description of N videos out of M uploads"
  - "no transcript was read, so the exact moment the line is said is not verified"

Every found result must say the timestamp is not verified.

### 7.3 Muse Spark: query variants, ranking, and fallback

Muse Spark does three jobs, all for YouTube only:

1. **Query variants (before search).** Ask `TEXT_MODEL` for 3 to 5 alternative wordings of the quote, as a JSON array. Use them as extra search queries (section 5.4).
2. **Ranking (after scoring, whenever the shortlist is non-empty).** Send the shortlist (titles, descriptions, URLs, dates), the quote, the scene, and the time window. Ask it to pick the best matches and give a one-line reason for each. Only shortlist URLs may be chosen.
3. **Fallback (when nothing is confident).** Use the rules below to answer from memory. This runs only when no candidate reaches the found threshold (section 7.2), including when the index finds nothing and when `searchEverywhere` finds nothing. It never runs if a confident metadata match already exists.

Stream the ranking and fallback calls to `TEXT_MODEL` through the Meta Model API. Build the system prompt with these rules:

- The user is recalling from memory and will almost never have the exact wording.
- The creator line says UNKNOWN when blank. In that case, identify who said the line. Prefer the original source. Viral clips, interviews, films, speeches, and podcasts all count.
- A `where` line restricts answers to real YouTube watch URLs.
- A `sceneLine` gives the scene description as a disambiguator.
- A `whenLine` gives the human-readable window and tells the model to return nothing older. Use these labels: "the last 24 hours", "7 days", "30 days", "2 months", "6 months", "the last year".
- Provide the real fetched catalogue: shortlist titles, descriptions, and URLs. The model must choose only from real URLs.
- **Always list 10 plausible candidate videos with real, watchable URLs when unsure.**
- Say that the AI's answer is an estimate from memory, not a verified match.
- Reply with a single JSON object with these fields:
  `found`, `confidence`, `videoUrl`, `videoTitle`, `publishedAt`, `startTime`, `endTime`, `fullSentence`, `context`, `notes`, `candidates[]`

Parse the reply by extracting the raw JSON and validating it with a schema validator (for example Zod). `normalize` sets a missing `url` to `""`. The AI's `startTime` and `endTime` are estimates only and must be labelled that way in the UI.

### 7.4 No confident hit: pad to 10

Return exactly 10 candidates when unsure. Fill the list in this order:

1. Videos from the metadata hits.
2. Shortlist pool entries, with a "Possible match · <date>" reason line.

### 7.5 Link verification (no hallucinated links)

`urlExists(url)`:

- YouTube URLs: check with oEmbed, `GET https://www.youtube.com/oembed?url=...&format=json`. No key is needed. Timeout: 8 seconds.
- Other URLs: send a `HEAD` request. If the response is 405 or 403, retry with `GET`. Timeout: 8 seconds.

`verifyUrls` runs 4 checks concurrently.

Trust rules:

- Shortlist YouTube watch URLs are trusted without a check, because they come from the official API.
- The AI's main `videoUrl` and all AI candidate URLs must pass verification.
  - If the main link is dead, clear the answer: `found = false`, with an explanatory note.
  - Remove dead candidates and note how many were dropped.
  - Pad the final list back to 10 from trusted sources.

### 7.6 Time window

Map `sinceDays` to a `publishedAfter` ISO date. Accepted values: `0` (any time), `1`, `7`, `30`, `60`, `180`, `365`, or any custom number of days. Pass the cutoff into the YouTube engine and the AI prompt.

### 7.7 Optional Meta features

These extend the core flow. They are optional, but they show more of the Meta stack. Build them only after the core path works.

- **Muse Glimmer query rephrasing (open weights).** This adds to the Muse Spark variants in section 7.3, step 1. Ask a locally served Muse Glimmer model (`OPEN_MODEL_URL`) for 3 to 5 more wordings of the remembered line, and add them to the search queries in section 5.4. Glimmer is Apache 2.0 and runs on your own hardware with vLLM, SGLang, llama.cpp, or ExecuTorch. If `OPEN_MODEL_URL` is unset, only the Muse Spark variants are used.
- **Muse Image quote card.** For each found result, call `POST ${META_BASE_URL}/images/generations` with model `IMAGE_MODEL` to create a shareable card with the full sentence. Show it in the result card. If the call fails, hide the card. The result must still work without it.
- **Muse Code.** The project is built with Muse Code, Meta's coding agent. This is a build tool, not a runtime dependency. Name it in the README.

---

## 8. API endpoints

### 8.1 `quote-stream`: `POST`

**Request body** (validate with a schema):

| Field | Type | Rules |
|---|---|---|
| `quote` | string | Required, minimum length 1 |
| `creator` | string | Default `""` |
| `scene` | string | Default `""` |
| `sinceDays` | integer | 0 to 3650, default 0 |

**Behavior:** run `locateQuote` and stream Server-Sent Events:

- `progress` events with `{ stage, detail }` at each step. Stages include:
  - "Resolving channel"
  - "Indexing uploads"
  - "Ranking candidates"
  - "Matching titles and descriptions"
  - "Asking the model"
  - "Verifying links"
- `result` event with the full result, or
- `error` event with `{ message }`

**Response headers:**

- `content-type: text/event-stream; charset=utf-8`
- `cache-control: no-store`
- `connection: keep-alive`

### 8.2 `transcribe`: `POST`

- Request: multipart form with an `audio` file (16 kHz mono 16-bit PCM WAV, as produced by the client hook in section 9).
- Reject files smaller than 2 KB, larger than 32 MB, or longer than 10 minutes.
- Forward to `POST ${META_BASE_URL}/asr/transcribe` as a multipart form with a `request` JSON part (`{"mode":"PUSH_TO_TALK","model":"muse-voice-transcribe-1.0","audioEncoding":"WAV"}`) and the `audio` part. Auth with `Authorization: Bearer ${MODEL_API_KEY}`.
- On `429`, retry with exponential backoff. On `500`, retry once.
- Response: `{ "text": "..." }`, taken from the response's `transcript` field.

---

## 9. Voice input (client hook)

Expose the hook as `{ recording, transcribing, error, toggle }`.

- Capture microphone audio with `getUserMedia`.
- Convert to 16 kHz mono WAV. (The original used `ScriptProcessor`; `AudioWorklet` is the modern equivalent.)
- POST the WAV to the `transcribe` endpoint.
- Place the returned text into the quote box.

**UI:**

- A microphone button beside the quote input:
  - Square icon while recording
  - Spinner while transcribing
  - Destructive color while recording
- Input placeholder: "The line you remember — or say it out loud"
- Status text:
  - "Listening… tap the square when you're done."
  - "Writing down what you said…"

---

## 10. Main page: session-only chat UI

### 10.1 Layout

- Chat-style turns. Each search is one turn.
- Each turn shows:
  1. The user's input: quote, creator, scene, and time window.
  2. A live progress feed built from the SSE stages.
  3. The result card or candidate list.
- The time window appears in every turn's header.

### 10.2 Input area

- **Quote row:** quote input with the microphone button, and a creator input.
- **Scene field:** a two-row textarea with the prompt "describe the scene — what was happening, who was on screen".
- **Time window pills:** Any time · 24 hours · 7 days · 30 days · 2 months · 6 months · 1 year, plus a custom-days number input.
- **Helper text:** "Say it however you remember it — the wording doesn't have to be right."

### 10.3 Result card (found)

- Confidence badge: High or Medium.
- Header: creator · time window.
- Video title and published date.
- The full sentence, in a highlighted quote block. The remembered line is the visual hero of the card.
- A notice that reads: "The exact moment this line is said has not been verified."
- Context lines.
- **Player** for YouTube results:
  - Embed URL: `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&modestbranding=1`. Add `&start=${start}` only when the user supplied an estimate, and label it "your estimate".
  - Header: "Video · starts at 0:00" or "Video · your estimate: mm:ss".
  - A copy button for the video link.
- Add the `?t=` deep-link parameter only when a real video ID exists and a timestamp was supplied.

### 10.4 Candidates

Each candidate is clickable:

- **YouTube:** "Play here" (inline embed) and "Open on YouTube".
- **No URL:** "Search this title", which opens a YouTube search for the title.

Each candidate line shows: creator · "last X days" (or "any time").

### 10.5 Opening links

Do not open links with `window.open`. Preview sandboxes block it (`ERR_BLOCKED_BY_RESPONSE`). Instead, use `openExternal(url)`:

1. Create a temporary `<a href="url" target="_blank" rel="noopener noreferrer">`.
2. Click it.
3. Remove it.

### 10.6 Streaming

- Parse SSE incrementally with `fetch` and a `ReadableStream` reader.
- Show each progress stage as it arrives.
- After submit, clear the quote, scene, and time window fields.
- Keep the creator selection after submit.

---

## 11. Design direction

- Distinctive, not generic. Avoid default-looking templates.
- Typography: display font for headings, body font for text, monospace for timestamps.
- Warm, editorial palette. Define all colors as semantic tokens in one stylesheet. No hardcoded colors. No purple gradients.
- Generous whitespace. The remembered line is the hero of each result.

---

## 12. Verification

After every change, the project must pass its type checker.

Then test the API with `curl` or any HTTP client:

| # | Request | Expected result |
|---|---|---|
| a | YouTube, creator given, line that appears in a video title | Match with the video, "timestamp not verified" notice, player embed |
| b | YouTube, creator given, deliberately misworded line | Match through fuzzy scoring or the AI fallback, capped at medium |
| c | YouTube, creator blank | `searchEverywhere` returns a video whose title or description matches |
| d | `sinceDays: 30`, made-up line | 10 real candidates, all links verified |
| e | YouTube, misworded line, Muse query variants on | Muse ranking picks shortlist videos only; any AI URL that fails verification is dropped |

In the browser, confirm:

- Links open without `ERR_BLOCKED_BY_RESPONSE`.
- Voice input fills the quote box.
- No request goes to a transcript service, Instagram, or a download tool.

---

## 13. Behavior to preserve

- **YouTube** gets official-API search, title and description matching, and Muse Spark query variants and ranking. Timestamps are not verified in this version.
- **No scraping, transcripts, or downloads.** Playback uses the official embedded player only.
- **Instagram, TikTok, and Facebook are not supported** in this version.
- Matching is loose on wording and strict on substance (the `keyCoverage` guard).
- Time windows filter the YouTube engine and the AI prompt, and appear in every turn's header.
- The app must always return at least 10 verified candidates when it is not confident.
- Credentials are entered only through the platform's secret store, never in chat or source code.
