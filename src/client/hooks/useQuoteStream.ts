import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchInput } from "../components/Composer";
import { createSseParser, type SseEvent } from "../lib/sse";

// Client mirror of the server's LocateResult (quote-finder.ts). Fields the
// UI doesn't show (engine) are still read so the shape stays in sync.
export interface QuoteCandidate {
  url: string;
  title: string;
  creator: string;
  reason: string;
}

export interface LocateResult {
  found: boolean;
  confidence: "high" | "medium" | "low";
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

export interface ProgressUpdate {
  stage: string;
  detail: string;
}

export interface StreamCallbacks {
  onStarted: () => void;
  onProgress: (update: ProgressUpdate) => void;
  onResult: (result: LocateResult) => void;
  onError: (message: string) => void;
}

function readJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Fill missing result fields with safe defaults so cards never crash. */
function normalizeResult(data: Record<string, unknown>): LocateResult {
  const rawCandidates = Array.isArray(data.candidates) ? data.candidates : [];
  const rawEngine =
    typeof data.engine === "object" && data.engine !== null
      ? (data.engine as Record<string, unknown>)
      : {};
  return {
    found: data.found === true,
    confidence:
      data.confidence === "high" ||
      data.confidence === "medium" ||
      data.confidence === "low"
        ? data.confidence
        : "low",
    creator: asString(data.creator),
    videoTitle: asString(data.videoTitle),
    videoUrl: asString(data.videoUrl),
    publishedAt: asString(data.publishedAt),
    startTime: asNumber(data.startTime),
    startEstimate: data.startEstimate === true,
    timestampVerified: false,
    fullSentence: asString(data.fullSentence),
    context: asStringArray(data.context),
    notes: asStringArray(data.notes),
    candidates: rawCandidates.map((item) => {
      const c =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)
          : {};
      return {
        url: asString(c.url),
        title: asString(c.title),
        creator: asString(c.creator),
        reason: asString(c.reason),
      };
    }),
    engine: {
      scanned: asNumber(rawEngine.scanned),
      channelTitle: asString(rawEngine.channelTitle),
      channelId: asString(rawEngine.channelId),
      videoCount: asNumber(rawEngine.videoCount),
    },
  };
}

/**
 * POSTs one search to /api/quote-stream and delivers SSE events through the
 * callbacks. One search at a time; leaving the page stops the callbacks.
 */
export function useQuoteStream(): {
  running: boolean;
  start: (input: SearchInput, callbacks: StreamCallbacks) => void;
} {
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const start = useCallback(
    (input: SearchInput, callbacks: StreamCallbacks) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setRunning(true);
      void runStream(input, callbacks, () => cancelledRef.current).finally(
        () => {
          runningRef.current = false;
          if (!cancelledRef.current) setRunning(false);
        },
      );
    },
    [],
  );

  return { running, start };
}

async function runStream(
  input: SearchInput,
  callbacks: StreamCallbacks,
  isCancelled: () => boolean,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/quote-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quote: input.quote,
        creator: input.creator,
        scene: input.scene,
        sinceDays: input.sinceDays,
      }),
    });
  } catch (error) {
    if (!isCancelled()) {
      callbacks.onError(
        error instanceof Error ? error.message : "search request failed",
      );
    }
    return;
  }
  if (isCancelled()) return;

  if (!response.ok || !response.body) {
    let message = `request failed with status ${response.status}`;
    try {
      const data = readJsonObject(await response.text());
      if (typeof data?.message === "string" && data.message) {
        message = data.message;
      }
    } catch {
      // Keep the status fallback.
    }
    callbacks.onError(message);
    return;
  }

  callbacks.onStarted();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (isCancelled()) {
        await reader.cancel().catch(() => {});
        return;
      }
      if (done) return;
      const finished = dispatchEvents(
        parser.feed(decoder.decode(value, { stream: true })),
        callbacks,
      );
      if (finished || isCancelled()) {
        await reader.cancel().catch(() => {});
        return;
      }
    }
  } catch (error) {
    if (!isCancelled()) {
      callbacks.onError(
        error instanceof Error ? error.message : "stream interrupted",
      );
    }
  }
}

/** Returns true once a terminal result/error event has been handled. */
function dispatchEvents(
  events: SseEvent[],
  callbacks: StreamCallbacks,
): boolean {
  for (const evt of events) {
    if (evt.event === "progress") {
      const data = readJsonObject(evt.data);
      callbacks.onProgress({
        stage: typeof data?.stage === "string" ? data.stage : "",
        detail: typeof data?.detail === "string" ? data.detail : "",
      });
    } else if (evt.event === "result") {
      const data = readJsonObject(evt.data);
      if (!data) {
        callbacks.onError("the server sent a result that couldn't be read");
        return true;
      }
      callbacks.onResult(normalizeResult(data));
      return true;
    } else if (evt.event === "error") {
      const data = readJsonObject(evt.data);
      const message =
        typeof data?.message === "string" && data.message
          ? data.message
          : "the search didn't finish";
      callbacks.onError(message);
      return true;
    }
  }
  return false;
}
