import { useEffect, useRef, useState } from "react";
import type { LocateResult } from "../hooks/useQuoteStream";
import { formatDate, videoIdFromUrl, youtubeEmbedUrl } from "../lib/format";

interface ResultCardProps {
  result: LocateResult;
  timeWindow: string;
}

/** Shareable quote card (§7.7): fetched lazily after the result
 * renders, hidden entirely when the call fails. */
function QuoteCard({ sentence }: { sentence: string }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setImageUrl(null);
    fetch("/api/quote-card", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentence }),
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`status ${res.status}`);
        }
        const data = (await res.json()) as { imageUrl?: string };
        if (typeof data.imageUrl !== "string" || !data.imageUrl) {
          throw new Error("no image in response");
        }
        return data.imageUrl;
      })
      .then((url) => {
        if (!cancelled) {
          setImageUrl(url);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sentence]);

  if (!loading && !imageUrl) {
    return null;
  }
  return (
    <div className="mt-4">
      {loading && !imageUrl && (
        <p className="text-sm text-muted">Making your share card…</p>
      )}
      {imageUrl && (
        <>
          <img
            src={imageUrl}
            alt={`Share card: ${sentence}`}
            loading="lazy"
            className="w-full rounded-xl border border-border"
          />
          <p className="text-sm text-muted">
            AI-generated share card. The text may differ slightly from the
            original.
          </p>
        </>
      )}
    </div>
  );
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
      {result.fullSentence && <QuoteCard sentence={result.fullSentence} />}
    </div>
  );
}
