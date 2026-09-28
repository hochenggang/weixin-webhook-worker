CREATE TABLE IF NOT EXISTS admin_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
