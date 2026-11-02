import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  createQuoteCardHandler,
  moodFor,
  QUOTE_CARD_DAILY_CALL_LIMIT,
  QUOTE_CARD_MAX_SENTENCE,
  type QuoteCardDeps,
} from "./quote-card";

type ScriptStep = { status: number; body?: unknown } | "throw";

function setup(
  script: ScriptStep[] = [
    { status: 200, body: { data: [{ url: "https://img.test/card.png" }] } },
  ],
  overrides: Partial<QuoteCardDeps> = {},
): {
  app: Hono;
  seen: Array<{ url: string; init: RequestInit }>;
} {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let calls = 0;
  const fetchFn = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const step = script[Math.min(calls, script.length - 1)] as ScriptStep;
    calls += 1;
    seen.push({ url: String(url), init: init ?? {} });
    if (step === "throw") {
      throw new Error("boom");
    }
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.body,
    } as Response;
  }) as unknown as typeof fetch;
  const app = new Hono();
  app.post(
    "/api/quote-card",
    createQuoteCardHandler({
      modelApiKey: "meta-key",
      metaBaseUrl: "https://meta.test/v1",
      imageModel: "test-image",
      fetchFn,
      ...overrides,
    }),
  );
  return { app, seen };
}

async function postCard(app: Hono, body: unknown): Promise<Response> {
  return app.request("/api/quote-card", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/quote-card", () => {
  it("forwards the mood and returns the image URL", async () => {
    const { app, seen } = setup();
    const res = await postCard(app, { sentence: "never give up" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      imageUrl: "https://img.test/card.png",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://meta.test/v1/images/generations");
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.headers).toEqual({
      Authorization: "Bearer meta-key",
      "Content-Type": "application/json",
    });
    const forwarded = JSON.parse(String(seen[0]?.init.body)) as {
      model: string;
      prompt: string;
      size: string;
      n: number;
    };
    expect(forwarded.model).toBe("test-image");
    expect(forwarded.prompt).toContain("calm and thoughtful");
    expect(forwarded.prompt).not.toContain("never give up");
    expect(forwarded.size).toBe("1792x1024");
    expect(forwarded.n).toBe(1);
  });

  it("asks for a text-free background with the sentence as a mood hint", async () => {
    const { app, seen } = setup();
    const res = await postCard(app, { sentence: "never give up" });
    expect(res.status).toBe(200);
    const forwarded = JSON.parse(String(seen[0]?.init.body)) as {
      prompt: string;
    };
    expect(forwarded.prompt).toContain("No text");
    expect(forwarded.prompt).toContain("calm and thoughtful");
    expect(forwarded.prompt).not.toContain("never give up");
    expect(forwarded.prompt).not.toContain("Design an elegant");
    expect(forwarded.prompt).not.toContain("Display this exact text");
  });

  it("sends the mood word for the sentence, never the sentence", async () => {
    const { app, seen } = setup();
    const res = await postCard(app, { sentence: "we danced with joy" });
    expect(res.status).toBe(200);
    const forwarded = JSON.parse(String(seen[0]?.init.body)) as {
      prompt: string;
    };
    expect(forwarded.prompt).toContain("warm and joyful");
    expect(forwarded.prompt).not.toContain("we danced with joy");
  });

  it("builds a data URL from b64_json", async () => {
    const { app } = setup([
      { status: 200, body: { data: [{ b64_json: "aGVsbG8=" }] } },
    ]);
    const res = await postCard(app, { sentence: "never give up" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      imageUrl: "data:image/png;base64,aGVsbG8=",
    });
  });

  it("accepts a null url when b64_json is present", async () => {
    const { app } = setup([
      { status: 200, body: { data: [{ url: null, b64_json: "aGVsbG8=" }] } },
    ]);
    const res = await postCard(app, { sentence: "never give up" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      imageUrl: "data:image/png;base64,aGVsbG8=",
    });
  });

  it("rejects invalid bodies with a 400", async () => {
    const { app, seen } = setup();
    expect((await postCard(app, "not json{")).status).toBe(400);
    expect((await postCard(app, {})).status).toBe(400);
    expect((await postCard(app, { sentence: "  " })).status).toBe(400);
    expect(
      (
        await postCard(app, {
          sentence: "x".repeat(QUOTE_CARD_MAX_SENTENCE + 1),
        })
      ).status,
    ).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("returns 500 without a key", async () => {
    const { app, seen } = setup(
      [{ status: 200, body: { data: [{ url: "https://img.test/x.png" }] } }],
      { modelApiKey: "" },
    );
    const res = await postCard(app, { sentence: "never give up" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      message: "Missing server env MODEL_API_KEY.",
    });
    expect(seen).toHaveLength(0);
  });

  it("returns 502 on upstream failure", async () => {
    const { app } = setup([{ status: 503 }]);
    const res = await postCard(app, { sentence: "never give up" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      message: "quote card failed (503)",
    });
    const { app: throwing } = setup(["throw"]);
    const res2 = await postCard(throwing, { sentence: "never give up" });
    expect(res2.status).toBe(502);
    expect(await res2.json()).toEqual({
      message: "quote card request failed",
    });
  });

  it("returns 502 when no image comes back", async () => {
    const bodies: unknown[] = [
      {},
      { data: [] },
      { data: [{}] },
      { data: [{ url: "", b64_json: "" }] },
    ];
    for (const body of bodies) {
      const { app } = setup([{ status: 200, body }]);
      const res = await postCard(app, { sentence: "never give up" });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        message: "quote card returned no image",
      });
    }
  });
});

describe("moodFor", () => {
  it("returns the first mood whose keywords match", () => {
    expect(moodFor("run from the danger")).toBe("tense and dramatic");
    expect(moodFor("I miss you, goodbye")).toBe("quiet and melancholy");
    expect(moodFor("we laughed with joy")).toBe("warm and joyful");
    expect(moodFor("hope at dawn")).toBe("hopeful and serene");
    expect(moodFor("never give up")).toBe("calm and thoughtful");
  });

  it("matches whole words only", () => {
    expect(moodFor("running wild")).toBe("calm and thoughtful");
    expect(moodFor("RUN FOR YOUR LIFE")).toBe("tense and dramatic");
  });
});

describe("daily call budget", () => {
  it("refuses the call just over the cap without calling Meta", async () => {
    const { app, seen } = setup();
    for (let i = 0; i < QUOTE_CARD_DAILY_CALL_LIMIT; i += 1) {
      expect((await postCard(app, { sentence: "never give up" })).status).toBe(
        200,
      );
    }
    expect(seen).toHaveLength(QUOTE_CARD_DAILY_CALL_LIMIT);
    const refused = await postCard(app, { sentence: "never give up" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      message: "Share cards are busy today.",
    });
    expect(seen).toHaveLength(QUOTE_CARD_DAILY_CALL_LIMIT);
  }, 60000);

  it("resets the budget on the next UTC day", async () => {
    let now = new Date("2026-10-30T12:00:00Z");
    const { app, seen } = setup(
      [{ status: 200, body: { data: [{ url: "https://img.test/card.png" }] } }],
      { now: () => now },
    );
    for (let i = 0; i < QUOTE_CARD_DAILY_CALL_LIMIT; i += 1) {
      expect((await postCard(app, { sentence: "never give up" })).status).toBe(
        200,
      );
    }
    expect((await postCard(app, { sentence: "never give up" })).status).toBe(
      429,
    );
    now = new Date("2026-10-31T00:00:01Z");
    const res = await postCard(app, { sentence: "never give up" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      imageUrl: "https://img.test/card.png",
    });
    expect(seen).toHaveLength(QUOTE_CARD_DAILY_CALL_LIMIT + 1);
  }, 60000);
});
