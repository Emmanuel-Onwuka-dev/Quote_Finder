# Creator archive (transcript search): draft build spec

Written for: the coding agent and the project owner. This is a DRAFT. Section 7
lists decisions that must be made before the build starts. It supersedes the
"no transcripts" rule in `Quotefinder_Spec.md` (sections 5.3, 6, and 13) only
for creators who opt in. Those sections must be updated once this is approved.

## 1. What this is

A creator signs in with their Google account and authorizes Quotefinder for
their own channel. Quotefinder then reads that channel's captions and indexes
them. Viewers can search the creator's archive for a line they remember and get
the video and the moment it is said, with a timestamp read from the captions.

This is an opt-in feature for creators. Videos from channels that have not
opted in keep the current behavior: title and description matching only.

## 2. Facts that constrain the design (from YouTube's docs)

- **Auth.** Downloading a caption track requires OAuth with
  `https://www.googleapis.com/auth/youtube.force-ssl` or
  `https://www.googleapis.com/auth/youtubepartner`. An API key is not enough.
- **Permission.** The download needs edit permission on the video. In practice,
  the creator, or a manager they have granted access to.
- **Storage.** Other authorized API data may be stored for at most 30 calendar
  days. After that it must be deleted or refreshed.
- **Deletion.** If a creator revokes access, their stored data must be deleted
  within 7 calendar days. Deleting immediately is the target.
- **No downloads of audiovisual content.** Caption text is not audiovisual
  content, but confirm this reading with YouTube before launch (see section 7).
- **Quota.** Default 10,000 units per day. `captions.list` costs 50 units per
  call. `captions.download` costs 200 units per call. One indexed video costs
  about 250 units. Indexing is capped per day (section 4.3).
- **Caption kinds.** `captions.list` returns `trackKind`: `standard`
  (uploaded by the creator), `asr` (auto-generated), or `forced`. Track kind
  decides how the result is labelled (section 5.3).
- **Verification.** An unverified Google OAuth app is limited to listed test
  users, and their tokens expire. Judges can only sign in if they are added as
  test users or the app is verified. See section 7.

## 3. What does not change

- The current search, scoring, fuzzy matching, and link verification for
  videos from non-opted-in channels.
- The SSE stream, the chat UI, and the result and candidate cards. They gain a
  new result type (section 5.4).
- Credentials stay server-side. Nothing secret reaches the browser.
- Muse Spark is still used for query variants and ranking. Transcripts give it
  more to work with, and the ranking rules stay the same.

## 4. Creator flow

### 4.1 Authorize

1. A creator opens `/creator` and selects "Connect my YouTube channel".
2. The server starts Google OAuth with the `youtube.force-ssl` scope and PKCE.
3. On success, the server stores the refresh token encrypted, keyed by the
   channel ID. The token is never sent to the browser.
4. The page shows the channel name and the indexed-video count.

### 4.2 Choose and index

1. The server lists the channel's uploads (up to 50 per page, paginated, max
   the daily cap).
2. The creator sees the list and selects which videos to index. Default: the
   most recent 20.
3. For each selected video: `captions.list` (50 units). If a track exists, call
   `captions.download` with `tfmt=srt` (200 units). Store the cue text and
   timestamps. Record the track kind.
4. Show progress per video, using the same SSE progress pattern as search.

### 4.3 Daily cap

Indexing stops when the day's budget is spent. Budget: 5,000 units per day,
which is about 20 videos. Show "Indexing paused until tomorrow" when the cap is
hit. Keep the budget in a counter the server reads before each call.

### 4.4 Revoke and delete

1. The creator selects "Disconnect and delete".
2. The server revokes the token with Google and deletes all stored caption
   text, cue timestamps, and the refresh token. Target: immediate, and never
   more than 7 days.
3. The page confirms: "Your captions and sign-in have been deleted."

### 4.5 Refresh

Stored captions are refreshed or deleted every 30 days. A daily job checks each
indexed video's `captions.list` timestamps (or simply re-downloads). Videos that
fail the refresh are removed from the index and the creator is told.

## 5. Viewer flow

