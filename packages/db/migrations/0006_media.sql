-- Media attached to posts: uploads and rendered graphics. The file itself lives in the media
-- store (Cloudflare R2 or a local folder); the post revision records its SHA-256, so an
-- approval covers exactly that file.
BEGIN;

ALTER TABLE assets ADD COLUMN sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE assets ADD COLUMN bytes bigint CHECK (bytes > 0);
ALTER TABLE assets ADD COLUMN duration_ms integer CHECK (duration_ms >= 0);
ALTER TABLE assets ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE assets ADD CONSTRAINT assets_storage_key_format CHECK (storage_key ~ '^t/[0-9a-f-]{36}/[A-Za-z0-9_-]{32}\.(jpg|png|webp|mp4|mov|webm|bin)$');
-- A key belongs to its tenant: the key's tenant segment must match the row's tenant.
ALTER TABLE assets ADD CONSTRAINT assets_storage_key_tenant CHECK (split_part(storage_key, '/', 2) = tenant_id::text);
CREATE UNIQUE INDEX assets_storage_key ON assets (storage_key);
ALTER TABLE assets ADD CONSTRAINT assets_tenant_id_unique UNIQUE (tenant_id, id);

-- What the platform said that a person should know (e.g. "sent to TikTok drafts; finish in the app").
ALTER TABLE publications ADD COLUMN note text;

COMMIT;

-- Assets are immutable records of an approved file: the app only adds them.
REVOKE UPDATE, DELETE ON assets FROM app_user;
