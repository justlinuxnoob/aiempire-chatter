-- Step 4: what she can sell (vault photos, described by the vision model) and what she sold.
CREATE TABLE catalog (
  member_id TEXT NOT NULL,
  media_uuid TEXT NOT NULL,
  source TEXT NOT NULL,               -- 'vault' | 'generated'
  description TEXT,                   -- one sentence, by the vision model (editable)
  level TEXT,                         -- 'sfw' | 'spicy' | 'explicit'
  price_cents INTEGER,                -- suggested price (editable in Telegram)
  enabled INTEGER NOT NULL DEFAULT 1, -- 0 = never sell this one
  describe_job TEXT,                  -- RunPod job while it's being described
  describe_attempts INTEGER NOT NULL DEFAULT 0,
  described_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, media_uuid)
);

-- Every locked photo she sent, and whether he opened (bought) it.
CREATE TABLE sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL,
  fan_id TEXT NOT NULL,
  message_uuid TEXT,                  -- the Fanvue message carrying it (null for tests)
  media_uuids TEXT NOT NULL,          -- JSON array
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL,               -- 'offered' | 'bought'
  offered_at INTEGER NOT NULL,
  checked_at INTEGER,
  bought_at INTEGER
);
CREATE INDEX sales_by_fan ON sales (member_id, fan_id, offered_at);
CREATE INDEX sales_open ON sales (status, offered_at);
