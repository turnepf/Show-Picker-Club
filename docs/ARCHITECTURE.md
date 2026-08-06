# Show Picker Club — Architecture

Implementation reference for the Show Picker Club codebase. For the user-facing description, see [`PRODUCT.md`](PRODUCT.md).

## Stack

- **Hosting:** Cloudflare Pages (`shows` project).
- **Backend:** Cloudflare Pages Functions. JavaScript modules under `functions/` route by file path.
- **Database:** Cloudflare D1 (`shows-db`), serverless SQLite at the edge. Single `DB` binding in `wrangler.toml`.
- **Frontend:** Static HTML/CSS/JS, no build step. Vanilla ES6 in `<script>` tags. Service worker for PWA install + offline shell.
- **External APIs:** TMDB (ratings, canonical titles, cast + actor IMDB ids, creator/director + IMDB id, season dates, genres), Anthropic Claude (vibe trait scoring, admin-only batch), Twilio (outbound SMS). *(OMDB retired 2026-07 — TMDB is the sole enrichment source.)*
- **Backups:** Daily wrangler `d1 export` → Google Drive via rclone, GitHub Actions workflow.

The `wrangler.toml` is minimal:

```toml
name = "shows"
pages_build_output_dir = "public"
compatibility_date = "2024-09-23"

[[d1_databases]]
binding = "DB"
database_name = "shows-db"
database_id = "..."
```

## Database

`schema.sql` is the complete schema for a fresh deployment. The numbered files in `migrations/` are the historical upgrade path for existing databases; their one-off data fixes should not be run against a new database.

### `members`
| Column         | Type | Notes                                                 |
|----------------|------|--------------------------------------------------------|
| `slug`         | TEXT PRIMARY KEY | URL slug (`/whitt`).                        |
| `name`         | TEXT NOT NULL    | Full name.                                  |
| `first_name`   | TEXT             | Override for display name (rare collisions).|
| `last_initial` | TEXT             | Suffix used to disambiguate two first-name collisions. |
| `created_at`   | TEXT             | Default `datetime('now')`.                  |
| `calendar_fetched_at` / `calendar_fetch_count`| TEXT / INTEGER | Migration 061. Stamped by `/calendar/<slug>.ics` on every successful fetch (best-effort, never fatal). A subscribed calendar polls on its own schedule, so these are the only signal that the feed is in use at all — surfaced as the Reporting **Calendar** card. |
| `last_login_method`| TEXT          | Migration 059. How they last got in (`apple` | `google` | `email` | `sms` | `demo`), stamped beside `last_login_at` and durable for the same reason. Shown per member in Manage Members. |
| `last_login_at`| TEXT             | Migration 013. Stamped on every session issue and never cleared, so it survives logout/disable (which delete `sessions` rows). Any "last login" / "never logged in" display must read this, not `MAX(sessions.created_at)`. |
| `enrolled_via` | TEXT             | Migration 031. How the account came to exist: `email` \| `apple` \| `google`; NULL only for rows predating self-enrollment. |
| `enroll_ip`    | TEXT             | Migration 058. Origin IP of the signup, backing the per-IP enrollment cap. Deleted with the member. |

### Login identity tables
Login is by one-time code or Sign in with Apple — there are no stored passwords. The relevant tables are included in `schema.sql` and were introduced over time by migrations:

- `member_emails` / `member_phones` — map an email or phone to a member; the address a login code is sent to and matched against.
- `login_otps` — short-lived, single-use email codes (`member_slug`, `code`, `channel`, `expires_at`, `used_at`, and `ip`/`user_agent` of the requester — migration 046). SMS codes are held by Twilio Verify, not stored here, but a marker row with `code=''` still records the request (and its IP) for rate-limiting. The IP columns exist so unrequested codes (someone submitting a member's email/phone) can be traced to a source and blocked at the Cloudflare edge.
- `member_apple_ids` — links an Apple user id (`apple_sub`) to a member, populated on first Apple sign-in by email match so later sign-ins work even behind a private-relay address.

### `shows`
| Column              | Type | Notes |
|---------------------|------|-------|
| `id`                | INTEGER PK | |
| `title`             | TEXT NOT NULL | |
| `network`           | TEXT | |
| `network_url`       | TEXT | Deep link to show on network site (or a search-page placeholder until upgraded). |
| `recommended_by`    | TEXT | Free-text attribution. |
| `rating`            | TEXT | Audience rating string. TMDB's score since 2026-07 (migration 043); was the IMDB score from OMDB before that. Drives Sort-by-Rating and vibe input. |
| `list`              | TEXT NOT NULL | `watching` / `waiting` / `recommending` / `next`. |
| `notes`             | TEXT | |
| `movie`             | INTEGER DEFAULT 0 | Suppresses TMDB season lookups. |
| `full_series`       | INTEGER DEFAULT 0 | 🎬 badge; set when TMDB reports the series ended. |
| `watching_with`     | TEXT | |
| `next_season_date`  | TEXT | ISO date from TMDB. |
| `season_end_date`   | TEXT | ISO date from TMDB. |
| `archived`          | INTEGER DEFAULT 0 | |
| `member_slug`       | TEXT REFERENCES members(slug) | |
| `created_at`        | TEXT | Default `datetime('now')`. May be NULL for seeded shows. |
| `updated_at`        | TEXT | Default `datetime('now')`. Bumped by member edits (not enrichment). |
| `added_by`          | TEXT | `'seed'` for seeded shows, otherwise editor email or `'Anonymous'` for public suggestions. |
| `enriched_at`       | TEXT | Bumped by TMDB enrichment so enrichment can prioritize stale rows. |
| `genres`            | TEXT | Comma-separated, from TMDB. |
| `sort_order`        | INTEGER | Position for the member's "My Order" manual sort (migration 033). NULL = never manually placed. Written only by `POST /api/shows/reorder`, which deliberately does **not** bump `updated_at`. |
| `overview`          | TEXT | Plot synopsis from TMDB (migration 042). |
| `backdrop_url`      | TEXT | Wide 16:9 hero image (TMDB `backdrop_path`, w780). Migration 042. |
| `tmdb_rating`       | TEXT | TMDB audience score "x.y". Since 2026-07 (migration 043) `rating` carries the same TMDB score; `tmdb_rating` is retained because older app builds still read it. Migration 042. |
| `content_rating`    | TEXT | US maturity certification (TV-MA, R, …). Migration 042. |
| `trailer_key`       | TEXT | YouTube video key for the trailer. Migration 042. |
| `director`          | TEXT | Director (movie) or creator(s) (TV). Migration 042. |
| `director_imdb_id`  | TEXT | IMDB id (nm…) of the creator/director, from TMDB external_ids. The detail screen links the name to the IMDB person page, but only for a single-person credit. Migration 043. |
| `runtime`           | INTEGER | Minutes — a film's length, or one episode's for a series. Migration 042. |
| `release_year`      | INTEGER | First release / first-air year. Migration 042. |
| `watch_link`        | TEXT | TMDB/JustWatch "where to watch" page. A **fallback only** — the UI prefers the real deep-link `network_url` and shows this aggregator page only when no deep link exists. Migration 042. |
| `tmdb_id`           | INTEGER | TMDB's id for the matched title. Migration 049. Canonical cross-member join key: a member rating table keys off `(tmdb_id, tmdb_type)` rather than any one member's row, so every member's independent copy of the same show shares one rating pool. Captured on insert/edit whenever enrichment resolves a match (`_shared/enrichment.js`'s `enrichFromTmdbId`/`fetchEnrichment` now return it); NULL for rows added before migration 049 until the one-time `/api/admin-tmdb-backfill` pass fills them in. |
| `tmdb_type`         | TEXT | `movie` or `tv`, alongside `tmdb_id` — TMDB ids aren't unique across the two (movie #550 and tv #550 are different titles), so the pair is the real key. Migration 049. |

### `actors`
Join table for per-show cast.

| Column     | Type | Notes |
|------------|------|-------|
| `id`       | INTEGER PK | |
| `show_id`  | INTEGER REFERENCES shows(id) ON DELETE CASCADE | |
| `name`     | TEXT NOT NULL | |
| `imdb_id`  | TEXT | NULL for seeded rows and legacy enrichments that predate TMDB actor ids. |

### `show_ratings`
Member ratings (docs/PRODUCT.md backlog: "Member ratings"). Migration 053. Keyed off `(tmdb_id, tmdb_type)` rather than any one member's `shows` row, so every member's independent copy of the same title shares one rating pool.

