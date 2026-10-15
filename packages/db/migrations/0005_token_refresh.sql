-- Token refresh for OAuth platforms (X, Google Business Profile, Threads, LinkedIn expiry).
BEGIN;

-- The publisher's background job finds connections whose access tokens expire soon, across
-- tenants. As with due publications, it sees only ids, channel, status and timing.
GRANT SELECT (channel, token_expires_at) ON integrations TO jat_scheduler;

COMMIT;
