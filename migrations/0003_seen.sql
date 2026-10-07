-- Fanvue messages the bot looked at but deliberately didn't answer
-- (the test-account code, messages too old to answer), so they're skipped next time.
CREATE TABLE seen_messages (
  member_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, external_id)
);
