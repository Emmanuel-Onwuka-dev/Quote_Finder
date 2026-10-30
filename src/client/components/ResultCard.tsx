import { useEffect, useRef, useState } from "react";
import type { LocateResult } from "../hooks/useQuoteStream";
import { formatDate, videoIdFromUrl, youtubeEmbedUrl } from "../lib/format";

interface ResultCardProps {
  result: LocateResult;
  timeWindow: string;
}

export function ResultCard({ result, timeWindow }: ResultCardProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  const videoId = videoIdFromUrl(result.videoUrl);
  const published = formatDate(result.publishedAt);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(result.videoUrl);
      setCopied(true);
    } catch {
      // Clipboard unavailable; leave the button unchanged.
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
          {result.confidence === "medium" ? "Medium" : "Low"}
        </span>
      )}
      <p className="mt-3 font-mono text-sm text-muted">
        {result.creator || "Unknown creator"} · {timeWindow}
      </p>
      <h3
        ref={headingRef}
        tabIndex={-1}
        className="mt-2 font-display text-2xl font-bold"
      >
        {result.videoTitle}
      </h3>
      {published && (
        <p className="mt-1 font-mono text-sm text-muted">{published}</p>
      )}
      <blockquote className="mt-4 border-l-4 border-accent pl-4 font-display text-2xl leading-snug">
        {result.fullSentence}
      </blockquote>
      <p className="mt-4 rounded-lg border border-border p-3">
        The exact moment this line is said has not been verified.
      </p>
      {result.context.map((line, index) => (
        <p key={`${index}-${line.slice(0, 24)}`} className="mt-3">
          {line}
        </p>
      ))}
      {videoId && (
        <div className="mt-4">
          <iframe
            className="aspect-video w-full rounded-xl border border-border"
            src={youtubeEmbedUrl(videoId)}
            title={result.videoTitle || "Matched video"}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
          <p className="mt-2 font-mono text-sm text-muted">
            Video · starts at 0:00
          </p>
        </div>
      )}
      <button
        type="button"
        onClick={() => void copyLink()}
        className="mt-4 rounded-lg border border-border px-4 py-2 font-medium text-foreground"
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
