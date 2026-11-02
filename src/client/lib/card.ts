// Share-card text layout (§7.7): pure helpers that wrap the exact
// sentence for the canvas card. No DOM here, so these unit test cleanly.

/** Most lines the card draws. Longer sentences cut off with an ellipsis. */
const MAX_CARD_LINES = 8;

/** Split a sentence into display lines: fill each line up to maxChars,
 * splitting on words only. Never breaks a word. Returns at most 8
 * lines; when the sentence runs longer, the last line ends with "…". */
export function wrapSentence(sentence: string, maxChars: number): string[] {
  const words = sentence.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  if (lines.length <= MAX_CARD_LINES) {
    return lines;
  }
  const kept = lines.slice(0, MAX_CARD_LINES);
  kept[MAX_CARD_LINES - 1] += "…";
  return kept;
}

/** Sentence size in px for the card canvas: steps down as lines grow. */
export function cardTextSize(lineCount: number): number {
  if (lineCount <= 3) {
    return 56;
  }
  if (lineCount <= 5) {
    return 48;
  }
  return 40;
}
