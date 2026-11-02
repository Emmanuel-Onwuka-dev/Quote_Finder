// §7.7 Muse Image quote card: POST endpoint. Accepts the found
// sentence, asks the Meta image API for a text-free background, and
// returns an image URL. The app draws the exact sentence on top in
// the browser. The result card hides itself on any failure, so this
// is single-attempt by design: no retries.

import { z } from "zod";
import type { Context } from "hono";
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

/** Background mood from sentence keywords, checked in order. Whole
 * words only, so "running" never matches "run". Pure and total: any
 * sentence without a keyword gets the calm default. */
export function moodFor(sentence: string): string {
  const moods: Array<{ mood: string; keywords: string[] }> = [
    {
      mood: "tense and dramatic",
      keywords: [
        "fight",
        "run",
        "danger",
        "afraid",
        "fear",
        "war",
        "chase",
        "escape",
      ],
    },
    {
      mood: "quiet and melancholy",
      keywords: [
        "miss",
        "gone",
        "lost",
        "alone",
        "goodbye",
        "tears",
        "cry",
        "grief",
        "sorry",
      ],
    },
    {
      mood: "warm and joyful",
      keywords: [
        "love",
        "happy",
        "joy",
        "laugh",
        "smile",
        "dance",
        "celebrate",
        "friend",
      ],
    },
    {
      mood: "hopeful and serene",
      keywords: [
        "hope",
        "pray",
        "grace",
        "faith",
        "light",
        "peace",
        "dawn",
        "believe",
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
  return "calm and thoughtful";
}

function cardPrompt(sentence: string): string {
  return (
    "An abstract, atmospheric background with soft light and texture " +
    `that feels ${moodFor(sentence)}. ` +
    "No text, no letters, no words, no numbers, no symbols, no people, " +
    "no faces. Landscape composition with calm open space in the centre."
  );
}

export function createQuoteCardHandler(deps: QuoteCardDeps) {
  const fetchFn = deps.fetchFn ?? fetch;
  const clock = deps.now ?? (() => new Date());
  // Daily call counter, keyed by UTC date. Kept in memory: it resets on
  // server restart and is per process, so this is a cost guard, not a
  // security control.
  const budget = { day: "", count: 0 };
  // True (and counted) when a Meta call may proceed; resets the count
  // when the UTC date rolls over.
  const takeBudget = (): boolean => {
    const day = clock().toISOString().slice(0, 10);
    if (budget.day !== day) {
      budget.day = day;
      budget.count = 0;
    }
    if (budget.count >= QUOTE_CARD_DAILY_CALL_LIMIT) {
      return false;
    }
    budget.count += 1;
    return true;
  };
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
    if (!takeBudget()) {
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
