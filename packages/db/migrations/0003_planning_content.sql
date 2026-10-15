-- Channel settings, content planning and drafting.
BEGIN;

-- Which channels a client uses and how often. Delivery is "export" until an API adapter is
-- connected and approved for that channel (Phase 4).
CREATE TABLE channel_settings (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id        uuid NOT NULL,
  channel         text NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  posts_per_week  smallint NOT NULL CHECK (posts_per_week BETWEEN 0 AND 21),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, channel),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id) ON DELETE CASCADE
);

-- Default landing page for links in posts (UTM-tagged per post).
ALTER TABLE brands ADD COLUMN website_url text CHECK (website_url IS NULL OR website_url ~ '^https?://');

-- Campaign context from the planner.
ALTER TABLE campaigns ADD COLUMN description text;
ALTER TABLE campaigns ADD COLUMN dna_version_id uuid;
ALTER TABLE campaigns ADD COLUMN plan_notes jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE campaigns ADD FOREIGN KEY (tenant_id, brand_id, dna_version_id) REFERENCES brand_dna_versions (tenant_id, brand_id, id);

-- What each slot is about.
ALTER TABLE calendar_slots ADD COLUMN topic text NOT NULL DEFAULT '' CHECK (length(topic) <= 300);
ALTER TABLE calendar_slots ADD COLUMN notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 1000);
ALTER TABLE claims ADD CONSTRAINT claims_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE calendar_slots ADD COLUMN offer_claim_id uuid;
ALTER TABLE calendar_slots ADD FOREIGN KEY (tenant_id, offer_claim_id) REFERENCES claims(tenant_id, id) ON DELETE SET NULL (offer_claim_id);
ALTER TABLE calendar_slots ADD COLUMN brand_id uuid;
UPDATE calendar_slots s SET brand_id = c.brand_id FROM campaigns c WHERE c.id = s.campaign_id;
ALTER TABLE calendar_slots ALTER COLUMN brand_id SET NOT NULL;
ALTER TABLE calendar_slots ADD FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id) ON DELETE CASCADE;
CREATE INDEX calendar_slots_brand_time ON calendar_slots (tenant_id, brand_id, publish_at);

-- At most one content item per slot.
CREATE UNIQUE INDEX content_items_one_per_slot ON content_items (slot_id) WHERE slot_id IS NOT NULL;

-- Each revision carries the checks that ran on it (deterministic lint + AI review). Immutable like the revision.
ALTER TABLE content_revisions ADD COLUMN findings jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE content_revisions ADD COLUMN review jsonb;

-- Background work (planning, drafting) with progress for the UI.
CREATE TABLE work_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  brand_id     uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('plan', 'draft')),
  campaign_id  uuid,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  input        jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress     jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  started_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns(tenant_id, id) ON DELETE CASCADE
);

-- Jobs run in-process (MVP); a restart can strand a run as queued/running. Runs carry a
-- heartbeat (updated_at) so stale ones can be marked interrupted instead of blocking forever.
ALTER TABLE onboarding_runs ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX work_runs_one_active ON work_runs (brand_id, kind) WHERE status IN ('queued', 'running');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_settings', 'work_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON channel_settings TO app_user;
GRANT SELECT, INSERT, UPDATE ON work_runs TO app_user;

COMMIT;
