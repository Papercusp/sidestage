-- The acceptance Postgres entrypoint starts a temporary server to run these
-- init files, then shuts it down and starts the real server. The marker lets
-- the healthcheck distinguish that temporary server from the final one.
CREATE TABLE IF NOT EXISTS acceptance_init_marker (
  id boolean PRIMARY KEY,
  ready_at timestamptz NOT NULL
);

INSERT INTO acceptance_init_marker (id, ready_at)
VALUES (true, clock_timestamp())
ON CONFLICT (id) DO UPDATE SET ready_at = EXCLUDED.ready_at;
