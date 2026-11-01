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
