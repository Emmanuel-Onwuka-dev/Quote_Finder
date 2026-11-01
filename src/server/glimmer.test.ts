import { describe, expect, it } from "vitest";
import { GLIMMER_DEFAULT_MODEL, glimmerVariants } from "./glimmer";

function chatResponse(content: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

describe("glimmerVariants", () => {
  it("posts an OpenAI-compatible chat request without auth", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      seen.push({ url: String(url), init: init ?? {} });
      return chatResponse(JSON.stringify(["reworded quote", "another take"]));
    }) as unknown as typeof fetch;
    const variants = await glimmerVariants("half remembered line", {
      openModelUrl: "http://glimmer.test/v1/",
      fetchFn,
    });
    expect(variants).toEqual(["reworded quote", "another take"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://glimmer.test/v1/chat/completions");
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      model: GLIMMER_DEFAULT_MODEL,
      messages: [
        { role: "system", content: expect.stringContaining("JSON array") },
        { role: "user", content: "Quote: half remembered line" },
      ],
    });
  });

  it("sends the configured model name", async () => {
    let body = "";
    const fetchFn = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      body = String(init?.body ?? "");
      return chatResponse(JSON.stringify(["take one"]));
    }) as unknown as typeof fetch;
    await glimmerVariants("quote", {
      openModelUrl: "http://glimmer.test/v1",
      fetchFn,
      model: "my-glimmer-7b",
    });
    expect(JSON.parse(body).model).toBe("my-glimmer-7b");
  });

  it("returns [] without calling when no URL is configured", async () => {
    let calls = 0;
    const fetchFn = (async (): Promise<Response> => {
      calls += 1;
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    await expect(
      glimmerVariants("quote", { openModelUrl: "  ", fetchFn }),
    ).resolves.toEqual([]);
    await expect(
      glimmerVariants("quote", { openModelUrl: "", fetchFn }),
    ).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  it("trims, dedupes, and caps at 5", async () => {
    const fetchFn = (async (): Promise<Response> =>
      chatResponse(
        JSON.stringify([" b ", "b", "a", "c", "d", "e", "f", " ", ""]),
      )) as unknown as typeof fetch;
    await expect(
      glimmerVariants("quote", {
        openModelUrl: "http://glimmer.test/v1",
        fetchFn,
      }),
    ).resolves.toEqual(["b", "a", "c", "d", "e"]);
  });

  it("returns [] on error status, bad shape, or no JSON array", async () => {
    const failing = [
      { ok: false, status: 500, json: async () => ({}) },
      {
        ok: true,
        status: 200,
        json: async () => ({ choices: [] }),
      },
      {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "no brackets here" } }],
        }),
      },
    ] as unknown as Response[];
    for (const response of failing) {
      const fetchFn = (async (): Promise<Response> =>
        response) as unknown as typeof fetch;
      await expect(
        glimmerVariants("quote", {
          openModelUrl: "http://glimmer.test/v1",
          fetchFn,
        }),
      ).resolves.toEqual([]);
    }
  });

  it("returns [] when fetch throws or times out", async () => {
    const throwing = (async (): Promise<Response> => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(
      glimmerVariants("quote", {
        openModelUrl: "http://glimmer.test/v1",
        fetchFn: throwing,
      }),
    ).resolves.toEqual([]);
    const hanging = ((
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as unknown as typeof fetch;
    await expect(
      glimmerVariants("quote", {
        openModelUrl: "http://glimmer.test/v1",
        fetchFn: hanging,
        timeoutMs: 10,
      }),
    ).resolves.toEqual([]);
  });
});
