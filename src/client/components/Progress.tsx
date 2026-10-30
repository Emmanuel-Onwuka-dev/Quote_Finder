import type { ProgressUpdate } from "../hooks/useQuoteStream";
import { Magnifier } from "./Brand";

export function Progress({ events }: { events: ProgressUpdate[] }) {
  return (
    <div className="mt-4 flex gap-3">
      <Magnifier className="magnifier-pulse mt-1 h-6 w-6 shrink-0" />
      <div aria-live="polite" className="min-w-0 flex-1">
        {events.length === 0 ? (
          <p className="text-muted">Starting the search…</p>
        ) : (
          <ul className="space-y-1.5">
            {events.map((update, index) => {
              const newest = index === events.length - 1;
              return (
                <li
                  key={`${index}-${update.stage}`}
                  className="flex items-start gap-2"
                >
                  <span
                    aria-hidden="true"
                    className="mt-0.5 w-4 shrink-0 text-center"
                  >
                    {newest ? (
                      <span className="spinner" />
                    ) : (
                      <span className="text-accent">✓</span>
                    )}
                  </span>
                  <span>
                    <span className="font-medium">{update.stage}</span>
                    {update.detail && (
                      <span className="text-muted"> — {update.detail}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
