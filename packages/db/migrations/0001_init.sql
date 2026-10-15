-- JAT Marketing OS — initial schema
-- Run as the schema owner (role "migrator"). The application connects as "app_user",
-- which has no BYPASSRLS and therefore can only see rows for the tenant set in
-- the transaction-local setting app.tenant_id.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
  END IF;
  -- The publisher worker is the only role that can read encrypted credentials.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publisher_user') THEN
    CREATE ROLE publisher_user NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- Current tenant from the transaction-local setting; NULL when unset (fails closed).
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Platform-level tables
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  slug                      text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,64}$'),
  automation_mode           text NOT NULL DEFAULT 'manual' CHECK (automation_mode IN ('manual','assisted','autonomous')),
  autonomous_eligible       boolean NOT NULL DEFAULT false,
  publishing_enabled        boolean NOT NULL DEFAULT false,
  paused_at                 timestamptz,
  paused_reason             text,
  monthly_ai_budget_cents   integer NOT NULL DEFAULT 1500 CHECK (monthly_ai_budget_cents >= 0),
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL CHECK (position('@' in email) > 1),
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE platform_settings (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  global_paused   boolean NOT NULL DEFAULT false,
  paused_reason   text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings DEFAULT VALUES;

-- ---------------------------------------------------------------------------
-- Tenant-scoped tables
-- ---------------------------------------------------------------------------
CREATE TABLE memberships (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Platform admins are not tenant members; they are managed by separate admin tooling.
  role        text NOT NULL CHECK (role IN ('agency_operator','client_owner','client_editor','reviewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE brands (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  active_dna_version_id  uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  brand_id        uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('url','pdf','image','note','social_profile','report')),
  uri             text NOT NULL,
  evidence_id     text NOT NULL,           -- e.g. "web:/about", "doc:brandbook.pdf#p4"
  sha256          text,
  extracted_text  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (brand_id, evidence_id)
);

CREATE TABLE brand_dna_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  brand_id     uuid NOT NULL,
  version      integer NOT NULL CHECK (version > 0),
  status       text NOT NULL CHECK (status IN ('proposed','active','superseded','rejected')),
  data         jsonb NOT NULL,
  created_by   text NOT NULL,              -- "user:<id>" or "agent_run:<id>"
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (brand_id, version),
  UNIQUE (tenant_id, brand_id, id),
  CHECK (status <> 'active' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
-- At most one active version per brand.
CREATE UNIQUE INDEX brand_dna_one_active ON brand_dna_versions (brand_id) WHERE status = 'active';

-- Active/superseded versions are immutable except for the status change active -> superseded.
CREATE OR REPLACE FUNCTION brand_dna_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('active','superseded') THEN
    IF NEW.data IS DISTINCT FROM OLD.data OR NEW.version <> OLD.version OR NEW.brand_id <> OLD.brand_id
       OR NOT (OLD.status = 'active' AND NEW.status = 'superseded') THEN
      RAISE EXCEPTION 'brand_dna_versions % is immutable', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brand_dna_immutable BEFORE UPDATE ON brand_dna_versions
  FOR EACH ROW EXECUTE FUNCTION brand_dna_immutable();

-- A brand's active version must belong to that brand (and tenant).
ALTER TABLE brands ADD FOREIGN KEY (tenant_id, id, active_dna_version_id)
  REFERENCES brand_dna_versions (tenant_id, brand_id, id);

CREATE TABLE claims (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  brand_id     uuid NOT NULL,
  text         text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  category     text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','expired','rejected')),
  evidence     jsonb NOT NULL DEFAULT '[]'::jsonb,
  verified_by  uuid REFERENCES users(id),
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id) ON DELETE CASCADE,
  CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND jsonb_array_length(evidence) > 0))
);

CREATE TABLE campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  brand_id    uuid NOT NULL,
  name        text NOT NULL,
  objective   text NOT NULL CHECK (objective IN ('awareness','engagement','traffic','leads','retention')),
  starts_on   date NOT NULL,
  ends_on     date NOT NULL CHECK (ends_on >= starts_on),
  status      text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','active','completed','cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id)
);

CREATE TABLE calendar_slots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  campaign_id  uuid NOT NULL,
  channel      text NOT NULL,
  format       text NOT NULL,
  pillar_id    text NOT NULL,
  persona_id   text NOT NULL,
  objective    text NOT NULL,
  publish_at   timestamptz NOT NULL,
  delivery     text NOT NULL CHECK (delivery IN ('api','export')),
  status       text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','drafted','cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id)
);
CREATE INDEX calendar_slots_due ON calendar_slots (publish_at) WHERE status = 'planned';