### 5.1 Search

1. The viewer picks a creator from the list of indexed creators, or leaves it
   blank to search the usual YouTube path.
2. The viewer enters the quote, optional scene, and time window, as today.
3. The server runs the same query variants, then matches the quote against the
   caption cues, not just titles and descriptions.

### 5.2 Caption matching

- Build a sliding window of 3 to 6 consecutive cues, joined as one text.
- Score each window with the existing `overlapScore` and require
  `keyCoverage >= 0.6`, as for metadata.
- Take the best window per video. Its start time is the first cue's start.
- Keep the same confidence rules: `high` at 0.8, `medium` at 0.55. Transcript
  matches may be `high`. Metadata-only matches stay capped at `medium`.

### 5.3 Track kind

- `standard`: the timestamp is labelled "verified from the creator's captions".
- `asr`: the timestamp is labelled "verified from auto-generated captions", and
  confidence is capped at `medium`. Auto-generated text is often wrong.
- `forced`: treat as `standard`.

### 5.4 Result

When a transcript match is found, the result card shows:
- The video title and date, and the creator.
- A timestamped link: `https://www.youtube.com/watch?v={id}&t={seconds}s`.
- An embedded player started at that time, using `start={seconds}`. Remove the
  "your estimate" label, since the time now comes from captions.
- The track-kind label from 5.3.
- Context: the matched caption text, as a quote.

The "exact moment not verified" notice stays for every metadata-only result.

## 6. Storage

Captions and refresh tokens are stored in a local database. Use SQLite
(`better-sqlite3`) unless you decide otherwise in section 7. Tables:
- `creators(channel_id, channel_title, token_enc, created_at)`
- `videos(video_id, channel_id, title, published_at, track_kind, indexed_at)`
- `cues(video_id, idx, start_seconds, text)`

Rules:
- Nothing is stored in plain text outside the database. The database file stays
  out of git (`.gitignore`).
- A purge job removes rows older than 30 days unless they were refreshed.
- Revoking a creator deletes all of their rows in one transaction.
- The database file path comes from an env var, `ARCHIVE_DB_PATH`.

## 7. Decisions (made by the project owner, 2026-10-30)

1. **Demo creator:** the owner's own channel. Use its captioned videos for all
   testing.
2. **Judge access:** the owner will record a demo video. The creator path does
   not need to work on a live link for judges.
3. **Storage:** SQLite (section 6). A restart must not drop the index, and the
   30-day purge needs stored timestamps. Re-indexing after every restart would
   also burn daily quota.
4. **Auto-generated captions:** allowed. Label them and cap confidence at
   `medium` (section 5.3).
5. **Viewer search scope:** a creator appears in viewer search only after the
   creator turns on "List my archive" on `/creator`. Connecting does not list
   the archive. Default: off.
6. **Known risk, not blocking:** YouTube's policy text does not address showing
   caption text from an authorized channel to other viewers. Record this in the
   README as a known risk. Do not block the build on it.

## 8. Build phases

- **A1.** Google OAuth on the server with PKCE. Token storage encrypted.
  Creator page with connect and disconnect. Tests with mocked Google endpoints.
- **A2.** Upload listing, `captions.list`, `captions.download`, SRT parsing, and
  the daily budget counter. Tests with fixture SRT files.
- **A3.** SQLite storage, the 30-day purge, and revoke-and-delete. Tests for
  each rule.
- **A4.** Caption window matching and the new result type. Tests with fixture
  cues, including `asr` capping.
- **A5.** Viewer creator picker, UI for the new result, and the timestamped
  embed.

Each phase ends with typecheck and tests passing, then a commit. Do not
start A1 until section 7 is decided.

## 9. Acceptance checks

1. A creator connects, indexes 3 videos, and a viewer finds a line from one of
   them, with the right timestamp within a few seconds.
2. An `asr` match is labelled as auto-generated and capped at medium.
3. Revoking the creator removes their videos from search and deletes their rows.
4. A stored caption older than 30 days is purged.
5. The daily cap stops indexing and says so.
6. No token or caption text appears in the browser's network responses other
   than the search result itself.
