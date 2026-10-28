import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true, service: "quotefinder" }));

// In production (`vite build` output present), serve the client bundle.
if (existsSync("./dist/index.html")) {
  app.use("*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

export default app;

// Only listen when run directly (`npm run dev:server` / `npm start`), so
// tests can import the app and call it in-process with no network.
const invokedAs = (process.argv[1] ?? "").replace(/\\/g, "/");
if (invokedAs.endsWith("src/server/index.ts")) {
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port });
  // oxlint-disable-next-line no-console
  console.log(`quotefinder server listening on :${port}`);
}
