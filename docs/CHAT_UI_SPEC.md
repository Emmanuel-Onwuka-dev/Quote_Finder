# Chat UI (P3b): build spec

Written for: the coding agent building the Quotefinder web UI. Read
`Quotefinder_Spec.md` sections 9 to 11 for the full product context. This file
is the concrete build spec for the chat page. Where the two disagree, this file
wins for the UI and `Quotefinder_Spec.md` wins for behavior.

## Scope

In scope:
- One page at `/`: a session-only chat of search turns.
- A composer: quote, creator, scene, time window, submit.
- Live progress from the `POST /api/quote-stream` SSE endpoint.
- Result card (found), candidate list (not found), error card.

Out of scope for this phase:
- Voice input and the microphone button (P4). Do not render a mic button yet.
- Platform choice. Only YouTube is searched.
- Login, saved history, or any storage beyond the page's memory.
- Quote card images (Muse Image). Optional, later.

## Existing code to build on

- `src/client/App.tsx` is the P0 placeholder. Replace it. Do not keep the
  placeholder text.
- `src/client/index.css` defines the semantic tokens. Use them. Do not hardcode
  colors in components.
- `vite.config.ts` proxies `/api` to `http://localhost:8787`. Call the endpoint
  with a relative path, `/api/quote-stream`.
- `src/server/quote-stream.ts` is the endpoint contract (below).

## Endpoint contract

Request: `POST /api/quote-stream`, `Content-Type: application/json`

```json
{ "quote": "string, required", "creator": "string", "scene": "string", "sinceDays": 0 }
```

`sinceDays` is an integer from 0 to 3650. `0` means any time.

Response: `text/event-stream`. Events, in order:
- `event: progress`, `data: { "stage": string, "detail": string }`, zero or more times.
- Then exactly one of:
  - `event: result`, `data:` a `LocateResult` (below).
  - `event: error`, `data: { "message": string }`.

A failed request before the stream starts returns HTTP 400 with
`{ "message": string }` as JSON.

`LocateResult` fields the UI uses:
- `found: boolean`
- `confidence: "high" | "medium" | "low"`
- `creator: string`
- `videoTitle: string`, `videoUrl: string`, `publishedAt: string` (ISO date)
- `startTime: number`, `startEstimate: boolean`. The server always sends
  `startTime: 0` and `startEstimate: false` for now.
- `timestampVerified: false` (always)
- `fullSentence: string`
- `context: string[]`
- `notes: string[]`
- `candidates: { url: string, title: string, creator: string, reason: string }[]`
- `engine: { scanned, channelTitle, channelId, videoCount }` (not shown)

SSE parsing: read the body with `fetch` and a `ReadableStream` reader. Decode
with `TextDecoder`. Split on a blank line (`\n\n`). Each block has an `event:`
line and a `data:` line. Buffer partial blocks across reads. Do not use
`EventSource`, because it only supports GET.

## Page layout

Top to bottom:
1. Header. The wordmark "Quotefinder" in the display font, and one line of
   helper text: "Say it however you remember it — the wording doesn't have to be right."
2. Turn list. Newest turn at the bottom. The page scrolls to the newest turn when
   a turn starts.
3. Composer, pinned to the bottom of the page on wide screens and at the end of
   the page on narrow ones.

Max content width: 42rem. Generous vertical spacing: 1.5rem between turns.

## Composer

Fields, in this order:
1. **Quote** (single-line input). Placeholder: "The line you remember". It is
   required. Enter submits.
2. **Creator** (single-line input). Placeholder: "Creator (optional)". Blank
   means search everywhere.
3. **Scene** (two-row textarea). Placeholder: "describe the scene — what was
   happening, who was on screen". Cmd/Ctrl+Enter submits.
4. **Time window**: a row of pills, one selected at a time. Labels and values:
   - Any time: 0
   - 24 hours: 1
   - 7 days: 7
   - 30 days: 30
   - 2 months: 60
   - 6 months: 180
   - 1 year: 365
   - Custom: a number input for days, 0 to 3650. Selecting it focuses the input.
   Default: Any time.
