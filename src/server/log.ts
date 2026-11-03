// Server-side error log: when the app quietly falls back, the real error
// must reach the server console. Callers keep their fallbacks exactly as
// they are; this only prints one line per failure. It never logs headers,
// request bodies, keys, or URL query strings.

import { captureAlert } from "./alerts";

export type LogContextValue = string | number | boolean | undefined;

/** Context keys that name secrets, matched case-insensitively. */
const SECRET_KEY = /(api[_-]?key|token|secret|passwd|password|authorization|cookie|session|credential)/i;
/** Values that look like credentials: bearer tokens or long hex runs. */
const TOKEN_VALUE = /(^bearer\s+\S+)|([0-9a-f]{32,})/i;
/** Query-string parameters: the query string is never logged. */
const QUERY_PARAM = /[?&][^=\s&]+=[^&\s]*/g;

const REDACTED = "[redacted]";

/** Redact query strings and token-looking runs in free text. Shared
 * with the Sentry scrubber (alerts.ts) so both use the same rules. */
export function scrubText(text: string): string {
  return text.replace(QUERY_PARAM, REDACTED).replace(TOKEN_VALUE, REDACTED);
}

/** Redact one context value by its key name and shape. Shared with alerts.ts. */
export function scrubValue(
  key: string,
  value: LogContextValue,
): LogContextValue {
  if (typeof value !== "string") {
    return value;
  }
  if (SECRET_KEY.test(key) || TOKEN_VALUE.test(value)) {
    return REDACTED;
  }
  return scrubText(value);
}

function scrubContext(
  context: Record<string, LogContextValue>,
): Record<string, LogContextValue> {
  const clean: Record<string, LogContextValue> = {};
  for (const [key, value] of Object.entries(context)) {
    clean[key] = scrubValue(key, value);
  }
  return clean;
}

/** Keep only the path of an endpoint, dropping any host or query string. */
function pathOnly(endpoint: string): string {
  const noHost = endpoint.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/, "");
  const cut = noHost.search(/[?#]/);
  return cut < 0 ? noHost : noHost.slice(0, cut);
}

/** One terminal line per Meta call: model, path, status, duration.
 * Prints no host, query string, headers, body, or key. Status 0
 * means the request failed before a response. */
export function logMetaCall(
  model: string,
  endpoint: string,
  status: number,
  startedAt: number,
): void {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const result = status === 0 ? "failed" : String(status);
  console.log(`[meta] ${model} ${pathOnly(endpoint)} ${result} ${seconds}s`);
}

export function logError(
  step: string,
  error: unknown,
  context?: Record<string, LogContextValue>,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const line = `[quotefinder] ${step} failed: ${scrubText(message)}`;
  if (context === undefined) {
    console.error(line);
  } else {
    console.error(`${line} ${JSON.stringify(scrubContext(context))}`);
  }
  captureAlert(step, error, context);
}
