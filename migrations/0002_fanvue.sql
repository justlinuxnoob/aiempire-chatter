-- Step 3: the connection to the member's Fanvue account.
-- Tokens and the webhook secret are stored encrypted (AES-GCM, see src/crypto.ts).
CREATE TABLE fanvue_accounts (
  member_id TEXT PRIMARY KEY,
  creator_uuid TEXT NOT NULL,
  handle TEXT,
  display_name TEXT,
  is_ai_creator INTEGER NOT NULL DEFAULT 0,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refreshing_until INTEGER,
  scope TEXT,
  webhook_id TEXT,
  webhook_secret TEXT,
  status TEXT NOT NULL DEFAULT 'connected', -- connected | disconnected
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX fanvue_accounts_by_creator ON fanvue_accounts (creator_uuid);

-- One-time "Connect Fanvue" attempts (OAuth state + PKCE verifier).
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Fanvue's message id, so the same message is never handled twice
-- (webhooks can arrive more than once, and the every-minute check overlaps them).
ALTER TABLE messages ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX messages_external ON messages (member_id, external_id) WHERE external_id IS NOT NULL;

-- Fans: Fanvue handle, and whether this is the owner's own test account.
ALTER TABLE fans ADD COLUMN handle TEXT;
ALTER TABLE fans ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
