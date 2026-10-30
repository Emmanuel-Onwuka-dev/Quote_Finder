// YouTube engine (§5): official Data API v3 only. No transcripts, no
// scraping, no downloads. Matching uses titles and descriptions only.

import { analyzeOverlap, keyCoverage } from "./fuzzy";

export interface VideoMeta {
  id: string;
  title: string;
  publishedAt: string;
  description: string;
  channelTitle: string;
}

export interface ScoredVideo {
  video: VideoMeta;
  score: number;
  matchedWords: string[];
}

export interface EngineOutput {
  shortlist: VideoMeta[];
  hits: ScoredVideo[];
  scanned: number;
  channelTitle: string;
  channelId: string;
  videoCount: number;
}

export type ProgressFn = (stage: string, detail: string) => void;

const API = "https://www.googleapis.com/youtube/v3";
const MAX_INDEX_VIDEOS = 300;
const SHORTLIST_CAP = 12;
const HITS_CAP = 10;
const KEY_COVERAGE_MIN = 0.6;
const YT_TIMEOUT_MS = 10000;
// Muse variants are extra search queries; cap how many we run (each search
// costs API quota).
const VARIANT_QUERY_LIMIT = 3;

/** YouTube Data API quota costs counted against the search budget. */
export const SEARCH_LIST_COST = 100;
export const VIDEOS_LIST_COST = 1;
export const CHANNELS_LIST_COST = 1;
export const PLAYLIST_ITEMS_COST = 1;

/** Every YouTube endpoint the engine calls that costs quota. */
export type CountedApiCall =
  | "search.list"
  | "videos.list"
  | "channels.list"
  | "playlistItems.list";

/** Reserves quota for one counted call before it is made.
 * Must throw when the reservation fails, so the call is never made. */
export type QuotaReserve = (endpoint: CountedApiCall) => void;

async function fetchYt(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    signal: AbortSignal.timeout(YT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`YouTube API ${res.status} on ${path.split("?")[0]}`);
  }
  return res.json() as Promise<unknown>;
}

// --- Creator input parsing (§5.1) ---

export type CreatorKind = "channelId" | "handle" | "text";

export interface ParsedCreator {
  kind: CreatorKind;
  value: string;
}

export function parseCreatorInput(input: string): ParsedCreator {
  const trimmed = input.trim();
  const channelUrl = trimmed.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
  if (channelUrl?.[1]) {
    return { kind: "channelId", value: channelUrl[1] };
  }
  if (/^UC[\w-]{22}$/.test(trimmed)) {
    return { kind: "channelId", value: trimmed };
  }
  const handleUrl = trimmed.match(/youtube\.com\/@([\w.-]+)/);
  if (handleUrl?.[1]) {
    return { kind: "handle", value: handleUrl[1] };
  }
  if (trimmed.startsWith("@") && trimmed.length > 1) {
    return { kind: "handle", value: trimmed.slice(1) };
  }
  return { kind: "text", value: trimmed };
}

interface ChannelHeader {
  channelId: string;
  channelTitle: string;
  uploadsPlaylistId: string;
}

interface ChannelsResponse {
  items?: Array<{
    id?: string;
    snippet?: { title?: string };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }>;
}

interface SearchResponse {
  items?: Array<{
    id?: { channelId?: string; videoId?: string };
    snippet?: {
      title?: string;
      description?: string;
      publishedAt?: string;
      channelTitle?: string;
    };
  }>;
}

interface PlaylistItemsResponse {
  nextPageToken?: string;
  items?: Array<{
    snippet?: {
      title?: string;
      description?: string;
      publishedAt?: string;
      resourceId?: { videoId?: string };
    };
  }>;
}

interface VideosResponse {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      description?: string;
      publishedAt?: string;
      channelTitle?: string;
    };
  }>;
}

function isChannelsResponse(value: unknown): value is ChannelsResponse {
  return typeof value === "object" && value !== null;
}

async function channelHeaderFor(
  channelId: string,
  apiKey: string,
  reserveQuota?: QuotaReserve,
): Promise<ChannelHeader> {
  reserveQuota?.("channels.list");
  const data: unknown = await fetchYt(
    `/channels?part=snippet,contentDetails&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`,
  );
  if (!isChannelsResponse(data)) {
    throw new Error("YouTube API returned an unexpected channels payload");
  }
  const item = data.items?.[0];
  const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
  if (!item?.id || !uploads) {
    throw new Error("Channel has no uploads playlist");
  }
  return {
    channelId: item.id,
    channelTitle: item.snippet?.title ?? "",
    uploadsPlaylistId: uploads,
  };
}

