import sqlite3

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  team TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  department TEXT,
  organization TEXT,
  email TEXT,
  phone TEXT,
  color TEXT NOT NULL DEFAULT '#2563eb',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  tag TEXT,
  status TEXT NOT NULL DEFAULT 'recording',
  started_at TEXT NOT NULL,
  duration_sec REAL,
  audio_filename TEXT,
  error_message TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, participant_id)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  time_sec REAL NOT NULL,
  title TEXT NOT NULL,
  note TEXT,
  kind TEXT NOT NULL DEFAULT 'memo',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  meeting_id INTEGER PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  key_points TEXT NOT NULL,
  decisions TEXT NOT NULL,
  action_items TEXT NOT NULL,
  discussion TEXT NOT NULL DEFAULT '',
  followups TEXT NOT NULL DEFAULT '[]',
  engine_note TEXT,
  minutes_md TEXT NOT NULL,
  engine TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#16a34a',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS org_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('department', 'role', 'organization')),
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(user_id, kind, name)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_meetings_user ON meetings(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_meeting ON bookmarks(meeting_id, time_sec);
CREATE INDEX IF NOT EXISTS idx_segments_meeting ON transcript_segments(meeting_id, start_sec);
"""


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


def _migrate(conn: sqlite3.Connection) -> None:
    """기존 DB에 추가된 컬럼 반영 (CREATE IF NOT EXISTS로 못 잡는 변경)"""
    cols = [row[1] for row in conn.execute("PRAGMA table_info(participants)")]
    for col in ("department", "organization", "email", "phone"):
        if col not in cols:
            conn.execute(f"ALTER TABLE participants ADD COLUMN {col} TEXT")

    bcols = [row[1] for row in conn.execute("PRAGMA table_info(bookmarks)")]
    if "kind" not in bcols:
        conn.execute("ALTER TABLE bookmarks ADD COLUMN kind TEXT NOT NULL DEFAULT 'memo'")

    ocols = [row[1] for row in conn.execute("PRAGMA table_info(org_options)")]
    if ocols and "color" not in ocols:
        conn.execute("ALTER TABLE org_options ADD COLUMN color TEXT")

    mcols = [row[1] for row in conn.execute("PRAGMA table_info(meetings)")]
    if "deleted_at" not in mcols:
        conn.execute("ALTER TABLE meetings ADD COLUMN deleted_at TEXT")

    scols = [row[1] for row in conn.execute("PRAGMA table_info(summaries)")]
    if "discussion" not in scols:
        conn.execute("ALTER TABLE summaries ADD COLUMN discussion TEXT NOT NULL DEFAULT ''")
    if "followups" not in scols:
        conn.execute("ALTER TABLE summaries ADD COLUMN followups TEXT NOT NULL DEFAULT '[]'")
    if "engine_note" not in scols:
        conn.execute("ALTER TABLE summaries ADD COLUMN engine_note TEXT")

    # org_options CHECK에 'organization' 추가 (SQLite는 CHECK 변경 불가 → 테이블 재생성)
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='org_options'"
    ).fetchone()
    if row and "'organization'" not in row[0]:
        conn.execute("ALTER TABLE org_options RENAME TO org_options_old")
        conn.execute(
            """
            CREATE TABLE org_options (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              kind TEXT NOT NULL CHECK (kind IN ('department', 'role', 'organization')),
              name TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
              UNIQUE(user_id, kind, name)
            )
            """
        )
        conn.execute(
            "INSERT INTO org_options (id, user_id, kind, name, created_at) "
            "SELECT id, user_id, kind, name, created_at FROM org_options_old"
        )
        conn.execute("DROP TABLE org_options_old")
