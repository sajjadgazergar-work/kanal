-- KANAL initial schema, mirroring plan §6.2.
-- Postgres 16. Run with: psql -d kanal -f 0000_init.sql
-- Requires extensions: pg_uuidv7, pg_trgm, vector

CREATE EXTENSION IF NOT EXISTS pg_uuidv7;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- 1 ---------------------------------------------------------------
CREATE TABLE org (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  name            text NOT NULL,
  ui_locale       text NOT NULL DEFAULT 'en'      CHECK (ui_locale IN ('en','fa')),
  timezone        text NOT NULL DEFAULT 'UTC',
  calendar_system text NOT NULL DEFAULT 'gregory' CHECK (calendar_system IN ('gregory','persian')),
  numeral_system  text NOT NULL DEFAULT 'latn'    CHECK (numeral_system IN ('latn','arabext')),
  budget_month_usd numeric(10,2) NOT NULL DEFAULT 50.00,
  spent_month_usd  numeric(10,4) NOT NULL DEFAULT 0,
  budget_period_start date NOT NULL DEFAULT date_trunc('month', now())::date,
  global_halt_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 2 ---------------------------------------------------------------
CREATE TYPE platform_kind AS ENUM ('telegram','bale','rubika','eitaa','x','reddit');

CREATE TABLE channel (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id                uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  platform              platform_kind NOT NULL,
  platform_channel_id   text NOT NULL,
  handle                text,
  display_name          text NOT NULL,
  content_locale        text NOT NULL DEFAULT 'en',
  content_timezone      text NOT NULL DEFAULT 'UTC',
  default_lane          text NOT NULL DEFAULT 'copilot' CHECK (default_lane IN ('auto','copilot','manual')),
  voice_pack_id         uuid,
  manifest_set_id       uuid,
  credential_ref        text NOT NULL,
  capabilities          jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities_probed_at timestamptz,
  pacing_policy         jsonb NOT NULL DEFAULT '{}'::jsonb,
  publish_halted_at     timestamptz,
  halt_reason           text,
  budget_day_usd        numeric(8,2) NOT NULL DEFAULT 2.00,
  subscriber_count      integer,
  subscriber_count_at   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, platform, platform_channel_id)
);

-- 3 ---------------------------------------------------------------
CREATE TYPE source_kind AS ENUM
  ('rss','atom','jsonfeed','sitemap','html_selector','reddit_json','youtube_rss',
   'hn_algolia','arxiv','webhook','manual');

CREATE TABLE source (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  kind            source_kind NOT NULL,
  url             text,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  trust_tier      smallint NOT NULL DEFAULT 1 CHECK (trust_tier BETWEEN 0 AND 4),
  trust_score     numeric(5,2) NOT NULL DEFAULT 50.0,
  poll_interval_s integer NOT NULL DEFAULT 900,
  etag            text,
  last_modified   text,
  last_polled_at  timestamptz,
  last_ok_at      timestamptz,
  consecutive_failures smallint NOT NULL DEFAULT 0,
  quarantined_at  timestamptz,
  license_hint    text DEFAULT 'unknown',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, url)
);

-- 4 ---------------------------------------------------------------
CREATE TABLE source_item (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id            uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  source_id         uuid NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  canonical_url     text NOT NULL,
  raw_url           text NOT NULL,
  url_hash          bytea NOT NULL,
  simhash           bigint NOT NULL,
  cluster_id        uuid,
  title             text,
  body_text         text NOT NULL,
  body_sha256       bytea NOT NULL,
  lang              text,
  published_at      timestamptz,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  http_status       smallint,
  content_bytes     integer,
  embedding         vector(1024),
  injection_flags   text[] NOT NULL DEFAULT '{}',
  UNIQUE (org_id, url_hash)
);
CREATE INDEX source_item_recent_idx ON source_item (org_id, published_at DESC NULLS LAST);
CREATE INDEX source_item_cluster_idx ON source_item (cluster_id);
CREATE INDEX source_item_title_trgm ON source_item USING gin (title gin_trgm_ops);
CREATE INDEX source_item_vec_idx ON source_item USING hnsw (embedding vector_cosine_ops);

-- 5 ---------------------------------------------------------------
CREATE TYPE run_state AS ENUM (
  'intake','briefed','sourcing','researched','authoring','drafting','critiquing','revising',
  'formatting','media_pending','policy_check','review_pending','approved','scheduled',
  'publishing','published','publish_uncertain','measuring','learned',
  'escalated','blocked_policy','blocked_budget','blocked_provider','halted','cancelled','failed');