export async function resolveChannel(
  creator: string,
  apiKey: string,
  reserveQuota?: QuotaReserve,
): Promise<ChannelHeader> {
  const parsed = parseCreatorInput(creator);
  if (parsed.kind === "channelId") {
    return channelHeaderFor(parsed.value, apiKey, reserveQuota);
  }
  if (parsed.kind === "handle") {
    reserveQuota?.("channels.list");
    const data: unknown = await fetchYt(
      `/channels?part=snippet,contentDetails&forHandle=${encodeURIComponent(parsed.value)}&key=${encodeURIComponent(apiKey)}`,
    );
    if (!isChannelsResponse(data) || !data.items?.[0]?.id) {
      throw new Error(`No channel found for @${parsed.value}`);
    }
    const id = data.items[0].id;
    return channelHeaderFor(id, apiKey, reserveQuota);
  }
  reserveQuota?.("search.list");
  const data: unknown = await fetchYt(
    `/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(parsed.value)}&key=${encodeURIComponent(apiKey)}`,
  );
  const item = (data as SearchResponse).items?.[0];
  const channelId = item?.id?.channelId;
  if (!channelId) {
    throw new Error(`No channel found for "${parsed.value}"`);
  }
  return channelHeaderFor(channelId, apiKey, reserveQuota);
}

// --- Upload index (§5.2): in-memory, one request, never persisted ---

export interface UploadsPage {
  videos: VideoMeta[];
  nextPageToken?: string;
}

