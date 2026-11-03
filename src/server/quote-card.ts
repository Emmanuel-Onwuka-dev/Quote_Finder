// §7.7 Muse Image quote card: POST endpoint. Accepts the found
// sentence, asks the Meta image API for a text-free background, and
// returns an image URL. The app draws the exact sentence on top in
// the browser. The result card hides itself on any failure, so this
// is single-attempt by design: no retries.

import { z } from "zod";
import type { Context } from "hono";
import { createDailyCallBudget } from "./daily-budget";
import { logError } from "./log";

export interface QuoteCardDeps {
  modelApiKey: string;
  metaBaseUrl: string;
  imageModel: string;
  fetchFn?: typeof fetch;
  /** Injected clock for the daily budget (tests pin the UTC date). */
  now?: () => Date;
}

/** Longest sentence accepted: only its mood reaches the image model. */
export const QUOTE_CARD_MAX_SENTENCE = 500;
/** §7.7 daily call budget: at most this many paid Meta calls per UTC day. */
export const QUOTE_CARD_DAILY_CALL_LIMIT = 500;
/** Landscape card, sized for link unfurls. */
const QUOTE_CARD_SIZE = "1792x1024";

const QuoteCardBodySchema = z.object({
  sentence: z.string().trim().min(1).max(QUOTE_CARD_MAX_SENTENCE),
});

const GenerationsSchema = z.object({
  data: z
    .array(
      z.object({
        url: z
          .string()
          .nullish()
          .transform((value) => value ?? undefined),
        b64_json: z
          .string()
          .nullish()
          .transform((value) => value ?? undefined),
      }),
    )
    .min(1),
});

/** Fallback moods for sentences that match no keyword. Every entry
 * has a scene list below, so any pick renders. */
const FALLBACK_MOODS = [
  "tense and dramatic",
  "quiet and melancholy",
  "warm and joyful",
  "hopeful and serene",
  "calm and thoughtful",
];

/** Background mood from sentence keywords, checked in order. Whole
 * words only, so "running" never matches "run". Sentences without
 * a keyword get a fallback mood picked by a stable hash of the
 * sentence, so the same sentence always gets the same mood and
 * different sentences usually differ. Pure and total. */
export function moodFor(sentence: string): string {
  const moods: Array<{ mood: string; keywords: string[] }> = [
    {
      mood: "tense and dramatic",
      keywords: [
        "fight",
        "run",
        "running",
        "danger",
        "afraid",
        "fear",
        "war",
        "chase",
        "escape",
        "storm",
        "angry",
        "shout",
        "hurry",
      ],
    },
    {
      mood: "quiet and melancholy",
      keywords: [
        "miss",
        "missed",
        "gone",
        "lost",
        "alone",
        "goodbye",
        "tears",
        "cry",
        "crying",
        "grief",
        "sorry",
        "empty",
        "rain",
        "night",
      ],
    },
    {
      mood: "warm and joyful",
      keywords: [
        "love",
        "happy",
        "joy",
        "laugh",
        "laughing",
        "smile",
        "dance",
        "celebrate",
        "friend",
        "friends",
        "sun",
        "summer",
        "home",
      ],
    },
    {
      mood: "hopeful and serene",
      keywords: [
        "hope",
        "pray",
        "prayer",
        "grace",
        "faith",
        "light",
        "peace",
        "dawn",
        "believe",
        "morning",
        "calm",
        "gentle",
      ],
    },
  ];
  for (const { mood, keywords } of moods) {
    for (const keyword of keywords) {
      if (new RegExp(`\\b${keyword}\\b`).test(sentence.toLowerCase())) {
        return mood;
      }
    }
  }
  return (
    FALLBACK_MOODS[hash32(sentence) % FALLBACK_MOODS.length] ??
    "calm and thoughtful"
  );
}

/** Fixed background scenes per mood: quiet landscapes and still
 * scenes with no people, no text, and no symbols. */
