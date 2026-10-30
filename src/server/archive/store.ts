// Creator archive storage (SQLite via better-sqlite3). Holds connected
// creators and their encrypted refresh tokens; videos and caption cues
// arrive in A3. The database file stays out of git (see .gitignore).

import Database from "better-sqlite3";

export interface CreatorRow {
  channel_id: string;
  channel_title: string;
  token_enc: string;
  /** §7.5 "List my archive" — viewer search scope. Default off. */
  listed: number;
  created_at: string;
}

export interface ArchiveStore {
  saveCreator(row: {
    channelId: string;
    channelTitle: string;
    tokenEnc: string;
  }): void;
  getCreator(channelId: string): CreatorRow | undefined;
  listCreators(): CreatorRow[];
  deleteCreator(channelId: string): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creators (
  channel_id TEXT PRIMARY KEY,
  channel_title TEXT NOT NULL DEFAULT '',
  token_enc TEXT NOT NULL DEFAULT '',
  listed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
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
  const deleteStmt = db.prepare("DELETE FROM creators WHERE channel_id = ?");

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
    deleteCreator(channelId) {
      deleteStmt.run(channelId);
    },
    close() {
      db.close();
    },
  };
}
