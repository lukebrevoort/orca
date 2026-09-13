CREATE TABLE account_attention_preferences (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  default_choice TEXT NOT NULL CHECK(default_choice IN ('notify', 'quiet')),
  senders_json TEXT NOT NULL
);
