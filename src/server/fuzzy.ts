// Fuzzy matching (§5.5): loose on wording, strict on substance.

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "so", "of", "at",
  "by", "for", "with", "about", "into", "through", "during", "to", "from",
  "in", "on", "off", "over", "under", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "must", "can", "shall",
  "i", "me", "my", "we", "us", "our", "you", "your", "he", "him", "his",
  "she", "her", "it", "its", "they", "them", "their", "this", "that",
  "these", "those", "as", "not", "no", "yes", "just", "very", "really",
  "quite", "how", "what", "when", "where", "who", "whom", "why", "there",
  "here", "out", "up", "down", "again", "once", "all", "any", "both",
  "each", "few", "more", "most", "other", "some", "such", "than", "too",
  "s", "t", "d", "m", "re", "ve", "ll",
]);

// Tiny deterministic suffix stemmer (dependency-free by design).
export function stem(word: string): string {
  const w = word;
  if (w.length > 4 && w.endsWith("ies")) {
    return `${w.slice(0, -3)}y`;
  }
  if (w.length > 4 && w.endsWith("ied")) {
    return `${w.slice(0, -3)}y`;
  }
  if (w.length > 5 && w.endsWith("ing")) {
    return w.slice(0, -3);
  }
  if (w.length > 4 && w.endsWith("ed")) {
    return w.slice(0, -2);
  }
  if (w.length > 4 && w.endsWith("es")) {
    return w.slice(0, -2);
  }
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) {
    return w.slice(0, -1);
  }
  if (w.length > 4 && w.endsWith("ly")) {
    return w.slice(0, -2);
  }
  return w;
}

// Lowercase, strip punctuation, drop stop words, stem. Returns a word set.
export function tokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .filter((w) => !STOP_WORDS.has(w))
    .map(stem)
    .filter((w) => w.length > 0);
  return [...new Set(words)];
}

// Bounded edit distance: true when distance(a, b) <= max.
export function close(a: string, b: string, max = 1): boolean {
  if (a === b) {
    return true;
  }
  if (Math.abs(a.length - b.length) > max) {
    return false;
  }
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const best = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr.push(best);
      if (best < rowMin) {
        rowMin = best;
      }
    }
    if (rowMin > max) {
      return false;
    }
    prev = curr;
  }
  return (prev[b.length] ?? 0) <= max;
}

export function weight(word: string): number {
  if (word.length >= 7) {
    return 1.6;
  }
  if (word.length >= 5) {
    return 1.25;
  }
  return 1;
}

export interface OverlapResult {
  score: number;
  matchedWords: string[];
}

// Weighted overlap of word sets: rare words count more, near-misses count
// at 80%, and remembered word order adds up to +0.12. Capped at 1.
export function analyzeOverlap(needle: string, haystack: string): OverlapResult {
  const needleTokens = tokens(needle);
  const hayTokens = tokens(haystack);
  const haySet = new Set(hayTokens);
  if (needleTokens.length === 0) {
    return { score: 0, matchedWords: [] };
  }
  const total = needleTokens.reduce((sum, t) => sum + weight(t), 0);
  let matched = 0;
  const matchedWords: string[] = [];
  const positions: number[] = [];
  for (const n of needleTokens) {
    if (haySet.has(n)) {
      matched += weight(n);
      matchedWords.push(n);
      positions.push(hayTokens.indexOf(n));
      continue;
    }
    const nearIndex = hayTokens.findIndex((h) => close(n, h, 1));
    if (nearIndex >= 0) {
      matched += 0.8 * weight(n);
      matchedWords.push(n);
      positions.push(nearIndex);
    }
  }
  let bonus = 0;
  if (positions.length >= 2) {
    let ordered = 0;
    let pairs = 0;
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        pairs += 1;
        if ((positions[i] ?? 0) < (positions[j] ?? 0)) {
          ordered += 1;
        }
      }
    }
    bonus = pairs > 0 ? (ordered / pairs) * 0.12 : 0;
  }
  return { score: Math.min(1, matched / total + bonus), matchedWords };
}

export function overlapScore(needle: string, haystack: string): number {
  return analyzeOverlap(needle, haystack).score;
}

// Guard: fraction of distinctive (6+ char) needle words present in the
// haystack, counting near-misses. Returns 1 when the needle has no
// distinctive words — short quotes carry no substance to guard.
export function keyCoverage(needle: string, haystack: string): number {
  const distinctive = tokens(needle).filter((w) => w.length >= 6);
  if (distinctive.length === 0) {
    return 1;
  }
  const hayTokens = tokens(haystack);
  const haySet = new Set(hayTokens);
  let found = 0;
  for (const d of distinctive) {
    if (haySet.has(d) || hayTokens.some((h) => close(d, h, 1))) {
      found += 1;
    }
  }
  return found / distinctive.length;
}