| Column          | Type | Notes |
|-----------------|------|-------|
| `id`            | INTEGER PK | |
| `tmdb_id`       | INTEGER NOT NULL | |
| `tmdb_type`     | TEXT NOT NULL | `movie` or `tv`. |
| `season_number` | INTEGER NOT NULL DEFAULT 0 | `0` = the overall rating; `1+` = that season (matches `seasons_released`'s numbering). A sentinel, not NULL — SQLite's UNIQUE constraint treats every NULL as distinct, so a NULL-based "one overall rating per member" rule wouldn't actually be enforced. |
| `member_slug`   | TEXT NOT NULL REFERENCES members(slug) | |
| `rating`        | INTEGER NOT NULL CHECK 1-10 | |
| `created_at` / `updated_at` | TEXT | |

`UNIQUE (tmdb_id, tmdb_type, season_number, member_slug)` — one row per member per title per season (or overall). `functions/_shared/ratings.js` owns validation (`isValidRating`), the upsert, and `getRatingsSummary()` (club average + count, the viewer's own ratings, and — when viewing a specific other member's copy — that member's ratings too, overall and per season).

Entry is gated to shows on any list except Next Up (`list !== 'next'`), enforced server-side in `PUT /api/shows/:id/rating`; a show with no `tmdb_id` yet (not enriched) can't be rated either. The average/count show on every card regardless of login state — a deliberate, scoped exception to the otherwise-tiny public surface (`GET /api/shows/:id` returns the summary in its public/redacted branch too, never member names or individual scores beyond the specific owner being viewed).

`GET /api/rate-backlog` (session required) backs the bulk-rate flow (the web page was archived in the 2026-08 teardown — see [Frontend pages](#frontend-pages) — and the iOS `RateBacklogView` is the live client): every active show the member has except Next Up and archived rows, left-joined to `show_ratings` for the member's existing overall (`season_number = 0`) rating, unrated shows first. Overall-only by design — each row links to `/<slug>?show=<id>` (the show's detail page, which `showMember()` opens directly via a `show` query param) for season-level rating. `GET /api/rate-backlog-count` returns `{ count }` for the same set of rows — the "Rate my backlog" nav badge, which the main app derives from the library it already has loaded but `shell.js` has no library for. The two share an eligibility clause; change one and change the other, or the badge disagrees with the page it links to.

`GET /api/reporting` (admin-only, backs `/reporting`) reports rating activity alongside the other show metrics: a "People who rated" card (distinct `member_slug`s with an insert/update to `show_ratings` in the same day/week/month/all-time windows as new/edited/archived shows, keyed off `updated_at` so re-rating counts as activity) plus all-time submitted-ratings and distinct-titles-rated totals. Defensive like the other migration-gated reporting fields: falls back to zeros rather than 500ing the dashboard if `show_ratings` isn't there.

Native support: `ShowPickerCore/Sources/ShowPickerCore/Ratings.swift` defines `RatingsSummary`/`SeasonRatingSummary`/`RatingResponse`/`RateBacklogShow`/`RateBacklogResponse`, shared by all three Apple targets; `ShowResponse` carries `ratings` as a sibling of `show` (matching the JSON shape, not nested). iOS gets full entry via `API.rateShow(id:rating:season:)` and a "Ratings" section in `ShowDetailView` (`RatingTapRow`/`RatingEntryRow` in `Views/RatingTapRow.swift`); tvOS and watchOS only read `ratings` off their existing show-detail calls and render it (no write path — both apps are view-only/read-only generally). iOS also has a native bulk rate-your-backlog screen, `RateBacklogView` (`API.rateBacklog(member:)` → `GET /api/rate-backlog`), surfaced next to Subscription audit on Home, the iPad sidebar, and a member's own page — tvOS/watchOS don't get it. Rating is routed through the offline write queue like any other edit: `PendingMutation.Kind.rate` carries `rating`/`season`, `OfflineQueue.enqueueRate`/`pendingRating` queue and expose the latest not-yet-synced value, and `API.rateShow` falls back to queueing when offline instead of throwing.

### `sessions`
| Column          | Type | Notes |
|-----------------|------|-------|
| `id`            | TEXT PK | UUID. |
| `email`         | TEXT NOT NULL | Display/identifier for the session (member's first name or name). |
| `member_slug`   | TEXT | Which member this session can edit. |
| `expires_at`    | TEXT NOT NULL | 30 days, sliding. `/auth/check` extends it to a fresh 30 days (and re-sends the cookie with the new `Expires`) whenever the session is more than a day into its window, so an active member is never logged out for being active. Both halves have to move together — the row decides authorization, the cookie's own `Expires` decides whether the client still sends it. |
| `created_at`    | TEXT | |
| `last_seen_at`  | TEXT | Bumped by `/auth/check`, throttled to once per hour per session. Drives DAU/WAU/MAU in reporting. |
| `auth_method`   | TEXT | Migration 059. How this session was authenticated: `apple` | `google` | `email` | `sms` | `demo`. NULL for sessions minted before the column existed. Counted by `/api/reporting`'s `signin_methods` (7/30/90-day windows) — the number that says whether an auth channel still earns what it costs to run. |
| `platform`      | TEXT | Migration 016. One of `_shared/platform.js#KNOWN_PLATFORMS` (`iphone`, `ipad`, `mac`, `watchos`, `tvos`, `roku`, `web-small`, `web-large`), self-reported via the `X-Client-Platform` header and stamped by `/auth/check`. Deleted with the session on logout/disable — it's a live snapshot, not history; see `member_platforms` for durable per-member tracking. |

### `member_platforms`
Migration 047. Durable "every platform this member has ever used," unlike `sessions.platform` which disappears on logout/disable. Shown as badges on the Manage Members admin page (web `/members`, iOS `ManageMembersView`); the same badges, laid out identically above the roster, double as a filter — tap one to show only members who've ever used that platform, tap it again to clear.

| Column          | Type | Notes |
|-----------------|------|-------|
| `member_slug`   | TEXT | Part of the PK (with `platform`). |
| `platform`      | TEXT | One of `KNOWN_PLATFORMS`; see `sessions.platform` above. |
| `first_seen_at` | TEXT NOT NULL | Set once, on first insert. |
| `last_seen_at`  | TEXT NOT NULL | Updated on every recognized `X-Client-Platform` header (unthrottled — a plain `ON CONFLICT DO UPDATE`; club-scale traffic makes the write volume a non-issue). |

Stamped from two call sites, both via `_shared/platform.js#recordPlatformUsage()`: `_shared/auth.js#getSession()` (every authenticated API call — the reliable catch-all, since native apps send the header on every request) and `auth/check.js` (covers the web app, which only sends the header on that one ping). watchOS never calls `/auth/check` — it relays its session from the phone via WatchConnectivity and calls API endpoints directly — so `getSession()` is its only coverage.

### `failed_logins`
Used by login throttling. Auto-pruned (>7 days) by the daily backup workflow.

| Column         | Type | Notes |
|----------------|------|-------|
| `id`           | INTEGER PK | |
| `ip`           | TEXT NOT NULL | |
| `member_slug`  | TEXT | |
| `created_at`   | TEXT NOT NULL | |

### `show_traits`
Pre-computed taste fingerprint per title, used by the vibe system. Keyed by `LOWER(title)`.

27 trait columns (REAL, 0.0–1.0): `warmth`, `empathy`, `emotional_repair`, `moral_ambiguity`, `darkness`, `cynicism`, `manipulation`, `power_orientation`, `chaos_intensity`, `humor_warmth`, `cruel_humor`, `intellectual_curiosity`, `growth_orientation`, `violence_intensity`, `comfort_coziness`, `community_belonging`, `satire`, `prestige_energy`, `emotional_volatility`, `healing_redemption`, `revenge_energy`, `status_obsession`, `optimism`, `nihilism`, `teamwork`, `absurdism`.

Plus `title_lower` (PK), `title`, `unknown_show` (1 if Claude couldn't identify the show), `generated_at`.

### `member_subscriptions`
Per-member subscription decisions for the Subscription Audit (`/subscriptions`). Added by `migrations/014_member_subscriptions.sql`. The audit itself is **derived** from the `shows` table on every request — this table only stores what can't be computed.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `member_slug` | TEXT NOT NULL | FK to `members`. |
| `network` | TEXT NOT NULL | Canonical network name for derived services, or free text for a manual service. One row per `(member_slug, network)`. |
| `status` | TEXT NOT NULL | `subscribed` / `paused` / `cancelled`. The member's real decision. |
| `monthly_price_cents` | INTEGER | What they pay; `NULL` falls back to the editable default in `_shared/networks.js#DEFAULT_PRICE_CENTS`. |
| `resubscribe_date` | TEXT | Optional ISO `yyyy-mm-dd` reminder; emitted into the member's calendar feed as a "Resubscribe" event. |
| `is_manual` | INTEGER DEFAULT 0 | 1 for a service the member pays for but tracks no shows on (e.g. a sports package). Stays 1 once set (`MAX` on upsert). |
| `created_at`, `updated_at` | TEXT | |

### `household_members`
Members a person shares streaming services with, so the audit pools everyone's shows. Added by `migrations/045_household_members.sql`. Directed and per-member: `member_slug`'s household includes `other_slug` (A adding B doesn't change B's own audit). PK `(member_slug, other_slug)`; the PUT endpoint replaces the whole set. Managed via `GET/PUT /api/household` (`functions/api/household.js`).

## Subscription audit

`GET/PUT /api/subscriptions` (`functions/api/subscriptions.js`), the web page (`subscriptions.html`) was archived in the 2026-08 teardown; the iOS Subscription audit is the live client. Both verbs require a session and operate on the logged-in member.

- **Household pooling.** Before grouping, the GET reads the member's `household_members` and pools active shows across the member + those members. The same title appearing on more than one household member's list is deduped per network, keeping the most-active list (watching > waiting > next up > loved) so the verdict reflects whoever's furthest along. The response includes `household` (the pooled members' slugs + display names) for the "including …" line. Household is invite-based on iOS, the same shape as groups: `POST /api/household/invite` mints a 7-day link (`/household/join?code=…`), the recipient's app accepts it via `POST /api/household/join`, and `POST /api/household/remove` drops someone. You can't add a person to your household from a roster any more than you can add them to a group. `GET /api/household` still returns the current set; `PUT` (whole-set replace) remains for the web modal.
- **GET** groups the (pooled) active shows by canonical network and assigns each service a **verdict**:
  - `keep` — ≥1 show in `watching`.
  - `pause` — nothing watching, but a `waiting` show has a future `next_season_date`; the soonest such date is the suggested resubscribe target.
  - `pause_tba` — `waiting` shows but no announced premiere date.
  - `start` — only `next` ("next up") shows; start one or skip.
  - `cancel` — only finished / `recommending` shows.
  - Manual services (no shows) carry verdict `manual`.
  Saved `member_subscriptions` rows are merged in (status, price, resubscribe date), and totals (service count, est. monthly spend, potential savings) are computed. Savings = sum of price over non-cancelled services whose verdict is `cancel` / `pause` / `pause_tba`.
- **PUT** upserts one service's saved decision. Only the fields the caller actually sends are overwritten (a status change won't wipe a saved price), via per-field `CASE WHEN ?` flags in the `ON CONFLICT` clause. `{ remove: true }` deletes a manual service.

## Private groups

Migration 056: `groups` (name + `creator_slug`), `group_members` (the join
table membership is checked against on every group route), and `group_invites`
(a 24-character token with a 7-day `expires_at`). A group is private to its
members — every endpoint below the group id verifies membership and 403s
otherwise; only the creator can delete.

- **One `Group` payload shape.** Every endpoint that returns a group returns
  `id`, `name`, `creator_slug`, `created_at`, plus the computed `member_count`
  and `is_creator` (1/0 — D1 has no boolean). The Apple apps decode a single
  `ShowPickerCore.Group` from all three, and the detail screen gates its
  Delete action on `is_creator`, so an endpoint that drops those columns
  silently disables it.
- **Group Trending** mirrors `/api/popular` but scoped to the group's members
  and the last 30 days, ranked by how many of them added the title. Each row
  carries `members` (first names) so the apps can caption a row with who added
  it.
- **Joining is a link.** `POST /api/groups/[id]/invite` mints the token and the
  share URL (`/groups/join?token=…`); opening it signed in joins the group,
  signed out it previews the group name and asks for a login.
- **Platforms.** iPhone and iPad create, invite, join, leave and delete. Apple
  TV browses groups read-only (`GroupsListViewTV` / `GroupDetailViewTV`), which
  is why the tvOS API client has only the three read calls. The watch has no
  groups at all. Note that `SwiftUI.Group` collides with the model in any file
  that uses it in type position — spell it `ShowPickerCore.Group` there
  (`CoreImports.swift` re-exports the package into every file of the app).

## Routing

Two routing systems combine:

1. **`public/_redirects`** (handled by Cloudflare Pages):
   - `/privacy` → `/privacy.html` and `/terms` → `/terms.html` (200 rewrites, pretty URLs).
   - `/dorothy` and `/dorothy/` → `/whitt` (301, legacy slug rename).
   - `/*` → `/index.html` (200, SPA fallback).

2. **Pages Functions file routing** (takes precedence over `_redirects`):
   - Any file under `functions/api/`, `functions/auth/`, or `functions/calendar/` becomes a route at that path. Dynamic segments use `[param].js`.

The complete map:

| Route                                  | File                                       | Methods | Auth |
|----------------------------------------|--------------------------------------------|---------|------|
| `POST /auth/login`                     | `functions/auth/login.js`                  | POST    | none |
| `GET /auth/check`                      | `functions/auth/check.js`                  | GET     | none (reads cookie) |
| `GET/POST /auth/logout`                | `functions/auth/logout.js`                 | GET, POST | none (POST is canonical; GET kept for shipped app builds) |
| `GET /api/members`                     | `functions/api/members.js`                 | GET     | none (full names + calendar tokens only with a session) |
| `GET /api/popular`                     | `functions/api/popular.js`                 | GET     | none |
| `GET /api/activity`                    | `functions/api/activity.js`                | GET     | session |
| `GET /api/rate-backlog`                | `functions/api/rate-backlog.js`            | GET     | session — backs `/rate-backlog`, the bulk-rate flow |
| `GET /api/rate-backlog-count`          | `functions/api/rate-backlog-count.js`      | GET     | session — the unrated count alone, for the nav badge |
| `GET /api/recommendations`             | `functions/api/recommendations.js`         | GET     | session (legacy — no longer called by any client) |
| `GET /api/vibe`                        | `functions/api/vibe.js`                    | GET     | session — you and members of your groups only; any other slug is 403 |
| `GET /api/shows`                       | `functions/api/shows.js`                   | GET     | session |
| `GET /api/export`                      | `functions/api/export.js`                  | GET     | session (exports the caller's OWN lists only; plain-text download) |
| `POST /api/shows`                      | `functions/api/shows.js`                   | POST    | session |
| `GET /api/shows/all`                   | `functions/api/shows/all.js`               | GET     | session — your own rows plus those of members you share a group with |
| `GET /api/shows/check`                 | `functions/api/shows/check.js`             | GET     | session |
| `POST /api/shows/share`                | `functions/api/shows/share.js`             | POST    | retired 2026-07 — returns 410 Gone |
| `GET /api/shows/[id]`                  | `functions/api/shows/[id].js`              | GET     | none; catalog fields only unless the session owns the show (notes, watching_with, recommended_by are owner-only). `group_watchers` is session-only and group-scoped — see below. `list` is present-but-empty for a logged-out visitor rather than absent: the Apple clients decode it non-optionally, and omitting it failed the whole payload, blanking a public show card whose catalog fields were all being sent |
| `PUT /api/shows/[id]`                  | `functions/api/shows/[id].js`              | PUT     | session |
| `DELETE /api/shows/[id]`               | `functions/api/shows/[id].js`              | DELETE  | session |
| `PUT /api/shows/[id]/move`             | `functions/api/shows/[id]/move.js`         | PUT     | session |
| `POST /api/shows/reorder`              | `functions/api/shows/reorder.js`           | POST    | session (own rows only) |
| `PUT /api/shows/[id]/archive`          | `functions/api/shows/[id]/archive.js`      | PUT     | session |
| `GET /api/shows/[id]/actors`           | `functions/api/shows/[id]/actors.js`       | GET     | none |
| `PUT /api/shows/[id]/rating`           | `functions/api/shows/[id]/rating.js`       | PUT     | session (own copy only, list != Next Up, tmdb_id required) |
| `POST /api/suggestions`                | `functions/api/suggestions.js`             | POST    | retired 2026-07 — returns 410 Gone |
| `GET /api/groups`                      | `functions/api/groups.js`                  | GET     | session — the caller's own groups |
| `POST /api/groups`                     | `functions/api/groups.js`                  | POST    | session — creates the group, joins the caller, returns a first invite |
| `GET /api/groups/[id]`                 | `functions/api/groups/[id].js`             | GET     | session + membership (403 otherwise) |
| `DELETE /api/groups/[id]`              | `functions/api/groups/[id].js`             | DELETE  | session + creator |
| `POST /api/groups/[id]/invite`         | `functions/api/groups/[id]/invite.js`      | POST    | session + membership — mints a 7-day token |
| `POST /api/groups/[id]/leave`          | `functions/api/groups/[id]/leave.js`       | POST    | session + membership |
| `GET /api/groups/[id]/trending`        | `functions/api/groups/[id]/trending.js`    | GET     | session + membership — top 10 titles the group added in 30 days |
| `GET /api/groups/join?token=`          | `functions/api/groups/join.js`             | GET     | session joins; without one, returns a name-only preview |
| `POST /api/enrich`                     | `functions/api/enrich.js`                  | POST    | session or `CRON_SECRET` header |
| `POST /api/sync-urls`                  | `functions/api/sync-urls.js`               | POST    | session (demo member's rows excluded as URL sources) |
| `GET /api/reporting`                   | `functions/api/reporting.js`               | GET     | admin session |
| `POST /api/account-delete`             | `functions/api/account-delete.js`          | POST    | session; hard-deletes the caller's account after an emailed code confirms |
| `POST /auth/enroll`                    | `functions/auth/enroll.js`                 | POST    | signup code from `enroll_otps` |
| `POST /auth/google`                    | `functions/auth/google.js`                 | POST    | Google ID token (inert unless `GOOGLE_CLIENT_ID` set) |
| `GET /auth/config`                     | `functions/auth/config.js`                 | GET     | none — public flags/keys for the login UI |
| `POST /api/admin-member-disable`       | `functions/api/admin-member-disable.js`    | POST    | admin session |
| `POST /api/admin-member-role`          | `functions/api/admin-member-role.js`       | POST    | admin session — promote/demote `members.is_admin`; refuses to demote the last admin |
| `POST /api/admin-member-merge`         | `functions/api/admin-member-merge.js`      | POST    | admin session — merge a duplicate member account into the kept one, then delete the duplicate |
| `GET/POST /api/admin-dupe-ignores`     | `functions/api/admin-dupe-ignores.js`      | GET, POST | admin session — list / dismiss / restore Possible-duplicates matches |
| `POST /api/admin-vibe-fill`            | `functions/api/admin-vibe-fill.js`         | POST    | admin session or `CRON_SECRET` header |
| `POST /api/admin-url-cleanup`          | `functions/api/admin-url-cleanup.js`       | POST    | admin session |
| `POST /api/admin-tmdb-backfill`        | `functions/api/admin-tmdb-backfill.js`     | POST    | admin session — one-time `tmdb_id`/`tmdb_type` backfill for rows added before migration 049; call repeatedly until `remaining` is 0, then review `unresolved` manually |
| `POST /api/admin-sms-test`             | `functions/api/admin-sms-test.js`          | POST    | admin session |
| `POST /api/admin-fill-watch-urls`      | `functions/api/admin-fill-watch-urls.js`   | POST    | admin session or `CRON_SECRET` header |
| `POST /api/admin-demo-reset`           | `functions/api/admin-demo-reset.js`        | POST    | admin session or `CRON_SECRET` header |
| `GET /calendar/[slug].ics`             | `functions/calendar/[slug].js`             | GET     | `?key=<calendar_token>` (per-member secret) |

The public (no-session) surface is deliberately small: the member roster
(first names + counts), Trending, catalog-level show detail + cast for the
Trending screen, and the auth/signup endpoints. Everything derived from
members' libraries — lists, notes, activity, cross-library search — needs a
logged-in session. "Admin session" = a session whose member row has
`members.is_admin = 1` (see Authentication).

The `[slug]` param matches the full final segment (including `.ics`); the handler strips the suffix.

### Notable query params

- `GET /api/members` — returns every member with derived fields:
  - `show_count`: total active shows across all lists.
  - `watching_count`: active shows on the Watching list.
  - `waiting_count`: active shows on the list now labeled "Awaiting" in the UI (the stored value is still `waiting`, so the field name is unchanged).
  - `last_activity_at`: `MAX(COALESCE(updated_at, created_at))` over the member's shows where `added_by != 'seed'`. Editing or archiving a seeded row doesn't count — only self-added, suggested-in, or shared-in shows register. NULL `added_by` predates the column and is treated as engaged since seeds always carry `added_by='seed'`. This is the primary roster sort key on every client.

  Rows are ordered by `last_activity_at DESC NULLS LAST, name`. Every client roster (web home + member-page sidebar, iPhone/iPad home, Apple TV home) keeps that order — most recent activity first, with the active-show count (Watching + Next Up + Loved) only as a tiebreaker. The web home features the top 6; the rest go behind a "Show all members" disclosure.
- `GET /api/shows?member=<slug>&include_archived=1` — `include_archived=1` is set by the per-member search modal so archived rows can be found.
- `GET /api/shows/[id]` — `group_watchers`: a sibling of `show`/`ratings`, listing other members of the *viewer's* groups who have this same title on their Watching list (`{ slug, name }`, first names only, sorted). Session-only and group-scoped — the viewer and the row's owner are both excluded, and nobody the viewer doesn't already share a group with can appear, so this stays inside the "everything derived from members' libraries needs a session" rule. Copies are matched the same way the rest of the app matches a title across members: `tmdb_id` when the row has one, else case-insensitive title. `[]` for a logged-out visitor or a member in no groups. Rendered as the "Also watching" row directly above Network on the iOS show card and directly above the watch button on tvOS.

## Authentication

### Login flow

1. `POST /auth/login` with `{phone, code}` or `{email, code}` (codes are requested first via `POST /auth/request-code`). Sign in with Apple uses `POST /auth/apple` with Apple's identity token instead.
   - `request-code` caps a member to 5 code sends/hour, caps any single source IP to 10 sends/hour across all members (`MAX_PER_IP_PER_HOUR`, skipped when `CF-Connecting-IP` is missing so a shared "unknown" bucket can't lock out unrelated members), and logs the requester's IP on every row. On the **web** email form it also requires a Turnstile token (returns `403 {error:'captcha'}` on failure, checked *before* the membership lookup so it can't be used to probe which emails are members). This is gated on a browser `Origin` header so native iOS/tvOS email/phone login — which can't produce a Turnstile token — is never challenged, and is inert unless `TURNSTILE_SECRET_KEY` is set. Sending a code never exposes it to the requester (it only ever goes to the address already on file), and the verify step's per-IP + per-member failure caps make the 6-digit code non-brute-forceable, so unrequested codes are a nuisance, not an account risk.
2. Throttle check: 5 failed attempts per IP in 15 minutes → 429 with `Retry-After`.
3. Resolve the member: phone → `member_phones` + Twilio Verify; email → `member_emails` + `login_otps`; Apple → verify the token, then `member_apple_ids` (or first-time email match against `member_emails`).
4. On success: insert a `sessions` row (UUID id, member's name as `email`, 30-day `expires_at`), set an HttpOnly + Secure + SameSite=Lax `session=` cookie, return the slug.
5. On failure: insert a `failed_logins` row, return 401.

`functions/_shared/auth.js` exports `getSession(request, env)` which reads the cookie, queries the session row, checks `expires_at` and that the member isn't disabled (`members.disabled`, migration 030), and returns `{email, member_slug}` or `null`. Every mutating endpoint and `/api/reporting` calls `getSession` first. Disabling a member (`POST /api/admin-member-disable`, or the Disable button on `/members`) also deletes their sessions, so bans are immediate.

Admin endpoints are gated by `_shared/admin.js#isAdmin()` — a valid session whose member row has `members.is_admin = 1` (migration 029). Admin rights live in the database, so admins are added/removed with an `UPDATE members SET is_admin = ...`, not a code change. There is no separate admin secret; an admin just needs to be logged in. Endpoints that need to know *which* admin acted use `getAdminSession()` from the same module.

Rate limits on `POST /auth/login`: 5 failed attempts per IP **and** 10 failed attempts per member account per 15 minutes → 429 with `Retry-After`. The per-member cap stops a distributed guesser who knows a member's email/phone from brute-forcing a 6-digit code across many IPs.

Scheduled-job endpoints accept an `X-Cron-Secret` header compared in constant time (`_shared/secrets.js#cronAuthorized`).

### Self-enrollment (migration 031; approval retired in migration 058)

Signing up is the only way a member row is created — there is no operator-created path, no `/join` request queue, and no approval step. Unknown identities create accounts directly: `/auth/request-code` sends a signup code (`enroll_otps`) for unknown emails, `/auth/login` answers `{needs_name:true}` for a valid signup code, and `/auth/enroll` completes it; `/auth/apple` and `/auth/google` enroll unrecognized identities directly (asking the client for a name via `{needs_name:true}` when the token doesn't carry one). A new member is a full member immediately: on the roster, in cross-library search, activity, trending, and vibe like anyone else. Guards live in `_shared/enroll.js`: global daily circuit breaker (`SELF_ENROLL_MAX_PER_DAY`, default 20 — counts `members` rows with a non-NULL `enrolled_via`), a per-IP cap of 3/day (counts `members.enroll_ip`), a per-email code cap, optional Turnstile (`TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY`, fail-open when unset), a reserved-slug blocklist (`_shared/create-member.js#RESERVED_SLUGS`), and an operator email per signup (capped 10/hour; its button links the new member's page, `showpicker.club/<slug>`, so it opens the app on iPhone/iPad rather than the browser — the roster is demoted to a plain link because `/members` is AASA-excluded and can only open in a browser). Members self-delete via `/api/account-delete` (fresh emailed code, `channel='delete'` in `login_otps`, hard delete — the member row carries the last of the enrollment record, so nothing survives it).

**Retired 2026-08 (migration 058).** `members.approved` (the "held" state that hid a new account from the roster, vibe, search, activity, and trending), the `signup_requests` table, the `/join` request form and its `POST /api/signup-request` endpoint, `GET/POST /api/admin-signup-requests`, `POST /api/admin-member-approve`, and the `SELF_ENROLL` kill switch are all gone. `/join` 301s to `/`. `DEMO_APPLE_FALLBACK` went with them: signup now catches every unrecognized Apple identity that carries an email, so the fallback branch was unreachable — App Review uses the `DEMO_LOGIN_EMAIL`/`DEMO_LOGIN_CODE` login.

**Registration name capture.** `_shared/enroll.js#validFullName()` requires a first *and* last name (at least two whitespace-separated tokens, 2–60 characters total, ≥1 Unicode letter, no control chars/angle brackets) — a single-word name is rejected with `'Enter your first and last name.'` before any member row is created. Self-enrollment is the only registration path, so every member is guaranteed a `last_name` at creation time. (Manual-add, retired 2026-07, was the one path where `last_name` was always optional; its removal plus this check is what closed the gap that let one member register with no last name.)

Enrollment responses include `enrolled: true` alongside the usual `{success, slug}` session payload (`issueSession`'s `extra` param); plain logins omit it. Native clients ignore the extra key. The flag existed for the web frontend's GA4 `sign_up` conversion event, and `/welcome` (`welcome.html`) was the stable confirmation URL registered with Google Ads' page-based conversion tracking — **both went away with the web app in 2026-08.** There is no web signup any more, so that conversion can never fire; `/welcome` 301s to `/`, and the Google Ads Smart campaign's conversion setting is pointing at a dead URL until someone re-points it. The `enrolled` flag itself is harmless and still returned.

### Demo account

`DEMO_LOGIN_EMAIL` + `DEMO_LOGIN_CODE` (Cloudflare secrets) enable a reviewer/demo login: that one email signs in with a fixed code. With the secrets unset, all of it is inert. (`DEMO_APPLE_FALLBACK`, which routed unrecognized Apple IDs into the same demo member, was removed in migration 058 — signup turns those identities into real accounts before the fallback could run.)

The demo member's data auto-resets (`_shared/demo.js`): each demo sign-in snapshots the account's shows/actors/subscriptions as a baseline (if clean) and arms a reset for one hour later. The reset runs lazily at the next demo sign-in and daily via the `demo-reset.yml` GitHub Action → `POST /api/admin-demo-reset`. The demo member's rows are ignored as URL-sync sources. (Cross-member writes — suggestions, shares — were retired for everyone in 2026-07.)

### Session activity tracking

`/auth/check` is hit on every page load by the SPA. It bumps `sessions.last_seen_at`, but throttled — the `UPDATE` clause only fires when `last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 hour')`. This means at most one write per session per hour, with no read-then-write.

`last_seen_at` feeds **Reporting** only: DAU / WAU / MAU = `COUNT(DISTINCT member_slug) FROM sessions WHERE last_seen_at >= ...`. The home-page member ordering is library-based (`last_activity_at` on `/api/members`), not session-based.

Platform breakdown (Reporting's "Active by platform" and the Manage Members badges) reads `_shared/platform.js#KNOWN_PLATFORMS` — the single source of truth for valid `X-Client-Platform` values, imported by both `_shared/auth.js` and `auth/check.js` so they can't drift out of sync with each other (they used to define it separately, and the duplicate silently dropped `watchos`).

Durable login tracking is separate: `members.last_login_at` (stamped by `_shared/session.js#issueSession` on every login). The `sessions` table cannot answer "when did this member last log in" — logout, admin disable, and account deletion all delete session rows — so the admin member list (`/api/admin-member-emails`) and the engagement script read `last_login_at`, falling back to sessions only when the column is NULL. The endpoint normalises the value to fraction-less UTC ISO (`2026-07-19T08:30:00Z`) because the shipped iOS admin screen's `ISO8601DateFormatter` rejects fractional seconds.

## Frontend pages

**The web member app was removed in 2026-08.** `showpicker.club` is a marketing
site: a pitch, the public Trending shelf, and an App Store link. What still
deploys from `public/` is `index.html` (the marketing page), `privacy.html`,
`terms.html`, `sms.html` (all three are linked from the App Store listing and
from each other), `styles.css`, `favicon.svg`, the `sw.js` tombstone, `_headers`,
`_redirects`, and `.well-known/`. Nothing else.

The retired pages were **moved, not deleted**, to `archive/web/` at the repo root
— outside `pages_build_output_dir`, so they no longer deploy but are one
`git mv` from coming back. That set is: the member SPA (`archive/web/member-app.html`,
formerly `public/index.html`), `groups.html`, `rate-backlog.html`,
`subscriptions.html`, `vibe.html`, the four admin tools (`members.html`,
`reporting.html`, `url-cleanup.html`, `vibe-admin.html`), `welcome.html`, and the
shared front-end scripts they depended on (`shell.js`, `nav.js`,
`show-renderer.js`, `app-banner.js`).

Consequences worth knowing before you go looking for them:

- **There is no web sign-in any more.** The SPA carried the entire login UI, so
  archiving it removed email-code, Sign in with Apple, and Sign in with Google
  from the browser. The `/auth/*` endpoints themselves are untouched — the Apple
  apps run on them — and restoring the page restores the flow.
- **The four admin tools are iOS-only now.** Reporting, Manage members, Show
  Cleanup and Vibe trait scoring all exist in the iPhone/iPad app, which is why
  they were safe to pull.
- **`welcome.html` was the Google Ads conversion URL.** With no web signup it can
  never fire again; the Smart campaign's conversion setting is now pointing at a
  page that 301s to `/`.
- **CSP got tighter with the teardown** (`public/_headers`): the Apple, Google
  and Turnstile script/frame/form-action sources existed only for web sign-in and
  are gone. What remains covers Google Analytics, Cloudflare Insights, and TMDB
  poster art.

### `index.html` — the marketing page

Self-contained: hero, four feature cards, the Trending shelf, and a footer.
Trending comes from the public `GET /api/popular` (logged out it names no
members — see [Public surface](#public-surface)), rendered by ~60 lines of
inline JS with skeleton placeholders and an explicit failure message rather than
skeletons that pulse forever. It also carries the retired-PWA sweep that used to
live in the SPA: unregister any surviving service worker and drop its caches, so
old home-screen installs don't keep serving a member app that no longer exists.

The App Store call-to-action tailors only its **wording** per device (iPhone /
iPad / Mac), never its behavior. A browser cannot detect whether the app is
installed — there is no API, and the custom-URL-scheme probe fires an OS dialog
and fails silently in Safari. Apple's own machinery covers it instead: the
`apple-itunes-app` meta tag renders OPEN vs GET in iOS Safari, Safari on every
Apple platform offers "Open in app" for the universal-link domain, links arriving
from outside a browser (Mail, Messages) route straight to the app, and the App
Store page itself shows Open when the app is already installed.

### Redirects

`public/_redirects` 301s every retired path to `/`: `/join`, `/setup`,
`/requests`, `/admin`, `/welcome`, `/groups`, `/rate-backlog`, `/subscriptions`,
`/vibe`, `/members`, `/reporting`, `/url-cleanup`, `/vibe-admin`.

Member slugs are deliberately **not** in that list. They keep falling through the
SPA-era catch-all (`/*  /index.html  200`), which is a rewrite rather than a
redirect, so `showpicker.club/patrick` keeps its URL and renders the marketing
page. That is what lets iOS and macOS match it against
`.well-known/apple-app-site-association` and open the app instead of ever
fetching the page. A 301 would still work on Apple devices — the OS resolves the
link before any request goes out — but it would throw away the member context on
every other device, and on a shared link that context is the whole point.

## Universal links

`public/.well-known/apple-app-site-association` (served as `application/json` via a `_headers` rule — it has no extension) claims showpicker.club URLs for the iOS app (`NQ6AJVVBBJ.net.patrickturner.showpickerios`): member pages and `/` open in-app when tapped from another app; API/auth/calendar/admin paths and web-only pages (`/vibe`, `/subscriptions`, legal pages) are excluded and stay in the browser. The app side is the `applinks:showpicker.club` Associated Domains entitlement (iOS + Catalyst) plus `route(url:)` handlers in `HomeView` (iPhone: pushes the member) and `IPadHomeView` (focuses the member in the sidebar, honoring the `#list` fragment web URLs carry). Cold-launch links park in `pendingLink` until the roster loads; the `dorothy` → `whitt` slug redirect is mirrored. Apple's CDN caches the AASA file (~hours), so entitlement/AASA changes take a re-install or a day to propagate to devices.

## Native clients

Native SwiftUI apps for iOS, tvOS, and watchOS call the same public `/api/*` endpoints as the web. They share a `ShowPickerCore` Swift package (at the repo root) that holds the `Show` / `Actor` / `ShowList` models and their response wrappers, and are opened together via `ShowPickerClub.xcworkspace`. iOS and tvOS share one bundle id (`net.patrickturner.showpickerios`) and ship as a single universal App Store app (iPhone + Apple TV). The watchOS app (`watch/ShowPickerWatch`) is paired to the iPhone and receives its session via WatchConnectivity; its reads are public. Platform usage tracking now includes a `watchos` platform value.

A native **Roku** channel (`roku/`, SceneGraph/BrightScript) hits the same endpoints and behaves like the tvOS app, built from standard Roku controls. It self-identifies as `X-Client-Platform: roku` (added to `KNOWN_PLATFORMS`). Because Roku has no cookie jar, the channel captures the `session=<uuid>` cookie from `/auth/login`'s `Set-Cookie`, persists it in the Roku registry, and replays it as a manual `Cookie` header on every request (`roku/components/tasks/ApiTask.brs`). Like the other native clients it sends no `Origin` header, so `/auth/request-code` never issues a Turnstile challenge. Roku platform limits mean streaming deep links and trailers behave differently than on tvOS (see `roku/README.md`). Not part of the Cloudflare Pages output (`pages_build_output_dir = "public"`), so it doesn't affect the web deploy.

## Service worker + PWA (retired 2026-08)

The web app is no longer installable. `public/manifest.json` is gone, along with the `<link rel="manifest">` and `apple-mobile-web-app-*` tags those pages carried, and the CSP's `manifest-src` directive. The native Apple apps cover the install-to-home-screen case; the web is a browser page again, with no offline caching.

**`public/sw.js` is retained deliberately, as a tombstone** — do not delete it yet. It now registers no `fetch` handler and does one thing on `activate`: clear every Cache Storage bucket, then `self.registration.unregister()`. This is the only way to evict the workers already installed on members' devices. Deleting the file would not do it: `_redirects` maps `/*` to the SPA shell, so `/sw.js` would return index.html as `text/html` with a 200. A 404 unregisters a worker; an HTML 200 fails the update check on a MIME mismatch and leaves the old worker and its stale cache installed indefinitely. `index.html` also runs a `getRegistrations().unregister()` + `caches.delete()` sweep on load, so members who reach a member page are cleaned up immediately rather than on the browser's next update check.

`worker-src 'self'` stays in the CSP while the tombstone drains. Once `/sw.js` stops seeing traffic, both it and that directive can go.

## Security headers

`public/_headers` applies to every response under `/*`:

- **Content-Security-Policy:** `default-src 'self'`, plus `'unsafe-inline'` for scripts and styles (the SPA uses inline event handlers), and explicit allow-list for Google Analytics and Tag Manager. No third-party iframes, no inline base URI.
- **Strict-Transport-Security:** `max-age=31536000; includeSubDomains`.
- **X-Frame-Options:** `DENY`.
- **X-Content-Type-Options:** `nosniff`.
- **Permissions-Policy:** disables camera, microphone, geolocation, payment, USB, accelerometer, gyroscope, magnetometer, interest-cohort.

The deploy smoke test verifies these headers are present after each push.

## External APIs

### OMDB (retired 2026-07)
- Removed entirely. It used to supply the IMDB `rating` and a canonical-title override; the app now consolidates on TMDB's audience score (`rating` carries it — migration 043) and drops the `OMDB_API_KEY` secret. Kept here as a note so old references in commit history make sense.

### TMDB
- Env: `TMDB_API_KEY` (legacy v3 key for some calls), `TMDB_TOKEN` (v4 bearer token).
- Used by `_shared/enrichment.js` and `enrich.js`. **Sole enrichment source.**
- Returns canonical title, audience `rating` (vote_average), cast (first 4) with per-actor IMDB IDs, the creator/director + their IMDB id (`director_imdb_id`, via a `/person/{id}/external_ids` call), genres, next-episode-to-air date, last-episode date, status (`Ended` / `Canceled` → `full_series=1`).

### Anthropic Claude
- Env: `ANTHROPIC_API_KEY`.
- Only used by `/api/admin-vibe-fill`.
- Model: `claude-sonnet-4-6`. Max tokens: 1024 per show.
- System prompt: ~1000 tokens of calibration instructions for the 27-trait rubric, cached `ephemeral` so repeated batch calls hit the prompt cache.
- Handles 429 with the API's `Retry-After`, capped at 60s backoff.

### Twilio
- Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`.
- Used by `_shared/sms.js#sendSms` — every outbound SMS goes through this single helper (login codes, signup verification, recommendation alerts).
- Basic-auth POST to `/2010-04-01/Accounts/{sid}/Messages.json` with form-encoded `To`, `From`, `Body`.
- Returns `{ ok, sid, status }` on success, `{ ok: false, error, code }` on failure. Callers that shouldn't fail loudly (e.g. share/suggest alerts) can check `ok` and silently swallow.
- Test endpoint `/api/admin-sms-test` lets the operator confirm the credentials and a destination handset round-trip without touching the login flow.

## Enrichment

Two surfaces:

### Synchronous (`_shared/enrichment.js#fetchEnrichment`)
Called from `POST /api/shows` (and edit / suggestion paths). Returns `{canonicalTitle, rating, actors, directorImdbId}` plus the richer detail fields (see below) so the new row inserts with everything already filled in. TMDB is the sole source; `rating` is TMDB's `vote_average`.

**Canonical people + cast depth (migration 060).** Cast used to be capped at
4 per title, which routinely cut a major character, and every actor was stored
per show — the same person on five shows was five independent rows, so an IMDB
id resolved on one show did nothing for the others. `people` (keyed on TMDB's
person id) and `people_by_name` (name → imdb_id, for creators and legacy rows)
are what we already know: `_shared/people.js#knownByPersonIds` skips the TMDB
`/person/{id}/external_ids` call for anyone we've seen before, which is what
makes storing `CAST_DEPTH = 12` affordable inside the subrequest budget when a
club's shows share actors constantly. `fillActorIdsFromKnownPeople()` runs on
every `/api/enrich` call and links unlinked actor rows from that cache in pure
SQL, with no TMDB requests at all — the metered backfill pass only handles
what the cache can't. `actors.ord` stores TMDB's billing order so "the first
few" means the principals. Creators come back from `GET /api/shows/:id` as a
`creators` array of `{name, imdb_id}` (up to 4, resolved per name): `director`
is one comma-joined string carrying a single id for the first credit, so a
co-created show could previously link none of its creators.

**Rich detail fields (migration 042).** The one TMDB detail call already made pulls extra data via `append_to_response=credits,external_ids,videos,watch/providers,{content_ratings|release_dates}` — a single HTTP request, no extra subrequest budget. `extractTmdbDetailFields()` (exported from `enrichment.js`, shared by the add-time path and the background passes) pulls `overview`, `backdrop_url`, `tmdb_rating`, `content_rating`, `trailer_key`, `director`/creator, `runtime`, `release_year`, plus a **provider network**
(for a series, `runtime` reads TMDB's `episode_run_time`, then falls back to
`last_episode_to_air.runtime` and `next_episode_to_air.runtime` — that array is
empty for a large share of modern shows, which used to leave TV with no length
at all) and a **watch link** from `watch/providers` (US flatrate). The provider name feeds `network` only when `knownNetwork()` maps it to one of our services (so unaliased variants like "…with Ads" are skipped); the `watch_link` is a JustWatch/TMDB aggregator page stored separately and used by the UI **only as a fallback** when there's no real deep-link `network_url`. Deep links themselves are unchanged — still member paste, sibling inheritance, or the Watchmode lookup (`_shared/watch-providers.js`).

On insert, `POST /api/shows` also looks for any other member's active copy of the same title that already has a deep-link `network_url` (and a `network`). If one exists, the new row inherits both fields instead of falling back to the search-URL placeholder. So a show that someone else has already curated lands in the new member's library with the real URL on day one — never needs to go through `/url-cleanup`.

### Background (`POST /api/enrich`)
A logged-in member's page calls this fire-and-forget on load. TMDB-only since OMDB was retired:

- A TV pass over active non-movie shows (ordered by `COALESCE(enriched_at, '1970-01-01') ASC` so the stalest refresh first) plus a separate movie pass. Writes `next_season_date`, `season_end_date`, `full_series`, `genres`, poster/logo, and the detail fields — `overview`, `tmdb_rating`, `rating` (converges to the fresh TMDB score), `director`/`director_imdb_id`, etc. Most are coalesced (never overwrite an existing value); `rating` is refreshed from TMDB so old OMDB values migrate over time. Then propagates the catalog fields to every member's copy of the title and bumps `enriched_at`. `director_imdb_id` costs one extra `/person/{id}/external_ids` call per matched show.
- An actor-IMDB-id backfill re-runs TMDB enrichment for any title whose cast rows still lack ids. `mode: 'posters'` (alias `skip_omdb`) runs only the small poster catch-up batch so an artwork backfill fits within the subrequest budget. The response's `enriched` counter is retained but always 0 now (the OMDB ratings/actors pass it counted is gone).

`updated_at` is **not** touched by enrichment — only by member-initiated writes. This is what lets `updated_at != created_at` cleanly distinguish "the member touched it" from "we auto-enriched it."

`POST /api/sync-urls` is a separate maintenance call also triggered from the member page (throttled to 1/day per browser via `localStorage`). It finds shows where one member has a real `network_url` for a title and another member's copy has only a search-URL placeholder, and copies the good URL over.

## Networks

Source of truth: `functions/_shared/networks.js`. Each entry has:

- `stored` — exact string written to `shows.network`. The modern streaming-service brand (e.g. `HBO Max`, `Paramount+`, `Peacock`).
- `display` — what appears in the Add / Suggest dropdowns; includes the sub-brand hint in parens so members find their way ("Paramount+ (including CBS, MTV, …)").
- `aliases` — older / sub-brand names that get folded into this canonical when matching user input or migrating data.
- `search` — `{ base, param?, extra? }` template for the network's search page. Used as the fallback `network_url` when the member picks a network but doesn't paste a deep link.

`canonicalNetwork(name)` (from the same module) returns the canonical `stored` for any alias-or-stored name (case-insensitive). `POST /api/shows` and `PUT /api/shows/[id]` both run incoming `network` values through it so an alias submitted via API or pasted in the "other" field still ends up consistent in the DB.

`migrations/002_consolidate_networks.sql` ran a one-shot rewrite to fold pre-existing `HBO → Max`, `NBC → Peacock`, `Showtime → Paramount+`, etc. across all member rows. `migrations/003_rename_max_to_hbo_max.sql` then renamed the canonical from `Max` back to `HBO Max`.

## Calendar feed

`functions/calendar/[slug].js` builds an RFC 5545 iCalendar document on every request. The feed authenticates with `?key=<members.calendar_token>` (calendar apps can't log in); a missing or wrong key 404s, indistinguishable from an unknown member. The web member page and the iOS app only surface the subscribe link to logged-in sessions, since `/api/members` withholds tokens otherwise.

- **Slug param:** `params.slug` is the full final segment, e.g. `whitt.ics`. The handler strips `.ics`.
- **Membership check:** 404 if the slug isn't a known member.
- **Query:** all active shows for that member with `list IN ('watching','waiting')` and `(next_season_date IS NOT NULL OR season_end_date IS NOT NULL)`.
- **Events emitted:**
  - One per show with `next_season_date` (uid: `show-<id>-premiere@showpicker.club`).
  - One per show with `season_end_date != next_season_date` (uid: `show-<id>-finale@showpicker.club`).
  - One per `member_subscriptions` row with `status = 'paused'` and a `resubscribe_date` set (uid: `resub-<slug>-<network-slug>@showpicker.club`, summary `Resubscribe to <Network>`). These come from the Subscription Audit.
- **Event fields:**
  - `SUMMARY`: `<Title> on <Network>` (or just `<Title>` if no network).
  - `URL`: the show's `network_url` if it's a real deep link (not a `/search` or `/s?` placeholder), else the member's app page.
  - `DESCRIPTION`: list label, recommender (if any), network, and a link back to the member's app page.
  - All-day events: `DTSTART;VALUE=DATE:YYYYMMDD`, `DTEND` = next day (DTEND is exclusive in iCal).
- **Headers:** `Content-Type: text/calendar; charset=utf-8`, `Cache-Control: public, max-age=3600`. Plus `REFRESH-INTERVAL;VALUE=DURATION:PT24H` and `X-PUBLISHED-TTL:PT24H` so calendar clients know not to thrash.
- **Line folding:** RFC 5545 requires lines > 75 octets to fold with a leading space on continuation lines; the handler implements this.

## Recommendations (legacy)

> **No longer used by any client UI.** The "Picks for You" feature was removed from the web, iOS, and tvOS clients. No client calls this endpoint anymore; the backend is retained as-is for backwards compatibility. The algorithm below is kept for reference.

`GET /api/recommendations?member=<slug>` returns `{picks, cold_start, neighbor_pool, is_seed_only}` for the requesting member.

Picks come from one of two modes:

### Neighbor mode (default, when the member has enough taste data)
1. Compute the top non-seed-only members by active-title overlap with the requester.
2. From those neighbors' active shows, drop anything the requester already has on any list (including archived).
3. Score the remainder by neighbor-count, shared-actor-count, and average rating.
4. Return up to 5 picks, each annotated with `who[]` (which neighbors have it) and `shared_actors` count.

### Cold-start mode (under ~15 shows of taste signal)
Falls back to actor overlap with the requester's library + global popularity, so brand-new members get something non-empty.

Seed-only members get `picks: []` and `is_seed_only: true`.

## Vibe system

Three pieces:

- `_shared/vibe-traits.js`: defines the 27 trait dimensions and the Claude calibration prompt (cached as `ephemeral`).
- `_shared/vibe-clusters.js`: defines 7 cluster targets, each as a sparse target vector over the 27 traits (unspecified dims default to 0.5).
- `functions/api/vibe.js`: composes a member fingerprint and matches it against clusters.

### Fingerprint
For each of the member's non-seed shows, look up `show_traits` by `LOWER(title)`. Weight by list:

- `recommending` → 1.0
- `watching` → 0.8
- `waiting` → 0.6
- `next` → 0.3
- archived → ignored

Average across the member's library, weighted, to get a 27-vector.

### Cluster assignment
Compute the **deviation from the club mean** for both the member fingerprint and each cluster target (so clusters are matched on *pattern*, not absolute level). Take the cosine similarity. Highest match wins; top 3 are returned as a `blend`.

### Top / bottom traits, balance, aligned shows
- Top / bottom: the dimensions where the member's fingerprint diverges most positively / negatively from the club mean.
- Balance reads: precomputed contrasts (warmth vs darkness, cynicism vs optimism, etc.) extracted from the fingerprint.
- Aligned shows: rank the member's own active shows by dot-product against their top-N traits, grouped by list.

### Trait backfill (`/api/admin-vibe-fill`)
- Picks titles with no `show_traits` row (skipping titles where every copy is archived).
- Sends each title to Claude with the calibration prompt.
- Parses the returned JSON; writes the row or marks `unknown_show=1` if Claude can't identify it.
- 429-aware: respects `Retry-After`, capped at 60s.
- Batched: caller passes `count`, capped at 8 per request.

## Admin endpoints

All require an admin session via `isAdmin()` (`members.is_admin = 1`). No separate secret.

### `createMember()` (internal — `functions/_shared/create-member.js`)
Not an HTTP endpoint, and not reachable by an operator: self-enrollment (`_shared/enroll.js`) is the only caller. (The "Add a member manually" form and `POST /api/admin-create-member` were retired 2026-07; the `/join` approval path that also called this went in migration 058, and the module moved from `functions/api/` to `functions/_shared/` at the same time.) Takes `{full_name, emails, allowNoContact, enrolledVia, enrollIp}`; `full_name` is token-split into first/last, and the caller requires a first *and* last name (see "Registration name capture" below), so the split always yields a non-null `last_name`. The first token drives the slug (lowercased alphanumerics) and the possessive display name. There is no phone parameter — signup is email/Apple/Google, and phones are attached afterwards via the roster editor. The rename path (`POST /api/admin-member-emails` with `first_name`/`last_name`, legacy `name`) keeps `first_name` verbatim — including multi-word shared-list names like "Paula & Brad" — and doesn't enforce the two-name rule (an admin can rename someone to a single word). Inserts into `members` plus `member_emails` (the contacts the member's login codes are sent to). New members start with an empty library — auto-seeding 8 starter shows (2 per list, `added_by='seed'`) was retired 2026-07; the seed-only check (see "Seed-only definition" below) still applies to members created before then who still carry those rows.

### `POST /api/admin-member-merge`
Body: `{source, target}` (slugs). Merges a duplicate account into the member's real one, in a single all-or-nothing `DB.batch`. Exists because Sign in with Apple + "Hide My Email" mints a private-relay address that doesn't match `member_emails`, so self-enrollment creates a second account for an existing member (and links their `apple_sub` to it).

What happens: the source's shows move to the target (actors follow via `show_id`), except untouched seed rows (`added_by='seed' AND updated_at IS NULL` — dropped) and active rows whose title the target already carries actively (case-insensitive — the kept copy wins, the source's is dropped). Emails and phones are deduped against the target's set and moved as non-primary alternates, so the relay address still works for email-code login. `member_apple_ids` / `member_google_ids` are repointed — this is what makes the *next* relay sign-in resolve to the right member. `member_subscriptions` move (deduped on network), live `sessions` are repointed rather than killed (the member's phone stays signed in, now to the kept account), the target's `last_login_at` takes the max of the two, and the source's `login_otps` and member row are deleted.

Refuses to merge an admin source (`cannot_merge_admin` — demote first), the demo member on either side (`cannot_merge_demo`), or an account into itself. The `/members` page surfaces candidates (private-relay-only accounts, shared first names) in a "Possible duplicates" panel with a manual picker for anything the heuristics miss.

### `GET/POST /api/admin-dupe-ignores`
Backs the "Ignore this match" buttons on that panel — the heuristics false-positive (e.g. the demo account sharing a first name with a real member, which the merge guard rightly refuses), so dismissals must persist. Rows live in `dupe_ignores` (migration 034) as sorted slug pairs; a self-pair means "stop flagging this account as hidden-email-only". GET lists them; POST takes `{action: 'ignore'|'unignore', pairs: [[a,b], ...]}`. The POST creates the table on demand (identical `CREATE TABLE IF NOT EXISTS` as the migration) so deploy order doesn't matter, and rejects ignores naming unknown members. A successful merge deletes any ignore rows referencing the merged-away slug; the panel hides (but keeps) rows whose members have otherwise disappeared. Dismissed matches reappear via the panel's "ignored matches" disclosure → Un-ignore.

### `POST /api/admin-vibe-fill`
Body: `{secret, count}`. Runs the vibe trait-backfill loop described above. The iOS Vibe trait scoring screen calls it in a loop until the operator stops or every show is scored (the `vibe-admin.html` web UI was archived in 2026-08).

### `POST /api/admin-url-cleanup`
Body: `{secret}`. Before listing, runs `propagateGoodUrls` to push every known good URL out to any sibling row still on a placeholder (so the queue never surfaces a title that someone has already fixed). Then returns the residual queue: titles where *no* copy has a good URL yet. The companion Show Cleanup screen in the iOS app lets the operator paste a real deep link, then push it to every member's copy of that title in one go (the `url-cleanup.html` web UI was archived in 2026-08).

Some titles genuinely have no direct link to paste (too ambiguous to resolve to one show, not indexed by any service search). The `dismiss` action (`{action: 'dismiss', title}`, the row's "No good link — dismiss" button) permanently removes a title from the queue — recorded case-insensitively in `url_cleanup_ignores` (migration 048), which `QUEUE_FILTER` excludes. Same pattern as `dupe_ignores`: the endpoint creates the table on demand (identical statement to the migration) so deploy order doesn't matter. There's no un-dismiss action or UI — a title comes back into the queue only if its `network_url` regresses to a placeholder again, at which point it'd need re-dismissing by hand (`DELETE FROM url_cleanup_ignores WHERE ltitle = ...`).

The page's tools row also has a "Run enrichment passes" button — it loops `POST /api/enrich` (TMDB posters/dates/ratings/detail fields + actor-IMDB-id backfill) up to five times with the operator's session, stopping early once a pass returns all zeroes.

The `inherit_networks` action (the "Adopt networks from club copies" button on the page) rescues rows that have no `network` at all — URL propagation can't reach them because it is scoped to `(title, network)`. Any active row whose title has exactly one distinct network across the rest of the club adopts that network, then a propagation pass fills its URL from the siblings. Titles whose copies disagree on the service are deliberately skipped; those belong to the conflict queue. Returns `{networks_set, urls_filled}`.

The list response also carries a `needsPoster` section (`fetchNeedsPoster`): titles where *no* active copy has a poster, grouped by title. A missing poster is the observable symptom of a title TMDB can't match — a typo that stuck ("Marshalls" for *Marshals*), a descriptive member-entered name, or a title only indexed under the opposite media type. The row's URL may be perfectly good, which is exactly why the URL queue misses these. The companion "Missing posters" section (iOS Show Cleanup; the `url-cleanup.html` web UI was archived in 2026-08) offers two fixes per title: **Re-enrich** (the `re_enrich` action — a fresh `fetchEnrichment` lookup for the title as-is, which flips media types, writing any poster/logo/rating/cast onto every copy) and **Rename** (the shared `fix_title` action, for when the stored title itself is wrong).

The automatic title-healing that used to back this queue was retired in July 2026 (`b1ecd34`) once TMDB type-ahead pinning made new in-app rows arrive canonical: the old `bad_titles`/`title_ok` queue, `og:title` recovery from deep links (`title-fix.js`), title-variant and cross-media-type retries in `/api/enrich`'s poster passes, and the OMDB title-guessing fallback are all gone. Kept: the manual `fix_title` rename and the artwork sync/propagation passes. Bulk off-platform imports (e.g. migration 032) bypass type-ahead, so hand-typed titles and movie flags can still miss — the `needsPoster` queue and per-title fix migrations are the operator's net for exactly that.

## Seed-only definition

A member is "seed-only" iff every one of their show rows satisfies:
`added_by = 'seed' AND archived = 0 AND updated_at IS NULL`.

The moment a member edits a seeded row (changes list, notes, etc.), archives one, or adds their own row, they stop being seed-only. This check appears verbatim in several queries (`/api/recommendations`, `/api/vibe`). The home-page member ordering uses a stricter library-only signal — see `/api/members` — that ignores edits/archives of seeded rows.

## CI workflows

### `.github/workflows/deploy.yml`
- Trigger: push to `main`, or manual dispatch.
- Steps: checkout, install Node 22 + wrangler, **apply pending D1 migrations** (`bash scripts/apply-migrations.sh` — self-tracked via `schema_migrations`, runs *before* the deploy so new columns/tables exist before the code that depends on them goes live), `wrangler pages deploy public --project-name=shows --branch=main --commit-dirty=true`.
- **Post-deploy smoke test** (15s settle + checks):
  - `/.env` probe — must return > 10KB (i.e. the SPA shell, not the actual file).
  - Security headers — CSP, HSTS, X-Frame-Options, Permissions-Policy must be present on `/`.
  - Auth gates — `POST /api/shows/share`, `GET /api/reporting`, `POST /api/enrich`, `POST /api/sync-urls` must each return 401.
- Required secrets: `CLOUDFLARE_API_TOKEN` (Pages:Edit + D1:Edit), `CLOUDFLARE_ACCOUNT_ID`.

### `.github/workflows/migrate.yml` ("Apply D1 migration")
- Trigger: manual dispatch only, with a `file` input (bare `NNN_*.sql` resolves under `migrations/`).
- Steps: checkout, install wrangler, `wrangler d1 execute shows-db --remote --file=<file>`.
- Since `deploy.yml` already applies pending migrations automatically, this is only needed to apply a migration *ahead of* merging its code, or to run one against prod outside of a `main` push.
- Required secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

### `.github/workflows/backup.yml`
- Trigger: daily at 03:00 UTC, or manual dispatch.
- Steps: install rclone, install Node + wrangler, `wrangler d1 export shows-db --remote --output /tmp/...`, upload to Google Drive (`gdrive:Shows-Backups/`), prune drive backups older than 30 days, prune `failed_logins` rows older than 7 days.
- Required secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RCLONE_CONF` (full rclone config including drive token).

## Excluded members

`functions/_shared/excluded-members.js` exports a list of member slugs that are skipped from taste aggregation (popular, recommendations). Use this when an operator-only or test member's library would skew the social signals.

## Conventions that aren't obvious

- **`updated_at` is sacred.** Enrichment writes `enriched_at` so member intent (`updated_at != created_at`) stays clean. Don't bump `updated_at` from background jobs.
- **Seeded rows have NULL `created_at` and `updated_at`.** This is intentional — it makes the seed-only query single-sided and cheap.
- **Network URLs that look like `/search`, `/s?`, or `/?q=` are placeholders.** The frontend renders these as plain text instead of links; sync-urls and calendar feed treat them as missing.
- **Member display names disambiguate dynamically.** `/api/members` counts first-name collisions and appends `last_initial` only when it would otherwise be ambiguous.
- **Slug `dorothy` was renamed to `whitt`.** A permanent 301 in `_redirects` covers the old URL. She has since gone back to displaying as Dorothy (migration 025 updated her name and login email) — the slug stays `whitt`.
- **Show rows are a Swift-only concern now.** `public/show-renderer.js` was the single web renderer for every row and detail body; it went to `archive/web/` with the member app in 2026-08. `ShowRow.swift` is the one renderer left, and the convention it enforced — one renderer, never hand-rolled markup per screen — still applies on the Swift side.
- **Always clean up branches when a chunk of work is done.** After the work is merged to `main` and pushed live, delete the feature branch — local and remote. Caveat: in the Claude-Code-on-the-web remote environment the git proxy rejects remote-branch deletion (HTTP 403) and the GitHub MCP server has no delete-branch tool, so the remote branch may have to be deleted from GitHub's UI/API outside that environment. The local branch can always be deleted.
