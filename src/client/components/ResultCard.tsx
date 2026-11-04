import { useEffect, useRef, useState } from "react";
import type { LocateResult } from "../hooks/useQuoteStream";
import { cardTextSize, wrapSentence } from "../lib/card";
import {
  formatDate,
  formatStamp,
  videoIdFromUrl,
  youtubeEmbedUrl,
} from "../lib/format";
import { cardActions, copyToClipboard, shareText } from "../lib/share";

interface ResultCardProps {
  result: LocateResult;
  timeWindow: string;
}

/** Composed card size: 16:9, sized for link unfurls. */
const CARD_WIDTH = 1600;
const CARD_HEIGHT = 900;

/** Card text colors. These match the app palette (light text and muted)
 * in index.css, fixed here so the exported image never depends on the
 * page state. */
const CARD_LIGHT_TEXT = "#fffaf3";
const CARD_MUTED_TEXT = "#6f6557";

/** Load the AI background so it can be drawn without tainting the
 * canvas. Rejects when the image cannot be used. */
function loadBackground(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("background failed to load"));
    img.src = url;
  });
}

/** Draw the background cover-fit, a dark readable overlay, the exact
 * sentence centred, and the footer line. Returns a PNG data URL. */
function drawCard(background: HTMLImageElement, sentence: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("canvas 2d unavailable");
  }
  const scale = Math.max(
    CARD_WIDTH / background.naturalWidth,
    CARD_HEIGHT / background.naturalHeight,
  );
  const drawnWidth = background.naturalWidth * scale;
  const drawnHeight = background.naturalHeight * scale;
  ctx.drawImage(
    background,
    (CARD_WIDTH - drawnWidth) / 2,
    (CARD_HEIGHT - drawnHeight) / 2,
    drawnWidth,
    drawnHeight,
  );
  const shade = ctx.createLinearGradient(0, 0, 0, CARD_HEIGHT);
  shade.addColorStop(0, "rgba(0, 0, 0, 0.45)");
  shade.addColorStop(1, "rgba(0, 0, 0, 0.72)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  const lines = wrapSentence(sentence, 34);
  const size = cardTextSize(lines.length);
  ctx.fillStyle = CARD_LIGHT_TEXT;
  ctx.font = `${size}px "Space Grotesk", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lineHeight = size * 1.25;
  const firstBaseline =
    CARD_HEIGHT / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => {
    ctx.fillText(line, CARD_WIDTH / 2, firstBaseline + index * lineHeight);
  });
  ctx.font = '22px "DM Sans", sans-serif';
  ctx.fillStyle = CARD_MUTED_TEXT;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText("Quotefinder", 48, CARD_HEIGHT - 48);
  ctx.textAlign = "right";
  ctx.fillText("AI-generated background", CARD_WIDTH - 48, CARD_HEIGHT - 48);
  return canvas.toDataURL("image/png");
}

/** Shareable quote card (§7.7): fetched lazily after the result
 * renders. The server returns an AI background only; the exact
 * sentence is drawn on top here, so the wording never changes.
 * Hidden entirely when the background call or the drawing fails.
 * Reports the composed image (or null) so the parent can offer
 * download and image sharing. */
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
    const compose = async (): Promise<string> => {
      const res = await fetch("/api/quote-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence }),
      });
      if (!res.ok) {
        throw new Error(`status ${res.status}`);
      }
      const data = (await res.json()) as { imageUrl?: string };
      if (typeof data.imageUrl !== "string" || !data.imageUrl) {
        throw new Error("no image in response");
      }
      const background = await loadBackground(data.imageUrl);
      // Wait for the app fonts before drawing text with them.
      await document.fonts.ready;
      return drawCard(background, sentence);
    };
    compose()
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
        <p className="text-sm text-muted">Muse Image is painting the card background</p>
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
            AI-generated background. Quotefinder adds the sentence.
          </p>
        </>
      )}
    </div>
  );
}

const actionButton =
  "rounded-lg border border-border px-4 py-2 font-medium text-foreground";

/** Shown on the main card and on every other match. */
const VERIFICATION_NOTE =
  "The exact moment this line is said has not been verified.";

interface OtherMatch {
  key: string;
  title: string;
  creator: string;
  /** Null selects the original main result. */
  index: number | null;
}

/** Main display for a selected Other match: the candidate's own video
 * fields over the shared result. The date line uses the candidate's
 * own publishedAt, never the original video's date. Pure. */
export function selectedMain(
  result: LocateResult,
  selectedIndex: number | null,
): LocateResult {
  const selected =
    selectedIndex === null
      ? null
      : (result.candidates[selectedIndex] ?? null);
  if (selected === null) {
    return result;
  }
  return {
    ...result,
    videoTitle: selected.title,
    videoUrl: selected.url,
    creator: selected.creator || result.creator,
    publishedAt: selected.publishedAt,
    context: selected.reason ? [selected.reason] : result.context,
  };
}

export function ResultCard({ result, timeWindow }: ResultCardProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [shareStatus, setShareStatus] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const [cardImage, setCardImage] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const candidates = result.candidates;
  const selected =
    selectedIndex === null ? null : (candidates[selectedIndex] ?? null);
  const main = selectedMain(result, selectedIndex);
  const others: OtherMatch[] = [];
  if (selected === null) {
    candidates.slice(0, 4).forEach((candidate, index) => {
      others.push({
        key: `${index}-${candidate.url}`,
        title: candidate.title,
        creator: candidate.creator,
        index,
      });
    });
  } else {
    others.push({
      key: `main-${result.videoUrl}`,
      title: result.videoTitle,
      creator: result.creator,
      index: null,
    });
    candidates.forEach((candidate, index) => {
      if (index !== selectedIndex && others.length < 4) {
        others.push({
          key: `${index}-${candidate.url}`,
          title: candidate.title,
          creator: candidate.creator,
          index,
        });
      }
    });
  }
  const videoId = videoIdFromUrl(main.videoUrl);
  const published = formatDate(main.publishedAt);
  const stamp = formatStamp(result.startTime);
  const stampLabel = result.startEstimate
    ? `your estimate: ${stamp}`
    : `starts at ${stamp}`;
  const actions = cardActions(result, cardImage !== null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

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
    const ok = await copyToClipboard(main.videoUrl);
    setCopyStatus(ok ? "copied" : "failed");
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
    const ok = await copyToClipboard(
      shareText(result.fullSentence, main.videoUrl),
    );
    setShareStatus(ok ? "copied" : "failed");
  };

  const shareResult = async () => {
    const text = shareText(result.fullSentence, main.videoUrl);
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
          ? { title: "Quotefinder", text, url: main.videoUrl, files }
          : { title: "Quotefinder", text, url: main.videoUrl },
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
        {main.creator || "Unknown creator"} · {timeWindow}
      </p>
      <h3
        ref={headingRef}
        tabIndex={-1}
        className="mt-2 font-display text-2xl font-bold"
      >
        {main.videoTitle}
      </h3>
      {published && (
        <p className="mt-1 font-mono text-sm text-muted">{published}</p>
      )}
      <blockquote className="mt-4 border-l-4 border-accent pl-4 font-display text-2xl leading-snug">
        {result.fullSentence}
      </blockquote>
      <p className="mt-4 rounded-lg border border-border p-3">
        {VERIFICATION_NOTE}
      </p>
      {main.context.map((line, index) => (
        <p key={`${index}-${line.slice(0, 24)}`} className="mt-3">
          {line}
        </p>
      ))}
      {videoId && (
        <div className="mt-4">
          <iframe
            className="aspect-video w-full rounded-xl border border-border"
            src={youtubeEmbedUrl(videoId)}
            title={main.videoTitle || "Matched video"}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
          <p className="mt-2 font-mono text-sm text-muted">
            Video · {stampLabel}
          </p>
        </div>
      )}
      {others.length > 0 && (
        <div className="mt-4 border-t border-border pt-4">
          <h3 className="font-display text-lg font-bold">Other matches</h3>
          <ul className="mt-3 space-y-4">
            {others.map((item) => {
              const meta = [item.creator, timeWindow]
                .filter(Boolean)
                .join(" · ");
              return (
                <li
                  key={item.key}
                  className="border-t border-border pt-3 first:border-t-0 first:pt-0"
                >
                  <button
                    type="button"
                    onClick={() => setSelectedIndex(item.index)}
                    className="block w-full text-left"
                  >
                    <p className="font-medium">{item.title}</p>
                    {meta && (
                      <p className="mt-1 font-mono text-sm text-muted">{meta}</p>
                    )}
                    <p className="mt-1 text-sm text-muted">
                      {VERIFICATION_NOTE}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void copyLink()}
          className={actionButton}
        >
          {copyStatus === "copied"
            ? "Copied"
            : copyStatus === "failed"
              ? "Copy failed"
              : "Copy link"}
        </button>
        {actions.share && (
          <button
            type="button"
            onClick={() => void shareResult()}
            className={actionButton}
          >
            {shareStatus === "copied"
              ? "Copied"
              : shareStatus === "failed"
                ? "Copy failed"
                : "Share"}
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
