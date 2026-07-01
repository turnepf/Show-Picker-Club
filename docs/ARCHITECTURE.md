# Show Picker Club — Architecture

Implementation reference for the Show Picker Club codebase. For the user-facing description, see [`PRODUCT.md`](PRODUCT.md).

## Stack

- **Hosting:** Cloudflare Pages (`shows` project).
- **Backend:** Cloudflare Pages Functions. JavaScript modules under `functions/` route by file path.
- **Database:** Cloudflare D1 (`shows-db`), serverless SQLite at the edge. Single `DB` binding in `wrangler.toml`.
- **Frontend:** Static HTML/CSS/JS, no build step. Vanilla ES6 in `<script>` tags. Service worker for PWA install + offline shell.
- **External APIs:** OMDB (ratings + canonical titles), TMDB (cast, season dates, genres), Anthropic Claude (vibe trait scoring, admin-only batch), Twilio (outbound SMS).
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

`schema.sql` is the starter schema. Several columns and at least one column on `sessions` were added over time and live only in the production D1 — the descriptions below are the source of truth.

### `members`
| Column         | Type | Notes                                                 |
|----------------|------|--------------------------------------------------------|
| `slug`         | TEXT PRIMARY KEY | URL slug (`/whitt`).                        |
| `name`         | TEXT NOT NULL    | Full name.                                  |
| `first_name`   | TEXT             | Override for display name (rare collisions).|
| `last_initial` | TEXT             | Suffix used to disambiguate two first-name collisions. |
| `created_at`   | TEXT             | Default `datetime('now')`.                  |

### Login identity tables
Login is by one-time code or Sign in with Apple — there are no stored passwords. The relevant tables (added by migrations, not in the base `schema.sql`):

- `member_emails` / `member_phones` — map an email or phone to a member; the address a login code is sent to and matched against.
- `login_otps` — short-lived, single-use email codes (`member_slug`, `code`, `channel`, `expires_at`, `used_at`). SMS codes are held by Twilio Verify, not stored here.
- `member_apple_ids` — links an Apple user id (`apple_sub`) to a member, populated on first Apple sign-in by email match so later sign-ins work even behind a private-relay address.

### `shows`
| Column              | Type | Notes |
|---------------------|------|-------|
| `id`                | INTEGER PK | |
| `title`             | TEXT NOT NULL | |
| `network`           | TEXT | |
| `network_url`       | TEXT | Deep link to show on network site (or a search-page placeholder until upgraded). |
| `recommended_by`    | TEXT | Free-text attribution. |
| `rating`            | TEXT | IMDB rating string from OMDB. |
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
| `enriched_at`       | TEXT | Bumped by OMDB/TMDB enrichment so enrichment can prioritize stale rows. |
| `genres`            | TEXT | Comma-separated, from TMDB. |

### `actors`
Join table for per-show cast.

| Column     | Type | Notes |
|------------|------|-------|
| `id`       | INTEGER PK | |
| `show_id`  | INTEGER REFERENCES shows(id) ON DELETE CASCADE | |
| `name`     | TEXT NOT NULL | |
| `imdb_id`  | TEXT | NULL for seeded rows and for OMDB-only enrichments. |