export async function listUploadsPage(
  playlistId: string,
  apiKey: string,
  pageToken?: string,
  reserveQuota?: QuotaReserve,
): Promise<UploadsPage> {
  reserveQuota?.("playlistItems.list");
  const data: unknown = await fetchYt(
    `/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(apiKey)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
  );
  const page = data as PlaylistItemsResponse;
  const videos: VideoMeta[] = [];
  for (const item of page.items ?? []) {
    const id = item.snippet?.resourceId?.videoId;
    if (!id) {
      continue;
    }
    videos.push({
      id,
      title: item.snippet?.title ?? "",
      publishedAt: item.snippet?.publishedAt ?? "",
      description: item.snippet?.description ?? "",
      // Playlist items don't name the video's channel; callers stamp it.
      channelTitle: "",
    });
  }
  return { videos, nextPageToken: page.nextPageToken };
}

export async function listUploads(
  playlistId: string,
  apiKey: string,
  max = MAX_INDEX_VIDEOS,
  reserveQuota?: QuotaReserve,
): Promise<VideoMeta[]> {
  const videos: VideoMeta[] = [];
  let pageToken: string | undefined;
  while (videos.length < max) {
    const page = await listUploadsPage(playlistId, apiKey, pageToken, reserveQuota);
    for (const video of page.videos) {
      videos.push(video);
      if (videos.length >= max) {
        break;
      }
    }
    if (!page.nextPageToken || videos.length >= max) {
      break;
    }
    pageToken = page.nextPageToken;
  }
  return videos;
}

export async function videosById(
  ids: string[],
  apiKey: string,
  reserveQuota?: QuotaReserve,
): Promise<VideoMeta[]> {
  const videos: VideoMeta[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    reserveQuota?.("videos.list");
    const data: unknown = await fetchYt(
      `/videos?part=snippet&id=${batch.map(encodeURIComponent).join(",")}&key=${encodeURIComponent(apiKey)}`,
    );
    for (const item of (data as VideosResponse).items ?? []) {
      if (!item.id) {
        continue;
      }
      videos.push({
        id: item.id,
        title: item.snippet?.title ?? "",
        publishedAt: item.snippet?.publishedAt ?? "",
        description: item.snippet?.description ?? "",
        channelTitle: item.snippet?.channelTitle ?? "",
      });
    }
  }
  return videos;
}

async function searchVideos(
  query: string,
  apiKey: string,
  channelId?: string,
  maxResults = 15,
  reserveQuota?: QuotaReserve,
): Promise<VideoMeta[]> {
  reserveQuota?.("search.list");
  const data: unknown = await fetchYt(
    `/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}${channelId ? `&channelId=${encodeURIComponent(channelId)}` : ""}`,
  );
  const ids = ((data as SearchResponse).items ?? [])
    .map((item) => item.id?.videoId)
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0) {
    return [];
  }
  return videosById(ids, apiKey, reserveQuota);
}

// The quote plus the Muse variants, merged in order (§5.4 step 4).
async function searchQueries(
  quote: string,
  variants: string[],
  apiKey: string,
  channelId: string,
  reserveQuota?: QuotaReserve,
): Promise<VideoMeta[]> {
  const found = await searchVideos(quote, apiKey, channelId, 15, reserveQuota);
  for (const variant of variants.slice(0, VARIANT_QUERY_LIMIT)) {
    found.push(
      ...(await searchVideos(variant, apiKey, channelId, 8, reserveQuota)),
    );
  }
  return found;
}

// --- Time window (§7.6) ---

export function toPublishedAfter(
  sinceDays: number,
  now: Date = new Date(),
): string | undefined {
  if (sinceDays <= 0) {
    return undefined;
  }
  return new Date(now.getTime() - sinceDays * 86_400_000).toISOString();
}

export function filterAfter(
  videos: VideoMeta[],
  publishedAfter: string | undefined,
): VideoMeta[] {
  if (!publishedAfter) {
    return videos;
  }
  return videos.filter((v) => v.publishedAt >= publishedAfter);
}

// --- Metadata scoring (§5.6): capped at medium, never high ---

export function scoreVideo(
  quote: string,
  video: VideoMeta,
): ScoredVideo | null {
  const haystack = `${video.title} ${video.description}`;
  if (keyCoverage(quote, haystack) < KEY_COVERAGE_MIN) {
    return null;
  }
  const { score, matchedWords } = analyzeOverlap(quote, haystack);
  return { video, score, matchedWords };
}

export function mergeShortlist(
  ranked: VideoMeta[],
  searched: VideoMeta[],
  cap = SHORTLIST_CAP,
): VideoMeta[] {
  const seen = new Set<string>();
  const pool: VideoMeta[] = [];
  for (const video of [...ranked, ...searched]) {
    if (seen.has(video.id)) {
      continue;
    }
    seen.add(video.id);
    pool.push(video);
    if (pool.length >= cap) {
      break;
    }
  }
  return pool;
}

function scorePool(
  quote: string,
  pool: VideoMeta[],
  onProgress: ProgressFn,
  counter: { scanned: number },
): ScoredVideo[] {
  const hits: ScoredVideo[] = [];
  for (const video of pool) {
    counter.scanned += 1;
    onProgress("Matching titles and descriptions", video.title);
    const scored = scoreVideo(quote, video);
    if (scored) {
      hits.push(scored);
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

// --- Search flow (§5.4) ---

export interface ChannelSearchInput {
  quote: string;
  variants: string[];
  creator: string;
  sinceDays: number;
  apiKey: string;
  onProgress: ProgressFn;
  reserveQuota?: QuotaReserve;
}

export async function searchChannel(
  input: ChannelSearchInput,
): Promise<EngineOutput> {
  const { quote, variants, creator, sinceDays, apiKey, onProgress, reserveQuota } =
    input;
  const counter = { scanned: 0 };
  onProgress("Resolving channel", creator);
  const header = await resolveChannel(creator, apiKey, reserveQuota);
  const publishedAfter = toPublishedAfter(sinceDays);

  let ranked: VideoMeta[] = [];
  let indexSize = 0;
  try {
    onProgress("Indexing uploads", header.channelTitle);
    const index = (
      await listUploads(
        header.uploadsPlaylistId,
        apiKey,
        MAX_INDEX_VIDEOS,
        reserveQuota,
      )
    ).map(
      (video) => ({ ...video, channelTitle: header.channelTitle }),
    );
    indexSize = index.length;
    const fresh = filterAfter(index, publishedAfter);
    ranked = fresh
      .map((video) => {
        counter.scanned += 1;
        const { score } = analyzeOverlap(
          quote,
          `${video.title} ${video.description}`,
        );
        return { video, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.video);
  } catch {
    // §5.1: when the full index cannot be built, fall back to in-channel
    // search (the quote plus the Muse variants as extra queries).
    onProgress("Indexing uploads", "index unavailable — searching in-channel");
    const searched = await searchQueries(
      quote,
      variants,
      apiKey,
      header.channelId,
      reserveQuota,
    );
    const shortlist = mergeShortlist([], searched);
    const hits = scorePool(quote, shortlist, onProgress, counter);
    return {
      shortlist,
      hits: hits.slice(0, HITS_CAP),
      scanned: counter.scanned,
      channelTitle: header.channelTitle,
      channelId: header.channelId,
      videoCount: indexSize,
    };
  }

  const searched = await searchQueries(
    quote,
    variants,
    apiKey,
    header.channelId,
    reserveQuota,
  );
  const shortlist = mergeShortlist(ranked, searched);
  const hits = scorePool(quote, shortlist, onProgress, counter);
  return {
    shortlist,
    hits: hits.slice(0, HITS_CAP),
    scanned: counter.scanned,
    channelTitle: header.channelTitle,
    channelId: header.channelId,
    videoCount: indexSize,
  };
}

export interface EverywhereSearchInput {
  quote: string;
  variants: string[];
  apiKey: string;
  onProgress: ProgressFn;
  reserveQuota?: QuotaReserve;
}

export async function searchEverywhere(
  input: EverywhereSearchInput,
): Promise<EngineOutput> {
  const { quote, variants, apiKey, onProgress, reserveQuota } = input;
  const counter = { scanned: 0 };
  onProgress("Indexing uploads", "searching all of YouTube");
  const quoted = await searchVideos(`"${quote}"`, apiKey, undefined, 12, reserveQuota);
  const bare = await searchVideos(quote, apiKey, undefined, 12, reserveQuota);
  const extra: VideoMeta[] = [];
  for (const variant of variants.slice(0, VARIANT_QUERY_LIMIT)) {
    extra.push(
      ...(await searchVideos(variant, apiKey, undefined, 8, reserveQuota)),
    );
  }
  const shortlist = mergeShortlist(quoted, [...bare, ...extra]);
  const hits = scorePool(quote, shortlist, onProgress, counter);
  return {
    shortlist,
    hits: hits.slice(0, HITS_CAP),
    scanned: counter.scanned,
    channelTitle: "",
    channelId: "",
    videoCount: shortlist.length,
  };
}
