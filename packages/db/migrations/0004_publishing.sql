-- Publishing: scheduling, retries, cancellations and the dispatcher's narrow cross-tenant view.
BEGIN;

ALTER TABLE publications ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE publications ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE publications ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE publications DROP CONSTRAINT publications_status_check;
ALTER TABLE publications ADD CONSTRAINT publications_status_check
  CHECK (status IN ('queued','publishing','published','failed','needs_attention','exported','deleted','dry_run','cancelled'));
CREATE INDEX publications_due ON publications (scheduled_for) WHERE status = 'queued';
-- At most one live (queued/publishing) publication per content item.
CREATE UNIQUE INDEX publications_one_live ON publications (content_item_id) WHERE status IN ('queued', 'publishing');

-- One connected account per channel per brand-tenant (MVP: one brand per tenant).
CREATE UNIQUE INDEX integrations_one_per_channel ON integrations (tenant_id, channel) WHERE status <> 'revoked';

-- The dispatcher finds due work across tenants, but may see only ids and timing — never content
-- or credentials. It then processes each publication inside that tenant's RLS scope.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jat_scheduler') THEN
    CREATE ROLE jat_scheduler NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO jat_scheduler;
GRANT SELECT (id, tenant_id, status, scheduled_for, next_attempt_at, updated_at) ON publications TO jat_scheduler;
-- current_user check: publisher_user is a member of jat_scheduler, and a policy granted TO a role
-- also applies to its members. Without the check, publisher_user would see every tenant's rows.
CREATE POLICY scheduler_due_read ON publications FOR SELECT TO jat_scheduler USING (current_user = 'jat_scheduler');
GRANT jat_scheduler TO publisher_user;

-- "Test connection" from the web tier: the web role can't read credentials, so it only asks;
-- the publisher worker runs the check. The scheduler may see which integrations asked, nothing else.
ALTER TABLE integrations ADD COLUMN check_requested_at timestamptz;
GRANT SELECT (id, tenant_id, status, check_requested_at) ON integrations TO jat_scheduler;
CREATE POLICY scheduler_check_read ON integrations FOR SELECT TO jat_scheduler USING (current_user = 'jat_scheduler');

-- Platform-wide pause is read by the publisher (admin tooling sets it).
GRANT SELECT ON platform_settings TO publisher_user;

COMMIT;
