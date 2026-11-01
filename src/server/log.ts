// Server-side error log: when the app quietly falls back, the real error
// must reach the server console. Callers keep their fallbacks exactly as
// they are; this only prints one line per failure. It never logs headers,
// request bodies, keys, or URL query strings.

export type LogContextValue = string | number | boolean | undefined;

/** Context keys that name secrets, matched case-insensitively. */
const SECRET_KEY = /(api[_-]?key|token|secret|passwd|password|authorization|cookie|session|credential)/i;
/** Values that look like credentials: bearer tokens or long hex runs. */
const TOKEN_VALUE = /(^bearer\s+\S+)|([0-9a-f]{32,})/i;
/** Query-string parameters: the query string is never logged. */
const QUERY_PARAM = /[?&][^=\s&]+=[^&\s]*/g;

const REDACTED = "[redacted]";

function scrubText(text: string): string {
  return text.replace(QUERY_PARAM, REDACTED).replace(TOKEN_VALUE, REDACTED);
}

function scrubContext(
  context: Record<string, LogContextValue>,
): Record<string, LogContextValue> {
  const clean: Record<string, LogContextValue> = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value !== "string") {
      clean[key] = value;
    } else if (SECRET_KEY.test(key) || TOKEN_VALUE.test(value)) {
      clean[key] = REDACTED;
    } else {
      clean[key] = scrubText(value);
    }
  }
  return clean;
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
}
