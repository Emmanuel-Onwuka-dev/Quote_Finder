// Creator archive storage (SQLite via better-sqlite3). Holds connected
// creators and their encrypted refresh tokens, indexed videos with caption
// cues, and the daily API budget counter. The database file stays out of
// git (see .gitignore).

import Database from "better-sqlite3";
import type { CaptionCue } from "./srt";

export interface CreatorRow {
  channel_id: string;
  channel_title: string;
  token_enc: string;
  /** §7.5 "List my archive" — viewer search scope. Default off. */
  listed: number;
  created_at: string;
}

export interface StoredVideo {
  video_id: string;
  title: string;
  published_at: string;
  track_kind: string;
  fetched_at: string;
  cue_count: number;
}

export interface MatchableVideo {
  video_id: string;
  title: string;
  published_at: string;
  track_kind: string;
  cues: CaptionCue[];
}

export interface StaleVideo {
  video_id: string;
  title: string;
  published_at: string;
  track_kind: string;
}

export interface ListedCreator {
  channel_id: string;
  channel_title: string;
}

export type VideoFreshness = "fresh" | "expired" | "never";

export interface ArchiveStore {
  saveCreator(row: {
    channelId: string;
    channelTitle: string;
    tokenEnc: string;
  }): void;
  getCreator(channelId: string): CreatorRow | undefined;
  listCreators(): CreatorRow[];
  deleteChannel(channelId: string): void;
  getSpent(day: string): number;
  trySpend(day: string, units: number, cap?: number): boolean;
  saveVideoWithCues(args: {
    channelId: string;
    videoId: string;
    title: string;
    publishedAt: string;
    trackKind: string;
    fetchedAt: string;
    cues: CaptionCue[];
  }): void;
  getIndexedVideos(channelId: string): StoredVideo[];
  countFreshVideos(channelId: string, now: Date): number;
  purgeExpired(now: Date): number;
  /** Fresh videos with their cues, newest first, for matching. */
  getMatchableVideos(channelId: string, now: Date): MatchableVideo[];
  /** Expired `asr` videos, newest first, for on-miss refresh (§7.4). */
  getStaleAsrVideos(channelId: string, now: Date): StaleVideo[];
  /** §7.5 "List my archive" — viewer search scope. Default off. */
  setListed(channelId: string, listed: boolean): void;
  listListedCreators(): ListedCreator[];
  close(): void;
}

/** §4.3 daily indexing budget: 5,000 units, about 20 videos. */
export const DAILY_BUDGET_UNITS = 5000;

/** §4.3 caption retention: cue text is purged after 30 days. */
export const ARCHIVE_FRESH_DAYS = 30;

/** UTC calendar day key (`YYYY-MM-DD`) for the budget counter. */
export function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function freshnessCutoffMs(now: Date): number {
  return now.getTime() - ARCHIVE_FRESH_DAYS * 24 * 60 * 60 * 1000;
}

function freshnessCutoff(now: Date): string {
  return new Date(freshnessCutoffMs(now)).toISOString();
}

