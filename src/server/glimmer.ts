// §7.7 optional second model: extra query rephrasings from a locally
// served Muse Glimmer endpoint. The local servers named in the spec
// (vLLM, SGLang, llama.cpp, ExecuTorch) all speak OpenAI-compatible
// chat completions, so this posts the same shape the Spark client
// uses, without auth. Never fatal: [] on any failure, and [] when
// no URL is configured.

import { z } from "zod";
import { logError } from "./log";

export interface GlimmerDeps {
  openModelUrl: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Model name sent to the local server (its served model name). */
  model?: string;
}

/** Fallback model name when the caller doesn't name one. */
export const GLIMMER_DEFAULT_MODEL = "glimmer";
/** Glimmer timeout: a slow local endpoint must not hold up the search. */
const GLIMMER_TIMEOUT_MS = 5000;
/** §7.7 asks Glimmer for 3 to 5 more wordings. */
const GLIMMER_VARIANTS_MAX = 5;

const GlimmerChatSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
});

// Null items become "" and are dropped by the empty-filter below,
// so one null wording no longer discards every variant.
const GlimmerVariantsSchema = z.array(
  z.string().nullish().transform((value) => value ?? ""),
);

const GLIMMER_SYSTEM = [
  "You help find a video from a half-remembered quote.",
  "The user is recalling from memory and will almost never have the exact wording.",
  "Reply with ONLY a JSON array of 3 to 5 alternative wordings of the quote, no other text.",
].join(" ");

function extractJsonArray(text: string): unknown {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) {
    throw new Error("No JSON array in Glimmer reply");
  }
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

export async function glimmerVariants(
  quote: string,
  deps: GlimmerDeps,
): Promise<string[]> {
  const base = deps.openModelUrl.trim().replace(/\/+$/, "");
  if (!base) {
    return [];
  }
  try {
    const fetchFn = deps.fetchFn ?? fetch;
    const res = await fetchFn(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: deps.model ?? GLIMMER_DEFAULT_MODEL,
        messages: [
          { role: "system", content: GLIMMER_SYSTEM },
          { role: "user", content: `Quote: ${quote}` },
        ],
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? GLIMMER_TIMEOUT_MS),
    });
    if (!res.ok) {
      return [];
    }
    const chat = GlimmerChatSchema.safeParse(await res.json());
    if (!chat.success) {
      return [];
    }
    const parsed = GlimmerVariantsSchema.safeParse(
      extractJsonArray(chat.data.choices[0].message.content),
    );
    if (!parsed.success) {
      return [];
    }
    return [
      ...new Set(parsed.data.map((v) => v.trim()).filter((v) => v.length > 0)),
    ].slice(0, GLIMMER_VARIANTS_MAX);
  } catch (error) {
    logError("Glimmer rephrasing", error);
    return [];
  }
}
