// §7.7 Muse Image quote card: POST endpoint. Accepts the found
// sentence, asks the Meta image API for a shareable card, and returns
// an image URL. The result card hides itself on any failure, so this
// is single-attempt by design: no retries.

import { z } from "zod";
import type { Context } from "hono";

export interface QuoteCardDeps {
  modelApiKey: string;
  metaBaseUrl: string;
  imageModel: string;
  fetchFn?: typeof fetch;
  /** Injected clock for the daily budget (tests pin the UTC date). */
  now?: () => Date;
}

/** Longest sentence accepted: image prompts carry the exact words. */
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
        url: z.string().optional(),
        b64_json: z.string().optional(),
      }),
    )
    .min(1),
});

function cardPrompt(sentence: string): string {
  return [
    "Design an elegant minimal shareable quote card.",
    `Display this exact text prominently, word for word, with no other words: "${sentence}"`,
    "Clean typography on a calm background.",
  ].join(" ");
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
    } catch {
      return c.json({ message: "quote card request failed" }, 502);
    }
    if (!res.ok) {
      return c.json({ message: `quote card failed (${res.status})` }, 502);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
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
