/** Text for sharing a found result: the remembered sentence in curly
 * quotes, then the video URL on its own line. Never claims the quote
 * is verified. */
export function shareText(sentence: string, videoUrl: string): string {
  const trimmed = sentence.trim();
  if (!trimmed) {
    return videoUrl;
  }
  return `“${trimmed}”\n${videoUrl}`;
}
