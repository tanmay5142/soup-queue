-- The line of waiting jobs
CREATE TABLE jobs (
  id               BIGSERIAL PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  payload          JSONB NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempt          INT NOT NULL DEFAULT 0,
  worker_id        TEXT,
  lease_expires_at TIMESTAMPTZ,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Makes "find a waiting job" fast
CREATE INDEX idx_jobs_queued ON jobs (id) WHERE status = 'queued';
-- Makes "find jobs whose timer ran out" fast
CREATE INDEX idx_jobs_lease  ON jobs (lease_expires_at) WHERE status = 'running';

-- The result. A job can only have ONE row here.
CREATE TABLE job_effects (
  job_id     BIGINT PRIMARY KEY REFERENCES jobs(id),
  attempt    INT NOT NULL,
  worker_id  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A diary of every time a worker STARTED a job (no limits here)
CREATE TABLE run_log (
  id         BIGSERIAL PRIMARY KEY,
  job_id     BIGINT NOT NULL,
  attempt    INT NOT NULL,
  worker_id  TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);