5. **Submit** button. Disabled while a search is running or the quote is blank.

After a successful submit, clear the quote, scene, and time window back to Any
time. Keep the creator, as the spec requires.

Validation: block submit if the quote is blank after trimming. Show the server's
400 message in the composer if the request is rejected.

## Turn

Each submitted search is one turn with this structure:

1. **Turn header**: the creator (or "Any creator" when blank), a separator, and
   the time window label (for example "7 days" or "any time"). The time window
   label always appears in the header.
2. **The user's input**: the quote in the quote style, and the scene when
   present, in muted text.
3. **Progress feed**: one row per `progress` event, with the stage and detail.
   The newest row has a spinner and the rest have a check. Hide the feed once
   the result or error arrives.
4. **Outcome**: the result card when `found` is true; otherwise the candidate
   list and the notes. An error event shows the error card.

## Result card (found)

Layout, top to bottom:
- Confidence badge: "High" or "Medium" (see the low-confidence note below).
  High uses the accent color. Medium uses the muted color.
- Header line: creator, then " · ", then the time window label.
- Video title (display font) and the published date (`YYYY-MM-DD`).
- The remembered line as the hero: the full sentence in a block quote with a 4px
  left border in the accent color, in the display font at 1.5rem. Use the
  `fullSentence` text exactly as returned.
- The notice, in a bordered box: "The exact moment this line is said has not been verified."
- Context lines from `context[]`, in body text, one paragraph each.
- Player: an iframe with a 16:9 aspect ratio and the URL
  `https://www.youtube-nocookie.com/embed/{videoId}?rel=0&modestbranding=1`.
  Take the video ID from `videoUrl`. Do not add `start`, because
  `startEstimate` is false.
- Player caption, in monospace: "Video · starts at 0:00".
- A "Copy link" button that copies `videoUrl` to the clipboard. Show "Copied"
  for two seconds after a copy.

Low confidence: a found result with `confidence: "low"` shows the badge
"Low" in the muted color, with the same layout. Do not hide it.

## Candidate list (not found)

Show a heading "Possible matches" and the list of `candidates`. Each item:
- Title (body font, medium weight) and the reason line below it, muted.
- A line with the creator, the `publishedAt` date, and the time window label
  from the turn. Use the form "creator · 2026-10-01 · 7 days".
- Two actions: "Play here", which expands an inline 16:9 player, and "Open on
  YouTube", which calls `openExternal(url)`.

Show the `notes` above the list, in muted text, one line each.

If there are fewer than 10 candidates, show the list as returned. Do not pad.

## Error card

When the stream sends an `error` event, or the request fails before streaming:
- Heading: "The search didn't finish".
- The message from the server, in muted text.
- A "Try again" button that re-runs the same search with the same inputs.

## Opening links

Do not use `window.open`. Use this helper, `openExternal(url)`:
1. Create an `<a>` with `href=url`, `target="_blank"`, and
   `rel="noopener noreferrer"`.
2. Append it to the document body, click it, and remove it.

Use it for every external link, including "Open on YouTube".

## Streaming behavior

- Show each progress event as it arrives. Do not wait for the stream to end.
- If the user leaves the page mid-search, stop updating the turn. Do not crash.
- One search at a time. Disable submit while a stream is open.

## Brand

The logo and the magnifier are original artwork. Do not use the reference photo
or any other third-party image. Draw both as SVG in the repo.

- **Logo mark:** a pair of curly quotation marks (“ ”) set in the display font,
  in the accent color. Use it in the header, as the favicon, and as the social
  share image.
- **Magnifier:** a flat SVG icon of a round lens in a brass-colored ring with a
  wooden handle, in the style of an old detective's glass. Use only token
  colors: accent for the ring and handle, card for the lens, foreground for the
  outline. No gradients and no photographic detail. It must read clearly at 24px.
