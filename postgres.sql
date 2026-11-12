BEGIN;

CREATE SCHEMA IF NOT EXISTS drivepool;
REVOKE ALL ON SCHEMA drivepool FROM PUBLIC;

CREATE TABLE IF NOT EXISTS drivepool.sessions (
  id text PRIMARY KEY,
  user_id text,
  expiry bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS drivepool.oauth (
  state text PRIMARY KEY,
  session_id text NOT NULL,
  verifier text NOT NULL,
  expiry bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS drivepool.drives (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  token text NOT NULL,
  position bigint GENERATED ALWAYS AS IDENTITY,
  UNIQUE (user_id, subject)
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON drivepool.sessions (expiry);
CREATE INDEX IF NOT EXISTS oauth_expiry_idx ON drivepool.oauth (expiry);
CREATE INDEX IF NOT EXISTS oauth_session_idx ON drivepool.oauth (session_id);

ALTER TABLE drivepool.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivepool.oauth ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivepool.drives ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS drivepool.split_files (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  manifest text NOT NULL
);

CREATE INDEX IF NOT EXISTS split_files_user_idx ON drivepool.split_files (user_id);
ALTER TABLE drivepool.split_files ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS drivepool.folders (
  user_id text NOT NULL,
  path text NOT NULL,
  PRIMARY KEY (user_id, path)
);
ALTER TABLE drivepool.folders ENABLE ROW LEVEL SECURITY;

COMMIT;