### `sessions`
| Column          | Type | Notes |
|-----------------|------|-------|
| `id`            | TEXT PK | UUID. |
| `email`         | TEXT NOT NULL | Display/identifier for the session (member's first name or name). |
| `member_slug`   | TEXT | Which member this session can edit. |
| `expires_at`    | TEXT NOT NULL | 30 days from creation. |
| `created_at`    | TEXT | |
| `last_seen_at`  | TEXT | Bumped by `/auth/check`, throttled to once per hour per session. Drives DAU/WAU/MAU in reporting. |

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

## Subscription audit

`GET/PUT /api/subscriptions` (`functions/api/subscriptions.js`), page at `public/subscriptions.html`, linked from the member page nav (own page only). Both verbs require a session and operate on the logged-in member.

- **GET** groups the member's active shows by canonical network and assigns each service a **verdict**:
  - `keep` — ≥1 show in `watching`.
  - `pause` — nothing watching, but a `waiting` show has a future `next_season_date`; the soonest such date is the suggested resubscribe target.
  - `pause_tba` — `waiting` shows but no announced premiere date.
  - `start` — only `next` ("up next") shows; start one or skip.
  - `cancel` — only finished / `recommending` shows.
  - Manual services (no shows) carry verdict `manual`.
  Saved `member_subscriptions` rows are merged in (status, price, resubscribe date), and totals (service count, est. monthly spend, potential savings) are computed. Savings = sum of price over non-cancelled services whose verdict is `cancel` / `pause` / `pause_tba`.
- **PUT** upserts one service's saved decision. Only the fields the caller actually sends are overwritten (a status change won't wipe a saved price), via per-field `CASE WHEN ?` flags in the `ON CONFLICT` clause. `{ remove: true }` deletes a manual service.

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
| `GET /auth/logout`                     | `functions/auth/logout.js`                 | GET     | none |
| `GET /api/members`                     | `functions/api/members.js`                 | GET     | none |
| `GET /api/popular`                     | `functions/api/popular.js`                 | GET     | none |
| `GET /api/activity`                    | `functions/api/activity.js`                | GET     | none |
| `GET /api/recommendations`             | `functions/api/recommendations.js`         | GET     | none (legacy — no longer called by any client) |
| `GET /api/vibe`                        | `functions/api/vibe.js`                    | GET     | session |
| `GET /api/shows`                       | `functions/api/shows.js`                   | GET     | none |
| `POST /api/shows`                      | `functions/api/shows.js`                   | POST    | session |
| `GET /api/shows/all`                   | `functions/api/shows/all.js`               | GET     | none |
| `GET /api/shows/check`                 | `functions/api/shows/check.js`             | GET     | none |
| `POST /api/shows/share`                | `functions/api/shows/share.js`             | POST    | session |
| `GET /api/shows/[id]`                  | `functions/api/shows/[id].js`              | GET     | none |
| `PUT /api/shows/[id]`                  | `functions/api/shows/[id].js`              | PUT     | session |
| `DELETE /api/shows/[id]`               | `functions/api/shows/[id].js`              | DELETE  | session |
| `PUT /api/shows/[id]/move`             | `functions/api/shows/[id]/move.js`         | PUT     | session |
| `PUT /api/shows/[id]/archive`          | `functions/api/shows/[id]/archive.js`      | PUT     | session |
| `GET /api/shows/[id]/actors`           | `functions/api/shows/[id]/actors.js`       | GET     | none |
| `POST /api/suggestions`                | `functions/api/suggestions.js`             | POST    | session |
| `POST /api/enrich`                     | `functions/api/enrich.js`                  | POST    | session |
| `POST /api/sync-urls`                  | `functions/api/sync-urls.js`               | POST    | session |
| `GET /api/reporting`                   | `functions/api/reporting.js`               | GET     | session |
| `POST /api/admin-create-member`        | `functions/api/admin-create-member.js`     | POST    | patrick session |
| `POST /api/admin-vibe-fill`            | `functions/api/admin-vibe-fill.js`         | POST    | patrick session |
| `POST /api/admin-url-cleanup`          | `functions/api/admin-url-cleanup.js`       | POST    | patrick session |
| `POST /api/admin-sms-test`             | `functions/api/admin-sms-test.js`          | POST    | patrick session |
| `POST /api/admin-fill-watch-urls`      | `functions/api/admin-fill-watch-urls.js`   | POST    | patrick session |
| `POST /api/admin-dormant-digest`       | `functions/api/admin-dormant-digest.js`    | POST    | patrick session or `CRON_SECRET` header |
| `GET /calendar/[slug].ics`             | `functions/calendar/[slug].js`             | GET     | none |

The `[slug]` param matches the full final segment (including `.ics`); the handler strips the suffix.

### Notable query params

- `GET /api/members` — returns every member with derived fields:
  - `show_count`: total active shows across all lists.
  - `watching_count`: active shows on the Watching list.
  - `waiting_count`: active shows on the list now labeled "Awaiting" in the UI (the stored value is still `waiting`, so the field name is unchanged).
  - `last_activity_at`: `MAX(COALESCE(updated_at, created_at))` over the member's shows where `added_by != 'seed'`. Editing or archiving a seeded row doesn't count — only self-added, suggested-in, or shared-in shows register. NULL `added_by` predates the column and is treated as engaged since seeds always carry `added_by='seed'`. Kept for reference and possible future filtering even though the home page no longer uses it.

  Rows are ordered by `last_activity_at DESC NULLS LAST, name`. The home page re-sorts the response client-side by `watching_count DESC, waiting_count DESC` and features the top 6; the rest go behind a "Browse all members" disclosure.
