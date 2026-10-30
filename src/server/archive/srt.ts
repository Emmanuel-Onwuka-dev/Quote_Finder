// SRT caption parsing for the creator archive. YouTube serves tfmt=srt
// with comma decimals and CRLF; the parser also accepts dot decimals,
// strips formatting tags, and drops empty or malformed cues. Tested in
// srt.test.ts against fixture files.

export interface CaptionCue {
  idx: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

const TIMESTAMP = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

function toSeconds(match: RegExpMatchArray): number {
  const [, hours, minutes, seconds, millis] = match;
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(millis.padEnd(3, "0")) / 1000
  );
}

function cleanText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/<[^>]*>/g, "").trim())
    .filter((line) => line !== "")
    .join("\n");
}

export function parseSrt(input: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (lines.length < 2) {
      continue;
    }
    const idx = Number.parseInt(lines[0] ?? "", 10);
    if (!Number.isInteger(idx)) {
      continue;
    }
    const times = (lines[1] ?? "").split("-->");
    if (times.length !== 2) {
      continue;
    }
    const startMatch = (times[0] ?? "").trim().match(TIMESTAMP);
    const endMatch = (times[1] ?? "").trim().match(TIMESTAMP);
    if (!startMatch || !endMatch) {
      continue;
    }
    const text = cleanText(lines.slice(2).join("\n"));
    if (!text) {
      continue;
    }
    cues.push({
      idx,
      startSeconds: toSeconds(startMatch),
      endSeconds: toSeconds(endMatch),
      text,
    });
  }
  return cues;
}