CREATE TABLE content_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  brand_id             uuid NOT NULL,
  slot_id              uuid,
  channel              text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('social_post','blog_post','gbp_post','page_update','seo_meta','newsletter_section')),
  state                text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','in_review','approved','scheduled','publishing','published','exported','failed','paused','archived')),
  paused_from          text,
  current_revision_id  uuid,
  derived_from_id      uuid,
  risk_class           text CHECK (risk_class IN ('low','medium','high')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, slot_id) REFERENCES calendar_slots(tenant_id, id) ON DELETE SET NULL (slot_id),
  UNIQUE (tenant_id, id)
);
ALTER TABLE content_items
  ADD FOREIGN KEY (tenant_id, derived_from_id) REFERENCES content_items(tenant_id, id) ON DELETE SET NULL (derived_from_id);

CREATE TABLE content_revisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  content_item_id  uuid NOT NULL,
  revision         integer NOT NULL CHECK (revision > 0),
  body             jsonb NOT NULL,
  content_hash     text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, content_item_id) REFERENCES content_items(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (content_item_id, revision),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_item_id, id)
);

-- An item's current revision must be one of its own revisions.
ALTER TABLE content_items ADD FOREIGN KEY (tenant_id, id, current_revision_id)
  REFERENCES content_revisions (tenant_id, content_item_id, id);

CREATE TABLE assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  brand_id     uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('logo','photo','graphic','video','document','font')),
  storage_key  text NOT NULL,
  mime         text NOT NULL,
  width        integer,
  height       integer,
  alt_text     text,
  license      jsonb NOT NULL DEFAULT '{}'::jsonb,
  origin       text NOT NULL CHECK (origin IN ('uploaded','rendered','generated')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  content_item_id  uuid NOT NULL,
  revision_id      uuid NOT NULL,
  content_hash     text NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('approved','rejected','changes_requested')),
  decided_by       uuid REFERENCES users(id),        -- NULL only for policy auto-approvals
  policy_reason    text,                              -- set when the approval policy allowed auto-scheduling
  veto_until       timestamptz,                       -- Assisted mode veto window
  comment          text,
  decided_at       timestamptz NOT NULL DEFAULT now(),
  -- The revision must belong to the same content item.
  FOREIGN KEY (tenant_id, content_item_id, revision_id) REFERENCES content_revisions(tenant_id, content_item_id, id) ON DELETE CASCADE,
  CHECK (decided_by IS NOT NULL OR (decision = 'approved' AND policy_reason IS NOT NULL))
);

CREATE TABLE integrations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel                text NOT NULL,
  external_account_id    text NOT NULL,
  display_name           text NOT NULL,
  status                 text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','needs_reauth','revoked','error')),
  channel_paused         boolean NOT NULL DEFAULT false,
  capabilities           jsonb NOT NULL DEFAULT '{}'::jsonb,
  scopes                 text[] NOT NULL DEFAULT '{}',
  token_expires_at       timestamptz,
  last_health_check_at   timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, external_account_id),
  UNIQUE (tenant_id, id)
);

-- Envelope-encrypted credentials (see packages/vault). Never selected by UI queries.
CREATE TABLE credentials (
  integration_id  uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  version         smallint NOT NULL DEFAULT 1,
  kek_id          text NOT NULL,
  wrapped_dek     text NOT NULL,
  iv              text NOT NULL,
  auth_tag        text NOT NULL,
  ciphertext      text NOT NULL,
  rotated_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE publications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  content_item_id  uuid NOT NULL,
  revision_id      uuid NOT NULL,
  integration_id   uuid,
  idempotency_key  text NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','publishing','published','failed','needs_attention','exported','deleted','dry_run')),
  external_id      text,
  permalink        text,
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  scheduled_for    timestamptz,
  published_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, content_item_id, revision_id) REFERENCES content_revisions(tenant_id, content_item_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id)
);

CREATE TABLE metric_points (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  publication_id  uuid,
  page_url        text,
  metric          text NOT NULL,
  value           numeric NOT NULL,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL CHECK (period_end >= period_start),
  source          text NOT NULL,             -- e.g. "facebook.insights.v25", "gsc.searchanalytics"
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, publication_id) REFERENCES publications(tenant_id, id) ON DELETE CASCADE,
  CHECK (publication_id IS NOT NULL OR page_url IS NOT NULL)
);

