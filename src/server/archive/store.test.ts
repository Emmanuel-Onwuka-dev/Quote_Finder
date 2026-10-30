import { describe, expect, it } from "vitest";
import { openArchiveStore } from "./store";

function openMemory() {
  return openArchiveStore(":memory:");
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

  it("lists and deletes creators", () => {
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
      expect(store.listCreators().map((row) => row.channel_id)).toEqual([
        "UCa",
        "UCb",
      ]);
      store.deleteCreator("UCa");
      expect(store.getCreator("UCa")).toBeUndefined();
      expect(store.listCreators().map((row) => row.channel_id)).toEqual([
        "UCb",
      ]);
    } finally {
      store.close();
    }
  });
});