CREATE TABLE run (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  channel_id         uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  lane               text NOT NULL CHECK (lane IN ('auto','copilot','manual')),
  state              run_state NOT NULL DEFAULT 'intake',
  cursor_stage       text NOT NULL DEFAULT 'intake',
  brief              jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_set_hash  bytea NOT NULL,
  prompt_pack_version text NOT NULL,
  policy_hash        bytea,
  trace_id           bytea NOT NULL,
  budget_cap_usd     numeric(8,4) NOT NULL DEFAULT 0.15,
  spent_usd          numeric(8,4) NOT NULL DEFAULT 0,
  cancel_requested   boolean NOT NULL DEFAULT false,
  error_code         text,
  error_detail       text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  CONSTRAINT run_budget_sane CHECK (spent_usd <= budget_cap_usd * 1.25)
);
CREATE INDEX run_active_idx ON run (org_id, channel_id, state)
  WHERE state NOT IN ('learned','cancelled','failed');

-- 6 ---------------------------------------------------------------
CREATE TABLE run_step (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  run_id         uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  stage          text NOT NULL,
  attempt        smallint NOT NULL DEFAULT 1,
  agent_ref      text,
  zone           text NOT NULL CHECK (zone IN ('quarantine','trusted','deterministic')),
  idempotency_key bytea NOT NULL,
  state          text NOT NULL CHECK (state IN ('queued','in_flight','done','failed','skipped','cancelled')),
  input_hash     bytea NOT NULL,
  output         jsonb,
  error          jsonb,
  span_id        bytea,
  model_ref      text,
  input_tokens   integer,
  output_tokens  integer,
  cached_tokens  integer,
  cost_usd       numeric(10,6),
  latency_ms     integer,
  heartbeat_at   timestamptz,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  UNIQUE (run_id, stage, attempt),
  UNIQUE (idempotency_key)
);
CREATE INDEX run_step_reclaim_idx ON run_step (heartbeat_at) WHERE state = 'in_flight';

-- 6b: job queue (plan §12.3) -----------------------------------------
-- The coordinator's private scratch space; NOT tenant-isolated by RLS (every
-- payload carries org_id for the handler to set kanal.org_id before touching
-- tenant tables). Dequeue is FOR UPDATE SKIP LOCKED (§12.3).
CREATE TABLE job (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  queue         text NOT NULL CHECK (queue IN ('pipeline','ingest','publish','metrics')),
  singleton_key text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      smallint NOT NULL DEFAULT 0,
  max_attempts  smallint NOT NULL DEFAULT 5,
  state         text NOT NULL DEFAULT 'ready' CHECK (state IN
                 ('ready','running','done','failed','dead')),
  locked_by     text,
  locked_at     timestamptz
);
CREATE UNIQUE INDEX job_singleton_in_flight_unique
  ON job (queue, singleton_key) WHERE state IN ('ready','running') AND singleton_key IS NOT NULL;
CREATE INDEX job_ready_idx ON job (queue, run_at) WHERE state = 'ready';

-- 7 ---------------------------------------------------------------
CREATE TABLE post (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  channel_id         uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  run_id             uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  current_revision_id uuid,
  content_locale     text NOT NULL,
  risk_class         smallint NOT NULL DEFAULT 0 CHECK (risk_class BETWEEN 0 AND 3),
  is_promotional     boolean NOT NULL DEFAULT false,
  scheduled_for      timestamptz,
  slot_grace_s       integer NOT NULL DEFAULT 1200,
  published_at       timestamptz,
  retracted_at       timestamptz,
  UNIQUE (run_id)
);
CREATE INDEX post_due_idx ON post (channel_id, scheduled_for)
  WHERE published_at IS NULL AND retracted_at IS NULL;

-- 8 ---------------------------------------------------------------
CREATE TABLE post_revision (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  post_id         uuid NOT NULL REFERENCES post(id) ON DELETE CASCADE,
  revision_no     integer NOT NULL,
  author_actor    text NOT NULL,
  body_md         text NOT NULL,
  body_rendered   text NOT NULL,
  render_mode     text NOT NULL DEFAULT 'html',
  char_count      integer NOT NULL,
  entity_count    integer NOT NULL DEFAULT 0,
  media           jsonb NOT NULL DEFAULT '[]'::jsonb,
  allowed_urls    text[] NOT NULL DEFAULT '{}',
  claim_ids       uuid[] NOT NULL DEFAULT '{}',
  eval_scores     jsonb,
  banned_patterns jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_sha256  bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, revision_no)
);