CREATE TABLE agent_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent          text NOT NULL,
  model          text NOT NULL,
  input_hash     text NOT NULL,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  cached_tokens  integer NOT NULL DEFAULT 0,
  cost_micros    bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),  -- USD * 1e6
  latency_ms     integer,
  status         text NOT NULL CHECK (status IN ('succeeded','failed','rejected_budget')),
  output         jsonb,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_runs_cost_month ON agent_runs (tenant_id, created_at);

CREATE TABLE wp_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  integration_id  uuid NOT NULL,
  wp_post_id      bigint NOT NULL,
  change_id       text NOT NULL,
  fields          text[] NOT NULL,
  before          jsonb NOT NULL,
  after           jsonb NOT NULL,
  rolled_back_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (integration_id, change_id)
);

CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL,   -- no FK: audit history outlives tenant deletion (retention policy applies)
  actor_type   text NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_id     text NOT NULL,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  before       jsonb,
  after        jsonb,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity ON audit_log (tenant_id, entity_type, entity_id, created_at);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships','brands','sources','brand_dna_versions','claims','campaigns','calendar_slots',
    'content_items','content_revisions','assets','approvals','integrations','credentials',
    'publications','metric_points','agent_runs','wp_changes','audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t);
  END LOOP;
END $$;

-- The tenants table: the app may read/update only the current tenant's row.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());

-- Login needs to list a user's workspaces before a tenant is selected. The auth layer
-- sets app.user_id (transaction-local) after verifying the session; these SELECT-only
-- policies let a user see their own memberships and those tenants' rows, nothing else.
CREATE POLICY membership_self_read ON memberships FOR SELECT USING (user_id = app_current_user());
-- Users: see yourself and members of the current workspace; update only yourself.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users FOR SELECT USING (
  id = app_current_user()
  OR id IN (SELECT m.user_id FROM memberships m WHERE m.tenant_id = app_current_tenant()));
CREATE POLICY users_update ON users FOR UPDATE USING (id = app_current_user()) WITH CHECK (id = app_current_user());

CREATE POLICY tenant_member_read ON tenants FOR SELECT
  USING (id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app_current_user()));

-- Disconnecting an account removes its credential without the web tier ever
-- being able to SELECT credentials. Runs as the owner but still under FORCE RLS,
-- so it can only touch the current tenant's row.
CREATE OR REPLACE FUNCTION remove_credential(p_integration_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH d AS (DELETE FROM credentials WHERE integration_id = p_integration_id AND tenant_id = app_current_tenant() RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM d)
$$;
REVOKE ALL ON FUNCTION remove_credential(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Grants (least privilege for the application role)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO app_user, publisher_user;

-- Mutable tenant data.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  brands, sources, claims, campaigns, calendar_slots, content_items, assets,
  integrations, publications, metric_points, wp_changes
TO app_user;

-- Append-only / immutable records: revisions, approvals, the audit log and the AI cost ledger.
GRANT SELECT, INSERT ON content_revisions, approvals, audit_log, agent_runs TO app_user;
-- Brand DNA: insert proposals, update status (trigger enforces immutability), never delete.
GRANT SELECT, INSERT, UPDATE ON brand_dna_versions TO app_user;

-- Memberships and users are managed by admin/invitation tooling; the app only reads them.
GRANT SELECT ON memberships TO app_user;
GRANT SELECT ON users TO app_user;
GRANT UPDATE (name) ON users TO app_user;

-- Tenants: the app may change only operational columns. Gating flags
-- (publishing_enabled, autonomous_eligible, monthly_ai_budget_cents) are admin-only.
GRANT SELECT ON tenants TO app_user;
GRANT UPDATE (name, automation_mode, paused_at, paused_reason) ON tenants TO app_user;
GRANT SELECT ON platform_settings TO app_user;          -- only admin tooling may pause globally

-- Credentials: the web tier can store (OAuth callback) and remove (disconnect) but never read.
GRANT INSERT ON credentials TO app_user;
GRANT EXECUTE ON FUNCTION remove_credential(uuid) TO app_user;
GRANT app_user TO publisher_user;
GRANT SELECT, UPDATE ON credentials TO publisher_user;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;
GRANT EXECUTE ON FUNCTION app_current_tenant(), app_current_user() TO app_user;

COMMIT;
