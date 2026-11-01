import { useEffect, useRef, useState } from "react";
import type { LocateResult } from "../hooks/useQuoteStream";
import { formatDate, videoIdFromUrl, youtubeEmbedUrl } from "../lib/format";
import { cardActions, shareText } from "../lib/share";

interface ResultCardProps {
  result: LocateResult;
  timeWindow: string;
}

/** Shareable quote card (§7.7): fetched lazily after the result
 * renders, hidden entirely when the call fails. Reports the loaded URL
 * (or null) so the parent can offer download and image sharing. */
function QuoteCard({
  sentence,
  onImage,
}: {
  sentence: string;
  onImage: (url: string | null) => void;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setImageUrl(null);
    onImage(null);
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
          onImage(url);
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

const actionButton =
  "rounded-lg border border-border px-4 py-2 font-medium text-foreground";

export function ResultCard({ result, timeWindow }: ResultCardProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [cardImage, setCardImage] = useState<string | null>(null);
  const videoId = videoIdFromUrl(result.videoUrl);
  const published = formatDate(result.publishedAt);
  const actions = cardActions(result, cardImage !== null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!shareCopied) return;
    const timer = window.setTimeout(() => setShareCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [shareCopied]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(result.videoUrl);
      setCopied(true);
    } catch {
      // Clipboard unavailable; leave the button unchanged.
    }
  };

  const downloadCard = async () => {
    if (!cardImage) {
      return;
    }
    // A data: URL downloads directly; a remote URL goes through a blob
    // so the download attribute is honored.
    try {
      const href = cardImage.startsWith("data:")
        ? cardImage
        : URL.createObjectURL(await (await fetch(cardImage)).blob());
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "quotefinder-card.png";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      if (!cardImage.startsWith("data:")) {
        URL.revokeObjectURL(href);
      }
    } catch {
      // Cross-origin or otherwise unfetchable: open it instead, quietly.
      window.open(cardImage, "_blank", "noopener");
    }
  };

  const copyShareText = async () => {
    try {
      await navigator.clipboard.writeText(
        shareText(result.fullSentence, result.videoUrl),
      );
      setShareCopied(true);
    } catch {
      // Clipboard unavailable; leave the button unchanged.
    }
  };

  const shareResult = async () => {
    const text = shareText(result.fullSentence, result.videoUrl);
    if (typeof navigator.share !== "function") {
      await copyShareText();
      return;
    }
    try {
      let files: File[] | undefined;
      if (cardImage) {
        try {
          const blob = await (await fetch(cardImage)).blob();
          const file = new File([blob], "quotefinder-card.png", {
            type: blob.type || "image/png",
          });
          if (
            typeof navigator.canShare === "function" &&
            navigator.canShare({ files: [file] })
          ) {
            files = [file];
          }
        } catch {
          // Image unavailable for sharing; share text and URL only.
        }
      }
      await navigator.share(
        files
          ? { title: "Quotefinder", text, url: result.videoUrl, files }
          : { title: "Quotefinder", text, url: result.videoUrl },
      );
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
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void copyLink()}
          className={actionButton}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        {actions.share && (
          <button
            type="button"
            onClick={() => void shareResult()}
            className={actionButton}
          >
            {shareCopied ? "Copied" : "Share"}
          </button>
        )}
        {actions.download && (
          <button
            type="button"
            onClick={() => void downloadCard()}
            className={actionButton}
          >
            Download card
          </button>
        )}
      </div>
      {result.fullSentence && (
        <QuoteCard sentence={result.fullSentence} onImage={setCardImage} />
      )}
    </div>
  );
}
