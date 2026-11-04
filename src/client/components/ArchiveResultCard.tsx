import { useEffect, useState } from "react";
import {
  formatDate,
  formatStamp,
  videoIdFromUrl,
  youtubeEmbedUrl,
} from "../lib/format";
import { openExternal } from "../lib/openExternal";
import { archiveShareText, copyToClipboard } from "../lib/share";

/** One creator-archive match, as returned by POST /api/archive/search. */
export interface CreatorArchiveMatch {
  videoTitle: string;
  videoUrl: string;
  publishedAt: string;
  creator: string;
  startSeconds: number;
  timestampVerified: boolean;
  trackKind: "standard" | "asr";
  trackLabel: string;
  confidence: "high" | "medium";
  text: string;
}

interface ArchiveResultCardProps {
  result: CreatorArchiveMatch;
  timeWindow?: string;
}

export function ArchiveResultCard({
  result,
  timeWindow,
}: ArchiveResultCardProps) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [shareStatus, setShareStatus] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const videoId = videoIdFromUrl(result.videoUrl);
  const published = formatDate(result.publishedAt);

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  useEffect(() => {
    if (shareStatus === "idle") return;
    const timer = window.setTimeout(() => setShareStatus("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [shareStatus]);

  const copyLink = async () => {
    const ok = await copyToClipboard(result.videoUrl);
    setCopyStatus(ok ? "copied" : "failed");
  };

  const copyShareText = async () => {
    const ok = await copyToClipboard(
      archiveShareText(result.videoTitle, result.videoUrl),
    );
    setShareStatus(ok ? "copied" : "failed");
  };

  // Video link only: title and URL. The matched caption text,
  // timestamps, and cue text are never passed here.
  const shareLink = async () => {
    if (typeof navigator.share !== "function") {
      await copyShareText();
      return;
    }
    try {
      await navigator.share({
        title: "Quotefinder",
        text: archiveShareText(result.videoTitle, result.videoUrl),
        url: result.videoUrl,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      await copyShareText();
    }
  };

  return (
    <div className="mt-4 border-t border-border pt-4">
      {result.confidence === "high" ? (
        <span className="rounded-full bg-accent px-3 py-1 text-sm font-medium text-accent-foreground">
          High
        </span>
      ) : (
        <span className="rounded-full border border-border px-3 py-1 text-sm font-medium text-muted">
          Medium
        </span>
      )}
      <p className="mt-3 font-mono text-sm text-muted">
        {result.creator || "Unknown creator"}
        {timeWindow ? ` · ${timeWindow}` : ""}
      </p>
      <h3 className="mt-2 font-display text-2xl font-bold">
        {result.videoTitle}
      </h3>
      {published && (
        <p className="mt-1 font-mono text-sm text-muted">{published}</p>
      )}
      <blockquote className="mt-4 border-l-4 border-accent pl-4 font-display text-2xl leading-snug">
        {result.text}
      </blockquote>
      {result.trackLabel && (
        <p className="mt-4 rounded-lg border border-border p-3">
          <span aria-hidden="true" className="text-accent">
            ✓{" "}
          </span>
          Timestamp {result.trackLabel}.
        </p>
      )}
      {videoId && result.timestampVerified && (
        <div className="mt-4">
          <iframe
            className="aspect-video w-full rounded-xl border border-border"
            src={youtubeEmbedUrl(videoId, result.startSeconds)}
            title={result.videoTitle || "Matched video"}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
          <p className="mt-2 font-mono text-sm text-muted">
            Video · starts at {formatStamp(result.startSeconds)}
          </p>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void copyLink()}
          className="rounded-lg border border-border px-4 py-2 font-medium text-foreground"
        >
          {copyStatus === "copied"
            ? "Copied"
            : copyStatus === "failed"
              ? "Copy failed"
              : "Copy link"}
        </button>
        <button
          type="button"
          onClick={() => void shareLink()}
          className="rounded-lg border border-border px-4 py-2 font-medium text-foreground"
        >
          {shareStatus === "copied"
            ? "Copied"
            : shareStatus === "failed"
              ? "Copy failed"
              : "Share link"}
        </button>
        {videoId && (
          <button
            type="button"
            onClick={() => openExternal(result.videoUrl)}
            className="rounded-lg border border-border px-4 py-2 font-medium text-foreground"
          >
            Open on YouTube
          </button>
        )}
      </div>
    </div>
  );
}
