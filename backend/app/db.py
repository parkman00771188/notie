import sqlite3

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  team TEXT,
  organization TEXT,
  department TEXT,
  position TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  active INTEGER NOT NULL DEFAULT 1,
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
  source_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
  locked INTEGER NOT NULL DEFAULT 0,
  is_shared INTEGER NOT NULL DEFAULT 0,
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
  is_global INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS tag_permissions (
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (tag_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_number TEXT,
  task_title TEXT,
  principal_investigator TEXT,
  research_institution TEXT,
  title TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2563eb',
  active INTEGER NOT NULL DEFAULT 1,
  period_start TEXT,
  period_end TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS project_tags (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (project_id, tag_id)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (project_id, user_id)
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
CREATE INDEX IF NOT EXISTS idx_projects_active ON projects(active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_title ON projects(title);
CREATE INDEX IF NOT EXISTS idx_project_tags_tag ON project_tags(tag_id, project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id, project_id);
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
        _ensure_superadmin(conn)


def _migrate(conn: sqlite3.Connection) -> None:
    """기존 DB에 추가된 컬럼 반영 (CREATE IF NOT EXISTS로 못 잡는 변경)"""
    cols = [row[1] for row in conn.execute("PRAGMA table_info(participants)")]
    for col in ("department", "organization", "email", "phone"):
        if col not in cols:
            conn.execute(f"ALTER TABLE participants ADD COLUMN {col} TEXT")
    if "source_user_id" not in cols:
        conn.execute("ALTER TABLE participants ADD COLUMN source_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_participants_source_user ON participants(user_id, source_user_id)"
    )

    bcols = [row[1] for row in conn.execute("PRAGMA table_info(bookmarks)")]
    if "kind" not in bcols:
        conn.execute("ALTER TABLE bookmarks ADD COLUMN kind TEXT NOT NULL DEFAULT 'memo'")

    ocols = [row[1] for row in conn.execute("PRAGMA table_info(org_options)")]
    if ocols and "color" not in ocols:
        conn.execute("ALTER TABLE org_options ADD COLUMN color TEXT")

    mcols = [row[1] for row in conn.execute("PRAGMA table_info(meetings)")]
    if "deleted_at" not in mcols:
        conn.execute("ALTER TABLE meetings ADD COLUMN deleted_at TEXT")
    if "locked" not in mcols:
        conn.execute("ALTER TABLE meetings ADD COLUMN locked INTEGER NOT NULL DEFAULT 0")
    if "is_shared" not in mcols:
        conn.execute("ALTER TABLE meetings ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_meetings_shared ON meetings(is_shared, created_at DESC)"
    )

    ucols = [row[1] for row in conn.execute("PRAGMA table_info(users)")]
    if "username" not in ucols:
        conn.execute("ALTER TABLE users ADD COLUMN username TEXT")
        conn.execute(
            """
            UPDATE users
            SET username = lower(substr(email, 1, instr(email || '@', '@') - 1))
            WHERE username IS NULL OR trim(username) = ''
            """
        )
    for col in ("organization", "department", "position", "phone"):
        if col not in ucols:
            conn.execute(f"ALTER TABLE users ADD COLUMN {col} TEXT")
    if "role" not in ucols:
        conn.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'")
    if "active" not in ucols:
        conn.execute("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users(username)")

    tcols = [row[1] for row in conn.execute("PRAGMA table_info(tags)")]
    if "is_global" not in tcols:
        conn.execute("ALTER TABLE tags ADD COLUMN is_global INTEGER NOT NULL DEFAULT 0")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_global_name_unique ON tags(name) WHERE is_global = 1"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tag_permissions (
          tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
          PRIMARY KEY (tag_id, user_id)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tag_permissions_user ON tag_permissions(user_id, tag_id)"
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_number TEXT,
          task_title TEXT,
          principal_investigator TEXT,
          research_institution TEXT,
          title TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#2563eb',
          active INTEGER NOT NULL DEFAULT 1,
          period_start TEXT,
          period_end TEXT,
          created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        )
        """
    )
    pcols = [row[1] for row in conn.execute("PRAGMA table_info(projects)")]
    for col in (
        "task_number",
        "task_title",
        "principal_investigator",
        "research_institution",
        "period_start",
        "period_end",
    ):
        if pcols and col not in pcols:
            conn.execute(f"ALTER TABLE projects ADD COLUMN {col} TEXT")
    if pcols and "task_title" not in pcols:
        conn.execute("UPDATE projects SET task_title = COALESCE(task_title, title)")
    if pcols and "color" not in pcols:
        conn.execute("ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT '#2563eb'")
    if pcols and "active" not in pcols:
        conn.execute("ALTER TABLE projects ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
    if pcols and "created_by" not in pcols:
        conn.execute("ALTER TABLE projects ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE CASCADE")
    if pcols and "updated_at" not in pcols:
        conn.execute("ALTER TABLE projects ADD COLUMN updated_at TEXT")
        conn.execute("UPDATE projects SET updated_at = COALESCE(updated_at, created_at, datetime('now', 'localtime'))")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_projects_active ON projects(active, created_at DESC)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_projects_title ON projects(title)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_tags (
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
          PRIMARY KEY (project_id, tag_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_members (
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
          PRIMARY KEY (project_id, user_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_tags_tag ON project_tags(tag_id, project_id)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id, project_id)"
    )

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
              color TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
              UNIQUE(user_id, kind, name)
            )
            """
        )
        conn.execute(
            "INSERT INTO org_options (id, user_id, kind, name, color, created_at) "
            "SELECT id, user_id, kind, name, color, created_at FROM org_options_old"
        )
        conn.execute("DROP TABLE org_options_old")


def _ensure_superadmin(conn: sqlite3.Connection) -> None:
    """Create the default admin only when the database has no admin account."""
    admin_count = conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]
    if admin_count:
        return

    from .auth_utils import hash_password

    username = config.SUPERADMIN_USERNAME.strip().lower() or "admin"
    password = config.SUPERADMIN_PASSWORD or "admin123!@#"
    name = config.SUPERADMIN_NAME.strip() or "관리자"
    email = config.SUPERADMIN_EMAIL.strip().lower() or "admin@notie.local"

    row = conn.execute(
        "SELECT id FROM users WHERE lower(username) = ? OR lower(email) = ?",
        (username, email),
    ).fetchone()
    if row is not None:
        conn.execute(
            """
            UPDATE users
            SET username = ?, name = ?, role = 'admin', active = 1
            WHERE id = ?
            """,
            (username, name, row["id"]),
        )
        return

    conn.execute(
        """
        INSERT INTO users (
          username, email, password_hash, name, team, organization,
          department, position, phone, role, active
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', 1)
        """,
        (
            username,
            email,
            hash_password(password),
            name,
            "관리팀",
            "Notie",
            "관리팀",
            "관리자",
            None,
        ),
    )
