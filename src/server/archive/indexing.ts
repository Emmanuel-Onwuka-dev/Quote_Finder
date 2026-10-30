// Caption indexing runs (§4.2): for each selected video, spend budget,
// fetch the best caption track, download and parse the SRT. Results are
// returned, not stored — A3 persists them. Progress mirrors the search
// SSE pattern (one event per video plus its outcome).

import {
  CAPTIONS_DOWNLOAD_COST,
  CAPTIONS_LIST_COST,
  downloadCaptions,
  listCaptionTracks,
  pickTrack,
} from "./captions";
import type { ProgressFn } from "../youtube";
import { parseSrt, type CaptionCue } from "./srt";
import { todayKey, type ArchiveStore, type BudgetKind } from "./store";

export interface IndexedVideo {
  videoId: string;
  trackId: string;
  trackKind: string;
  language: string;
  cues: CaptionCue[];
}

export interface SkippedVideo {
  videoId: string;
  reason: string;
}

export interface IndexRunResult {
  indexed: IndexedVideo[];
  skipped: SkippedVideo[];
  paused: boolean;
  /** Units spent today on this run's budget, including this run. */
  spentUnits: number;
}

export interface IndexRunInput {
  videoIds: string[];
  accessToken: string;
  store: ArchiveStore;
  fetchFn?: typeof fetch;
  onProgress?: ProgressFn;
  now?: Date;
  /** Which daily budget to spend; creator indexing by default. */
  budgetKind?: BudgetKind;
}

/** §4.3 message shown when the daily budget stops a run. */
export const INDEX_PAUSED_MESSAGE = "Indexing paused until tomorrow";

export async function runIndexing(
  input: IndexRunInput,
): Promise<IndexRunResult> {
  const { videoIds, accessToken, store } = input;
  const fetchFn = input.fetchFn ?? fetch;
  const onProgress: ProgressFn = input.onProgress ?? (() => {});
  const day = todayKey(input.now ?? new Date());
  const budgetKind = input.budgetKind ?? "creator";
  const indexed: IndexedVideo[] = [];
  const skipped: SkippedVideo[] = [];
  let paused = false;

  for (let position = 0; position < videoIds.length; position += 1) {
    const videoId = videoIds[position] ?? "";
    if (!videoId) {
      continue;
    }
    const label = `video ${videoId} (${position + 1} of ${videoIds.length})`;
    onProgress("Indexing videos", label);
    if (!store.trySpend(day, CAPTIONS_LIST_COST, budgetKind)) {
      paused = true;
      break;
    }
    let tracks;
    try {
      tracks = await listCaptionTracks(videoId, accessToken, fetchFn);
    } catch (error) {
      skipped.push({ videoId, reason: describe(error) });
      onProgress("Indexing videos", `${label} — skipped`);
      continue;
    }
    const track = pickTrack(tracks);
    if (!track) {
      skipped.push({ videoId, reason: "no usable caption track" });
      onProgress("Indexing videos", `${label} — skipped`);
      continue;
    }
    if (!store.trySpend(day, CAPTIONS_DOWNLOAD_COST, budgetKind)) {
      paused = true;
      break;
    }
    try {
      const cues = parseSrt(
        await downloadCaptions(track.id, accessToken, fetchFn),
      );
      if (cues.length === 0) {
        skipped.push({ videoId, reason: "captions were empty" });
        onProgress("Indexing videos", `${label} — skipped`);
        continue;
      }
      indexed.push({
        videoId,
        trackId: track.id,
        trackKind: track.trackKind,
        language: track.language,
        cues,
      });
      onProgress("Indexing videos", `${label} — ${cues.length} cues`);
    } catch (error) {
      skipped.push({ videoId, reason: describe(error) });
      onProgress("Indexing videos", `${label} — skipped`);
    }
  }

  return {
    indexed,
    skipped,
    paused,
    spentUnits: store.getSpent(day, budgetKind),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}
