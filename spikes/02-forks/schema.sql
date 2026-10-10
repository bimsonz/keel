CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recv_at INTEGER NOT NULL,      -- Date.now() in the queue consumer
  msg_ts INTEGER,                -- Queue message timestamp
  type TEXT,
  ns TEXT,                       -- source.namespace
  repo TEXT,                     -- source.repoName
  target_ns TEXT,                -- payload.namespace (repo.forked)
  target_repo TEXT,              -- payload.repoName (repo.forked)
  event_ts TEXT,                 -- metadata.eventTimestamp
  body_type TEXT,                -- typeof message body
  raw TEXT
);
