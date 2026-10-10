CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT UNIQUE,   -- Workflow instance id (step retries do not double-count)
  started_at INTEGER,        -- Date.now() at the top of run()
  wf_ts INTEGER,             -- event.timestamp (instance creation)
  type TEXT, ns TEXT, repo TEXT, ref TEXT, before TEXT, after TEXT,
  event_ts TEXT,             -- metadata.eventTimestamp, if present
  payload_type TEXT,
  raw TEXT
);
CREATE TABLE IF NOT EXISTS qevents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recv_at INTEGER,           -- Date.now() in the queue consumer
  msg_ts INTEGER,            -- Queue message timestamp
  msg_id TEXT,
  type TEXT, ns TEXT, repo TEXT, ref TEXT, before TEXT, after TEXT,
  event_ts TEXT,
  body_type TEXT,
  raw TEXT
);
