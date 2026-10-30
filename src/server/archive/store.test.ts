import Database from "better-sqlite3";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openArchiveStore, videoFreshness } from "./store";

function openMemory() {
  return openArchiveStore(":memory:");
}

function cue(idx: number, text = `line ${idx}`) {
  return { idx, startSeconds: idx, endSeconds: idx + 1, text };
}

describe("openArchiveStore", () => {
  it("saves and reads back a creator with listed off", () => {
    const store = openMemory();
    try {
      store.saveCreator({
        channelId: "UCchan1",
        channelTitle: "Test Channel",
        tokenEnc: "iv:body",
      });
      const row = store.getCreator("UCchan1");
      expect(row).toMatchObject({
        channel_id: "UCchan1",
        channel_title: "Test Channel",
        token_enc: "iv:body",
        listed: 0,
      });
      expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      store.close();
    }
  });

  it("reconnecting overwrites the title and token", () => {
    const store = openMemory();
    try {
      store.saveCreator({
        channelId: "UCchan1",
        channelTitle: "Old Title",
        tokenEnc: "iv:old",
      });
      store.saveCreator({
        channelId: "UCchan1",
        channelTitle: "New Title",
        tokenEnc: "iv:new",
      });
      expect(store.getCreator("UCchan1")).toMatchObject({
        channel_title: "New Title",
        token_enc: "iv:new",
      });
      expect(store.listCreators()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("returns undefined for an unknown channel", () => {
    const store = openMemory();
    try {
      expect(store.getCreator("UCmissing")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("deletes a channel with its videos and cues", () => {
    const store = openMemory();
    try {
      store.saveCreator({
        channelId: "UCa",
        channelTitle: "A",
        tokenEnc: "iv:a",
      });
      store.saveCreator({
        channelId: "UCb",
        channelTitle: "B",
        tokenEnc: "iv:b",
      });
      store.saveVideoWithCues({
        channelId: "UCa",
        videoId: "va",
        title: "A vid",
        publishedAt: "2026-10-01T00:00:00Z",
        trackKind: "standard",
        fetchedAt: "2026-10-30T00:00:00Z",
        cues: [cue(1)],
      });
      store.saveVideoWithCues({
        channelId: "UCb",
        videoId: "vb",
        title: "B vid",
        publishedAt: "2026-10-01T00:00:00Z",
        trackKind: "standard",
        fetchedAt: "2026-10-30T00:00:00Z",
        cues: [cue(1)],
      });
      const refreshAt = new Date("2026-10-30T12:00:00Z");
      store.recordRefreshes("UCa", ["va"], refreshAt);
      store.recordRefreshes("UCb", ["vb"], refreshAt);
      store.deleteChannel("UCa");
      expect(store.getCreator("UCa")).toBeUndefined();
      expect(store.getIndexedVideos("UCa")).toEqual([]);
      expect(store.listCreators().map((row) => row.channel_id)).toEqual([
        "UCb",
      ]);
      expect(store.getIndexedVideos("UCb")).toHaveLength(1);
      expect(store.lastChannelRefreshAt("UCa")).toBeNull();
      expect(store.lastChannelRefreshAt("UCb")).toBe(
        "2026-10-30T12:00:00.000Z",
      );
    } finally {
      store.close();
    }
  });
});

describe("daily budget", () => {
  it("spends within the cap and pauses past it", () => {
    const store = openMemory();
    try {
      expect(store.getSpent("2026-10-30")).toBe(0);
      expect(store.trySpend("2026-10-30", 5001)).toBe(false);
      expect(store.getSpent("2026-10-30")).toBe(0);
      expect(store.trySpend("2026-10-30", 4900)).toBe(true);
      expect(store.trySpend("2026-10-30", 200)).toBe(false);
      expect(store.getSpent("2026-10-30")).toBe(4900);
      expect(store.trySpend("2026-10-30", 100)).toBe(true);
      expect(store.getSpent("2026-10-30")).toBe(5000);
    } finally {
      store.close();
    }
  });

  it("tracks each day separately", () => {
    const store = openMemory();
    try {
      expect(store.trySpend("2026-10-30", 5000)).toBe(true);
      expect(store.getSpent("2026-10-31")).toBe(0);
      expect(store.trySpend("2026-10-31", 250)).toBe(true);
      expect(store.getSpent("2026-10-30")).toBe(5000);
    } finally {
      store.close();
    }
  });

  it("tracks creator and viewer budgets separately", () => {
    const store = openMemory();
    try {
      expect(store.trySpend("2026-10-30", 5000)).toBe(true);
      expect(store.trySpend("2026-10-30", 1)).toBe(false);
      expect(store.getSpent("2026-10-30", "viewer")).toBe(0);
      expect(store.trySpend("2026-10-30", 1000, "viewer")).toBe(true);
      expect(store.trySpend("2026-10-30", 1, "viewer")).toBe(false);
      expect(store.getSpent("2026-10-30")).toBe(5000);
      expect(store.getSpent("2026-10-30", "viewer")).toBe(1000);
    } finally {
      store.close();
    }
  });

  it("upgrades legacy day-only budget rows to creator rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "quotefinder-"));
    const path = join(dir, "archive.db");
    try {
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE budget (day TEXT PRIMARY KEY, spent INTEGER NOT NULL DEFAULT 0);
        INSERT INTO budget (day, spent) VALUES ('2026-10-30', 1500);
      `);
      legacy.close();
      const store = openArchiveStore(path);
      try {
        expect(store.getSpent("2026-10-30")).toBe(1500);
        expect(store.getSpent("2026-10-30", "viewer")).toBe(0);
        expect(store.trySpend("2026-10-30", 100, "viewer")).toBe(true);
      } finally {
        store.close();
      }
      // Reopening a migrated database keeps both budgets intact.
      const reopened = openArchiveStore(path);
      try {
        expect(reopened.getSpent("2026-10-30")).toBe(1500);
        expect(reopened.getSpent("2026-10-30", "viewer")).toBe(100);
      } finally {
        reopened.close();
      }
    } finally {
      unlinkSync(path);
      rmdirSync(dir);
    }
  });
});

describe("viewer refresh tracking", () => {
  it("records refreshes per channel and video", () => {
    const store = openMemory();
    const now = new Date("2026-10-30T12:00:00Z");
    try {
      expect(store.lastChannelRefreshAt("UCchan1")).toBeNull();
      store.recordRefreshes("UCchan1", ["v1", "v2"], now);
      expect(store.lastChannelRefreshAt("UCchan1")).toBe(
        "2026-10-30T12:00:00.000Z",
      );
      expect(store.lastChannelRefreshAt("UCother")).toBeNull();
      expect(
        store
          .recentlyRefreshedVideoIds("UCchan1", new Date("2026-10-29T12:00:00Z"))
          .sort(),
      ).toEqual(["v1", "v2"]);
      expect(
        store.recentlyRefreshedVideoIds("UCchan1", now),
      ).toEqual([]);
      const later = new Date("2026-10-31T12:00:00Z");
      store.recordRefreshes("UCchan1", ["v1"], later);
      expect(store.lastChannelRefreshAt("UCchan1")).toBe(
        "2026-10-31T12:00:00.000Z",
      );
      expect(
        store.recentlyRefreshedVideoIds(
          "UCchan1",
          new Date("2026-10-30T12:00:00Z"),
        ),
      ).toEqual(["v1"]);
      store.recordRefreshes("UCchan1", [], later);
      expect(store.lastChannelRefreshAt("UCchan1")).toBe(
        "2026-10-31T12:00:00.000Z",
      );
    } finally {
      store.close();
    }
  });
});

describe("videos and cues", () => {
  it("saves a video with cues and reads it back", () => {
    const store = openMemory();
    try {
      store.saveVideoWithCues({
        channelId: "UCchan1",
        videoId: "vid1",
        title: "A build",
        publishedAt: "2026-10-01T00:00:00Z",
        trackKind: "standard",
        fetchedAt: "2026-10-30T00:00:00Z",
        cues: [cue(1), cue(2)],
      });
      expect(store.getIndexedVideos("UCchan1")).toEqual([
        {
          video_id: "vid1",
          title: "A build",
          published_at: "2026-10-01T00:00:00Z",
          track_kind: "standard",
          fetched_at: "2026-10-30T00:00:00Z",
          cue_count: 2,
        },
      ]);
      expect(store.getIndexedVideos("UCmissing")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("re-indexing replaces cues and refreshes the fetch time", () => {
    const store = openMemory();
    try {
      store.saveVideoWithCues({
        channelId: "UCchan1",
        videoId: "vid1",
        title: "Old title",
        publishedAt: "",
        trackKind: "asr",
        fetchedAt: "2026-09-01T00:00:00Z",
        cues: [cue(1), cue(2), cue(3)],
      });
      store.saveVideoWithCues({
        channelId: "UCchan1",
        videoId: "vid1",
        title: "New title",
        publishedAt: "",
        trackKind: "standard",
        fetchedAt: "2026-10-30T00:00:00Z",
        cues: [cue(1)],
      });
      expect(store.getIndexedVideos("UCchan1")).toEqual([
        expect.objectContaining({
          video_id: "vid1",
          title: "New title",
          track_kind: "standard",
          fetched_at: "2026-10-30T00:00:00Z",
          cue_count: 1,
        }),
      ]);
    } finally {
      store.close();
    }
  });
});

describe("videoFreshness", () => {
  const now = new Date("2026-10-30T12:00:00Z");

  it("reports never for unknown videos", () => {
    expect(videoFreshness(undefined, now)).toBe("never");
  });

  it("reports fresh for recent videos with cues", () => {
    expect(
      videoFreshness(
        { fetched_at: "2026-10-29T00:00:00Z", cue_count: 5 },
        now,
      ),
    ).toBe("fresh");
  });

  it("reports expired for old or cueless videos", () => {
    expect(
      videoFreshness(
        { fetched_at: "2026-09-01T00:00:00Z", cue_count: 5 },
        now,
      ),
    ).toBe("expired");
    expect(
      videoFreshness(
        { fetched_at: "2026-10-29T00:00:00Z", cue_count: 0 },
        now,
      ),
    ).toBe("expired");
    // Exactly at the 30-day cutoff counts as expired.
    expect(
      videoFreshness(
        { fetched_at: "2026-09-30T12:00:00Z", cue_count: 5 },
        now,
      ),
    ).toBe("expired");
  });
});

describe("countFreshVideos", () => {
  it("counts only fresh videos with cues", () => {
    const store = openMemory();
    const now = new Date("2026-10-30T12:00:00Z");
    try {
      const base = {
        channelId: "UCchan1",
        title: "t",
        publishedAt: "",
        trackKind: "standard",
      };
      store.saveVideoWithCues({
        ...base,
        videoId: "fresh",
        fetchedAt: "2026-10-29T00:00:00Z",
        cues: [cue(1)],
      });
      store.saveVideoWithCues({
        ...base,
        videoId: "stale",
        fetchedAt: "2026-09-01T00:00:00Z",
        cues: [cue(1)],
      });
      store.saveVideoWithCues({
        ...base,
        videoId: "empty",
        fetchedAt: "2026-10-29T00:00:00Z",
        cues: [],
      });
      store.saveVideoWithCues({
        ...base,
        channelId: "UCother",
        videoId: "other",
        fetchedAt: "2026-10-29T00:00:00Z",
        cues: [cue(1)],
      });
      expect(store.countFreshVideos("UCchan1", now)).toBe(1);
      expect(store.countFreshVideos("UCother", now)).toBe(1);
      expect(store.countFreshVideos("UCmissing", now)).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("purgeExpired", () => {
  it("deletes cue text for old videos but keeps titles", () => {
    const store = openMemory();
    try {
      store.saveVideoWithCues({
        channelId: "UCchan1",
        videoId: "old",
        title: "Old",
        publishedAt: "",
        trackKind: "asr",
        fetchedAt: "2026-09-01T00:00:00Z",
        cues: [cue(1), cue(2)],
      });
      store.saveVideoWithCues({
        channelId: "UCchan1",
        videoId: "fresh",
        title: "Fresh",
        publishedAt: "",
        trackKind: "standard",
        fetchedAt: "2026-10-29T00:00:00Z",
        cues: [cue(1)],
      });
      expect(store.purgeExpired(new Date("2026-10-30T12:00:00Z"))).toBe(2);
      const byId = new Map(
        store
          .getIndexedVideos("UCchan1")
          .map((video) => [video.video_id, video]),
      );
      expect(byId.get("old")).toMatchObject({ title: "Old", cue_count: 0 });
      expect(byId.get("fresh")).toMatchObject({
        title: "Fresh",
        cue_count: 1,
      });
      expect(store.purgeExpired(new Date("2026-10-30T12:00:00Z"))).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("getMatchableVideos", () => {
  it("returns fresh videos with cues, newest first", () => {
    const store = openMemory();
    const now = new Date("2026-10-30T12:00:00Z");
    try {
      const base = {
        channelId: "UCchan1",
        fetchedAt: "2026-10-29T00:00:00Z",
        trackKind: "standard",
      };
      store.saveVideoWithCues({
        ...base,
        videoId: "older",
        title: "Older",
        publishedAt: "2026-10-01T00:00:00Z",
        cues: [cue(1, "older line")],
      });
      store.saveVideoWithCues({
        ...base,
        videoId: "newer",
        title: "Newer",
        publishedAt: "2026-10-20T00:00:00Z",
        cues: [cue(2, "second"), cue(1, "first")],
      });
      store.saveVideoWithCues({
        ...base,
        videoId: "stale",
        title: "Stale",
        publishedAt: "2026-10-25T00:00:00Z",
        fetchedAt: "2026-09-01T00:00:00Z",
        cues: [cue(1)],
      });
      store.saveVideoWithCues({
        ...base,
        videoId: "empty",
        title: "Empty",
        publishedAt: "2026-10-26T00:00:00Z",
        cues: [],
      });
      store.saveVideoWithCues({
        ...base,
        channelId: "UCother",
        videoId: "theirs",
        title: "Theirs",
        publishedAt: "2026-10-27T00:00:00Z",
        cues: [cue(1)],
      });
      expect(store.getMatchableVideos("UCchan1", now)).toEqual([
        {
          video_id: "newer",
          title: "Newer",
          published_at: "2026-10-20T00:00:00Z",
          track_kind: "standard",
          cues: [
            {
              idx: 1,
              startSeconds: 1,
              endSeconds: 2,
              text: "first",
            },
            {
              idx: 2,
              startSeconds: 2,
              endSeconds: 3,
              text: "second",
            },
          ],
        },
        {
          video_id: "older",
          title: "Older",
          published_at: "2026-10-01T00:00:00Z",
          track_kind: "standard",
          cues: [
            {
              idx: 1,
              startSeconds: 1,
              endSeconds: 2,
              text: "older line",
            },
          ],
        },
      ]);
      expect(store.getMatchableVideos("UCmissing", now)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("getStaleAsrVideos", () => {
  it("returns expired asr videos only, newest first", () => {
    const store = openMemory();
    const now = new Date("2026-10-30T12:00:00Z");
    try {
      const base = { channelId: "UCchan1", title: "t", publishedAt: "" };
      store.saveVideoWithCues({
        ...base,
        videoId: "stale-asr",
        trackKind: "asr",
        fetchedAt: "2026-09-01T00:00:00Z",
        cues: [],
      });
      store.saveVideoWithCues({
        ...base,
        videoId: "stale-standard",
        trackKind: "standard",
        fetchedAt: "2026-09-01T00:00:00Z",
        cues: [],
      });
      store.saveVideoWithCues({
        ...base,
        videoId: "fresh-asr",
        title: "Fresh",
        publishedAt: "2026-10-20T00:00:00Z",
        trackKind: "asr",
        fetchedAt: "2026-10-29T00:00:00Z",
        cues: [cue(1)],
      });
      expect(store.getStaleAsrVideos("UCchan1", now)).toEqual([
        {
          video_id: "stale-asr",
          title: "t",
          published_at: "",
          track_kind: "asr",
        },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("listed creators", () => {
  it("lists only channels the creator opted in", () => {
    const store = openMemory();
    try {
      store.saveCreator({
        channelId: "UCchan1",
        channelTitle: "Listed",
        tokenEnc: "iv:one",
      });
      store.saveCreator({
        channelId: "UCchan2",
        channelTitle: "Private",
        tokenEnc: "iv:two",
      });
      expect(store.listListedCreators()).toEqual([]);
      store.setListed("UCchan1", true);
      expect(store.getCreator("UCchan1")).toMatchObject({ listed: 1 });
      expect(store.listListedCreators()).toEqual([
        { channel_id: "UCchan1", channel_title: "Listed" },
      ]);
      store.setListed("UCchan1", false);
      expect(store.listListedCreators()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("reconnecting preserves the listing choice", () => {
    const store = openMemory();
    try {
      store.saveCreator({
        channelId: "UCchan1",
        channelTitle: "Test Channel",
        tokenEnc: "iv:old",
      });
      store.setListed("UCchan1", true);
      store.saveCreator({
        channelId: "UCchan1",
        channelTitle: "Renamed",
        tokenEnc: "iv:new",
      });
      expect(store.getCreator("UCchan1")).toMatchObject({
        channel_title: "Renamed",
        listed: 1,
      });
    } finally {
      store.close();
    }
  });
});
