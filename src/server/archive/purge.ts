// Daily cleanup (§13A.4): purge expired caption text on a schedule,
// so deletion never depends on someone using the archive.
import { logError } from "../log";
import type { ArchiveStore } from "./store";

/** Run store.purgeExpired(now()) once right away and then every
 * intervalMs. Each run is guarded: errors go to logError and never
 * stop the schedule. The timer is unref'd so it never keeps the
 * process alive. Returns a stop function that clears the timer. */
export function startPurgeSchedule(
  store: ArchiveStore,
  intervalMs: number,
  now: () => Date = () => new Date(),
): () => void {
  const run = () => {
    try {
      store.purgeExpired(now());
    } catch (error) {
      logError("scheduled purge", error);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
