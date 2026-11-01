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
