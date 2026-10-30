// Orchestrator (§7): locateQuote — Muse query variants → YouTube
// search/score → Muse ranking → memory fallback with verified links.
// No transcripts anywhere: every confidence caps at medium.

import { z } from "zod";
import type { ArchiveStore } from "./archive/store";
import { loadConfig, requireKey } from "./config";
import { authHeaders, createLlmClient, type LlmClient } from "./llm-client";
import {
  CHANNELS_LIST_COST,
  PLAYLIST_ITEMS_COST,
  SEARCH_LIST_COST,
  VIDEOS_LIST_COST,
  searchChannel,
  searchEverywhere,
  type CountedApiCall,
  type EngineOutput,
  type ProgressFn,
  type QuotaReserve,
  type VideoMeta,
} from "./youtube";

export const FOUND_THRESHOLD = 0.45;
const HIGH_AT = 0.8;
const MEDIUM_AT = 0.55;
const CANDIDATE_TARGET = 10;
const VERIFY_CONCURRENCY = 4;
const VERIFY_TIMEOUT_MS = 8000;
const MODEL_TIMEOUT_MS = 30000;

export type Confidence = "high" | "medium" | "low";

export function stamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function windowLabel(sinceDays: number): string {
  switch (sinceDays) {
    case 0:
      return "any time";
    case 1:
      return "the last 24 hours";
    case 7:
      return "7 days";
    case 30:
      return "30 days";
    case 60:
      return "2 months";
    case 180:
      return "6 months";
    case 365:
      return "the last year";
    default:
      return `last ${sinceDays} days`;
  }
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function isYouTubeWatchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === "www.youtube.com" ||
        parsed.hostname === "youtube.com" ||
        parsed.hostname === "youtu.be") &&
      (parsed.pathname === "/watch" || parsed.hostname === "youtu.be")
    );
  } catch {
    return false;
  }
}

export interface LocateInput {
  quote: string;
  creator: string;
  scene: string;
  sinceDays: number;
}

export interface QuoteCandidate {
  url: string;
  title: string;
  creator: string;
  reason: string;
}

export interface LocateResult {
  found: boolean;
  confidence: Confidence;
  creator: string;
  videoTitle: string;
  videoUrl: string;
  publishedAt: string;
  startTime: number;
  startEstimate: boolean;
  timestampVerified: false;
  fullSentence: string;
  context: string[];
  notes: string[];
  candidates: QuoteCandidate[];
  engine: {
    scanned: number;
    channelTitle: string;
    channelId: string;
    videoCount: number;
  };
}

export interface LocateDeps {
  llm?: LlmClient;
  youtubeApiKey?: string;
  onProgress?: ProgressFn;
  fetchFn?: typeof fetch;
  /** Skip the YouTube engine and answer from memory (quota spent). */
  skipEngine?: boolean;
  /** Store + day for recording search quota spend. */
  searchQuota?: { store: ArchiveStore; day: string };
  /** Store for the search-budget pre-check (used by the handler). */
  archiveStore?: ArchiveStore;
}

// --- Meta Model API: single-shot JSON chat (P3 streams progress) ---

const ChatResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
});

