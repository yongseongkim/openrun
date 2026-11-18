CREATE TABLE waiting_requests (
  id uuid PRIMARY KEY,
  restaurant_id text NOT NULL,
  visit_date date NOT NULL,
  slot text NOT NULL CHECK (slot IN ('am', 'pm')),
  party_size smallint NOT NULL CHECK (party_size > 0),
  phone_ciphertext text NOT NULL,
  phone_masked text NOT NULL,
  opens_at timestamptz NOT NULL,
  prepare_at timestamptz NOT NULL,
  runs_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('SCHEDULED','RUNNING','SUBMITTING','SUCCEEDED','UNKNOWN','FAILED','EXPIRED','CANCELLED','INTERRUPTED')),
  notify boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  message text,
  result jsonb,
  notification_state text CHECK (notification_state IN ('SENT','FAILED')),
  CHECK (prepare_at <= opens_at AND opens_at <= runs_at AND runs_at < deadline_at)
);
CREATE INDEX waiting_requests_due ON waiting_requests (runs_at, id) WHERE state = 'SCHEDULED';
CREATE UNIQUE INDEX waiting_requests_unique_active ON waiting_requests (restaurant_id, visit_date, slot)
  WHERE state NOT IN ('CANCELLED','FAILED','EXPIRED');

CREATE TABLE waiting_attempts (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES waiting_requests(id),
  state text NOT NULL CHECK (state IN ('RUNNING','SUBMITTING','SUCCEEDED','UNKNOWN','FAILED','INTERRUPTED')),
  started_at timestamptz NOT NULL,
  submitted_at timestamptz,
  finished_at timestamptz,
  message text,
  result jsonb
);
