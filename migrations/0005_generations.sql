-- Step 5: photos made on demand for a fan, with an optional approval step in Telegram.
CREATE TABLE generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL,
  fan_id TEXT NOT NULL,
  source TEXT NOT NULL,               -- 'fanvue' | 'test' | 'sim'
  kind TEXT NOT NULL,                 -- 'teaser' (free, SFW endpoint) | 'ppv' (paid, NSFW endpoint)
  prompt TEXT NOT NULL,
  caption TEXT NOT NULL,
  price_cents INTEGER,
  endpoint TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,               -- generating | review | sent | rejected | failed
  media_uuid TEXT,                    -- uploaded to Fanvue
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX generations_by_status ON generations (status, created_at);
CREATE INDEX generations_by_fan ON generations (member_id, fan_id, created_at);
