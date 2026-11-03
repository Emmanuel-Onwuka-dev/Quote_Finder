import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logError } from "../log";
import type { ArchiveStore } from "./store";
import { startPurgeSchedule } from "./purge";

vi.mock("../log", () => ({ logError: vi.fn() }));

describe("startPurgeSchedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function fakeStore(
    impl: () => number = () => 0,
  ): { store: ArchiveStore; purgeExpired: () => number } {
    const purgeExpired = vi.fn(impl);
    return {
      store: { purgeExpired } as unknown as ArchiveStore,
      purgeExpired,
    };
  }

  it("purges once at start", () => {
    const { store, purgeExpired } = fakeStore();
    const stop = startPurgeSchedule(store, 1000);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    stop();
  });

  it("purges again after the interval", () => {
    const { store, purgeExpired } = fakeStore();
    const stop = startPurgeSchedule(store, 1000);
    vi.advanceTimersByTime(1000);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(purgeExpired).toHaveBeenCalledTimes(3);
    stop();
  });

  it("logs a store error without stopping the schedule", () => {
    const { store, purgeExpired } = fakeStore(() => {
      throw new Error("boom");
    });
    const stop = startPurgeSchedule(store, 1000);
    expect(logError).toHaveBeenCalledWith(
      "scheduled purge",
      expect.any(Error),
    );
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops purging when the returned function runs", () => {
    const { store, purgeExpired } = fakeStore();
    const stop = startPurgeSchedule(store, 1000);
    stop();
    vi.advanceTimersByTime(5000);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
  });
});