const SCENES: Record<string, string[]> = {
  "tense and dramatic": [
    "a storm-darkened ridgeline with lightning far off",
    "black waves breaking against jagged rocks",
    "a wind-torn forest under racing clouds",
    "a narrow canyon with a river rushing through it",
    "dark dunes shifting under a burning sky",
  ],
  "quiet and melancholy": [
    "a rain-streaked window at dusk",
    "an empty shoreline under grey clouds",
    "a single lamp in a dark field",
    "a misty lake with bare trees on its banks",
    "a quiet moor fading into evening fog",
  ],
  "warm and joyful": [
    "a sunlit meadow with wildflowers in bloom",
    "a golden wheat field under a bright blue sky",
    "a village square strung with paper lanterns",
    "an orchard heavy with ripe fruit at noon",
    "a calm cove with gentle surf at midday",
  ],
  "hopeful and serene": [
    "a sunrise over calm mountain lakes",
    "a pale dawn sky above rolling green hills",
    "a still pond reflecting soft morning light",
    "a lighthouse beam sweeping a quiet cove at dawn",
    "snow peaks glowing pink above a silent valley",
  ],
  "calm and thoughtful": [
    "a stone path winding through ancient woods",
    "a slow river bending past willow trees",
    "a courtyard garden with a mossy stone bench",
    "soft clouds drifting over open farmland",
    "a cabin window glowing in deep pine woods",
  ],
};

/** FNV-1a 32-bit hash: stable across runs, no randomness. */
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const FALLBACK_SCENE = "soft clouds drifting over open farmland";

/** Pick the background scene for a sentence from its mood's fixed
 * list, using a stable hash of the sentence. The same sentence and
 * mood always return the same scene. Unknown moods fall back to the
 * calm list. Pure: no randomness, no clock. */
export function sceneFor(sentence: string, mood: string): string {
  const scenes = SCENES[mood] ?? SCENES["calm and thoughtful"] ?? [];
  if (scenes.length === 0) {
    return FALLBACK_SCENE;
  }
  return scenes[hash32(sentence) % scenes.length] ?? FALLBACK_SCENE;
}

function cardPrompt(sentence: string): string {
  const mood = moodFor(sentence);
  const scene = sceneFor(sentence, mood);
  return (
    "An atmospheric background of " +
    `${scene}, with soft light and texture that feels ${mood}. ` +
    "No text, no letters, no words, no numbers, no symbols, no people, " +
    "no faces. Landscape composition with calm open space in the centre."
  );
}

export function createQuoteCardHandler(deps: QuoteCardDeps) {
  const fetchFn = deps.fetchFn ?? fetch;
  const clock = deps.now ?? (() => new Date());
  const budget = createDailyCallBudget(QUOTE_CARD_DAILY_CALL_LIMIT, clock);
  return async (c: Context): Promise<Response> => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ message: "request body must be JSON" }, 400);
    }
    const parsed = QuoteCardBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { message: "a non-empty sentence up to 500 characters is required" },
        400,
      );
    }
    if (!deps.modelApiKey) {
      return c.json({ message: "Missing server env MODEL_API_KEY." }, 500);
    }
    if (!budget.take()) {
      return c.json({ message: "Share cards are busy today." }, 429);
    }
    let res: Response;
    try {
      res = await fetchFn(`${deps.metaBaseUrl}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.modelApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: deps.imageModel,
          prompt: cardPrompt(parsed.data.sentence),
          size: QUOTE_CARD_SIZE,
          n: 1,
        }),
      });
    } catch (error) {
      logError("quote card", error);
      return c.json({ message: "quote card request failed" }, 502);
    }
    if (!res.ok) {
      return c.json({ message: `quote card failed (${res.status})` }, 502);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch (error) {
      logError("quote card", error, { status: res.status });
      return c.json({ message: "quote card returned no image" }, 502);
    }
    const images = GenerationsSchema.safeParse(data);
    if (!images.success) {
      return c.json({ message: "quote card returned no image" }, 502);
    }
    const first = images.data.data[0];
    const imageUrl =
      first.url || (first.b64_json ? `data:image/png;base64,${first.b64_json}` : "");
    if (!imageUrl) {
      return c.json({ message: "quote card returned no image" }, 502);
    }
    return c.json({ imageUrl });
  };
}
