// Shared daily call budget for paid Meta calls: one counter per
// handler, keyed by UTC date. The counter is kept in memory: it
// resets on server restart and is per process, so this is a cost
// guard, not a security control. Unit tested in daily-budget.test.ts.

export interface DailyCallBudget {
  /** True (and counted) while calls remain under the limit. */
  take: () => boolean;
}

/** Budget of `limit` paid calls per UTC day, with an injected clock
 * so tests can pin the date. Resets the count when the UTC date
 * rolls over; returns false once the limit is reached. */
export function createDailyCallBudget(
  limit: number,
  clock: () => Date,
): DailyCallBudget {
  const budget = { day: "", count: 0 };
  return {
    take(): boolean {
      const day = clock().toISOString().slice(0, 10);
      if (budget.day !== day) {
        budget.day = day;
        budget.count = 0;
      }
      if (budget.count >= limit) {
        return false;
      }
      budget.count += 1;
      return true;
    },
  };
}
