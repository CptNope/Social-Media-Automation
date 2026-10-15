-- Magic-link sign-in and brand onboarding runs.
BEGIN;

-- ---------------------------------------------------------------------------
-- Magic-link tokens. Only token hashes are stored. The app role has no direct
-- access; it can only call the two narrow functions below.
-- ---------------------------------------------------------------------------
CREATE TABLE login_tokens (
  token_hash  text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_tokens_user ON login_tokens (user_id, created_at);
REVOKE ALL ON login_tokens FROM PUBLIC;

-- Issues a token for an existing user. Returns false (and stores nothing) for unknown
-- emails; the web tier shows the same response either way so emails can't be enumerated.
-- Someone spamming requests for a victim's email must not lock the victim out, so instead
-- of refusing, only the 5 newest unused tokens stay valid (older ones are invalidated).
CREATE OR REPLACE FUNCTION issue_login_token(p_email text, p_token_hash text, p_ttl_minutes integer)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  IF p_ttl_minutes < 1 OR p_ttl_minutes > 60 THEN RAISE EXCEPTION 'invalid ttl'; END IF;
  SELECT id INTO v_user FROM users WHERE lower(email) = lower(trim(p_email));
  IF v_user IS NULL THEN RETURN false; END IF;
  INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES (p_token_hash, v_user, now() + make_interval(mins => p_ttl_minutes));
  UPDATE login_tokens SET used_at = now()
  WHERE user_id = v_user AND used_at IS NULL
    AND token_hash NOT IN (SELECT token_hash FROM login_tokens WHERE user_id = v_user AND used_at IS NULL ORDER BY created_at DESC, token_hash LIMIT 5);
  DELETE FROM login_tokens WHERE created_at < now() - interval '7 days';
  RETURN true;
END $$;

-- Single use: returns the user id and marks the token used, or NULL.
CREATE OR REPLACE FUNCTION consume_login_token(p_token_hash text)
RETURNS uuid LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE login_tokens SET used_at = now()
  WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
  RETURNING user_id
$$;

REVOKE ALL ON FUNCTION issue_login_token(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_login_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION issue_login_token(text, text, integer), consume_login_token(text) TO app_user;

-- ---------------------------------------------------------------------------
-- Brand onboarding runs (crawl + Brand DNA extraction jobs)
-- ---------------------------------------------------------------------------
CREATE TABLE onboarding_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  brand_id          uuid NOT NULL,
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','crawling','extracting','ready','failed')),
  website_url       text,
  business          jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_by        uuid NOT NULL REFERENCES users(id),
  dna_version_id    uuid,
  findings          jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts         jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_info      jsonb NOT NULL DEFAULT '[]'::jsonb,
  crawl_summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_micros       bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, brand_id, dna_version_id) REFERENCES brand_dna_versions(tenant_id, brand_id, id)
);
CREATE INDEX onboarding_runs_brand ON onboarding_runs (tenant_id, brand_id, created_at DESC);

ALTER TABLE onboarding_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON onboarding_runs USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON onboarding_runs TO app_user;

-- Evidence is versioned per onboarding run: re-running onboarding must never rewrite the
-- evidence an approved Brand DNA version cites.
ALTER TABLE sources ADD COLUMN onboarding_run_id uuid REFERENCES onboarding_runs(id) ON DELETE CASCADE;
ALTER TABLE sources DROP CONSTRAINT sources_brand_id_evidence_id_key;
CREATE UNIQUE INDEX sources_run_evidence ON sources (brand_id, onboarding_run_id, evidence_id) NULLS NOT DISTINCT;
REVOKE UPDATE ON sources FROM app_user;

-- At most one unfinished onboarding run per brand.
CREATE UNIQUE INDEX onboarding_one_active ON onboarding_runs (brand_id) WHERE status IN ('queued', 'crawling', 'extracting');

-- Sign out everywhere: sessions carry the epoch they were issued in; bumping it revokes them.
ALTER TABLE users ADD COLUMN session_epoch integer NOT NULL DEFAULT 0;
GRANT UPDATE (session_epoch) ON users TO app_user;

-- Proposed versions may be edited (field confirmations); active/superseded are immutable (0001 trigger).
COMMIT;