- **Quote-mark input:** the same curly quote marks sit on each side of the quote
  field, in the accent color. The field is a normal input, so typing, paste, and
  screen readers work as usual.
- **Pulse:** the magnifier pulses (a slow scale and opacity animation, about 1.6
  seconds per cycle) only while progress events are arriving. It stops when the
  result or error arrives. Turn the animation off when the user has reduced
  motion enabled in their OS settings (`prefers-reduced-motion`).

Do not copy any other product's logo or animation. Build these from scratch.

## Design

- Warm, editorial, and not generic. Avoid default-looking templates.
- Colors come only from the tokens in `src/client/index.css`: background,
  foreground, card, muted, border, accent, accent-foreground, destructive.
  No hardcoded hex values in components. No purple gradients.
- Fonts: headings and the wordmark in `font-display` (Space Grotesk). Body text
  in `font-body` (DM Sans). Timestamps, dates, and captions in `font-mono`
  (JetBrains Mono). Load the fonts in `index.html` through Google Fonts, with
  the weights from `Quotefinder_Spec.md` section 2.
- Cards: `bg-card`, a 1px `border-border` border, 0.75rem radius, and padding of 1.25rem.
- The remembered line is the visual hero of each result.
- Buttons: accent background with accent-foreground text for the primary action.
  Secondary actions use a border and foreground text.

## Accessibility

- Every input has a visible label. Placeholders are not labels.
- Progress rows sit in an `aria-live="polite"` region.
- The result card is announced when it appears. Move focus to its heading.
- Pills are buttons with `aria-pressed`.
- Color is never the only signal: the confidence badge has text.
- Buttons and links have visible focus rings.

## SEO

Edit `index.html` (spec section 2):
- `<title>Quotefinder: find a video from a line you remember</title>`
- `<meta name="description">` with one sentence about the product.
- Open Graph: `og:type` is `website`, plus `og:title` and `og:description`.
- Twitter: `twitter:card` is `summary_large_image`.

## Files

- `src/client/App.tsx`: the page and layout.
- `src/client/components/Composer.tsx`
- `src/client/components/Turn.tsx`
- `src/client/components/ResultCard.tsx`
- `src/client/components/CandidateList.tsx`
- `src/client/components/Progress.tsx`
- `src/client/hooks/useQuoteStream.ts`: posts the request and yields events.
- `src/client/lib/sse.ts`: a pure SSE block parser. Unit tested.
- `src/client/lib/openExternal.ts`
- `src/client/lib/format.ts`: the time window label, the video ID from a URL,
  and the date formatting. Unit tested.
- `src/client/lib/sse.test.ts` and `src/client/lib/format.test.ts`

Vitest runs `*.test.ts` already. Keep component tests out of scope for this
phase.

## Acceptance checks

Run these before the phase is done:
1. `npm run typecheck` passes.
2. `npm test` passes, including the new `sse` and `format` tests.
3. With `npm run dev:server` and `npm run dev:client` running:
   - A search for a line in a real video title returns a found card with an
     embed, the "not verified" notice, and the time window in the header.
   - A misworded line returns a card or candidate list, never a blank page.
   - An empty quote is blocked in the UI and never sent.
   - A bad creator shows the error card or the notes, not a blank page.
   - Progress rows appear one at a time while the search runs.
   - Submitting clears the quote, scene, and time window, and keeps the creator.
   - "Open on YouTube" opens in a new tab without `ERR_BLOCKED_BY_RESPONSE`.
   - No `window.open` appears in the code. Search for it.
   - No hardcoded colors in components. Search for `#` and `rgb(` in
     `src/client`, outside `index.css`.
4. Keyboard only: you can run a full search without the mouse.

## Commits

Commit in small steps: the layout and composer, then the stream hook and turn
flow, then the result and candidate cards, then the tests and SEO. Keep the
commit messages short and factual. Do not add an attribution line.
