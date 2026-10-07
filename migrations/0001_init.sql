-- Every row belongs to a member (the creator who owns this chatter), so the
-- same tables can later hold several Premium members' accounts.

-- The creator who owns this chatter, linked to their Telegram account.
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  telegram_chat_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One-time codes from the /setup page that link the owner's Telegram account.
CREATE TABLE claim_codes (
  code TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Everything set through /setup and /settings (name, persona, endpoint IDs...).
CREATE TABLE settings (
  member_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, key)
);

-- What the control bot is waiting for (e.g. "the answer to the persona question").
CREATE TABLE control_state (
  member_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  field TEXT,
  updated_at INTEGER NOT NULL
);

-- Each fan she talks to. source: 'fanvue' (real), 'test' (you, via /chat), 'sim' (simulator).
-- profile is JSON: {"name": "...", "notes": ["likes the gym", ...]}
CREATE TABLE fans (
  member_id TEXT NOT NULL,
  fan_id TEXT NOT NULL,
  source TEXT NOT NULL,
  display_name TEXT,
  profile TEXT NOT NULL DEFAULT '{}',
  total_spent_cents INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, fan_id)
);

-- The conversation. role: 'fan' or 'her'.
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL,
  fan_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_by_fan ON messages (member_id, fan_id, id);

-- Safety flags and errors, also sent to the owner in Telegram.
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL,
  fan_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