- `GET /api/shows?member=<slug>&include_archived=1` — `include_archived=1` is set by the per-member search modal so archived rows can be found.

## Authentication

### Login flow

1. `POST /auth/login` with `{phone, code}` or `{email, code}` (codes are requested first via `POST /auth/request-code`). Sign in with Apple uses `POST /auth/apple` with Apple's identity token instead.
2. Throttle check: 5 failed attempts per IP in 15 minutes → 429 with `Retry-After`.
3. Resolve the member: phone → `member_phones` + Twilio Verify; email → `member_emails` + `login_otps`; Apple → verify the token, then `member_apple_ids` (or first-time email match against `member_emails`).
4. On success: insert a `sessions` row (UUID id, member's name as `email`, 30-day `expires_at`), set an HttpOnly + Secure + SameSite=Lax `session=` cookie, return the slug.
5. On failure: insert a `failed_logins` row, return 401.

`functions/_shared/auth.js` exports `getSession(request, env)` which reads the cookie, queries the session row, checks `expires_at`, and returns `{email, member_slug}` or `null`. Every mutating endpoint and `/api/reporting` calls `getSession` first.

Admin endpoints are gated by `_shared/admin.js#isAdmin()` — a valid session whose `member_slug` is the operator (`patrick`). There is no separate admin secret; the operator just needs to be logged in. This strengthens automatically once login moves to SMS one-time codes.

### Session activity tracking

`/auth/check` is hit on every page load by the SPA. It bumps `sessions.last_seen_at`, but throttled — the `UPDATE` clause only fires when `last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 hour')`. This means at most one write per session per hour, with no read-then-write.

`last_seen_at` feeds **Reporting** only: DAU / WAU / MAU = `COUNT(DISTINCT member_slug) FROM sessions WHERE last_seen_at >= ...`. The home-page member ordering is library-based (`last_activity_at` on `/api/members`), not session-based.

## Frontend pages

### `index.html` (1939 lines)

Single-page app. Detects whether `window.location.pathname` is empty (landing) or a slug (member page) and renders accordingly. Major UI surfaces:

- **Landing:** `My Shows` link (logged in), Trending shows shelf, featured Members row + "Browse all members" disclosure, `Search all libraries` button, What's New changelog.
- **Member page:** title + tabs (Watching, Awaiting, Recommending, Up Next), search button, `+ Add` button (when logged in), per-tab list of show rows with always-visible meta (Next up on Awaiting, Recommended by on Up Next), sort + toggle pills at the bottom, footer with `Curious?` / `Vibe` / `📅 Calendar feed` links.
- **Modals:** Add/Edit Show, Share to another member, Suggest a Show, Add to My List (used from Popular and from cross-library search), Search.

State lives in a handful of top-level `let` vars (`shows`, `currentTab`, `isEditor`, `memberSlug`, `authMember`, `searchMode`, etc.). No framework. All API I/O is `fetch()` to relative paths.

### `vibe.html`

Member taste profile UI. Calls `/api/vibe?member=<slug>` and renders the cluster identity, trait bars, blend bars, balance reads, and aligned shows.

### `reporting.html`

Auth-gated dashboard for the operator. Calls `/api/reporting`; displays metric cards and a few tables.

### `setup.html`, `url-cleanup.html`, `vibe-admin.html`

Admin tools. Each requires the operator to be logged in as `patrick` (session cookie); they show a "log in first" hint otherwise. Not linked from the navigation.

## Native clients

Native SwiftUI apps for iOS, tvOS, and watchOS call the same public `/api/*` endpoints as the web. They share a `ShowPickerCore` Swift package (at the repo root) that holds the `Show` / `Actor` / `ShowList` models and their response wrappers, and are opened together via `ShowPickerClub.xcworkspace`. iOS and tvOS share one bundle id (`net.patrickturner.showpickerios`) and ship as a single universal App Store app (iPhone + Apple TV). The watchOS app (`watch/ShowPickerWatch`) is paired to the iPhone and receives its session via WatchConnectivity; its reads are public. Platform usage tracking now includes a `watchos` platform value.

## Service worker + PWA

`public/sw.js` implements a network-first strategy with a single `shows-v1` cache:

- `install`: `self.skipWaiting()`.
- `activate`: `clients.claim()` so the new SW takes over open tabs.
- `fetch`: on success, clone into cache and return; on failure, fall back to cached response if present.
- Skips caching `/api/*` and `/auth/*` (always live).

`public/manifest.json` is a standard PWA manifest with `display: standalone`, theme colors matching the app palette, and the `favicon.svg` as the icon. This is what enables Apple's "Add to Home Screen" experience.

## Security headers

`public/_headers` applies to every response under `/*`:

- **Content-Security-Policy:** `default-src 'self'`, plus `'unsafe-inline'` for scripts and styles (the SPA uses inline event handlers), and explicit allow-list for Google Analytics and Tag Manager. No third-party iframes, no inline base URI.
- **Strict-Transport-Security:** `max-age=31536000; includeSubDomains`.
- **X-Frame-Options:** `DENY`.
- **Permissions-Policy:** disables camera, microphone, geolocation, payment, USB, accelerometer, gyroscope, magnetometer, interest-cohort.

The deploy smoke test verifies these headers are present after each push.

## External APIs

### OMDB
- Env: `OMDB_API_KEY`.
- Used by `_shared/enrichment.js` (`fetchEnrichment`), `enrich.js`, and `suggestions.js`.
- Returns canonical title, IMDB rating, comma-separated actors. No IMDB IDs for individual actors.
- Fallback path: tries exact title, "The " prefix, prefix stripped, collapsed-spaces title, then OMDB search endpoint.
- Free tier is ~1000/day; on-demand enrichment is soft-capped at 50 per call.

### TMDB
- Env: `TMDB_API_KEY` (legacy v3 key for some calls), `TMDB_TOKEN` (v4 bearer token).
- Used by `_shared/enrichment.js` and `enrich.js`.
- Returns canonical title, cast (first 4), per-actor IMDB IDs, genres, next-episode-to-air date, last-episode date, status (`Ended` / `Canceled` → `full_series=1`).
- Preferred over OMDB for actor IMDB IDs and for season metadata.

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
Called from `POST /api/shows` (and edit / suggestion paths). Returns `{canonicalTitle, rating, actors}` so the new row inserts with rating + cast already filled in. TMDB is tried first (more accurate cast); OMDB is the fallback.

On insert, `POST /api/shows` also looks for any other member's active copy of the same title that already has a deep-link `network_url` (and a `network`). If one exists, the new row inherits both fields instead of falling back to the search-URL placeholder. So a show that someone else has already curated lands in the new member's library with the real URL on day one — never needs to go through `/url-cleanup`.

### Background (`POST /api/enrich`)
A logged-in member's page calls this fire-and-forget on load. Two phases:

1. **OMDB phase:** picks up to 50 active shows missing `rating`, missing `network_url`, or with no actor rows. Updates whatever it gets back. Title gets canonicalized only if there's no other row with that title (avoids creating duplicates).
2. **TMDB phase:** picks up to 50 active non-movie shows, ordered by `COALESCE(enriched_at, '1970-01-01') ASC` so the stalest get refreshed first. Writes `next_season_date`, `season_end_date`, `full_series`, `genres` (coalesced — doesn't overwrite existing genres), and bumps `enriched_at`.

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

`functions/calendar/[slug].js` builds an RFC 5545 iCalendar document on every request.

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

All require an operator (`patrick`) session via `isAdmin()`. No separate secret.

### `POST /api/admin-create-member`
Body: `{secret, full_name, phone, emails}`. Generates a slug from `full_name`, inserts into `members` plus `member_phones`/`member_emails` (the contacts the member's login codes are sent to), then picks 8 seed shows (2 per list) drawn from the existing club's highly-rated picks with cast and a real network URL. Shows are inserted with `added_by='seed'`, `created_at=NULL`, `updated_at=NULL` so the seed-only check (which looks for exactly that signature) recognizes them.

### `POST /api/admin-vibe-fill`
Body: `{secret, count}`. Runs the vibe trait-backfill loop described above. The `vibe-admin.html` UI calls it in a loop until the operator stops or every show is scored.

### `POST /api/admin-url-cleanup`
Body: `{secret}`. Before listing, runs `propagateGoodUrls` to push every known good URL out to any sibling row still on a placeholder (so the queue never surfaces a title that someone has already fixed). Then returns the residual queue: titles where *no* copy has a good URL yet. The companion `url-cleanup.html` UI lets the operator paste a real deep link, then push it to every member's copy of that title in one go.

The list response also carries a `bad_titles` section: titles enrichment has attempted (`enriched_at` set) but never matched to a poster on any copy. A missing poster is the observable symptom of a made-up name (e.g. "Juul Documentary" for *Big Vape: The Rise and Fall of Juul*) — the row's URL may be perfectly good, which is exactly why the URL queue misses it. The `fix_title` action renames every active copy, re-enriches, and now also pulls the new title's poster and network logo (preferring fresh artwork over whatever the old title had).

Bad titles are fixed automatically where possible (`functions/_shared/title-fix.js`): when the row carries a real deep link, the streaming service's title page is a public SEO page whose `og:title` holds the show's actual name. Both the cleanup list action (capped pass before listing, reported as `auto_fixed`) and `/api/enrich`'s TMDB passes (fallback when no title spelling matches) recover the name that way, re-search TMDB, and rename every copy — member-safely: a member who already carries the show under its real name gets their wrong-titled duplicate archived instead of renamed. Only titles the automation can't confidently match (no poster from the recovered name) remain in `bad_titles` for manual cleanup.

## Seed-only definition

A member is "seed-only" iff every one of their show rows satisfies:
`added_by = 'seed' AND archived = 0 AND updated_at IS NULL`.

The moment a member edits a seeded row (changes list, notes, etc.), archives one, or adds their own row, they stop being seed-only. This check appears verbatim in several queries (`/api/recommendations`, `/api/vibe`). The home-page member ordering uses a stricter library-only signal — see `/api/members` — that ignores edits/archives of seeded rows.

## CI workflows

### `.github/workflows/deploy.yml`
- Trigger: push to `main`, or manual dispatch.
- Steps: checkout, install Node 22 + wrangler, `wrangler pages deploy public --project-name=shows --branch=main --commit-dirty=true`.
- **Post-deploy smoke test** (15s settle + checks):
  - `/.env` probe — must return > 10KB (i.e. the SPA shell, not the actual file).
  - Security headers — CSP, HSTS, X-Frame-Options, Permissions-Policy must be present on `/`.
  - Auth gates — `POST /api/shows/share`, `GET /api/reporting`, `POST /api/enrich`, `POST /api/sync-urls` must each return 401.
- Required secrets: `CLOUDFLARE_API_TOKEN` (Pages:Edit + D1:Edit), `CLOUDFLARE_ACCOUNT_ID`.

### `.github/workflows/backup.yml`
- Trigger: daily at 03:00 UTC, or manual dispatch.
- Steps: install rclone, install Node + wrangler, `wrangler d1 export shows-db --remote --output /tmp/...`, upload to Google Drive (`gdrive:Shows-Backups/`), prune drive backups older than 30 days, prune `failed_logins` rows older than 7 days.
- Required secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RCLONE_CONF` (full rclone config including drive token).

### `.github/workflows/dormant-digest.yml`
- Trigger: 14:00 UTC on the 1st of each month, or manual dispatch.
- Steps: `curl POST /api/admin-dormant-digest` with the `X-Cron-Secret` header. The endpoint computes the dormant-member list and texts the operator's primary phone via the app's Twilio integration.
- Required secret: `CRON_SECRET` (must match the `CRON_SECRET` Pages secret).
- "Dormant" = a member with no non-seed shows, no edits, no archives, and no session ping in the last 30 days.

## Excluded members

`functions/_shared/excluded-members.js` exports a list of member slugs that are skipped from taste aggregation (popular, recommendations). Use this when an operator-only or test member's library would skew the social signals.

## Conventions that aren't obvious

- **`updated_at` is sacred.** Enrichment writes `enriched_at` so member intent (`updated_at != created_at`) stays clean. Don't bump `updated_at` from background jobs.
- **Seeded rows have NULL `created_at` and `updated_at`.** This is intentional — it makes the seed-only query single-sided and cheap.
- **Network URLs that look like `/search`, `/s?`, or `/?q=` are placeholders.** The frontend renders these as plain text instead of links; sync-urls and calendar feed treat them as missing.
- **Member display names disambiguate dynamically.** `/api/members` counts first-name collisions and appends `last_initial` only when it would otherwise be ambiguous.
- **Slug `dorothy` was renamed to `whitt`.** A permanent 301 in `_redirects` covers the old URL.
- **Always clean up branches when a chunk of work is done.** After the work is merged to `main` and pushed live, delete the feature branch — local and remote. Caveat: in the Claude-Code-on-the-web remote environment the git proxy rejects remote-branch deletion (HTTP 403) and the GitHub MCP server has no delete-branch tool, so the remote branch may have to be deleted from GitHub's UI/API outside that environment. The local branch can always be deleted.
