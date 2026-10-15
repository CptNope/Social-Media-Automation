=== JAT Connector ===
Requires at least: 6.4
Requires PHP: 8.0
Stable tag: 0.1.0
License: GPLv2 or later

Connects a WordPress site to JAT Marketing OS.

== What it does ==
* Creates draft or scheduled posts.
* Reads and updates SEO titles and meta descriptions for Yoast SEO, Rank Math or All in One SEO, logging every change so it can be rolled back.

== Security ==
* Requests must use a WordPress Application Password (HTTPS only) for a dedicated user AND carry an HMAC-SHA256 signature with a shared secret, a timestamp within 5 minutes and a single-use nonce.
* Every action checks the WordPress capability for that action (per post for SEO changes).
* Post content is filtered with wp_kses_post.
* Only signed input is used: the JSON body and the route itself. Query-string parameters are ignored (they aren't covered by the signature).

== Known limits ==
* Nonce replay protection uses transients (check-then-set). Two identical requests arriving at the same instant could both pass; the timestamp window and signature still apply. An atomic store is planned.
* The SEO change log is a single option updated read-modify-write, so two concurrent SEO updates could lose one log entry (and its rollback). JAT sends SEO changes one at a time.

== Setup ==
1. Install and activate the plugin.
2. Create a user for JAT (Editor, or Author for drafts only) and an Application Password for it.
3. In JAT Marketing OS, connect the site with that username and Application Password; copy the signing secret it shows.
4. Paste the secret under Settings → JAT Connector.

== Status ==
The signature code is unit-tested and checked against the JAT Marketing OS client. The plugin has NOT yet been run on a live WordPress site. Before production use, test on staging with each SEO plugin:
* Yoast SEO post-meta keys (_yoast_wpseo_title, _yoast_wpseo_metadesc) and whether Yoast's indexables refresh after a direct meta update.
* Rank Math post-meta keys (rank_math_title, rank_math_description).
* AIOSEO model API (\AIOSEO\Plugin\Common\Models\Post).
