import { describe, expect, it } from "vitest";
import app from "./index";

describe("GET /api/health", () => {
  it("reports the service is up", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "quotefinder" });
  });
});
