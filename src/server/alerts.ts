// Error alerts: every failure logError records, plus unhandled route
// errors, is sent to Sentry. Sentry stays off unless SENTRY_DSN is set,
// so tests and local runs without it send nothing.

import * as Sentry from "@sentry/node";
import { scrubText, scrubValue } from "./log";

let initialised = false;

/** Strip request/user payloads and redact text with the log.ts rules, so
 * no bodies, headers, cookies, query strings, or keys ever leave the box.
 * Breadcrumbs need the same treatment: the YouTube key and search text
 * travel in query strings, and the SDK records outgoing URLs there. */
function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  delete event.request;
  delete event.user;
  if (typeof event.message === "string") {
    event.message = scrubText(event.message);
  }
  if (event.extra) {
    for (const [key, value] of Object.entries(event.extra)) {
      if (typeof value === "string") {
        event.extra[key] = scrubValue(key, value);
      }
    }
  }
  for (const item of event.exception?.values ?? []) {
    if (typeof item.value === "string") {
      item.value = scrubText(item.value);
    }
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (typeof crumb.message === "string") {
      crumb.message = scrubText(crumb.message);
    }
    const data = crumb.data as Record<string, unknown> | undefined;
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === "string") {
          data[key] = scrubText(value);
        }
      }
    }
  }
  return event;
}

export function initAlerts(dsn: string | undefined): void {
  if (!dsn) {
    return;
  }
  // No sendDefaultPii flag: @sentry/node v11 removed the option.
  // Excluding request/user payloads is enforced by scrubEvent instead.
  Sentry.init({
    dsn,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
  });
  initialised = true;
}

export function captureAlert(
  step: string,
  error: unknown,
  context?: Record<string, string | number | boolean | undefined>,
): void {
  if (!initialised) {
    return;
  }
  Sentry.captureException(error, {
    tags: { step },
    extra: { ...context },
  });
}
