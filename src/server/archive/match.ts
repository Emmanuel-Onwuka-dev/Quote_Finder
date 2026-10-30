// Caption-window matching (§5.2–§5.3): slide 3-to-6-cue windows over a
// channel's stored cues, score each with the shared fuzzy overlap, and
// keep the best window per video. Pure functions over caller-supplied
// cues; storage and refresh live in store.ts and routes.ts.

import { close, keyCoverage, overlapScore, tokens } from "../fuzzy";
import type { CaptionCue } from "./srt";

/** §5.2 confidence bars — the same values quote-finder uses. */
const HIGH_AT = 0.8;
const MEDIUM_AT = 0.55;
/** §5.2 distinctive-word guard, as for metadata. */
const KEY_COVERAGE_MIN = 0.6;
/** §5.2 window of 3 to 6 consecutive cues. */
const WINDOW_MIN = 3;
const WINDOW_MAX = 6;

export interface ArchiveVideoCues {
  videoId: string;
  title: string;
  publishedAt: string;
  channelTitle: string;
  trackKind: string;
  cues: CaptionCue[];
}

export type ArchiveConfidence = "high" | "medium";
export type ArchiveTrackKind = "standard" | "asr";

export interface ArchiveMatch {
  videoId: string;
  title: string;
  publishedAt: string;
  creator: string;
  /** Floored whole seconds, ready for `t={n}s` URLs. */
  startSeconds: number;
  trackKind: ArchiveTrackKind;
  trackLabel: string;
  confidence: ArchiveConfidence;
  score: number;
  /** The matched window's caption text. */
  text: string;
  url: string;
}

/** The archive result type (§5.4): flat like LocateResult, with the
 * timestamp verified from captions instead of estimated. `refreshed`
 * names ASR videos this search re-downloaded (approved §7.4 refresh). */
export interface ArchiveSearchResult {
  found: boolean;
  confidence: ArchiveConfidence | null;
  creator: string;
  videoTitle: string;
  videoUrl: string;
  publishedAt: string;
  startSeconds: number;
  timestampVerified: boolean;
  trackKind: ArchiveTrackKind | null;
  trackLabel: string;
  text: string;
  refreshed: string[];
  refreshPaused: boolean;
}

/** §5.3: `forced` counts as `standard`; only `asr` is labelled and
 * capped. YouTube sends no other kinds. */
export function trackLabel(trackKind: string): {
  kind: ArchiveTrackKind;
  label: string;
} {
  if (trackKind === "asr") {
    return { kind: "asr", label: "verified from auto-generated captions" };
  }
  return { kind: "standard", label: "verified from the creator's captions" };
}

/** Every consecutive run of 3 to 6 cues. Short videos get a single
 * window of whatever they have: one cue can hold the line. */
export function cueWindows(cues: CaptionCue[]): CaptionCue[][] {
  if (cues.length === 0) {
    return [];
  }
  if (cues.length <= WINDOW_MIN) {
    return [cues.slice()];
  }
  const windows: CaptionCue[][] = [];
  for (
    let size = WINDOW_MIN;
    size <= Math.min(WINDOW_MAX, cues.length);
    size += 1
  ) {
    for (let start = 0; start + size <= cues.length; start += 1) {
      windows.push(cues.slice(start, start + size));
    }
  }
  return windows;
}

function windowText(window: CaptionCue[]): string {
  return window.map((cue) => cue.text).join(" ");
}

/** Best overlap across the quote and its variants. A phrasing only
 * counts when its distinctive words mostly appear (§5.2 guard). */
export function scoreWindow(
  quote: string,
  variants: string[],
  text: string,
): number {
  let best = 0;
  for (const phrasing of [quote, ...variants]) {
    if (keyCoverage(phrasing, text) < KEY_COVERAGE_MIN) {
      continue;
    }
    const score = overlapScore(phrasing, text);
    if (score > best) {
      best = score;
    }
  }
  return best;
}

/** Drop leading and trailing cues that share no word (exact or
 * near-miss) with any phrasing, so the timestamp lands on the match
 * instead of the window edge. Score-neutral: trimmed cues contributed
 * nothing. */
function trimWindow(window: CaptionCue[], phrasings: string[]): CaptionCue[] {
  const targets = phrasings.flatMap(tokens);
  const hits = (cue: CaptionCue): boolean =>
    tokens(cue.text).some((word) =>
      targets.some((target) => target === word || close(target, word)),
    );
  let start = 0;
  while (start < window.length) {
    const cue = window[start];
    if (!cue || hits(cue)) {
      break;
    }
    start += 1;
  }
  let end = window.length;
  while (end > start) {
    const cue = window[end - 1];
    if (!cue || hits(cue)) {
      break;
    }
    end -= 1;
  }
  return window.slice(start, end);
}

/** Best matching window in one video, or null below medium. Ties keep
 * the earliest, smallest window; its edges are then trimmed to the
 * matching cues. */
export function matchVideo(
  video: ArchiveVideoCues,
  quote: string,
  variants: string[] = [],
): ArchiveMatch | null {
  const phrasings = [quote, ...variants];
  let best: { score: number; window: CaptionCue[] } | null = null;
  for (const window of cueWindows(video.cues)) {
    const score = scoreWindow(quote, variants, windowText(window));
    if (score >= MEDIUM_AT && (!best || score > best.score)) {
      best = { score, window };
    }
  }
  if (!best) {
    return null;
  }
  const trimmed = trimWindow(best.window, phrasings);
  const first = trimmed[0];
  if (!first) {
    return null;
  }
  const text = windowText(trimmed);
  const score = scoreWindow(quote, variants, text);
  const { kind, label } = trackLabel(video.trackKind);
  const startSeconds = Math.max(0, Math.floor(first.startSeconds));
  return {
    videoId: video.videoId,
    title: video.title,
    publishedAt: video.publishedAt,
    creator: video.channelTitle,
    startSeconds,
    trackKind: kind,
    trackLabel: label,
    confidence: score >= HIGH_AT && kind === "standard" ? "high" : "medium",
    score,
    text,
    url: `https://www.youtube.com/watch?v=${video.videoId}&t=${startSeconds}s`,
  };
}

/** Best match across videos, or null. Ties keep the first video, so
 * callers should pass their preferred order. */
export function matchArchive(
  videos: ArchiveVideoCues[],
  quote: string,
  variants: string[] = [],
): ArchiveMatch | null {
  let best: ArchiveMatch | null = null;
  for (const video of videos) {
    const match = matchVideo(video, quote, variants);
    if (match && (!best || match.score > best.score)) {
      best = match;
    }
  }
  return best;
}

export function toArchiveResult(
  match: ArchiveMatch,
  refreshed: string[],
  refreshPaused: boolean,
): ArchiveSearchResult {
  return {
    found: true,
    confidence: match.confidence,
    creator: match.creator,
    videoTitle: match.title,
    videoUrl: match.url,
    publishedAt: match.publishedAt,
    startSeconds: match.startSeconds,
    timestampVerified: true,
    trackKind: match.trackKind,
    trackLabel: match.trackLabel,
    text: match.text,
    refreshed,
    refreshPaused,
  };
}

export function noMatchResult(
  refreshed: string[],
  refreshPaused: boolean,
): ArchiveSearchResult {
  return {
    found: false,
    confidence: null,
    creator: "",
    videoTitle: "",
    videoUrl: "",
    publishedAt: "",
    startSeconds: 0,
    timestampVerified: false,
    trackKind: null,
    trackLabel: "",
    text: "",
    refreshed,
    refreshPaused,
  };
}
