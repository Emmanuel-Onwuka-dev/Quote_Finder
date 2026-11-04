/** Text for sharing a found result: the remembered sentence labelled
 * as unverified, then the video URL on its own line. Never claims
 * the quote is verified. */
export function shareText(sentence: string, videoUrl: string): string {
  const trimmed = sentence.trim();
  if (!trimmed) {
    return videoUrl;
  }
  return `Remembered line: “${trimmed}” (not verified)\n${videoUrl}`;
}

/** Text for sharing a creator-archive match: the video title, then
 * the video URL on its own line. Takes only title and URL, so matched
 * caption text, timestamps, and cue text can never leak into a share. */
export function archiveShareText(videoTitle: string, videoUrl: string): string {
  const trimmed = videoTitle.trim();
  if (!trimmed) {
    return videoUrl;
  }
  return `${trimmed}\n${videoUrl}`;
}

/** Copy text to the clipboard. Uses the async clipboard API when it is
 * available, otherwise a temporary textarea with execCommand. Never
 * throws: resolves false when nothing worked, so the caller can say so. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard && typeof clipboard.writeText === "function") {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const doc = globalThis.document;
    if (
      !doc ||
      typeof doc.createElement !== "function" ||
      typeof doc.execCommand !== "function" ||
      !doc.body
    ) {
      return false;
    }
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    doc.body.appendChild(area);
    try {
      area.select();
      return doc.execCommand("copy");
    } finally {
      doc.body.removeChild(area);
    }
  } catch {
    return false;
  }
}

/** Minimal result shape the card-action rules need. */
export interface CardActionInput {
  found: boolean;
}

export interface CardActions {
  share: boolean;
  download: boolean;
  copyLink: boolean;
}

/** Which actions a result card shows. Single home for the rule:
 * Copy link always shows; Share needs a found result; Download
 * also needs a loaded card image. */
export function cardActions(
  result: CardActionInput,
  imageLoaded: boolean,
): CardActions {
  return {
    share: result.found,
    download: result.found && imageLoaded,
    copyLink: true,
  };
}
