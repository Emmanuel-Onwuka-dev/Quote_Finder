// §8.1 quote-stream: POST endpoint. Validates the body with zod, runs
// locateQuote, and streams progress + result as SSE. The P3b chat UI
// consumes this with fetch + a ReadableStream reader.

import type { Context } from "hono";
import { z } from "zod";
import { SEARCH_BUDGET_UNITS, todayKey } from "./archive/store";
import { locateQuote, type LocateDeps, type LocateInput } from "./quote-finder";

export const QuoteStreamBodySchema = z.object({
  quote: z.string().trim().min(1, "quote must not be empty"),
  creator: z.string().default(""),
  scene: z.string().default(""),
  sinceDays: z.number().int().min(0).max(3650).default(0),
});

export type QuoteStreamBody = z.infer<typeof QuoteStreamBodySchema>;

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
} as const;

export function formatSseEvent(event: string, data: unknown): string {
  // JSON.stringify never emits a raw newline, so one data line is safe.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function quoteStream(
  input: LocateInput,
  deps: LocateDeps,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (!closed) {
          controller.enqueue(encoder.encode(formatSseEvent(event, data)));
        }
      };
      try {
        const result = await locateQuote(input, {
          ...deps,
          onProgress: (stage, detail) =>
            send("progress", { stage, detail }),
        });
        send("result", result);
      } catch (error) {
        send("error", {
          message:
            error instanceof Error ? error.message : "quote search failed",
        });
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      // Client disconnected: stop enqueueing; the locate run finishes
      // quietly in the background.
      closed = true;
    },
  });
}

// Deps default to the live services (env keys + global fetch). Tests pass
// mocks through and mount the handler on their own Hono app.
export function createQuoteStreamHandler(deps: LocateDeps = {}) {
  return async (c: Context): Promise<Response> => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ message: "request body must be JSON" }, 400);
    }
    const parsed = QuoteStreamBodySchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return c.json({ message: first?.message ?? "invalid request body" }, 400);
    }
    const quotaStore = deps.archiveStore;
    const searchQuota = quotaStore
      ? { store: quotaStore, day: todayKey() }
      : undefined;
    const quotaSpent = searchQuota
      ? searchQuota.store.getSpent(searchQuota.day, "search") >=
        SEARCH_BUDGET_UNITS
      : false;
    return new Response(
      quoteStream(parsed.data, {
        ...deps,
        skipEngine: quotaSpent,
        searchQuota,
      }),
      {
        headers: SSE_HEADERS,
      },
    );
  };
}