-- 9 ---------------------------------------------------------------
CREATE TABLE approval (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  run_id             uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  gate               text NOT NULL CHECK (gate IN
                       ('topic','draft','publish','policy_override','budget_raise','source_trust')),
  payload_hash       bytea NOT NULL,
  state              text NOT NULL DEFAULT 'pending' CHECK (state IN
                       ('pending','granted','denied','expired','superseded')),
  escalation_chain   uuid[] NOT NULL DEFAULT '{}',
  escalated_to_index smallint NOT NULL DEFAULT 0,
  sla_deadline       timestamptz NOT NULL,
  hard_expiry        timestamptz NOT NULL,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_by         text,
  decided_at         timestamptz,
  reason_code        text,
  note               text
);
CREATE UNIQUE INDEX approval_one_open_per_gate
  ON approval (run_id, gate) WHERE state = 'pending';
CREATE INDEX approval_sla_idx ON approval (sla_deadline) WHERE state = 'pending';

-- 9b: publish_intent (plan §4.1, §7.2, §9.2 #14) --------------------
-- The ONLY row that authorizes a publish. Created exclusively by a human
-- HTTP action or the signed autopublish policy evaluator — never by an agent
-- (§7.2 D2). ops.publish consumes a false->consumed intent per run.
CREATE TABLE publish_intent (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  post_id       uuid NOT NULL REFERENCES post(id) ON DELETE CASCADE,
  revision_id   uuid NOT NULL REFERENCES post_revision(id),
  channel_id    uuid NOT NULL REFERENCES channel(id),
  created_by    text NOT NULL,
  policy_hash   bytea,
  payload_hash  bytea NOT NULL,
  consumed      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  consumed_at   timestamptz
);
CREATE INDEX publish_intent_open_idx ON publish_intent (run_id) WHERE consumed = false;

-- 10 --------------------------------------------------------------
CREATE TABLE publish_attempt (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id              uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  post_id             uuid NOT NULL REFERENCES post(id) ON DELETE CASCADE,
  revision_id         uuid NOT NULL REFERENCES post_revision(id),
  channel_id          uuid NOT NULL REFERENCES channel(id),
  platform            platform_kind NOT NULL,
  idempotency_key     bytea NOT NULL,
  state               text NOT NULL CHECK (state IN
                        ('in_flight','succeeded','failed','uncertain','superseded')),
  platform_message_id text,
  request_started_at  timestamptz NOT NULL DEFAULT now(),
  responded_at        timestamptz,
  http_status         smallint,
  platform_error_code text,
  platform_error_desc text,
  retry_after_s       integer,
  attempt_no          smallint NOT NULL DEFAULT 1,
  deletable_until     timestamptz,
  editable            boolean NOT NULL DEFAULT true,
  UNIQUE (idempotency_key)
);
CREATE INDEX publish_attempt_uncertain_idx ON publish_attempt (channel_id)
  WHERE state = 'uncertain';

-- Secondary tables (plan §6.3) --------------------------------------
CREATE TABLE claim (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  source_item_id  uuid NOT NULL REFERENCES source_item(id) ON DELETE CASCADE,
  text            text NOT NULL,
  char_start      integer NOT NULL,
  char_end        integer NOT NULL,
  confidence      numeric(4,3) NOT NULL DEFAULT 0.5,
  is_quote        boolean NOT NULL DEFAULT false
);

CREATE TABLE provider (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  label           text NOT NULL,
  dialect         text NOT NULL,
  base_url        text NOT NULL,
  auth_kind       text NOT NULL DEFAULT 'bearer',
  custom_header_name text,
  key_ciphertext  text,
  extra_headers   jsonb NOT NULL DEFAULT '{}'::jsonb,
  proxy_url       text,
  dns_mode        text NOT NULL DEFAULT 'system',
  doh_url         text,
  tls_insecure    boolean NOT NULL DEFAULT false,
  timeout_ms      integer NOT NULL DEFAULT 60000,
  max_concurrent  integer NOT NULL DEFAULT 4,
  health_state    text NOT NULL DEFAULT 'unconfigured',
  last_checked_at timestamptz,
  last_error      jsonb
);

CREATE TABLE model (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  provider_id     uuid NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
  model_ref       text NOT NULL,
  capabilities    jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities_drifted boolean NOT NULL DEFAULT false,
  context_window  integer,
  override_by_human boolean NOT NULL DEFAULT false
);

CREATE TABLE model_price (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  model_ref       text NOT NULL,
  input_usd_per_mtok numeric(10,4) NOT NULL,
  output_usd_per_mtok numeric(10,4) NOT NULL,
  cached_input_usd_per_mtok numeric(10,4),
  source          text NOT NULL DEFAULT 'seed',
  confirmed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cost_ledger (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  step_id         uuid REFERENCES run_step(id),
  model_ref       text NOT NULL,
  input_tokens    integer NOT NULL,
  output_tokens   integer NOT NULL,
  cached_tokens   integer NOT NULL DEFAULT 0,
  cost_usd        numeric(12,6) NOT NULL,
  pricing_confidence text NOT NULL DEFAULT 'high',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_manifest (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  manifest_id     text NOT NULL,
  semver          text NOT NULL,
  yaml_source     text NOT NULL,
  parsed          jsonb NOT NULL,
  core_api_range  text NOT NULL,
  content_sha256  bytea NOT NULL
);

CREATE TABLE prompt_pack (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  pack_id         text NOT NULL,
  semver          text NOT NULL,
  core_api_range  text NOT NULL,
  locale          text NOT NULL DEFAULT 'en',
  templates       jsonb NOT NULL,
  signature       text
);

CREATE TABLE voice_pack (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  channel_id      uuid REFERENCES channel(id) ON DELETE CASCADE,
  semver          text NOT NULL,
  content         jsonb NOT NULL,
  content_sha256  bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  name            text NOT NULL,
  version         text NOT NULL,
  content         jsonb NOT NULL,
  content_sha256  bytea NOT NULL,
  enabled         boolean NOT NULL DEFAULT false,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_binding (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  source_id       uuid NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  weight          numeric(4,3) NOT NULL DEFAULT 1.0,
  enabled         boolean NOT NULL DEFAULT true,
  topic_filter    text,
  UNIQUE (channel_id, source_id)
);

CREATE TABLE metric_snapshot (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  publish_attempt_id uuid NOT NULL REFERENCES publish_attempt(id) ON DELETE CASCADE,
  captured_at     timestamptz NOT NULL,
  source          text NOT NULL,
  metric          text NOT NULL,
  value           numeric(12,2) NOT NULL
);

CREATE TABLE audit_event (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  prev_hash       bytea,
  actor           text NOT NULL,
  verb            text NOT NULL,
  object_ref      text NOT NULL,
  before          jsonb,
  after           jsonb,
  trace_id        bytea,
  at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiment (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  hypothesis      text NOT NULL,
  arm_definition  jsonb NOT NULL,
  assignment_rule text NOT NULL,
  planned_n       integer NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  stopped_at      timestamptz,
  result          jsonb
);

CREATE TABLE mtproto_session (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  session_blob_ciphertext text NOT NULL,
  consent_recorded_at timestamptz,
  consent_text_hash bytea,
  last_flood_wait_at timestamptz,
  disabled_at     timestamptz
);

-- RLS (plan §16.5) ----------------------------------------------------
ALTER TABLE org ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE source ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE run ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE post ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE publish_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE publish_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider ENABLE ROW LEVEL SECURITY;
ALTER TABLE model ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_price ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_pack ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_pack ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment ENABLE ROW LEVEL SECURITY;
ALTER TABLE mtproto_session ENABLE ROW LEVEL SECURITY;

-- The org table is the root: RLS matches its own id. All other tables match org_id.
CREATE POLICY org_isolation ON org
  USING (id = current_setting('kanal.org_id', true)::uuid);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'channel','source','source_item','run','run_step','post','post_revision',
    'approval','publish_intent','publish_attempt','claim','provider','model','model_price','cost_ledger',
    'agent_manifest','prompt_pack','voice_pack','policy','source_binding','metric_snapshot',
    'audit_event','experiment','mtproto_session'
  ] LOOP
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = current_setting(''kanal.org_id'', true)::uuid);', t);
  END LOOP;
END $$;

-- Audit hash chain trigger (plan §15.7) -------------------------------
CREATE OR REPLACE FUNCTION audit_chain_set_prev()
RETURNS trigger AS $$
DECLARE
  last_hash bytea;
BEGIN
  SELECT content_sha256 INTO last_hash FROM audit_event
  WHERE org_id = NEW.org_id ORDER BY at DESC, id DESC LIMIT 1;
  NEW.prev_hash := last_hash;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_chain BEFORE INSERT ON audit_event
FOR EACH ROW EXECUTE FUNCTION audit_chain_set_prev();

-- Job-queue NOTIFY (plan §12.3) ----------------------------------------
-- Workers LISTEN kanal_job_<queue> and additionally poll every 2s as a
-- safety net. The trigger fires on insert so a dequeue can start immediately.
CREATE OR REPLACE FUNCTION kanal_job_notify()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('kanal_job_' || NEW.queue, NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_notify AFTER INSERT ON job
FOR EACH ROW EXECUTE FUNCTION kanal_job_notify();