async function chatText(
  client: LlmClient,
  fetchFn: typeof fetch,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetchFn(`${client.baseUrl}/chat/completions`, {
    method: "POST",
    headers: authHeaders(client),
    body: JSON.stringify({
      model: client.textModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Meta Model API error ${res.status}`);
  }
  const data: unknown = await res.json();
  return ChatResponseSchema.parse(data).choices[0].message.content;
}

function extractJson(text: string, open: "{" | "["): unknown {
  const close = open === "{" ? "}" : "]";
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end <= start) {
    throw new Error("No JSON object in model reply");
  }
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

// --- Step 1: query variants (§7.3.1). Never fatal: [] on any failure. ---

const VariantsSchema = z.array(z.string());

const VARIANTS_SYSTEM = [
  "You help find a video from a half-remembered quote.",
  "The user is recalling from memory and will almost never have the exact wording.",
  "Reply with ONLY a JSON array of 3 to 5 alternative wordings of the quote, no other text.",
].join(" ");

export async function queryVariants(
  quote: string,
  client: LlmClient,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const content = await chatText(client, fetchFn, VARIANTS_SYSTEM, `Quote: ${quote}`);
    const parsed = VariantsSchema.safeParse(extractJson(content, "["));
    if (!parsed.success) {
      return [];
    }
    return [
      ...new Set(parsed.data.map((v) => v.trim()).filter((v) => v.length > 0)),
    ].slice(0, 5);
  } catch {
    return [];
  }
}

// --- Prompt context shared by ranking and fallback ---

export interface PromptContext {
  quote: string;
  creatorLine: string;
  sceneLine: string;
  whenLine: string;
  variants: string[];
  shortlist: VideoMeta[];
}

function catalogueBlock(shortlist: VideoMeta[]): string {
  if (shortlist.length === 0) {
    return "Catalogue: no videos were fetched.";
  }
  const lines = shortlist.map((video, index) => {
    const description =
      video.description.length > 300
        ? `${video.description.slice(0, 300)}…`
        : video.description;
    const date = video.publishedAt.slice(0, 10) || "undated";
    return `${index + 1}. ${video.title} — ${date} — ${youtubeWatchUrl(video.id)}\n   ${description}`;
  });
  return `Catalogue (real fetched videos — choose ONLY these URLs):\n${lines.join("\n")}`;
}

function contextBlock(context: PromptContext): string {
  const lines = [
    `Quote (remembered, wording unreliable): ${context.quote}`,
    `Creator: ${context.creatorLine}`,
    `Scene: ${context.sceneLine || "(none given)"}`,
    `Window: ${context.whenLine} — return nothing older.`,
  ];
  if (context.variants.length > 0) {
    lines.push(`Alternative wordings: ${context.variants.join(" | ")}`);
  }
  lines.push(catalogueBlock(context.shortlist));
  return lines.join("\n");
}

// --- Step 2: ranking (§7.3.2). Shortlist-only; [] on any failure. ---

const RankingSchema = z.object({
  picks: z.array(z.object({ url: z.string(), reason: z.string() })),
});

export interface RankPick {
  url: string;
  reason: string;
}

const RANK_SYSTEM = [
  "You help find a video from a half-remembered quote.",
  "The user is recalling from memory and will almost never have the exact wording.",
  "Pick the best matches from the catalogue below and give a one-line reason for each.",
  "Only catalogue URLs may be chosen.",
  'Reply with ONLY a single JSON object like {"picks": [{"url": "...", "reason": "..."}]}, no other text.',
].join(" ");

export async function rankShortlist(
  context: PromptContext,
  client: LlmClient,
  fetchFn: typeof fetch = fetch,
): Promise<RankPick[]> {
  try {
    const content = await chatText(
      client,
      fetchFn,
      RANK_SYSTEM,
      contextBlock(context),
    );
    const parsed = RankingSchema.safeParse(extractJson(content, "{"));
    if (!parsed.success) {
      return [];
    }
    return parsed.data.picks.filter((pick) => pick.url.length > 0);
  } catch {
    return [];
  }
}

// --- Step 3: fallback (§7.3.3). Throws on failure — caller degrades. ---

const FallbackCandidateSchema = z.object({
  url: z.string().optional().default(""),
  title: z.string().optional().default(""),
  reason: z.string().optional().default(""),
});

const FallbackSchema = z.object({
  found: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]).optional().default("low"),
  videoUrl: z.string().optional().default(""),
  videoTitle: z.string().optional().default(""),
  publishedAt: z.string().optional().default(""),
  startTime: z.number().optional().default(0),
  endTime: z.number().optional().default(0),
  fullSentence: z.string().optional().default(""),
  context: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  candidates: z.array(FallbackCandidateSchema).optional().default([]),
});

export type FallbackAnswer = z.infer<typeof FallbackSchema>;

const FALLBACK_SYSTEM = [
  "You help find a video from a half-remembered quote.",
  "The user is recalling from memory and will almost never have the exact wording.",
  "The creator line says UNKNOWN when blank. In that case, identify who said the line. Prefer the original source. Viral clips, interviews, films, speeches, and podcasts all count.",
  "Where: restrict answers to real YouTube watch URLs.",
  "Always list 10 plausible candidate videos with real, watchable URLs when unsure.",
  "Say that the AI's answer is an estimate from memory, not a verified match.",
  "Reply with ONLY a single JSON object with these fields: found, confidence, videoUrl, videoTitle, publishedAt, startTime, endTime, fullSentence, context, notes, candidates[]. No other text.",
].join(" ");

export async function fallbackAnswer(
  context: PromptContext,
  client: LlmClient,
  fetchFn: typeof fetch = fetch,
): Promise<FallbackAnswer> {
  const content = await chatText(
    client,
    fetchFn,
    FALLBACK_SYSTEM,
    contextBlock(context),
  );
  return FallbackSchema.parse(extractJson(content, "{"));
}

// --- Step 4: link verification (§7.5). No hallucinated links. ---

export async function urlExists(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    if (isYouTubeWatchUrl(url)) {
      const res = await fetchFn(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
        { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) },
      );
      return res.ok;
    }
    let res = await fetchFn(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (res.status === 405 || res.status === 403) {
      res = await fetchFn(url, {
        method: "GET",
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
    }
    return res.ok;
  } catch {
    return false;
  }
}

export async function verifyUrls(
  urls: string[],
  fetchFn: typeof fetch = fetch,
  concurrency: number = VERIFY_CONCURRENCY,
): Promise<boolean[]> {
  const results: boolean[] = new Array(urls.length).fill(false);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < urls.length) {
      const index = next;
      next += 1;
      results[index] = await urlExists(urls[index] ?? "", fetchFn);
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, urls.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// --- Result assembly ---

function confidenceForScore(score: number): Confidence {
  const raw: Confidence =
    score >= HIGH_AT ? "high" : score >= MEDIUM_AT ? "medium" : "low";
  // §5.6/§7.2: metadata-only matches cap at medium — this version never
  // verifies the moment a line is said.
  return raw === "high" ? "medium" : raw;
}

function capToMedium(confidence: Confidence): Confidence {
  return confidence === "high" ? "medium" : confidence;
}

function shortDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : "undated";
}

function searchNote(engine: EngineOutput): string {
  if (engine.channelId) {
    return `matched the title and description of ${engine.scanned} videos out of ${engine.videoCount} uploads`;
  }
  return `searched YouTube and scored ${engine.scanned} videos`;
}

const UNVERIFIED_NOTE =
  "no transcript was read, so the exact moment the line is said is not verified";

const SEARCH_QUOTA_SPENT_NOTE =
  "search quota spent for today — answering from memory";
const SEARCH_QUOTA_SPENT = "search quota spent for today";

function emptyEngine(): EngineOutput {
  return {
    shortlist: [],
    hits: [],
    scanned: 0,
    channelTitle: "",
    channelId: "",
    videoCount: 0,
  };
}

function engineSummary(engine: EngineOutput): LocateResult["engine"] {
  return {
    scanned: engine.scanned,
    channelTitle: engine.channelTitle,
    channelId: engine.channelId,
    videoCount: engine.videoCount,
  };
}

// Pad to 10 from trusted sources: metadata hits first, then shortlist pool.
function padCandidates(
  engine: EngineOutput,
  kept: QuoteCandidate[],
): QuoteCandidate[] {
  const seen = new Set(kept.map((candidate) => candidate.url));
  const channelOf = (video: VideoMeta) =>
    video.channelTitle || engine.channelTitle || "YouTube";
  const pads: QuoteCandidate[] = [];
  for (const hit of engine.hits) {
    const url = youtubeWatchUrl(hit.video.id);
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    pads.push({
      url,
      title: hit.video.title,
      creator: channelOf(hit.video),
      reason: `Title/description match · ${shortDate(hit.video.publishedAt)}`,
    });
  }
  for (const video of engine.shortlist) {
    if (kept.length + pads.length >= CANDIDATE_TARGET) {
      break;
    }
    const url = youtubeWatchUrl(video.id);
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    pads.push({
      url,
      title: video.title,
      creator: channelOf(video),
      reason: `Possible match · ${shortDate(video.publishedAt)}`,
    });
  }
  return [...kept, ...pads].slice(0, CANDIDATE_TARGET);
}

export async function locateQuote(
  input: LocateInput,
  deps: LocateDeps = {},
): Promise<LocateResult> {
  const quote = input.quote.trim();
  if (!quote) {
    throw new Error("quote must not be empty");
  }
  const llm = deps.llm ?? createLlmClient();
  const fetchFn = deps.fetchFn ?? fetch;
  const youtubeApiKey =
    deps.youtubeApiKey ??
    requireKey(loadConfig().youtubeApiKey, "YOUTUBE_API_KEY");
  const onProgress: ProgressFn = deps.onProgress ?? (() => {});
  const fullSentence = quote.replace(/\s+/g, " ");
  const creatorInput = input.creator.trim();
  const whenLine = windowLabel(input.sinceDays);

  // 1. Query variants (before search).
  onProgress("Asking the model", "alternative wordings");
  const variants = await queryVariants(quote, llm, fetchFn);

  // 2. Search path + shortlist scoring. A YouTube failure (bad creator, API
  // error) must not end the request: continue to the memory fallback (§7.1, §7.3).
  // A spent quota skips the engine without calling YouTube at all.
  const searchQuota = deps.searchQuota;
  // Every YouTube call reserves its own cost before it is made. A failed
  // reservation throws, so the call never happens and the engine's failure
  // path answers from memory with the quota note.
  const searchCosts: Record<CountedApiCall, number> = {
    "search.list": SEARCH_LIST_COST,
    "videos.list": VIDEOS_LIST_COST,
    "channels.list": CHANNELS_LIST_COST,
    "playlistItems.list": PLAYLIST_ITEMS_COST,
  };
  const reserveSearchQuota: QuotaReserve | undefined = searchQuota
    ? (endpoint) => {
        const reserved = searchQuota.store.trySpend(
          searchQuota.day,
          searchCosts[endpoint],
          "search",
        );
        if (!reserved) {
          throw new Error(SEARCH_QUOTA_SPENT_NOTE);
        }
      }
    : undefined;
  let engine: EngineOutput;
  let engineError = "";
  if (deps.skipEngine) {
    engine = emptyEngine();
  } else {
    try {
      engine = creatorInput
        ? await searchChannel({
            quote,
            variants,
            creator: creatorInput,
            sinceDays: input.sinceDays,
            apiKey: youtubeApiKey,
            onProgress,
            reserveQuota: reserveSearchQuota,
          })
        : await searchEverywhere({
            quote,
            variants,
            apiKey: youtubeApiKey,
            onProgress,
            reserveQuota: reserveSearchQuota,
          });
    } catch (error) {
      engineError =
        error instanceof Error ? error.message : "YouTube search failed";
      engine = emptyEngine();
    }
  }
  const quotaHitMidRun = engineError === SEARCH_QUOTA_SPENT_NOTE;
  const engineNotes =
    engineError && !quotaHitMidRun
      ? [`YouTube search failed (${engineError}), so the answer comes from memory`]
      : [];
  const searchNotes =
    deps.skipEngine || quotaHitMidRun
      ? [SEARCH_QUOTA_SPENT_NOTE]
      : engineError
        ? []
        : [searchNote(engine)];

  const shortlistUrls = new Set(
    engine.shortlist.map((video) => youtubeWatchUrl(video.id)),
  );
  const ordered = [...engine.hits];
  const reasons = new Map<string, string>();

  // 3. Ranking (whenever the shortlist is non-empty).
  if (engine.shortlist.length > 0) {
    onProgress("Ranking candidates", `${engine.shortlist.length} videos`);
    const picks = await rankShortlist(
      {
        quote,
        creatorLine: creatorInput || "UNKNOWN",
        sceneLine: input.scene.trim(),
        whenLine,
        variants,
        shortlist: engine.shortlist,
      },
      llm,
      fetchFn,
    );
    const pickOrder: string[] = [];
    for (const pick of picks) {
      if (shortlistUrls.has(pick.url) && !reasons.has(pick.url)) {
        reasons.set(pick.url, pick.reason);
        pickOrder.push(pick.url);
      }
    }
    ordered.sort((a, b) => {
      const orderOf = (url: string) => {
        const index = pickOrder.indexOf(url);
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
      };
      return (
        orderOf(youtubeWatchUrl(a.video.id)) -
          orderOf(youtubeWatchUrl(b.video.id)) || b.score - a.score
      );
    });
  }

  const best = ordered[0];
  if (best && best.score >= FOUND_THRESHOLD) {
    const videoUrl = youtubeWatchUrl(best.video.id);
    const reason = reasons.get(videoUrl);
    return {
      found: true,
      confidence: confidenceForScore(best.score),
      creator:
        engine.channelTitle ||
        best.video.channelTitle ||
        creatorInput ||
        "Unknown",
      videoTitle: best.video.title,
      videoUrl,
      publishedAt: best.video.publishedAt,
      startTime: 0,
      startEstimate: false,
      timestampVerified: false,
      fullSentence,
      context: reason ? [reason] : [],
      notes: [searchNote(engine), UNVERIFIED_NOTE],
      candidates: [],
      engine: engineSummary(engine),
    };
  }

  // 4. Fallback (only when nothing reaches the found threshold).
  onProgress("Asking the model", "answering from memory");
  let fallback: FallbackAnswer;
  try {
    fallback = await fallbackAnswer(
      {
        quote,
        creatorLine: creatorInput || "UNKNOWN",
        sceneLine: input.scene.trim(),
        whenLine,
        variants,
        shortlist: engine.shortlist,
      },
      llm,
      fetchFn,
    );
  } catch {
    if (deps.skipEngine) {
      throw new Error(SEARCH_QUOTA_SPENT);
    }
    const candidates = padCandidates(engine, []);
    const degradedNotes = [
      ...engineNotes,
      ...searchNotes,
      UNVERIFIED_NOTE,
      "the memory fallback was unavailable, so these candidates come only from title/description matching",
    ];
    if (candidates.length < CANDIDATE_TARGET) {
      degradedNotes.push(
        `only ${candidates.length} trusted candidates were available`,
      );
    }
    return {
      found: false,
      confidence: "low",
      creator: engine.channelTitle || creatorInput || "Unknown",
      videoTitle: "",
      videoUrl: "",
      publishedAt: "",
      startTime: 0,
      startEstimate: false,
      timestampVerified: false,
      fullSentence,
      context: [],
      notes: degradedNotes,
      candidates,
      engine: engineSummary(engine),
    };
  }

  // Shortlist URLs are trusted (official API); every AI URL is verified.
  onProgress(
    "Verifying links",
    `${fallback.candidates.length + (fallback.videoUrl ? 1 : 0)} links`,
  );
  const aiUrls = [
    ...(fallback.videoUrl ? [fallback.videoUrl] : []),
    ...fallback.candidates.map((candidate) => candidate.url || ""),
  ];
  const checks = await verifyUrls(aiUrls, fetchFn);
  const mainAlive = fallback.videoUrl ? (checks[0] ?? false) : false;

  const kept: QuoteCandidate[] = [];
  fallback.candidates.forEach((candidate, index) => {
    const url = candidate.url || "";
    if (url && (checks[index + (fallback.videoUrl ? 1 : 0)] ?? false)) {
      kept.push({
        url,
        title: candidate.title || url,
        creator: engine.channelTitle || "YouTube",
        reason: candidate.reason || "AI suggestion",
      });
    }
  });
  const dropped = fallback.candidates.length - kept.length;
  const candidates = padCandidates(engine, kept);

  const notes = [
    ...engineNotes,
    ...searchNotes,
    UNVERIFIED_NOTE,
    "the AI's answer is an estimate from memory, not a verified match",
  ];
  if (dropped > 0) {
    notes.push(`dropped ${dropped} dead link${dropped === 1 ? "" : "s"}`);
  }
  if (fallback.notes) {
    notes.push(fallback.notes);
  }
  if (candidates.length < CANDIDATE_TARGET) {
    notes.push(`only ${candidates.length} trusted candidates were available`);
  }

  if (fallback.found && fallback.videoUrl && mainAlive) {
    return {
      found: true,
      // §12b: the AI fallback caps at medium, like every metadata match.
      confidence: capToMedium(fallback.confidence),
      creator: engine.channelTitle || creatorInput || "Unknown",
      videoTitle: fallback.videoTitle,
      videoUrl: fallback.videoUrl,
      publishedAt: fallback.publishedAt,
      startTime: Math.max(0, Math.floor(fallback.startTime)),
      startEstimate: true,
      timestampVerified: false,
      fullSentence,
      context: fallback.context ? [fallback.context] : [],
      notes,
      candidates: [],
      engine: engineSummary(engine),
    };
  }

  if (fallback.found && fallback.videoUrl && !mainAlive) {
    notes.push("the AI's main link was dead, so no confident answer is shown");
  }
  return {
    found: false,
    confidence: capToMedium(fallback.confidence),
    creator: engine.channelTitle || creatorInput || "Unknown",
    videoTitle: "",
    videoUrl: "",
    publishedAt: "",
    startTime: 0,
    startEstimate: false,
    timestampVerified: false,
    fullSentence,
    context: fallback.context ? [fallback.context] : [],
    notes,
    candidates,
    engine: engineSummary(engine),
  };
}
