// Pure UI formatting helpers: time-window labels, YouTube video IDs,
// embed URLs, and date display. Unit tested in format.test.ts.

export interface TimeWindowOption {
  label: string;
  value: number;
}

export const TIME_WINDOW_OPTIONS: TimeWindowOption[] = [
  { label: "Any time", value: 0 },
  { label: "24 hours", value: 1 },
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "2 months", value: 60 },
  { label: "6 months", value: 180 },
  { label: "1 year", value: 365 },
];

/** Short lowercase label for turn headers, e.g. "7 days" or "any time". */
export function timeWindowLabel(sinceDays: number): string {
  const known = TIME_WINDOW_OPTIONS.find((o) => o.value === sinceDays);
  if (known) return known.label.toLowerCase();
  return `${sinceDays} days`;
}

/** YouTube video ID from a watch/shorts/embed/live/youtu.be URL, else "". */
export function videoIdFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "youtu.be") {
    return cleanVideoId(parsed.pathname.split("/").filter(Boolean)[0] ?? "");
  }
  if (
    host === "www.youtube.com" ||
    host === "youtube.com" ||
    host === "m.youtube.com"
  ) {
    if (parsed.pathname === "/watch") {
      return cleanVideoId(parsed.searchParams.get("v") ?? "");
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (
      (parts[0] === "embed" ||
        parts[0] === "shorts" ||
        parts[0] === "live") &&
      parts[1]
    ) {
      return cleanVideoId(parts[1]);
    }
  }
  return "";
}

function cleanVideoId(id: string): string {
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : "";
}

/** Privacy-enhanced embed URL for a video ID. */
export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&modestbranding=1`;
}

/** ISO timestamp to YYYY-MM-DD, or "" when missing/unparseable. */
export function formatDate(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match ? match[1] : "";
}