export function videoFreshness(
  row: { fetched_at: string; cue_count: number } | undefined,
  now: Date,
): VideoFreshness {
  if (!row) {
    return "never";
  }
  // Compare as time, not text: "…00Z" sorts after "…00.000Z", which
  // would wrongly call the cutoff second fresh.
  if (row.cue_count > 0 && Date.parse(row.fetched_at) > freshnessCutoffMs(now)) {
    return "fresh";
  }
  return "expired";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creators (
  channel_id TEXT PRIMARY KEY,
  channel_title TEXT NOT NULL DEFAULT '',
  token_enc TEXT NOT NULL DEFAULT '',
  listed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget (
  day TEXT PRIMARY KEY,
  spent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS videos (
  video_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  track_kind TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id);
CREATE TABLE IF NOT EXISTS cues (
  cue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  start_seconds REAL NOT NULL,
  end_seconds REAL NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cues_video_idx ON cues(video_id, idx);
CREATE INDEX IF NOT EXISTS idx_cues_text ON cues(text);
`;

export function openArchiveStore(path: string): ArchiveStore {
  const db = new Database(path);
  db.exec(SCHEMA);
  const saveStmt = db.prepare(`
    INSERT INTO creators (channel_id, channel_title, token_enc, listed, created_at)
    VALUES (@channelId, @channelTitle, @tokenEnc, 0, @createdAt)
    ON CONFLICT(channel_id) DO UPDATE SET
      channel_title = excluded.channel_title,
      token_enc = excluded.token_enc
  `);
  const getStmt = db.prepare(
    "SELECT channel_id, channel_title, token_enc, listed, created_at FROM creators WHERE channel_id = ?",
  );
  const listStmt = db.prepare(
    "SELECT channel_id, channel_title, token_enc, listed, created_at FROM creators ORDER BY created_at",
  );
  const deleteCreatorStmt = db.prepare(
    "DELETE FROM creators WHERE channel_id = ?",
  );
  const spentStmt = db.prepare("SELECT spent FROM budget WHERE day = ?");
  const upsertSpentStmt = db.prepare(`
    INSERT INTO budget (day, spent) VALUES (@day, @spent)
    ON CONFLICT(day) DO UPDATE SET spent = excluded.spent
  `);
  const upsertVideoStmt = db.prepare(`
    INSERT INTO videos (video_id, channel_id, title, published_at, track_kind, fetched_at)
    VALUES (@videoId, @channelId, @title, @publishedAt, @trackKind, @fetchedAt)
    ON CONFLICT(video_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      title = excluded.title,
      published_at = excluded.published_at,
      track_kind = excluded.track_kind,
      fetched_at = excluded.fetched_at
  `);
  const deleteVideoCuesStmt = db.prepare(
    "DELETE FROM cues WHERE video_id = ?",
  );
  const insertCueStmt = db.prepare(`
    INSERT INTO cues (video_id, idx, start_seconds, end_seconds, text)
    VALUES (@videoId, @idx, @startSeconds, @endSeconds, @text)
  `);
  const indexedVideosStmt = db.prepare(`
    SELECT v.video_id AS video_id, v.title AS title,
           v.published_at AS published_at, v.track_kind AS track_kind,
           v.fetched_at AS fetched_at, COUNT(c.cue_id) AS cue_count
    FROM videos v LEFT JOIN cues c ON c.video_id = v.video_id
    WHERE v.channel_id = ? GROUP BY v.video_id
  `);
  const countFreshStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM videos v
    WHERE v.channel_id = ?
      AND strftime('%s', v.fetched_at) > strftime('%s', ?)
      AND EXISTS (SELECT 1 FROM cues c WHERE c.video_id = v.video_id)
  `);
  const purgeStmt = db.prepare(`
    DELETE FROM cues WHERE video_id IN (
      SELECT video_id FROM videos
      WHERE strftime('%s', fetched_at) <= strftime('%s', ?)
    )
  `);
  const matchableStmt = db.prepare(`
    SELECT v.video_id AS video_id, v.title AS title,
           v.published_at AS published_at, v.track_kind AS track_kind,
           c.idx AS idx, c.start_seconds AS start_seconds,
           c.end_seconds AS end_seconds, c.text AS text
    FROM videos v JOIN cues c ON c.video_id = v.video_id
    WHERE v.channel_id = ? AND strftime('%s', v.fetched_at) > strftime('%s', ?)
    ORDER BY v.published_at DESC, v.video_id ASC, c.idx ASC
  `);
  const staleAsrStmt = db.prepare(`
    SELECT video_id, title, published_at, track_kind FROM videos
    WHERE channel_id = ? AND track_kind = 'asr'
      AND strftime('%s', fetched_at) <= strftime('%s', ?)
    ORDER BY published_at DESC, video_id ASC
  `);
  const setListedStmt = db.prepare(
    "UPDATE creators SET listed = ? WHERE channel_id = ?",
  );
  const listedStmt = db.prepare(
    "SELECT channel_id, channel_title FROM creators WHERE listed = 1 ORDER BY created_at",
  );
  const deleteChannelCuesStmt = db.prepare(`
    DELETE FROM cues WHERE video_id IN (
      SELECT video_id FROM videos WHERE channel_id = ?
    )
  `);
  const deleteChannelVideosStmt = db.prepare(
    "DELETE FROM videos WHERE channel_id = ?",
  );

  const trySpendTx = db.transaction(
    (day: string, units: number, cap: number): boolean => {
      const row = spentStmt.get(day) as { spent: number } | undefined;
      const spent = row?.spent ?? 0;
      if (spent + units > cap) {
        return false;
      }
      upsertSpentStmt.run({ day, spent: spent + units });
      return true;
    },
  );

  const saveVideoTx = db.transaction(
    (args: {
      channelId: string;
      videoId: string;
      title: string;
      publishedAt: string;
      trackKind: string;
      fetchedAt: string;
      cues: CaptionCue[];
    }): void => {
      upsertVideoStmt.run({
        videoId: args.videoId,
        channelId: args.channelId,
        title: args.title,
        publishedAt: args.publishedAt,
        trackKind: args.trackKind,
        fetchedAt: args.fetchedAt,
      });
      deleteVideoCuesStmt.run(args.videoId);
      for (const cue of args.cues) {
        insertCueStmt.run({ videoId: args.videoId, ...cue });
      }
    },
  );

  const deleteChannelTx = db.transaction((channelId: string): void => {
    deleteChannelCuesStmt.run(channelId);
    deleteChannelVideosStmt.run(channelId);
    deleteCreatorStmt.run(channelId);
  });

  return {
    saveCreator(row) {
      saveStmt.run({
        channelId: row.channelId,
        channelTitle: row.channelTitle,
        tokenEnc: row.tokenEnc,
        createdAt: new Date().toISOString(),
      });
    },
    getCreator(channelId) {
      return getStmt.get(channelId) as CreatorRow | undefined;
    },
    listCreators() {
      return listStmt.all() as CreatorRow[];
    },
    deleteChannel(channelId) {
      deleteChannelTx(channelId);
    },
    getSpent(day) {
      const row = spentStmt.get(day) as { spent: number } | undefined;
      return row?.spent ?? 0;
    },
    trySpend(day, units, cap = DAILY_BUDGET_UNITS) {
      return trySpendTx(day, units, cap);
    },
    saveVideoWithCues(args) {
      saveVideoTx(args);
    },
    getIndexedVideos(channelId) {
      return indexedVideosStmt.all(channelId) as StoredVideo[];
    },
    countFreshVideos(channelId, now) {
      const row = countFreshStmt.get(
        channelId,
        freshnessCutoff(now),
      ) as { count: number };
      return row.count;
    },
    purgeExpired(now) {
      return purgeStmt.run(freshnessCutoff(now)).changes;
    },
    getMatchableVideos(channelId, now) {
      const rows = matchableStmt.all(
        channelId,
        freshnessCutoff(now),
      ) as Array<{
        video_id: string;
        title: string;
        published_at: string;
        track_kind: string;
        idx: number;
        start_seconds: number;
        end_seconds: number;
        text: string;
      }>;
      const videos: MatchableVideo[] = [];
      for (const row of rows) {
        let video = videos[videos.length - 1];
        if (!video || video.video_id !== row.video_id) {
          video = {
            video_id: row.video_id,
            title: row.title,
            published_at: row.published_at,
            track_kind: row.track_kind,
            cues: [],
          };
          videos.push(video);
        }
        video.cues.push({
          idx: row.idx,
          startSeconds: row.start_seconds,
          endSeconds: row.end_seconds,
          text: row.text,
        });
      }
      return videos;
    },
    getStaleAsrVideos(channelId, now) {
      return staleAsrStmt.all(channelId, freshnessCutoff(now)) as StaleVideo[];
    },
    setListed(channelId, listed) {
      setListedStmt.run(listed ? 1 : 0, channelId);
    },
    listListedCreators() {
      return listedStmt.all() as ListedCreator[];
    },
    close() {
      db.close();
    },
  };
}
