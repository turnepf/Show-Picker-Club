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
Login is by passkey, one-time code, or Sign in with Apple — there are no stored passwords. The relevant tables are included in `schema.sql` and were introduced over time by migrations:

- `member_emails` / `member_phones` — map an email or phone to a member; the address a login code is sent to and matched against.
- `login_otps` — short-lived, single-use email codes (`member_slug`, `code`, `channel`, `expires_at`, `used_at`, and `ip`/`user_agent` of the requester — migration 046). SMS codes are held by Twilio Verify, not stored here, but a marker row with `code=''` still records the request (and its IP) for rate-limiting. The IP columns exist so unrequested codes (someone submitting a member's email/phone) can be traced to a source and blocked at the Cloudflare edge.
- `member_apple_ids` — links an Apple user id (`apple_sub`) to a member, populated on first Apple sign-in by email match so later sign-ins work even behind a private-relay address.
- `member_passkeys` (migration 062) — one row per registered passkey: `credential_id` (base64url, the primary key — globally unique, which is what lets sign-in resolve a member from the credential alone), `member_slug`, `public_key` (base64url COSE, re-imported into WebCrypto on each verification), `sign_count`, `aaguid`, a member-facing `label`, `created_at`, `last_used_at`. See [Passkeys](#passkeys).
- `webauthn_challenges` (migration 062) — single-use challenges (`purpose` = `register` | `authenticate`, `member_slug` set for registration only, `ip`, `expires_at`). Rows are deleted as they're consumed and swept when they expire, so the table stays near-empty.

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
| `watching_with`     | TEXT | The display string: free text first, then the names of any linked members (see [`show_watchers`](#show_watchers)). Kept composed server-side, so a client that knows nothing about links still renders it correctly. Owner-only — stripped for every other reader. |
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
| `tmdb_id`           | INTEGER | TMDB's id for the matched title. Migration 049. Canonical cross-member join key: a member rating table keys off `(tmdb_id, tmdb_type)` rather than any one member's row, so every member's independent copy of the same show shares one rating pool. Captured on insert/edit whenever enrichment resolves a match (`_shared/enrichment.js`'s `enrichFromTmdbId`/`fetchEnrichment` now return it). Since 2026-08, the `/api/enrich` rotation also persists the id it resolves — TV and movie passes alike, fill-only and title-scoped, so seeded rows and other members' copies pick it up without being the row the rotation happened to select. It self-heals from then on; `/api/admin-tmdb-backfill` remains for a deliberate one-shot sweep, and `tmdb_backfill_ignores` still exempts titles TMDB genuinely doesn't have. |
| `tmdb_type`         | TEXT | `movie` or `tv`, alongside `tmdb_id` — TMDB ids aren't unique across the two (movie #550 and tv #550 are different titles), so the pair is the real key. Migration 049. |
| `episodes_released` | INTEGER | Total episodes across all aired seasons; NULL for movies. The companion to `seasons_released`, which alone says nothing about size — four seasons of Severance is 19 episodes, four of Grey's Anatomy is 90. New-value-wins on re-enrichment (a running series gains episodes), same as `seasons_released`. Shown on the detail screen folded into the Series line. Migration 063. |
| `vote_count`        | INTEGER | Sample size behind `tmdb_rating` — an 8.9 from 42,000 people and a 9.1 from 11 render identically without it. Converges on re-enrichment like the rating does. **Stored, deliberately not displayed**: it exists so ratings can later be qualified or suppressed below a threshold without a re-enrichment pass. Migration 063. |
| `tagline`           | TEXT | TMDB's marketing one-liner — the only evocative text TMDB gives us; everything else is factual. Rendered above the overview on the detail screen. Migration 063. |
| `original_language` | TEXT | ISO 639-1 code of the production language (`ja`, `ko`, …). Displayed **only when it isn't English** — a "Language: English" row on nearly every card is noise. Migration 063. |
| `studio`            | TEXT | First production company (movie) or first TMDB network (series) — the originating studio/broadcaster. Named `studio` and never anything network-shaped on purpose: `network` above means the **streaming service**, while TMDB's "networks" means the originating broadcaster, and conflating the two is the same class of collision as Apple TV vs Apple TV+. **Stored, deliberately not displayed**: TMDB orders `production_companies` by internal id rather than prominence, so the first entry is as often a financing shell as it is A24. Migration 063. |

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

`GET /api/rate-backlog` (session required) backs the bulk-rate flow (`rate-backlog.html` on the web and the iOS `RateBacklogView` are both live clients — see [Frontend pages](#frontend-pages)): every active show the member has except Next Up and archived rows, left-joined to `show_ratings` for the member's existing overall (`season_number = 0`) rating, unrated shows first. Overall-only by design — each row links to `/<slug>?show=<id>` (the show's detail page, which `showMember()` opens directly via a `show` query param) for season-level rating. `GET /api/rate-backlog-count` returns `{ count }` for the same set of rows — the "Rate my backlog" nav badge, which the main app derives from the library it already has loaded but `shell.js` has no library for. The two share an eligibility clause; change one and change the other, or the badge disagrees with the page it links to.

`GET /api/reporting` (admin-only, backs `/reporting`) reports rating activity alongside the other show metrics: a "People who rated" card (distinct `member_slug`s with an insert/update to `show_ratings` in the same day/week/month/all-time windows as new/edited/archived shows, keyed off `updated_at` so re-rating counts as activity) plus all-time submitted-ratings and distinct-titles-rated totals. Defensive like the other migration-gated reporting fields: falls back to zeros rather than 500ing the dashboard if `show_ratings` isn't there.

Native support: `ShowPickerCore/Sources/ShowPickerCore/Ratings.swift` defines `RatingsSummary`/`SeasonRatingSummary`/`RatingResponse`/`RateBacklogShow`/`RateBacklogResponse`, shared by all three Apple targets; `ShowResponse` carries `ratings` as a sibling of `show` (matching the JSON shape, not nested). iOS gets full entry via `API.rateShow(id:rating:season:)` and a "Ratings" section in `ShowDetailView` (`RatingTapRow`/`RatingEntryRow` in `Views/RatingTapRow.swift`); tvOS and watchOS only read `ratings` off their existing show-detail calls and render it (no write path — both apps are view-only/read-only generally). iOS also has a native bulk rate-your-backlog screen, `RateBacklogView` (`API.rateBacklog(member:)` → `GET /api/rate-backlog`), surfaced next to Subscription audit on Home, the iPad sidebar, and a member's own page — tvOS/watchOS don't get it. Rating is routed through the offline write queue like any other edit: `PendingMutation.Kind.rate` carries `rating`/`season`, `OfflineQueue.enqueueRate`/`pendingRating` queue and expose the latest not-yet-synced value, and `API.rateShow` falls back to queueing when offline instead of throwing.

### `show_watchers`
Migration 064. "Watching With" as people rather than only text. One row = *the owner of `show_id` has named `member_slug` as someone they're watching it with*.

| Column        | Type | Notes |
|---------------|------|-------|
| `show_id`     | INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE | |
| `member_slug` | TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE | The person named. |
| `created_by`  | TEXT REFERENCES members(slug) | Whoever's tag wrote the row — the show's owner, or the other member when this is the mirror row their tag created. |
| `created_at`  | TEXT | |

PK `(show_id, member_slug)`.

`functions/_shared/watchers.js` owns every read and write. **This is the only cross-member write in the codebase** — suggest-a-show and share-to-member were retired in 2026-07 and still return 410 — so the rules it enforces are the point:

- **Only group-mates can be named.** Every slug from a client is checked against `group_members` before anything is written. A slug for someone the caller shares no group with is dropped silently (the rest of the save still succeeds), never honoured. A group is a relationship both people opted into; that gate is the entire difference between this and the writes that were retired.
- **Links are mirrored pairs.** Naming Whitt on your row inserts `(your_show, whitt)`, ensures Whitt has a copy of the title, and inserts `(their_show, you)` on it. "Watching with" is symmetrical by construction rather than a note one person keeps about another.
- **A list they already made is never rearranged.** An existing copy — matched by `tmdb_id`, else case-insensitively by title — is linked where it sits, on whatever list and in whatever order they put it. Only a title they don't have is created, and only then on the same list as the tagger's copy. An **archived** copy is unarchived onto that list rather than duplicated (an archived row is on no list, so there's no placement to preserve).
- **Unlinking never deletes their row.** Dropping a link removes both directions and takes the tagger's name out of their `watching_with`. The show stays on their list — it arrived, they may have started watching it, and removing it is their call.
- **Deleting your copy cleans up after itself.** `DELETE /api/shows/:id` calls `unlinkShow()` first. The foreign-key cascade only reaches links hanging off the deleted row; the mirrors live on *other members'* shows and point at an owner who still exists, so without that call a deleted copy would leave its owner's name on other people's lists forever.
- **`MAX_WATCHERS` (10)** caps how far one add can fan out.

Created rows inherit the source row's enrichment (poster, overview, cast, ids) instead of re-fetching, so a fan-out doesn't multiply TMDB calls by the size of the group; a source that was never enriched triggers one title lookup for the new row. `updated_at` *is* bumped on a row a tag touches — a show arriving on your list is a member-initiated change, just by a different member (the same "shared-in" activity `last_activity_at` has always counted). The `updated_at` rule bars *background jobs*, not other members.

`shows.watching_with` is not replaced. `composeWatchingWith()` rebuilds it after every link change as free text + linked names, comma-joined, so tvOS, watchOS and any already-installed build keep rendering the one field they read with no client change. Recomposition is passed the names linked *before* the change as well as after — without the "before" half, a name whose link was just dropped survives as free text and the removal appears to do nothing.

The structured half rides alongside as `watchers: [{slug, name}]` on `GET /api/shows?member=<self>` and `GET /api/shows/:id` — **owner-only**, exactly like `watching_with` and `notes`. So does attribution: on the same owner-only reads, a row whose `added_by` email resolves (via `member_emails`) to a member other than the owner carries `added_by_member: {slug, name}` — the group-mate whose tag created the copy — so a title the owner never added says why it's on their list. The apps render it as "Added by <name>" on the show card.

### `trending_cache`
Migration 067. Trending as a **daily snapshot**. One row: `day` (UTC date,
the primary key), `payload` (the ranked shows as JSON), `computed_at`. The
first `GET /api/popular` of a UTC day runs the ranking query at its full
50-row cap and stores it here; every later request that day reads this one
row and slices it to the caller's `?limit=`. Yesterday's row is deleted when
today's is written, so the table holds one row in steady state.

Why: the ranking query title-matches copies across the whole `shows` table
with correlated subqueries, and the endpoint is public and sits on every
platform's launch screen — so every uncached hit paid a cost proportional to
the whole library. On 2026-09-01 bot traffic burned the free tier's entire
daily D1 `rows_read` budget through it and took the API down for everyone.

The cached payload keeps `member_slugs` per row (never served) so the
per-viewer "Added by" names are still resolved fresh from the viewer's
session and groups on every request — nothing session-scoped is cached. A
missing table (pre-067 preview DB) or corrupt payload degrades to a fresh
compute, never an error. New adds trend the next UTC day on purpose. Group
Trending is a different, group-scoped and session-gated query and is not
cached. Pinned by `scripts/trending-cache-test.mjs`.

### `group_suggestions` / `group_suggestion_responses`
Migration 065. "Recommend to group" — JC's pop-up (via Jennifer). One
`group_suggestions` row = *`suggested_by` proposed this title to `group_id`*;
the row belongs to the **group**, not to any member's library.

| Column         | Type | Notes |
|----------------|------|-------|
| `id`           | INTEGER PK | |
| `group_id`     | INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE | |
| `suggested_by` | TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE | |
| `show_id`      | INTEGER REFERENCES shows(id) ON DELETE SET NULL | The recommender's own copy at suggest time — the enrichment source every "Add to Next Up" clones, and the id the apps navigate to detail with. Nulls out if they delete that copy; the snapshot columns keep the card renderable and addable. |
| `title` / `tmdb_id` / `movie` / `poster_url` / `network` | | Identity snapshot from that copy. |
| `note`         | TEXT | **Group-visible by design** — addressed to the group, unlike the owner-only memos (`notes`, `recommended_by`) on library rows. |
| `created_at`   | TEXT | |

`group_suggestion_responses` (PK `(suggestion_id, member_slug)`, `response IN
('dismissed','added')`) records each member's answer to the pop-up. A later
answer replaces an earlier one, so dismissing the pop-up doesn't bar adding
from the board afterwards.

`functions/_shared/group-suggestions.js` owns the logic, and the design rule
is the inverse of [`show_watchers`](#show_watchers): **nothing here writes to
another member's list, ever.** Recommending writes a group-owned card;
"Add to Next Up" is the *recipient's own* tap, which pulls a copy onto their
own Next Up through the same `ensureCopy` path Watching With uses (existing
copy honoured wherever it sits, archived copy revived, cast and enrichment
inherited from the recommender's row); Dismiss is a per-member mark that
hides nothing from anyone else. A fresh copy created by an Add stamps
`recommended_by` with the recommender's display name — the owner-only memo
that has always meant exactly this — and `added_by` with the *adder's own*
email (it was their tap). A copy they already had keeps its memos untouched.

Bounds: you can only recommend a copy you own; a duplicate title folds into
the group's existing card (200, same shape) instead of stacking pop-ups;
`MAX_SUGGESTIONS_PER_DAY` (10, per member per group) caps the fan-out of
pop-up attention; removal is the recommender or the group's creator. Leaving
a group deletes your cards in it (and your response marks there); account
deletion sweeps both tables explicitly like the rest of that path. Enforced
end to end by `scripts/group-suggestions-test.mjs`.

There is deliberately no push notification — the pop-up is delivered in-app
when a member next opens the group screen, one unanswered card at a time.

### `sessions`
| Column          | Type | Notes |
|-----------------|------|-------|
| `id`            | TEXT PK | UUID. |
| `email`         | TEXT NOT NULL | Display/identifier for the session (member's first name or name). |
| `member_slug`   | TEXT | Which member this session can edit. |
| `expires_at`    | TEXT NOT NULL | 30 days, sliding. `/auth/check` extends it to a fresh 30 days (and re-sends the cookie with the new `Expires`) whenever the session is more than a day into its window, so an active member is never logged out for being active. Both halves have to move together — the row decides authorization, the cookie's own `Expires` decides whether the client still sends it. |
| `created_at`    | TEXT | |
| `last_seen_at`  | TEXT | Bumped by `/auth/check`, throttled to once per hour per session. Drives DAU/WAU/MAU in reporting. |
| `auth_method`   | TEXT | Migration 059. How this session was authenticated: `apple` | `google` | `passkey` | `email` | `sms` | `demo`. NULL for sessions minted before the column existed. Counted by `/api/reporting`'s `signin_methods` (7/30/90-day windows) — the number that says whether an auth channel still earns what it costs to run. |
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

`GET/PUT /api/subscriptions` (`functions/api/subscriptions.js`), read by both `subscriptions.html` on the web and the iOS Subscription audit. Both verbs require a session and operate on the logged-in member.

- **Household pooling.** Before grouping, the GET reads the member's `household_members` and pools active shows across the member + those members. The same title appearing on more than one household member's list is deduped per network, keeping the most-active list (watching > waiting > next up > loved) so the verdict reflects whoever's furthest along. The response includes `household` (the pooled members' slugs + display names) for the "including …" line.
- **Who's watching.** When (and only when) a household is pooled, every show in a service's `shows` array carries `viewers`: `[{ slug, name, list }]` — each household member who has that title and the list it sits on *for them*, so a title deduped to `watching` still shows that it's only `next up` for you. `name` is the first-name label (`You` for the caller), disambiguated by last initial exactly as `/api/members` and `/api/household` do — one members lookup now serves both the viewer labels and the `household` array. A solo audit omits `viewers` entirely: with one person pooled, naming them says nothing. iOS renders it under each row of a service's "Why?" list and in the `keep` reason line ("Active now: Severance (Dorothy)"), which is the case where the verdict can rest on somebody else's show. Household is invite-based on iOS, the same shape as groups: `POST /api/household/invite` mints a 7-day link (`/household/join?code=…`), the recipient's app accepts it via `POST /api/household/join`, and `POST /api/household/remove` drops someone. You can't add a person to your household from a roster any more than you can add them to a group. `GET /api/household` still returns the current set; `PUT` (whole-set replace) remains for the web modal.
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
(a 24-character token with a 7-day `expires_at`). Migration 066 adds nullable
`icon` (an SF Symbol name) and `color` (a named accent) to `groups`, validated
against the curated sets in `functions/_shared/group-icons.js`, mirrored
client-side by `ShowPickerCore.GroupIcon`. Migration 068 adds
`profile_changed_by`/`profile_changed_at`/`profile_changed_fields` to `groups`
and `last_seen_change_at` to `group_members`, backing the rename/icon change
notice below. A group is private to its members — every endpoint below the
group id verifies membership and 403s otherwise; only the creator can delete.

- **One `Group` payload shape.** Every endpoint that returns a group returns
  `id`, `name`, `creator_slug`, `created_at`, `icon`, `color`, plus the
  computed `member_count`
  and `is_creator` (1/0 — D1 has no boolean). The Apple apps decode a single
  `ShowPickerCore.Group` from all three, and the detail screen gates its
  Delete action on `is_creator`, so an endpoint that drops those columns
  silently disables it.
- **Icon writes ride create and PATCH.** `POST /api/groups` takes optional
  `icon`/`color`; `PATCH /api/groups/[id]` (any group member, since migration
  068 — Delete is the only rename/icon-adjacent action still creator-only)
  treats an absent key as "leave it alone", `null` (or `''`) as "clear it",
  and rejects any value outside the curated sets with a 400 — so clients
  render whatever arrives without re-validating.
- **A real rename or icon change is announced once (migration 068).** `PATCH`
  diffs against the stored row — a no-op PATCH (renaming to the same name)
  stamps nothing — and on an actual change stores who touched `name` and/or
  `icon`/`color` (folded into one `'icon'` field; they're one user-facing
  action) and when, via `strftime('%Y-%m-%d %H:%M:%f','now')` for millisecond
  precision. The editor's own `group_members.last_seen_change_at` is stamped
  in the same call, so they never see their own notice. `GET
  /api/groups/[id]` compares each *other* member's `last_seen_change_at` and
  `joined_at` against that stamp: a member already in the group when it
  happened and who hasn't seen this exact change yet gets a `change_notice`
  object (`changed_by`, `changed_by_name`, `changed_fields`, `changed_at`) —
  which also advances their high-water mark, so a second load never repeats
  it — and a member who joined afterward gets nothing, since they've never
  known the group any other way. Only the latest change is ever tracked, not
  a log: a second edit before anyone visits overwrites the first's notice.
  iPhone/iPad only, matching where the edit itself lives.
- **The list is alphabetical.** `GET /api/groups` orders a member's groups by
  `name COLLATE NOCASE` (ties broken newest-first), and no client re-sorts —
  web, iPhone/iPad and Apple TV all render the server's order, so ordering is a
  server-only change.
- **Group Trending** mirrors `/api/popular` but scoped to the group's members
  and the last 30 days, ranked by how many of them added the title. Each row
  carries `members` (first names) so the apps can caption a row with who added
  it. It shares `?limit=` and the list rule below with the club-wide query.
- **What counts as trending** is `_shared/trending-lists.js`: Watching,
  Awaiting and Loved, never Next Up. Both queries import it rather than
  spelling the list out, because two copies of this rule is exactly the thing
  that drifts. Next Up used to count, which let a title nobody had started
  trend on bookmarks alone. Reported by Sarah against Group Trending, where it
  is most visible — a small member set makes one person's bookmarks move the
  ranking — but it was true of the club-wide query as well. Pinned by
  `scripts/favorite-actors-test.mjs`.
- **Joining is a link.** `POST /api/groups/[id]/invite` mints the token and the
  share URL (`/groups/join?token=…`); opening it signed in joins the group,
  signed out it previews the group name and asks for a login.
- **Groups are the consent boundary for "Watching with".** Sharing a group is
  what makes someone nameable on a show — and therefore what makes it legal to
  write a row onto their list. See [`show_watchers`](#show_watchers).
- **Watch Next boards (migration 065).** Each group has a recommendation
  board: "Recommend to group" on a show puts a card on it, and group-mates
  get an in-app pop-up — "JC has recommended Lanterns" — with Dismiss or Add
  to Next Up. Pull-only by design: no write to anyone's list except the
  recipient's own tap onto their own Next Up. See
  [`group_suggestions`](#group_suggestions--group_suggestion_responses).
- **One read from outside the group, and it belongs to admins.**
  `GET /api/admin-member-groups?member=<slug>` answers which groups a member is
  in and who else is in each, for the Groups section of the admin member screen
  (`MemberAdminDetail` → `AdminGroupRosterView`). Admin session only — a
  logged-in non-admin gets 403 even for a group they belong to — and it returns
  membership without content: no shows, no trending, no lists. Reading is not
  joining; the endpoint writes nothing and doesn't widen the admin's own
  group-scoped features. See
  [Invariant 13](INVARIANTS.md#13-a-groups-membership-is-legible-to-admins-its-content-never-is).
- **Platforms.** iPhone and iPad create, invite, join, leave and delete — and
  carry the whole Watch Next flow (recommend, pop-up, board). Apple
  TV browses groups read-only (`GroupsListViewTV` / `GroupDetailViewTV`), which
  is why the tvOS API client has only the read calls (the board renders there
  as a read-only shelf). The watch has no
  groups at all. The admin Groups section above is iPhone/iPad/Mac only, like
  every other admin tool — Apple TV and the watch have no admin surface to put
  it on. Note that `SwiftUI.Group` collides with the model in any file
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
| `GET /api/popular`                     | `functions/api/popular.js`                 | GET     | none — `?limit=` (1–50, default 10) is the "More" expansion; ranks Watching/Awaiting/Loved adds only, never Next Up; served from the `trending_cache` daily snapshot, recomputed on the first request of each UTC day |
**Filling the gaps left by the rate-limit bug.** `POST /api/enrich` with
`{mode:'gaps'}` selects rows on the *absence of data* — no `actors` row, or a
series with no `episodes_released` — rather than on age, and reports
`remaining` so a caller can drive it to zero. This is the only ordering that
finds them: the no-match path stamped `enriched_at` on rows it failed to
enrich, so the damaged rows carry a *fresh* timestamp and the ordinary
oldest-first rotation sends them to the back, where a plain re-run reaches them
last. `scripts/fill-enrichment-gaps.mjs` is the runner — it loops until
`remaining.total` is 0, sleeps between rounds, and stops after three rounds
that attempt work and change nothing (what's left then is a genuine TMDB
no-match, not damage). `--dry-run` reports the count and enriches nothing. **Actions → "Fill
enrichment gaps"** runs that script with the repo's `CRON_SECRET` and defaults
to a dry run, which is where this is meant to be driven from: the backlog is
drained once, so it deliberately has no button in the app.

| `GET /api/favorite-actors`             | `functions/api/favorite-actors.js`         | GET     | session — the caller's OWN library only; takes no `?member=` |
| `GET /api/networks`                    | `functions/api/networks.js`                | GET     | none — the network picker the apps fetch instead of hardcoding; constant table, no member data, edge-cached 1h |
| `GET /api/activity`                    | `functions/api/activity.js`                | GET     | session — `?member=<slug>` scopes it to one person, `?limit=` (1–50, default 10) |
| `GET /api/rate-backlog`                | `functions/api/rate-backlog.js`            | GET     | session — backs `/rate-backlog`, the bulk-rate flow |
| `GET /api/rate-backlog-count`          | `functions/api/rate-backlog-count.js`      | GET     | session — the unrated count alone, for the nav badge |
| `GET /api/recommendations`             | `functions/api/recommendations.js`         | GET     | session (legacy — no longer called by any client) |
| `GET /api/vibe`                        | `functions/api/vibe.js`                    | GET     | session — you and members of your groups only; any other slug is 403. Group membership is the *only* gate: the taste exclusion never hides a profile (see [Taste exclusion](#taste-exclusion-_sharedexcluded-membersjs)) |
| `GET /api/shows`                       | `functions/api/shows.js`                   | GET     | session |
| `GET /api/export`                      | `functions/api/export.js`                  | GET     | session (exports the caller's OWN lists only; plain-text download) |
| `POST /api/shows`                      | `functions/api/shows.js`                   | POST    | session. Optional `watcher_slugs` names group-mates — see [`show_watchers`](#show_watchers) |
| `GET /api/group-members`               | `functions/api/group-members.js`           | GET     | session — everyone the caller shares a private group with, self-scoped (no slug param). The candidate list for the "Watching with" picker, and exactly the set `watcher_slugs` is validated against |
| `POST /api/import/parse`               | `functions/api/import/parse.js`            | POST    | session |
| `POST /api/import/commit`              | `functions/api/import/commit.js`           | POST    | session |
| `GET /api/shows/all`                   | `functions/api/shows/all.js`               | GET     | session — your own rows plus those of members you share a group with |
| `GET /api/shows/check`                 | `functions/api/shows/check.js`             | GET     | session |
| `POST /api/shows/share`                | `functions/api/shows/share.js`             | POST    | retired 2026-07 — returns 410 Gone |
| `GET /api/shows/[id]`                  | `functions/api/shows/[id].js`              | GET     | none; catalog fields only unless the session owns the show (notes, watching_with, recommended_by are owner-only). `group_watchers` is session-only and group-scoped — see below. `list` is present-but-empty for a logged-out visitor rather than absent: the Apple clients decode it non-optionally, and omitting it failed the whole payload, blanking a public show card whose catalog fields were all being sent |
| `PUT /api/shows/[id]`                  | `functions/api/shows/[id].js`              | PUT     | session. `watcher_slugs` is the COMPLETE set, so unticking someone unlinks them; **omitting the key entirely leaves the links alone** (what an older build sends), which is why absent and `[]` must not be conflated |
| `DELETE /api/shows/[id]`               | `functions/api/shows/[id].js`              | DELETE  | session — unlinks watchers in both directions first (see [`show_watchers`](#show_watchers)) |
| `PUT /api/shows/[id]/move`             | `functions/api/shows/[id]/move.js`         | PUT     | session |
| `POST /api/shows/reorder`              | `functions/api/shows/reorder.js`           | POST    | session (own rows only) |
| `PUT /api/shows/[id]/archive`          | `functions/api/shows/[id]/archive.js`      | PUT     | session |
| `GET /api/shows/[id]/actors`           | `functions/api/shows/[id]/actors.js`       | GET     | none |
| `PUT /api/shows/[id]/rating`           | `functions/api/shows/[id]/rating.js`       | PUT     | session (own copy only, list != Next Up, tmdb_id required) |
| `POST /api/suggestions`                | `functions/api/suggestions.js`             | POST    | retired 2026-07 — returns 410 Gone |
| `GET /api/groups`                      | `functions/api/groups.js`                  | GET     | session — the caller's own groups |
| `POST /api/groups`                     | `functions/api/groups.js`                  | POST    | session — creates the group, joins the caller, returns a first invite |
| `GET /api/groups/[id]`                 | `functions/api/groups/[id].js`             | GET     | session + membership (403 otherwise) — response carries `change_notice` at most once per member per rename/icon change |
| `PATCH /api/groups/[id]`               | `functions/api/groups/[id].js`             | PATCH   | session + membership (any member, not just creator) — rename and/or set `icon`/`color` (curated sets; absent = keep, null = clear) |
| `DELETE /api/groups/[id]`              | `functions/api/groups/[id].js`             | DELETE  | session + creator |
| `POST /api/groups/[id]/invite`         | `functions/api/groups/[id]/invite.js`      | POST    | session + membership — mints a 7-day token |
| `POST /api/groups/[id]/leave`          | `functions/api/groups/[id]/leave.js`       | POST    | session + membership |
| `GET /api/groups/[id]/trending`        | `functions/api/groups/[id]/trending.js`    | GET     | session + membership — top 10 titles the group added in 30 days |
| `GET /api/groups/[id]/suggestions`     | `functions/api/groups/[id]/suggestions.js` | GET     | session + membership — the group's Watch Next board, shaped for the viewer |
| `POST /api/groups/[id]/suggestions`    | `functions/api/groups/[id]/suggestions.js` | POST    | session + membership — recommend your own copy of a show to the group (daily ceiling; duplicate titles fold) |
| `POST /api/groups/[id]/suggestions/[sid]` | `functions/api/groups/[id]/suggestions/[sid].js` | POST | session + membership — answer the pop-up (`dismiss` \| `add`); `add` copies onto the caller's own Next Up |
| `DELETE /api/groups/[id]/suggestions/[sid]` | `functions/api/groups/[id]/suggestions/[sid].js` | DELETE | session + (recommender or group creator) |
| `GET /api/groups/join?token=`          | `functions/api/groups/join.js`             | GET     | session joins; without one, returns a name-only preview |
| `POST /api/enrich`                     | `functions/api/enrich.js`                  | POST    | session or `CRON_SECRET` header |
| `POST /api/sync-urls`                  | `functions/api/sync-urls.js`               | POST    | session (demo member's rows excluded as URL sources) |
| `GET /api/reporting`                   | `functions/api/reporting.js`               | GET     | admin session |
| `POST /api/account-delete`             | `functions/api/account-delete.js`          | POST    | session; hard-deletes the caller's account after an emailed code confirms |
| `POST /auth/enroll`                    | `functions/auth/enroll.js`                 | POST    | signup code from `enroll_otps` |
| `POST /auth/google`                    | `functions/auth/google.js`                 | POST    | Google ID token (inert unless `GOOGLE_CLIENT_ID` set) |
| `GET /auth/config`                     | `functions/auth/config.js`                 | GET     | none — public flags/keys for the login UI |
| `POST /auth/passkey-begin`             | `functions/auth/passkey-begin.js`          | POST    | none — mints a sign-in challenge; takes no identifier |
| `POST /auth/passkey-finish`            | `functions/auth/passkey-finish.js`         | POST    | WebAuthn assertion — verifies and issues the session |
| `POST /auth/passkey-register-begin`    | `functions/auth/passkey-register-begin.js` | POST    | session — challenge + creation options for adding a passkey |
| `POST /auth/passkey-register-finish`   | `functions/auth/passkey-register-finish.js`| POST    | session — verifies the attestation and stores the credential |
| `GET /api/passkeys`                    | `functions/api/passkeys.js`                | GET     | session — the caller's own registered passkeys |
| `DELETE /api/passkeys/:id`             | `functions/api/passkeys/[id].js`           | DELETE  | session — removes one of the caller's own passkeys |
| `GET/POST /api/admin-member-emails`    | `functions/api/admin-member-emails.js`     | GET, POST | admin session — GET is the roster with contacts, platforms, last login, current per-list totals and 30-day activity; `?member=<slug>` narrows it to one row (the admin member screen). `list_counts` and `show_count` share the active-non-seed filter, so the four sum to the one. POST edits one member's name/emails/phones |
| `GET /api/admin-member-groups`         | `functions/api/admin-member-groups.js`     | GET     | admin session — `?member=<slug>` (required; 400 without it) returns the private groups that member is in, each with its roster (`slug`, `name`, `is_creator`, `disabled`). The one read of a group from outside it; membership only, never the group's content — see [Invariant 13](INVARIANTS.md#13-a-groups-membership-is-legible-to-admins-its-content-never-is) |
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
   - `request-code` caps a member to 5 code sends/hour, caps any single source IP to 10 sends/hour across all members (`MAX_PER_IP_PER_HOUR`, skipped when `CF-Connecting-IP` is missing so a shared "unknown" bucket can't lock out unrelated members), and logs the requester's IP on every row. On the **web** email form it also requires a Turnstile token (returns `403 {error:'captcha'}` on failure, checked *before* the membership lookup so it can't be used to probe which emails are members). This is gated on a browser `Origin` header so native iOS/tvOS email/phone login — which can't produce a Turnstile token — is never challenged, and is inert unless `TURNSTILE_SECRET_KEY` is set. That front-door check is the *only* Turnstile check on the path: the token is single-use, and until 2026-08 the unknown-email (signup-code) branch re-checked it, which fails closed for every native caller and silently dropped every signup code iOS and tvOS asked for. The email address of the configured demo account short-circuits before any of this and returns `{success:true}` without sending anything — see [Demo account](#demo-account). A delivery failure returns `502 {error:'send_failed'}` for members and strangers alike (whether a mail provider accepts an address doesn't depend on membership, so it leaks nothing, and swallowing it is what leaves someone waiting on a code that will never come). Sending a code never exposes it to the requester (it only ever goes to the address already on file), and the verify step's per-IP + per-member failure caps make the 6-digit code non-brute-forceable, so unrequested codes are a nuisance, not an account risk.
2. Throttle check: 5 failed attempts per IP in 15 minutes → 429 with `Retry-After`.
3. Resolve the member: phone → `member_phones` + Twilio Verify; email → `member_emails` + `login_otps`; Apple → verify the token, then `member_apple_ids` (or first-time email match against `member_emails`).
4. On success: insert a `sessions` row (UUID id, member's name as `email`, 30-day `expires_at`), set an HttpOnly + Secure + SameSite=Lax `session=` cookie, return the slug.
5. On failure: insert a `failed_logins` row, return 401.

`functions/_shared/auth.js` exports `getSession(request, env)` which reads the cookie, queries the session row, checks `expires_at` and that the member isn't disabled (`members.disabled`, migration 030), and returns `{email, member_slug}` or `null`. Every mutating endpoint and `/api/reporting` calls `getSession` first. Disabling a member (`POST /api/admin-member-disable`, or the Disable button on `/members`) also deletes their sessions, so bans are immediate.

Admin endpoints are gated by `_shared/admin.js#isAdmin()` — a valid session whose member row has `members.is_admin = 1` (migration 029). Admin rights live in the database, so admins are added/removed with an `UPDATE members SET is_admin = ...`, not a code change. There is no separate admin secret; an admin just needs to be logged in. Endpoints that need to know *which* admin acted use `getAdminSession()` from the same module.

Rate limits on `POST /auth/login`: 5 failed attempts per IP **and** 10 failed attempts per member account per 15 minutes → 429 with `Retry-After`. The per-member cap stops a distributed guesser who knows a member's email/phone from brute-forcing a 6-digit code across many IPs.

Scheduled-job endpoints accept an `X-Cron-Secret` header compared in constant time (`_shared/secrets.js#cronAuthorized`).

### Passkeys (migration 062)

WebAuthn sign-in, added 2026-08. A passkey is the only login path with no third party in it: no SMS, no email delivery, no identity provider — the device signs a challenge and the server checks it against a stored public key.

**A passkey never creates an account.** Registration requires a session, so a credential can only ever be added by someone who has already proved the account is theirs; an unrecognized credential at sign-in is refused, not enrolled. Enrollment stays with Apple/Google/email (see Self-enrollment below). That also means removing every passkey can't lock anybody out — the account's original method still works — which is why `DELETE /api/passkeys/:id` has no "last credential" guard.

Four endpoints, challenge-then-verify in both directions:

| Endpoint | Session | What it does |
| --- | --- | --- |
| `POST /auth/passkey-register-begin` | required | Mints a `register` challenge bound to the session's member and returns the creation options (rp, user handle, `excludeCredentials`, `residentKey: required`, `userVerification: required`). |
| `POST /auth/passkey-register-finish` | required | Verifies the attestation and stores the credential. Capped at 10 passkeys per member. |
| `POST /auth/passkey-begin` | none | Mints an `authenticate` challenge. Takes **no identifier** — the credentials are discoverable, so asking for an email first would leak whether an address is a member and buy nothing. The response is identical for everyone. |
| `POST /auth/passkey-finish` | none | Verifies the assertion, resolves the member from `credential_id`, issues the session (`auth_method = 'passkey'`). |

**The relying party is the site, not the app** — `showpicker.club`, overridable via `PASSKEY_RP_ID` / `PASSKEY_ORIGINS` for local preview. That's what makes one credential work across iPhone, iPad and Mac through the iCloud Keychain, and it's why the app needs the `webcredentials:showpicker.club` Associated Domains entitlement (both entitlement files) *plus* the `webcredentials` block in the AASA file. Miss either half and iOS refuses to hand the app a credential, with nothing in the logs to say why — `scripts/check-static.sh` asserts both.

**Verification is hand-rolled** in `functions/_shared/webauthn.js`, because this stack has no npm and no build step (see CLAUDE.md). It contains a minimal CBOR decoder, COSE→`CryptoKey` import for ES256 (what Apple's platform authenticator uses) and RS256 (hardware-key fallback), DER→raw ECDSA signature conversion, and the RP-ID-hash / origin / challenge / flag checks. `functions/_shared/passkeys.js` holds the policy around it: relying-party config, the single-use challenge store, and a ceiling of 20 outstanding challenges per IP (starting a sign-in is unauthenticated, so the table needs a bound).

Things that are deliberate rather than accidental:

- **Attestation is not verified.** Registration accepts `fmt: "none"` and self-attestation. We trust the device because the member was signed in when they enrolled it, not because a manufacturer certificate says so — and verifying a chain would mean shipping root certificates we have no way to keep current.
- **User verification is required, both ways.** The options ask for it and the server refuses any authenticator data without the UV flag, so the two can't drift apart.
- **The signature counter check only fires when both sides are non-zero.** Apple's passkeys always report 0 and never increment; treating that as a rollback would lock out every Apple device. It still catches a cloned hardware key.
- **Challenges are deleted on every lookup, hit or miss** — so a challenge offered up to a failed verification doesn't get a second attempt either. That, not the TTL, is what makes a captured assertion worthless.
- **The user handle is the member slug**, which comes back on an assertion, but `credential_id` is what actually resolves the member. The handle is attacker-controlled on the wire; the credential id is matched against a row we wrote.

Tests: `scripts/webauthn-test.mjs` (the cryptography — valid credentials verify, forged/replayed/wrong-origin/wrong-RP/counter-rollback ones don't) and `scripts/passkey-flow-test.mjs` (the endpoints, driven against a real SQLite database built from `schema.sql` — replay, purpose separation, cross-member isolation, disabled members). Both run in `pr-checks.yml`.

Clients: iOS/iPad only. `PasskeyAuthenticator.swift` wraps `ASAuthorizationController`, `PasskeysView.swift` is the management screen (account menu on iPhone, sidebar account menu on iPad), and `LoginView` gets a "Sign in with a passkey" button above Sign in with Apple. tvOS and watchOS are unchanged — see docs/PRODUCT.md#passkeys for why.

### Self-enrollment (migration 031; approval retired in migration 058)

Signing up is the only way a member row is created — there is no operator-created path, no `/join` request queue, and no approval step. Unknown identities create accounts directly: `/auth/request-code` sends a signup code (`enroll_otps`) for unknown emails, `/auth/login` answers `{needs_name:true}` for a valid signup code, and `/auth/enroll` completes it; `/auth/apple` and `/auth/google` enroll unrecognized identities directly (asking the client for a name via `{needs_name:true}` when the token doesn't carry one). A new member is a full member immediately: on the roster, in cross-library search, activity, trending, and vibe like anyone else. Guards live in `_shared/enroll.js`: global daily circuit breaker (`SELF_ENROLL_MAX_PER_DAY`, default 20 — counts `members` rows with a non-NULL `enrolled_via`), a per-IP cap of 3/day (counts `members.enroll_ip`), a per-email code cap, optional Turnstile (`TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY`, fail-open when unset), a reserved-slug blocklist (`_shared/create-member.js#RESERVED_SLUGS`), and an operator email per signup (capped 10/hour; its button links the new member's page, `showpicker.club/<slug>`, so it opens the app on iPhone/iPad rather than the browser — the roster is demoted to a plain link because `/members` is AASA-excluded and can only open in a browser). Members self-delete via `/api/account-delete` (fresh emailed code, `channel='delete'` in `login_otps`, hard delete — the member row carries the last of the enrollment record, so nothing survives it).

**Retired 2026-08 (migration 058).** `members.approved` (the "held" state that hid a new account from the roster, vibe, search, activity, and trending), the `signup_requests` table, the `/join` request form and its `POST /api/signup-request` endpoint, `GET/POST /api/admin-signup-requests`, `POST /api/admin-member-approve`, and the `SELF_ENROLL` kill switch are all gone. `/join` 301s to `/`. `DEMO_APPLE_FALLBACK` went with them: signup now catches every unrecognized Apple identity that carries an email, so the fallback branch was unreachable — App Review uses the `DEMO_LOGIN_EMAIL`/`DEMO_LOGIN_CODE` login.

**Registration name capture.** `_shared/enroll.js#validFullName()` requires a first *and* last name (at least two whitespace-separated tokens, 2–60 characters total, ≥1 Unicode letter, no control chars/angle brackets) — a single-word name is rejected with `'Enter your first and last name.'` before any member row is created. Self-enrollment is the only registration path, so every member is guaranteed a `last_name` at creation time. (Manual-add, retired 2026-07, was the one path where `last_name` was always optional; its removal plus this check is what closed the gap that let one member register with no last name.)

Enrollment responses include `enrolled: true` alongside the usual `{success, slug}` session payload (`issueSession`'s `extra` param); plain logins omit it. Native clients ignore the extra key. The flag existed for the web frontend's GA4 `sign_up` conversion event, and `/welcome` (`welcome.html`) was the stable confirmation URL registered with Google Ads' page-based conversion tracking — **both went away with the web app in 2026-08.** There is no web signup any more, so that conversion can never fire; `/welcome` 301s to `/`, and the Google Ads Smart campaign's conversion setting is pointing at a dead URL until someone re-points it. The `enrolled` flag itself is harmless and still returned.

### Demo account

`DEMO_LOGIN_EMAIL` + `DEMO_LOGIN_CODE` (Cloudflare secrets) enable a reviewer/demo login: that one email signs in with a fixed code. With the secrets unset, all of it is inert.

**The demo address never receives mail.** `POST /auth/request-code` answers `{success:true}` for it without generating an OTP or calling Resend, so the demo login works whether or not the address can receive email. It did not, and that is how tvOS 1.2 was rejected on 2026-08-08: `demo@example.com` is a reserved domain, Resend refuses it with a `422`, `request-code` turned that into a `502`, and the apps stopped at "Couldn't send the code" — one screen before the fixed code they'd been given would have worked. Both halves are covered by `scripts/auth-code-flow-test.mjs`, whose fake Resend refuses reserved domains the same way. The short-circuit requires both secrets *and* a member row for the address — the same three conditions `/auth/login` needs — so a half-configured demo falls through to the ordinary emailed-code flow rather than dead-ending. (`DEMO_APPLE_FALLBACK`, which routed unrecognized Apple IDs into the same demo member, was removed in migration 058 — signup turns those identities into real accounts before the fallback could run.)

The demo member's data auto-resets (`_shared/demo.js`): each demo sign-in snapshots the account's shows/actors/subscriptions as a baseline (if clean) and arms a reset for one hour later. The reset runs lazily at the next demo sign-in and daily via the `demo-reset.yml` GitHub Action → `POST /api/admin-demo-reset`. The demo member's rows are ignored as URL-sync sources. (Cross-member writes — suggestions, shares — were retired for everyone in 2026-07.)

### Session activity tracking

`/auth/check` is hit on every page load by the SPA. It bumps `sessions.last_seen_at`, but throttled — the `UPDATE` clause only fires when `last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 hour')`. This means at most one write per session per hour, with no read-then-write.

`last_seen_at` feeds **Reporting** only: DAU / WAU / MAU = `COUNT(DISTINCT member_slug) FROM sessions WHERE last_seen_at >= ...`. The home-page member ordering is library-based (`last_activity_at` on `/api/members`), not session-based.

Platform breakdown (Reporting's "Active by platform" and the Manage Members badges) reads `_shared/platform.js#KNOWN_PLATFORMS` — the single source of truth for valid `X-Client-Platform` values, imported by both `_shared/auth.js` and `auth/check.js` so they can't drift out of sync with each other (they used to define it separately, and the duplicate silently dropped `watchos`).

**The breakdown counts people, not sessions** (changed 2026-08). It was `COUNT(DISTINCT id)`, which counted session rows: a reinstall, a re-login and a browser tab are three rows for one person, and a two-member club read "13 iPhone / 22 / 31". It is now `COUNT(DISTINCT COALESCE(member_slug, 'session:' || id))` per platform per window — distinct members, with member-less sessions (an anonymous tvOS device) falling back to one-per-session so they neither collapse into one phantom person nor vanish. A member active on two platforms counts on both rows, so the rows don't sum to Active members; the iOS section header and footer say so. Pinned by `scripts/reporting-platform-test.mjs` and written down as invariant 11.

Durable login tracking is separate: `members.last_login_at` (stamped by `_shared/session.js#issueSession` on every login). The `sessions` table cannot answer "when did this member last log in" — logout, admin disable, and account deletion all delete session rows — so the admin member list (`/api/admin-member-emails`) and the engagement script read `last_login_at`, falling back to sessions only when the column is NULL. The endpoint normalises the value to fraction-less UTC ISO (`2026-07-19T08:30:00Z`) because the shipped iOS admin screen's `ISO8601DateFormatter` rejects fractional seconds.

## Frontend pages

**The web member app was removed in 2026-08 and restored the same month.** The
archive existed for four weeks; the restore was a `git mv` back, a `_redirects`
edit and the CSP sources sign-in needs. `archive/` is gone again — the files are
back under `public/`, and **`public/index.html` is the member SPA**, as it was
before the teardown. The marketing page moved to `public/download.html`.

| URL | Serves |
|---|---|
| `/`, `/patrick`, any unmatched path | `index.html` — the member SPA, **URL intact** |
| `/download` | `download.html` — the App Store pitch, Trending shelf, and a link into the app |
| `/groups`, `/vibe`, `/rate-backlog`, `/subscriptions`, `/welcome` | their own pages |
| `/members`, `/reporting`, `/url-cleanup`, `/vibe-admin` | the four admin tools |
| `/privacy`, `/terms`, `/sms` | legal pages, linked from the App Store listing |

### The catch-all can only point at `/index.html`

This is the constraint the whole layout is built around, and getting it wrong
took the site down on 2026-08-13. The first restore put the app at `app.html`
and pointed the catch-all there. Every path on the site — `/`, `/groups`, even
`.well-known/apple-app-site-association` — started answering 308, in a loop.

Reproduced and pinned down against `wrangler pages dev`:

| Rule | Result |
|---|---|
| `/*  /index.html  200` | real files win; only unmatched paths fall through. **The only correct shape.** |
| `/*  /app.html    200` | Pages canonicalizes the `.html` destination to `/app` with a 308 — which matches `/*` again. Every path, site-wide, loops. |
| `/*  /app         200` | no canonicalization, but it stops being a fallback: it rewrites unconditionally and swallows real files, the AASA included. |

A rewrite to `/index.html` is the one destination Pages treats as a fallback
rather than an unconditional rewrite. So whatever renders member slugs *is*
`index.html` — there is no arrangement where the app lives at another path and
still answers `/patrick`. Two things follow:

- **Pages Functions are unaffected** by any of this: they take precedence over
  `_redirects`, so `/api/*`, `/auth/*`, `/calendar/*`, `/show/:id` and the two
  invite previews resolve to their handlers, catch-all or not. Verified in the
  same emulator (`/api/shows` answers 401 from its own handler, not the app).
- **A root catch-all Function is not an alternative.** `functions/[[path]].js`
  shadows every other Function — `/api/popular` came back as HTML — and
  `context.next()` ignores a rewritten pathname, so it cannot serve a different
  asset anyway.

Things that follow from the app being the root:

- **`index.html` carries the fallback Open Graph tags.** Every URL without tags
  of its own previews from whatever the catch-all serves, so the `og:image` that
  #373 added to the marketing page had to move with the slot. `download.html`
  keeps its own copy for its own URL.
- **Web sign-in works again**, so the CSP carries the Apple, Google and Turnstile
  script/frame/form-action sources again. Each fails *silently* when missing —
  the button renders and the flow never completes — so both `check-static.sh`
  and `smoke.sh` assert them.
- **`welcome.html` is a live Google Ads conversion URL again.** Fresh web signups
  land there (see `finishLogin` in `index.html`).
- **Group invites shared from iOS (`/groups/join?token=…`) hit a Pages Function,
  not the SPA.** That's the link-preview card, and it now carries a "Join in your
  browser" link to `/groups?token=…` — the URL `groups.html` actually redeems —
  on live invites only, so an expired and an unknown token still render the same
  card. Household invite codes have no web redemption path, so that card stays
  App-Store-only.

### `download.html` — the marketing page

Self-contained: hero, four feature cards, the Trending shelf, and a footer.
Trending comes from the public `GET /api/popular` (logged out it names no
members — see [Public surface](#public-surface)), rendered by ~60 lines of
inline JS with skeleton placeholders and an explicit failure message rather than
skeletons that pulse forever. It also carries the retired-PWA sweep, as the SPA does:
unregister any surviving service worker and drop its caches, so old home-screen
installs don't keep serving a stale copy of the app.

The App Store call-to-action tailors only its **wording** per device (iPhone /
iPad / Mac), never its behavior. A browser cannot detect whether the app is
installed — there is no API, and the custom-URL-scheme probe fires an OS dialog
and fails silently in Safari. Apple's own machinery covers it instead: the
`apple-itunes-app` meta tag renders OPEN vs GET in iOS Safari, Safari on every
Apple platform offers "Open in app" for the universal-link domain, links arriving
from outside a browser (Mail, Messages) route straight to the app, and the App
Store page itself shows Open when the app is already installed.

### Redirects

`public/_redirects` 301s the four paths member approval left behind: `/join` →
`/`, and `/setup`, `/requests`, `/admin` → `/members`. Nothing else redirects —
the pages the 2026-08 teardown pointed at `/` are real files again, and a
leftover rule would bounce a member off the page they asked for (`check-static.sh`
and `smoke.sh` both assert their absence, because the catch-all would otherwise
hide the mistake by rendering the app at every one of them).

Member slugs are deliberately **not** in that list. They keep falling through the
catch-all (`/*  /index.html  200`), which is a rewrite rather than a
redirect, so `showpicker.club/patrick` keeps its URL and renders that member's
lists. That is what lets iOS and macOS match it against
`.well-known/apple-app-site-association` and open the app instead of ever
fetching the page. A 301 would still work on Apple devices — the OS resolves the
link before any request goes out — but it would throw away the member context on
every other device, and on a shared link that context is the whole point.

## Link previews (Open Graph)

The apps share three kinds of link — a show, a group invite, a household invite. All three are universal links that iOS already routes into the app; **this is not about the tap.** When a link is sent in Messages (or Slack, or WhatsApp), the device makes a plain server-side GET to build the preview bubble: no app is involved, and it happens whether or not the recipient has the app installed. The bubble is rendered entirely from the Open Graph tags in the HTML that GET returns.

Before 2026-08 there were no such tags. Every shared link fell through `_redirects`' catch-all, whose `og:title` is the constant "Show Picker Club" and which carried **no `og:image` at all** — so every share of every show arrived looking identical, with no artwork. Note the consequence for the Swift side: nothing passed to `ShareLink(subject:message:)` reaches that bubble. `subject`/`message`/`SharePreview` style the *share sheet* and the message body; the card comes from the page.

| Route | og:title | Image |
|---|---|---|
| `functions/show/[id].js` | `<Title> on Show Picker Club` | backdrop, else poster, upscaled to `w1280` |
| `functions/groups/join.js` | `Join <Group> on Show Picker Club` | site default |
| `functions/household/join.js` | `Join <First>'s household on Show Picker Club` | site default |

`functions/_shared/og-page.js` renders all three, plus `public/og-default.png` (1200×630) as the fallback and the marketing page's `og:image`.

These are Pages Functions, so they take precedence over the `_redirects` catch-all for their paths; `/groups/join` does not collide with the `/groups` 301, which is an exact match. They are **preview metadata plus a card for whoever opens one without the app**; the web member app is a separate surface at `/app` (see [PRODUCT.md#web-app-status](PRODUCT.md#web-app-status)).

Because they are public and session-free, the constraints are all negative ones, and `scripts/og-preview-test.mjs` pins them:

- The show route selects **catalog columns explicitly** rather than `SELECT *`, so a personal column added to `shows` later cannot quietly start appearing on a page anyone can fetch. No note, recommender, watching-with, or whose-list-is-it ever renders.
- Titles come from TMDB *and* from members' typing, so everything is HTML-escaped — `"` and `'` included, since these land inside `content="…"` attributes.
- `og:image` only ever emits a URL under `image.tmdb.org` or `showpicker.club`; anything else falls back to the default.
- An unknown invite token renders the identical card to an expired one, so a dead link never confirms a token existed. Only a live invite gets a group name or a first name.

## Universal links

`public/.well-known/apple-app-site-association` (served as `application/json` via a `_headers` rule — it has no extension) claims showpicker.club URLs for the iOS app (`NQ6AJVVBBJ.net.patrickturner.showpickerios`): member pages and `/` open in-app when tapped from another app; API/auth/calendar/admin paths and web-only pages (`/vibe`, `/subscriptions`, legal pages) are excluded and stay in the browser. The same file's `webcredentials` block is what authorizes the app to use passkeys scoped to the domain — see [Passkeys](#passkeys-migration-062). The app side is the `applinks:showpicker.club` and `webcredentials:showpicker.club` Associated Domains entitlements (iOS + Catalyst) plus `route(url:)` handlers in `HomeView` (iPhone: pushes the member) and `IPadHomeView` (focuses the member in the sidebar, honoring the `#list` fragment web URLs carry). Cold-launch links park in `pendingLink` until the roster loads; the `dorothy` → `whitt` slug redirect is mirrored. Apple's CDN caches the AASA file (~hours), so entitlement/AASA changes take a re-install or a day to propagate to devices.

## Native clients

Native SwiftUI apps for iOS, tvOS, and watchOS call the same public `/api/*` endpoints as the web. They share a `ShowPickerCore` Swift package (at the repo root) that holds the `Show` / `Actor` / `ShowList` models and their response wrappers, and are opened together via `ShowPickerClub.xcworkspace`. iOS and tvOS share one bundle id (`net.patrickturner.showpickerios`) and ship as a single universal App Store app (iPhone + Apple TV). The watchOS app (`ios/ShowPickerWatch Watch App`) is paired to the iPhone and receives its session via WatchConnectivity. Its reads are **session-gated like every other library read** — `/api/shows?member=…` 401s without a cookie, so the relayed cookie is what makes the watch work, not the slug alone. (An older comment here and in `WatchAPI.swift` claimed these reads were public; they haven't been since the public surface was tightened.) A 401 on the watch therefore means the hand-off is stale, and the fix is on the phone — the watch has no sign-in of its own, so `ListsView` says so instead of offering a Try Again that cannot succeed, and does not burn retries on it. Platform usage tracking now includes a `watchos` platform value.

### watchOS cold launch (stale-while-revalidate)

The watch is slow to launch mostly because it is slow to get a *network* up: watchOS brings the radio (or the phone's Bluetooth proxy) online lazily, so the first request can take seconds or fail outright and need a retry. Blocking the UI on that put a spinner in front of every launch, and the retry ladder (1.5s + 3.0s of sleeping) meant a failure took ~5s to surface.

`WatchCache` (`ShowPickerCore/Sources/ShowPickerCore/WatchCache.swift`) removes the wait: every successful `/api/shows` response is written to disk, and `ListsView.load()` replays it before touching the network, then refreshes in the background. Notes:

- **Application Support, not Caches** — watchOS purges Caches under storage pressure, which would put the spinner back.
- **One file per member slug**, and a loaded entry whose `slug` doesn't match is treated as a miss, so switching members can never flash the previous member's lists. `WatchAuth.apply()` calls `WatchCache.clear()` on sign-out *and* on a slug change.
- **Cache hydration only fills a blank screen.** A refresh of already-visible lists skips it, so the UI never flickers back through older data on its way to newer.
- **`ListsView` keys `.task(id:)` on `WatchAuth.sessionToken`** (slug *and* cookie), because the phone commonly hands off a fresh session a moment after launch; keying on the slug alone left an expired-cookie error on screen until the app was reopened.
- **Foreground refresh is unconditional.** It used to reload only when the screen was empty — with a cache it never is, so that check would have pinned a wrist-raise to stale lists.
- Foundation-only, so `swift test` covers it on Linux CI (`WatchCacheTests`).

### tvOS Watch button

Audited on device 2026-08-12 across every network the club carries. `ShowDetailView.swift` builds an **ordered list of candidate URLs** (`openTargets`) and `openWatch` walks it, using `openURL`'s completion to fall through to the next candidate whenever the device refuses one. Nothing is looked up at tap time. The per-service scheme table (and the `deepLinksToShow` flag) lives in `StreamingApps.swift`, not in the view, because the Streaming Link Check below reads the same table — a diagnostic that probes schemes production no longer tries is worse than none.

- **HBO Max and Apple TV+** honor the plain https URL by *service*, so they get it directly and land on the real show (`deepLinksToShow`). The HBO Max `/search?` fallback URL also goes direct — it opens HBO Max with the title pre-filled. Everything else opens its app to the home screen; the button says "Open X" rather than "Watch on X" to stay honest about that (`canDeepLink`).
- **Prime Video lands on the show too, but the property belongs to the URL rather than to the service** — `urlLandsOnShow` asks whether the stored URL's host is `watch.amazon.com`, and only that host reaches the title (device test 2026-09-10; `amazon.com/gp/video/detail/<ASIN>`, `amazon.com/<slug>/dp/<ASIN>` and `primevideo.com/detail/<id>` all fail). Watchmode hands back all four shapes, so **two members' copies of the same show can legitimately show different buttons** — "Watch on Prime Video" for the row that carries the working shape, "Open Prime Video" for the row that doesn't. That is the label doing its job rather than a bug: it promises show-level landing only where the row can deliver it. Repairing the stored shapes is the way to make it uniform, not widening the flag to the whole service.
- **Everything else** gets its custom URL schemes first, then the https URL as a backstop. On tvOS the https universal link doesn't open most streaming apps at all — `openURL` reports accepted=false — while the app's own scheme launches it.
- **Several services list more than one scheme** because these apps get renamed and it's the *old* scheme that stays registered: Paramount+ still ships as `com.cbsvideo.app` and MGM+ as `com.epix.epixnow`. Candidates are current-name-first (`paramountplus` → `cbsaa`, `mgmplus` → `epixnow` → `epix`, `aiv` → `primevideo`). A service renaming its scheme degrades to the next candidate instead of to a dead button.
- No `LSApplicationQueriesSchemes` declaration is needed or present — that gates `canOpenURL`, not `openURL`.

**Do not reintroduce a title-based Apple catalog lookup.** Until 2026-08-12 the button called iTunes Search with `media=tvShow`, whose default entity is **tvEpisode**: it matched episode titles across Apple's entire catalog and any hit took priority over the service's own scheme. "The Bear" resolved to a *Bones* episode, "Boiling Point" to a *1000-lb Sisters* episode, "Stranger Things" to a *Nightwatch* episode — and because a non-nil match won, `hulu://` and `aiv://` were never reached. Modern streaming originals aren't in Apple's purchasable catalog at all, so the lookup's upside was near zero and its false-positive rate was high. If an Apple TV fallback link is wanted, resolve it server-side against a real id and store it (see PRODUCT.md's deep-link backlog entry).

**Streaming Link Check** (`StreamingLinkCheckView.swift`) is the operator-facing
half of the same problem: Account tab → Streaming Link Check, admin sessions
only, one button per candidate scheme, result recorded per scheme. It calls
`openURL` rather than `canOpenURL` — `canOpenURL` would answer without leaving
the app but only for schemes declared in `LSApplicationQueriesSchemes`, and this
target's `Info.plist` is generated (`GENERATE_INFOPLIST_FILE`) so it can't carry
that array; `openURL` needs no declaration and a success lands you in the app,
which is the thing being tested. Because a pass backgrounds the app, results are
written to `UserDefaults` (`streamingLinkCheck.results`) inside the completion
handler rather than held in view state. Product behavior and the platform call
are in [PRODUCT.md](PRODUCT.md#streaming-link-check-apple-tv-admin-sessions-only).

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
- Two callers: `/api/admin-vibe-fill` (vibe trait scoring) and `/api/import/parse` (list import).
- **Vibe fill** — model `claude-sonnet-4-6`, max tokens 1024 per show. System prompt: ~1000 tokens of calibration instructions for the 27-trait rubric, cached `ephemeral` so repeated batch calls hit the prompt cache. Handles 429 with the API's `Retry-After`, capped at 60s backoff.
- **List import** — model `claude-opus-5`, max tokens 16000 per slice, `output_config.effort: "low"` (a scoped, latency-sensitive extraction; the member is waiting). Uses **structured outputs** (`output_config.format` with a JSON schema) rather than prose parsing, so the response is valid JSON in the expected shape or the request fails — there is no fenced-code stripping or regex extraction anywhere in the path. The system prompt is byte-identical across every slice of every import and is cached `ephemeral`. Same 429 retry shape as the vibe filler.
- The import prompt asks for **titles, never TMDB ids**. Ids come only from TMDB (see List import below). A model asked for ids will produce plausible ones, so it is never asked.

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
few" means the principals. TMDB can credit the same person twice (one entry
per role); `dedupeCast()` keeps the best-billed entry per person id (per name
for id-less credits) before the depth cap, in both the add-time path and the
background cast refresh — without it the refresh's delete-and-reinsert
re-created any dupes cleaned up by hand. Creators come back from `GET /api/shows/:id` as a
`creators` array of `{name, imdb_id}` (up to 4, resolved per name): `director`
is one comma-joined string carrying a single id for the first credit, so a
co-created show could previously link none of its creators.

**Rich detail fields (migration 042).** The one TMDB detail call already made pulls extra data via `append_to_response=credits,external_ids,videos,watch/providers,{content_ratings|release_dates}` — a single HTTP request, no extra subrequest budget. `extractTmdbDetailFields()` (exported from `enrichment.js`, shared by the add-time path and the background passes) pulls `overview`, `backdrop_url`, `tmdb_rating`, `content_rating`, `trailer_key`, `director`/creator, `runtime`, `release_year`, plus a **provider network**
(for a series, `runtime` reads TMDB's `episode_run_time`, then falls back to
`last_episode_to_air.runtime` and `next_episode_to_air.runtime` — that array is
empty for a large share of modern shows, which used to leave TV with no length
at all) and a **watch link** from `watch/providers` (US flatrate). The provider name feeds `network` only when `knownNetwork()` maps it to one of our services (so unaliased variants like "…with Ads" are skipped); the `watch_link` is a JustWatch/TMDB aggregator page stored separately and used by the UI **only as a fallback** when there's no real deep-link `network_url`. When no subscription service streams the title at all and the only US availability is rent/buy, `fallbackNetwork()` (exported from `enrichment.js`, used by every network-fill site) names the **storefront** instead ("Apple TV Store", "Fandango at Home") — otherwise a new-release movie lands with no `network` anywhere a card could show one, which is how group Trending's detail screen came to list no platform (2026-08). Rent/buy provider names resolve through `storefrontFromProvider()`, never `knownNetwork()`, so a rental can't be mislabeled as the Apple TV+ subscription. Deep links themselves are unchanged — still member paste, sibling inheritance, or the Watchmode lookup (`_shared/watch-providers.js`).

On insert, `POST /api/shows` also looks for any other member's active copy of the same title that already has a deep-link `network_url` (and a `network`). If one exists, the new row inherits both fields instead of falling back to the search-URL placeholder. So a show that someone else has already curated lands in the new member's library with the real URL on day one — never needs to go through `/url-cleanup`. A copy pinned to a *different* `tmdb_id` is never a donor — two entries can share one exact title (a remake next to its original), and that copy's URL streams the other show (see `docs/INVARIANTS.md` §17).

### Background (`POST /api/enrich`)
A logged-in member's page calls this fire-and-forget on load. TMDB-only since OMDB was retired:

**A member's network is never overwritten; TMDB answers beside it (2026-09).** `shows.network` is fill-only in both passes, so it goes stale as licensing moves — 61 of 137 films carried a network TMDB no longer lists. `streaming_on` (migration 069) holds TMDB's current US flatrate services, comma-separated canonical names, refreshed authoritatively on every pass and propagated to sibling copies (not fill-only there either — a fill-only propagation would freeze the first answer any copy received). Empty string means TMDB was asked and named nothing; NULL means it was never asked. We store no provenance for `network`, which is exactly why refreshing it is unsafe: nothing tells a member's pick from a machine's. The rule is `docs/INVARIANTS.md` §20.

**A background pass selects on everything it writes (2026-09).** The movie pass fills the whole detail block — genres, overview, runtime, tagline, studio, director, trailer, content rating — so its gate names the whole of it (`MOVIE_GAP`: artwork, network, genres or cast missing), not artwork alone. Gating it on `poster_url IS NULL OR network IS NULL` meant a film that inserted with a poster and a network never qualified again, and 125 of 137 unarchived films carried no genre, overview or runtime; the genre filter on Next Up hid every movie as a result. Unlike this pass, the TV pass has no gap predicate in its normal mode and cycles the whole library by oldest `enriched_at`, which is why TV was unaffected. Two consequences worth keeping: `mode: 'gaps'` must select on the absence of the data it repairs rather than a proxy (it keyed on missing cast, and every stuck film had cast), and its `remaining` counter must use the same predicate as the selection or a dry run certifies a backlog it can't see. The loop also gained the budget check the TV loop always had — an unbounded selection would spend past `SUBREQUEST_BUDGET`. The same pass now writes `network_logo_url` for films, which it never did: TV takes its logo from `detail.networks[0].logo_path`, a field TMDB does not return for movies, so the badge comes off the flatrate provider that already names `network`. Draining the films that predate that is `mode: 'logos'` — a sweep, not a gate, because a rent/buy-only film has no provider and so no badge, and a standing `network_logo_url IS NULL` gate would re-select those rows on every page load forever; its count therefore bottoms out above zero. The badge is looked up by the row's **own** network, not TMDB's highest-priority provider — the latter put Amazon's logo on cards labelled HBO Max — and a network TMDB doesn't list gets no badge at all. Pinned by `scripts/enrich-movie-detail-test.mjs`; the rule is `docs/INVARIANTS.md` §19.

**A stored `tmdb_id` is the row's identity (2026-08).** Every pass here fetches a row's stored `tmdb_id` directly and falls back to the title search only for rows nothing ever pinned (or an id TMDB 404s on). Re-guessing from the title is how a member's picked remake used to be swapped for the more-popular original sharing its exact name — TMDB orders search by popularity, both entries exact-match, and the next rotation overwrote the pick (Little House on the Prairie: the add stored the 2026 remake, the enrich pass rewrote the row as the 1974 series). For the same reason, the title-scoped propagation below skips copies pinned to a *different* `tmdb_id`, and the grouped queues group by `(title, tmdb_id)` so each pinned entry gets its own fetch. When a bare title *does* have to be resolved, the shared `pickBestMatch` prefers exact title matches, honors a trailing `"(YYYY)"` as a year pin (stripped from the search query itself), and otherwise takes the **newest** dated entry among same-named ones — the club wants the current version of a remade show. Pinned by `scripts/enrich-identity-test.mjs`; the rule is `docs/INVARIANTS.md` §17.

- A TV pass over active non-movie shows (ordered by `COALESCE(enriched_at, '1970-01-01') ASC` so the stalest refresh first) plus a separate movie pass. The movie pass selects on `poster_url IS NULL OR network IS NULL` — the network half is what retroactively fills the storefront fallback onto rent/buy-only movies added before it existed (a movie TMDB knows no US availability for stays NULL and simply rotates like an unfound poster does). Writes `next_season_date`, `season_end_date`, `full_series`, `genres`, poster/logo, and the detail fields — `overview`, `tmdb_rating`, `rating` (converges to the fresh TMDB score), `director`/`director_imdb_id`, etc. Most are coalesced (never overwrite an existing value); `rating` is refreshed from TMDB so old OMDB values migrate over time. Then propagates the catalog fields to every member's copy of the title and bumps `enriched_at`. `director_imdb_id` costs one extra `/person/{id}/external_ids` call per matched show.
- An actor-IMDB-id backfill re-runs TMDB enrichment for any title whose cast rows still lack ids. `mode: 'posters'` (alias `skip_omdb`) runs only the small poster catch-up batch so an artwork backfill fits within the subrequest budget. The response's `enriched` counter is retained but always 0 now (the OMDB ratings/actors pass it counted is gone).
- **The actor backfill is charged to the same subrequest budget as the passes above** (2026-08). Each of its titles is a full `fetchEnrichment` — search + detail + a person lookup per unresolved cast member, up to `CAST_DEPTH + 2` subrequests — and it used to run a fixed 8 of them *on top of* whatever the TV/movie passes had already spent, counted against nothing. So `max_tmdb` only ever shrank the first half of a round, and a default round ran far past `SUBREQUEST_BUDGET`; the resulting failures were swallowed by the pass's own empty catch, and the oversized invocations are what surfaced as intermittent 503s (`error code: 1102` — the worker hitting its resource ceiling) during long backfill runs. It now takes only the titles the remaining budget covers, and its default size scales with `max_tmdb`. A round where the budget is already gone skips it entirely; the pass rotates and self-heals, and the free `fillActorIdsFromKnownPeople()` cache pass still runs on every call.

`updated_at` is **not** touched by enrichment — only by member-initiated writes. This is what lets `updated_at != created_at` cleanly distinguish "the member touched it" from "we auto-enriched it."

`POST /api/sync-urls` is a separate maintenance call also triggered from the member page (throttled to 1/day per browser via `localStorage`). It finds shows where one member has a real `network_url` for a title and another member's copy has only a search-URL placeholder, and copies the good URL over.

## List import

Paste a list from somewhere else — Notes, a text file, an old spreadsheet — and have it sorted onto the four lists. iOS/iPad only (`ios/ShowPickerIOS/Views/ImportListView.swift`); tvOS is view-only and watchOS is read-only, so neither ships it. Not on the web — the member app is retired.

Two endpoints and a shared module, and **no schema change**: imported rows are ordinary `shows` rows.

| Piece | What it does |
|---|---|
| `functions/_shared/list-parse.js` | Slice the paste at a line boundary, one Claude call per slice, then one TMDB search per extracted title. Also the dupe-check query and the four-list constants. |
| `POST /api/import/parse` | Session-gated. Body `{ text, cursor?, section?, default_list? }` → `{ items, next_cursor, section, default_list, total_chars }`. **Writes nothing.** |
| `POST /api/import/commit` | Session-gated. Body `{ items }` → `{ added, skipped, titles, skipped_titles }`. Inserts into `shows`, always for the caller's own `member_slug`. |

### Why it pages

Both halves of the work are bounded per Worker invocation: one Claude call per slice, and one TMDB search per extracted title. A 300-title paste in a single request would exhaust the subrequest budget and time out. So `parse` takes a `cursor` into the pasted text and returns the next one; the client loops until it comes back `null`. A paste under `CHUNK_CHARS` (12k) finishes on the first call, so the loop is invisible for a normal list — and there is no cap on how long a list can be.

Slices are cut on a **line boundary**, and each response carries the section heading in effect at its end (`section`), which the client threads back into the next call. Without that, a slice starting mid-list loses its "Currently watching:" heading and everything in it is misclassified. `scripts/import-list-test.mjs` pins both.

### Why parse and commit are separate

`/api/shows` enriches synchronously — TMDB detail, credits, person and Watchmode lookups per row. Dozens of those in one invocation blows the subrequest budget. So `commit` inserts with only what `parse` already resolved (`tmdb_id`, canonical title, `poster_url`, `release_year`) plus a `networkSearchUrl()` placeholder, and the existing background `/api/enrich` rotation fills in overview, cast, trailer and a real deep link. The client fires `/api/enrich` once after a successful import so that happens promptly rather than on the next scheduled pass.

The split also gives the review screen for free: `parse` returns rows, the member fixes the list assignments, `commit` writes. Nothing is written without that confirmation.

### Claude extracts, TMDB identifies

This division is the whole design. Claude reads the paste and returns a **title** plus the personal fields around it (`list`, `notes`, `network`, `recommended_by`, `watching_with`, `movie`, `year`). TMDB is the only thing that says a title exists, and supplies the id, canonical spelling, poster and year. A hallucinated `tmdb_id` in the model's output is ignored at parse (it isn't in the schema) and again at commit (non-integers are dropped).

Unmatched titles are **kept, not dropped** — TMDB misses real things — and flagged `matched: false` so the review row says so.

### Rate limits and validation

- `commit` re-validates every field: list must be one of the four, `poster_url` must be on `https://image.tmdb.org/`, `tmdb_id` must be an integer, strings are trimmed and length-capped. Not a trust boundary (a member can only write to their own lists either way), but it keeps a mangled payload out of the list columns and an off-domain URL out of an `<img src>`.
- Own ceiling: **300 rows per member per rolling day**, counting imports and hand-adds together, and **200 rows per call**. `/api/shows`'s 50/day cap is human-pace for one-at-a-time adds and an import would trip it instantly — so imports get their own (much higher) limit rather than a bypass.
- Titles the member already has — **archived ones included** — are skipped, and the review screen greys them out and won't let them be ticked back on, so the client never promises an add that silently doesn't happen.
- `parse` caps one request's `text` at 400k characters and returns `503 import_unavailable` when `ANTHROPIC_API_KEY` isn't set.

### Default list

An extracted title with nothing in the text to place it goes to **the list the member was looking at when they opened the importer** — `parse`'s `default_list`, which the client sets from `MemberView`'s `currentList`, the same context rule Add Show follows. Pasting a bare list of titles from Next Up puts them on Next Up.

Headings in the paste always win over it: the fallback only applies to titles the text says nothing about.

Callers with no list in view — both Home doors — send nothing and get **Watching**, which is also what an omitted or unrecognised `default_list` resolves to (`normalizeList()` in `_shared/list-parse.js`). That matters because Watching feeds the calendar (`functions/calendar/[slug].js` selects `watching` + `waiting`): before the fallback was caller-controlled, an unheaded watchlist landed in a subscribed feed. It still can from Home, and the review screen is what keeps that honest.

The fallback rides in the **user turn**, not the system prompt. The system prompt is cached `ephemeral` and stays byte-identical across every slice of every import; interpolating one of four list names into it would cost a cache entry per list. `scripts/import-list-test.mjs` pins that it doesn't vary.

## Networks

Source of truth: `functions/_shared/networks.js`. Each entry has:

- `stored` — exact string written to `shows.network`. The modern streaming-service brand (e.g. `HBO Max`, `Paramount+`, `Peacock`).
- `display` — what appears in the Add / Suggest dropdowns; includes the sub-brand hint in parens so members find their way ("Paramount+ (including CBS, MTV, …)"). Also the sort key for the picker — see [The picker is served, not compiled in](#the-picker-is-served-not-compiled-in) below.
- `aliases` — older / sub-brand names that get folded into this canonical when matching user input or migrating data.
- `search` — `{ base, param?, extra? }` template for the network's search page. Used as the fallback `network_url` when the member picks a network but doesn't paste a deep link.
- `kind` — omitted for subscriptions (the default). `'storefront'` marks a pay-per-title source: **Apple TV Store**, **Fandango at Home** (rent/buy), and **Fandango** (theatre tickets, for a film still in its theatrical window). `isStorefront(network)` is the test.

**Regions.** The table is US-first but not US-only: the UK block (`BBC iPlayer`, `ITVX`, `Channel 4`, `Channel 5`, `NOW`) and the Australian block (`Stan`, `Binge`, `Foxtel`, `ABC iview`, `SBS On Demand`, `9Now`, `7plus`, `10 play`) sit between Pluto TV and the storefronts. Nothing about enrichment changes: `_shared/enrichment.js` still reads `watch/providers.results.US`, so a regional service arrives via what a member types, pastes or imports, not from TMDB. The point of an entry is that those values stop being free text — they canonicalize, group, price, and get a search fallback like everything else.

Two rules the regional entries follow, both enforced by `scripts/networks-test.mjs`:

- **A bare English word never claims a canonical.** `E4` and `Film4` are safe aliases; `Five`, `Nine` and `Ten` are not, and are absent even though the broadcasters go by them. The alias index is a Map built in list order, so a duplicate doesn't error — the later entry silently wins.
- **The two ABCs stay apart.** Bare `ABC` is a Hulu sub-brand (the US network); the Australian one is `ABC iview`, aliased as `ABC (AU)` (TMDB's own spelling), `ABC Australia` and `iview`. `BBC America` likewise stays an AMC+ alias rather than a route to iPlayer.

**Free ad-supported services.** `Pluto TV` is a subscription-kind network priced at `0` in `DEFAULT_PRICE_CENTS` — a title there is a reason to open an app you already have, not a per-view purchase, so it belongs in the audit rather than being skipped as a storefront; it just can't be cancelled for money. The zero is deliberate rather than an omission: absent means "nobody has priced this yet", `0` means "we know it's free". It is its own entry and not a `Paramount+` alias despite the shared owner — separate app, separate catalogue, and folding it in would put free titles behind a $7.99/mo card.

### Storefronts vs. subscriptions

A storefront sells a title per view, so it is never an argument for keeping or starting a monthly service, and `/api/subscriptions` skips those rows entirely when building the audit. They exist as networks anyway because they cover the long tail nothing streams — catalog films, and new releases in the window between theatres and streaming.

Two traps this exists to avoid, both of which had already happened:

1. **`tv.apple.com` serves Apple TV+ originals and $3.99 rentals from the same URL shape.** So the Apple TV Store entry deliberately declares **no domains** — a link can't decide which of the two a row belongs to. Only TMDB's flatrate-vs-rent/buy split can. `POST /api/admin-url-cleanup`'s `save` action likewise refuses to let an Apple link set `network` (see "Apple links vs. stored network").
2. **TMDB names its Apple rent/buy provider "Apple TV"**, which the alias index folds into `Apple TV+`. Rent/buy provider names therefore resolve through `storefrontFromProvider()` and never through `knownNetwork()`. That one collision is how rentals came to be labeled as Apple originals in the first place.

`Apple TV Store` is stored under that name rather than the bare `Apple TV` because `Apple TV` is already an alias of `Apple TV+`; reusing it would silently re-point every member who types it meaning the subscription. Members see `display` ("Apple TV (rent or buy)") regardless. The same reasoning keeps the bare `Fandango` alias off `Fandango at Home` — it belongs to the ticket site, a different service.

`storefrontFromUrl(url)` maps a link to its storefront and is deliberately separate from `networkFromUrl()`: `tv.apple.com` resolves to the Apple TV+ *subscription* there and to the Apple *storefront* here. `reclassify_storefronts` uses it so a row's new label agrees with the link already sitting on it — without it, TMDB's own rent/buy ordering put Apple-linked rows on Fandango at Home.

**Repairing the rows that predate the fix.** #337 corrected classification at
insert time, so new rows are right — and repaired nothing already stored.
Nothing else will either: `/api/enrich`'s rotation never touches storefront
classification, so without a deliberate pass the legacy backlog stays wrong
forever. **Actions → "Re-check Apple TV+ rentals"** runs
`scripts/reclassify-storefronts.mjs` against `reclassify_storefronts` until
`remaining` is zero (dry run by default). It lives in Actions rather than the
admin screens because it drains a backlog *once*; the button it replaced was
permanent UI for a one-time job.

That action is also the one thing on `/api/admin-url-cleanup` that accepts
`X-Cron-Secret` in place of an admin session, because it only re-derives a
network from what TMDB says and is idempotent. `dismiss`, `save`,
`resolve_conflict` and the rest stay admin-session-only, so a leaked cron
secret cannot dismiss a title out of the queue or overwrite a link.

`canonicalNetwork(name)` (from the same module) returns the canonical `stored` for any alias-or-stored name (case-insensitive). `POST /api/shows` and `PUT /api/shows/[id]` both run incoming `network` values through it so an alias submitted via API or pasted in the "other" field still ends up consistent in the DB.

**Default prices are US cents, and that bounds what can be priced.** `DEFAULT_PRICE_CENTS` seeds the Subscription Audit, which sums one currency. Free-to-air catch-up (BBC iPlayer, ITVX, Channel 4, Channel 5, ABC iview, SBS On Demand, 9Now, 7plus, 10 play) is `0` — the one figure that survives being quoted in dollars, and `0` means "we know it's free" where absent means "nobody has priced this". The paid non-US services (NOW, Stan, Binge, Foxtel) are deliberately **absent**: converting a pound or an Australian dollar into the total would be wrong twice, wrong rate and wrong currency, so those arrive unpriced and the member enters what they actually pay.

### The picker is served, not compiled in

The apps used to carry their own `[String]` copy of the list, so a network added here reached a member only when they installed a new App Store build — weeks later at best, never for anyone who doesn't update. MGM+ spent a release missing from the picker for exactly that reason. `GET /api/networks` now serves it:

- **`networkCatalog()`** (bottom of `_shared/networks.js`) builds the payload: `{ version, networks: [{ stored, display, section, storefront }] }`. Sections are built server-side from each entry's `region` (`REGION_SECTIONS`), and emitted as **consecutive runs** — clients group by "the section string changed", so a region added later needs no app release either. Storefronts come last regardless of where they sit in `NETWORKS`; grouping can't depend on somebody keeping the array tidy. An entry whose `region` has no section title is emitted under its raw key rather than dropped — ugly beats missing, and `networks-test.mjs` fails on it.
- **Rows are sorted alphabetically within their section**, case-insensitively (`byLabel`), on `display` — the label the web `<select>` draws. The iOS menu draws `stored`, and every `display` starts with its `stored` name except `Apple TV Store` ("Apple TV (rent or buy)"), whose neighbours sort the same either way, so both surfaces read alphabetically. Case-insensitive is the point of the comparator: a raw codepoint sort puts `AMC+` ahead of `Amazon Prime Video`. Position in the `NETWORKS` array therefore decides nothing a member sees, and `networks-test.mjs` fails if a section comes back unsorted. `NetworkCatalog.bundled` in ShowPickerCore is kept in the same order so the picker doesn't reshuffle when the first fetch lands.
- **`version`** is an FNV-1a hash of what a client renders, order included, and it doubles as the response's **ETag**. Not a security boundary (the payload is public) — it's how a client skips a redraw, how a stale cache gets named in a bug report, and how a repeat pull costs a 304 with no body. `If-None-Match` is compared weak-tolerantly, so a cache that rewrites the validator to `W/"…"` doesn't force a re-download.
- **The endpoint is public**, named in `PUBLIC_ENDPOINTS` in `check-static.sh`. It's a constant table with no member data, the same brand names already ship in `index.html`'s `<select>` to logged-out visitors, and gating it would stop an app from warming its picker before sign-in while making the response uncacheable at the edge.
- **`ShowPickerCore.NetworkCatalog`** is the client model — `validated()`, the section grouping, and a `bundled` seed. It lives in the shared package so Linux CI compiles and tests it (`NetworkCatalogTests`), not just Xcode. The rule that matters: **an empty or unusable payload never empties the picker**; it falls back to the seed. A member opening Add Show mid-deploy to find no networks at all is strictly worse than a stale list.
- **`NetworkCatalogStore`** (app target) **always tries the server, and treats its cache as the answer for a pull that fails** — not as a reason to skip one. `refresh()` runs on launch, on every foreground, and every time the Add/Edit sheet appears; a `refreshing` flag only coalesces callers that land in the same frame, and never suppresses a later pull. (It was once-per-launch when the endpoint landed, which left a resident app on a week-old list.) What's drawn while a request is in flight: the UserDefaults copy read synchronously at `init` — so the first Add Show paints the current list rather than flickering — and `bundled` for an install that has never reached the server. UserDefaults rather than `OfflineCache` because that gets wiped on logout and this isn't member data.

The seed is allowed to be *shorter* than the server's list — that's the point — but never to name a service the server wouldn't canonicalize, which is the direction `networks-test.mjs` checks.

The share extension has its own separate mapping: `ios/Shared/ShareTitleParser.swift` maps share text and hostnames to canonical names, offline, before any session exists. Its *text* checks are deliberately thinner than its host checks — "sky" lives inside "whisky", "stan" inside "Istanbul", and "binge" inside every "perfect binge-watch" blurb, so those three are recognized by host only.

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

**The Apple side of the same dates lives in `ShowPickerCore/Sources/ShowPickerCore/ShowCalendar.swift`** (renamed from `Premiere.swift`, 2026-08). `ShowCalendar.upcoming(from:on:calendar:)` is the single definition of "what's on the calendar" for the apps: Watching + Awaiting, unarchived, `next_season_date` and `season_end_date` both eligible, **one entry per show** (the sooner of its two dates, premiere winning a same-day tie), sorted by date then title, today inclusive. `ShowCalendar.next(...)` is its first element. `CalendarView` (the in-app Calendar screen) and the **Up Next** home-screen widget (`ios/ShowPickerWidgets/`) both call it, so neither can drift on what "next" means — the widget used to read `next_season_date` alone and sat empty whenever no premiere was announced. Days parse in the **device time zone** (`ShowCalendar.day`), not UTC: these are calendar days compared against `Calendar.current.startOfDay`, and a UTC parse dropped today's date and displayed every row a day early west of UTC. Covered by `ShowCalendarTests`.

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

### Cluster assignment (`_shared/vibe-match.js`)
Score the member against **the club's own distribution**, not against the trait scale.

1. Build a baseline from every unexcluded member's fingerprint: mean and spread (standard deviation) per trait. Fewer than 3 fingerprints isn't a distribution — fall back to deviation from 0.5.
2. Express the member as a z-score per trait — how far from the average member, in units of how much members actually vary on that trait. Spread is floored at 0.02 (a trait nobody differs on carries no information and must not be amplified) and z is capped at ±3 (no single trait swings a match).
3. Turn each cluster target into a direction by subtracting 0.5. Unspecified traits become exactly 0, so a cluster votes only on the traits it names.
4. Cosine between the two. Highest wins; top 3 return as a `blend`; the winner also carries `margin` (daylight over the runner-up) and `baseline_members`.

`similarity` is reported as `(cos + 1) / 2` so the clients keep rendering it as a 0–100% match: 50% means no relationship either way.

**Group variety comes before per-member accuracy** (`assignDistinct`). A vibe is a party trick and the trick is the comparison, so nobody in a group shares a persona while there are personas left: take the strongest member/cluster pair going, hand it out, cross both off, repeat. Greedy rather than optimal — at club scale the difference is a rounding error. Ties break on slug then cluster id, so the assignment is stable across requests, and it is computed over the member's **largest group (ties to the oldest)** rather than the viewer's, so everyone sees the same label for the same person. A group bigger than the cluster list runs out and the remainder take their own best match, repeats included. Members below the scored-title floor take no slot. A member moved off their own top match gets `assigned: true` and a tagline saying which closer persona was taken; the blend still leads with the assigned cluster and keeps the rest in true order.

**Two honesty rules, both delivered through fields the apps already render** (no client change):

- **Fewer than 5 scored titles → no cluster at all.** `pickCluster` returns `null` and the response carries `cluster: null`; `VibeView` renders traits, balance and picks without the persona box. A member with one show sits 3σ from the club on whatever that show happens to be, and the matcher would hand them a confident persona built entirely out of it.
- **Margin under 0.05 → the tagline says so.** The winner still leads, but its tagline becomes "You sit between X and Y — the blend below is the truer read", and `undecided: true` rides along. On the club's first real run 11 of 41 members were inside that margin.

**Why not self-centering.** Until 2026-08 both sides were centered on their own mean. A fingerprint is an average over dozens of titles, so it sits very close to the average of all television — every member scores highish on `prestige_energy` and `moral_ambiguity` because most of what anyone watches does. Self-centering leaves that shared shape standing, so cosine largely measured "does this look like TV" and the cluster nearest the average show won for nearly everybody: six libraries separated by 0.03 in different directions all came back **Prestige Drama Loyalist**, and the collapse got *worse* the more titles a member had. Pinned by `scripts/vibe-match-test.mjs`; `scripts/vibe-cluster-report.mjs` prints old-vs-new distributions across a production snapshot.

### Top / bottom traits, balance, aligned shows
- Top / bottom: the dimensions where the member's fingerprint diverges most positively / negatively from the club mean.
- Balance reads: precomputed contrasts (warmth vs darkness, cynicism vs optimism, etc.) extracted from the fingerprint.
- Aligned shows: rank the member's own active shows by dot-product against their top-N traits, grouped by list.

### Taste exclusion (`_shared/excluded-members.js`)
`EXCLUDED_FROM_TASTE` names members whose libraries are too sprawling to read as taste. **It bounds club-level math and nothing else — it is not a visibility rule.**

| Excluded from | Where |
| --- | --- |
| Trending | `/api/popular` — their adds don't rank titles |
| Recommendation neighbours | `/api/recommendations` (legacy) |
| The aligned-picks candidate pool | `/api/vibe` — a title *only* they hold is never offered to someone else, because a pick is a club-level claim |

`scripts/vibe-diagnose.mjs <slug>` is the operator tool for "why does X see no vibe": it snapshots production D1 read-only via `wrangler`, replays the real handler against an in-memory copy, and prints the profile the member's app renders plus what it's missing — unscored titles (queue backlog, drains itself) versus `unknown_show=1` titles (never drain; need a rename in Show Cleanup). It also re-checks the exclusion from every other member's side, so "she sees herself, nobody else does" is verified against real data rather than assumed.

**Not** excluded: who may read a vibe, and the trait-fill queue below. `/api/vibe` scopes reads on group membership alone — an excluded member appears in their own picker and in their group-mates' pickers, and everyone gets the same full profile. The `excluded: true` response no longer exists; `VibeMember.excluded` survives in the Swift models as an inert optional the API never sets.

Both carve-outs came out of the 2026-08 report that the one member on the list was the one member who couldn't use Vibe. The first pass fixed her own read; the exclusion was still deciding visibility, which left her invisible to the group-mates whose vibes she could see — a one-way mirror inside a group whose members can already open each other's libraries. Pinned by `scripts/vibe-scope-test.mjs`.

### Trait backfill (`/api/admin-vibe-fill`)
- Picks titles with no `show_traits` row (skipping titles where every copy is archived). **Club-wide, including titles only a taste-excluded member holds** — `show_traits` is a catalog of what a title is like, not a tally of whose taste counts, and skipping those rows left the excluded member's own fingerprint computed from just the sliver of her library someone else happens to share. Cost: her unique titles join the fill queue, which is batched and cron-drained.
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

**Apple links vs. stored network (the `save` action).** A pasted URL normally overrules the operator's dropdown, because copy-paste catches the real platform and the dropdown is only judgement (`networkFromUrl`). `tv.apple.com` is the one exception: it is a storefront, not a service, carrying both Apple TV+ originals and rent/buy titles that stream on somebody else's subscription. Letting an Apple link set `network` relabels rentals as Apple TV+, which feeds straight into the Subscription Audit's per-network value. So for Apple domains the operator's pick wins and only the URL is stored. This is what makes it safe to use Apple links as the universal deep-link fallback while `network` keeps naming the service that actually carries the title.

The `save` action writes to every active copy of the title that is either on the same network or has none (`network IS NULL OR network = ''` — the empty string counts as missing, matching what `fetchQueue` surfaces). Copies on a *different* specific service are deliberately left alone, since one title can legitimately live on two services. When that guard skips every row the action returns **409** with an error naming the conflicting services, rather than `ok: true, updated: 0` — the silent zero was indistinguishable from a successful save in the operator UI and made saves look like they landed at random. URLs are validated with `safeNetworkUrl` (http(s) only), same bar as `POST /api/shows`.

Some titles genuinely have no direct link to paste (too ambiguous to resolve to one show, not indexed by any service search). The `dismiss` action (`{action: 'dismiss', title}`, the row's "No good link — dismiss" button) permanently removes a title from the queue — recorded case-insensitively in `url_cleanup_ignores` (migration 048), which `QUEUE_FILTER` excludes. Same pattern as `dupe_ignores`: the endpoint creates the table on demand (identical statement to the migration) so deploy order doesn't matter. There's no un-dismiss action or UI — a title comes back into the queue only if its `network_url` regresses to a placeholder again, at which point it'd need re-dismissing by hand (`DELETE FROM url_cleanup_ignores WHERE ltitle = ...`).

The page's tools row also has a "Run enrichment passes" button — it loops `POST /api/enrich` (TMDB posters/dates/ratings/detail fields + actor-IMDB-id backfill) up to five times with the operator's session, stopping early once a pass returns all zeroes.

The `reclassify_storefronts` action (the "Re-check Apple TV+ rentals" button in iOS Show Cleanup) walks rows sitting on a subscription network that TMDB says doesn't stream the title. Per distinct `tmdb_id`: a service in `flatrate` becomes the network, `rent`/`buy`-only moves the row to the storefront (`Apple TV Store`, `Fandango at Home`), and a title TMDB knows nothing about is left alone rather than guessed at. `network_url` is never touched — the link still works whatever the label says. One subrequest per title via `fetchAvailability()` (a details call with only `watch/providers` appended), capped at `max_titles` (default 40, hard max 100) and ordered oldest-`enriched_at`-first; every processed row is stamped so it rotates to the back and repeated calls walk the whole backlog. Returns `{checked, kept, unknown, rows_changed, moved, remaining}`. Defaults to `Apple TV+` but takes any `network`.

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
- **Post-deploy smoke test**: 15s settle, then `bash scripts/smoke.sh https://showpicker.club` — the same script the nightly run uses, so there is one copy of the assertions.
- Required secrets: `CLOUDFLARE_API_TOKEN` (Pages:Edit + D1:Edit), `CLOUDFLARE_ACCOUNT_ID`.

### `.github/workflows/pr-checks.yml` ("PR checks") — the merge gate

Runs on every PR to `main`. Three deterministic jobs, all on Linux:

- **static** — `bash scripts/check-static.sh`, repo-shape invariants against the working tree. Every file under `functions/api/` is gated (`getSession` / `getAdminSession` / `isAdmin` / `CRON_SECRET`, or a 410 stub) unless it is named in that script's `PUBLIC_ENDPOINTS`; every retired path has a redirect; the catch-all is still a 200 rewrite; the AASA file claims `/*`, excludes API/auth/calendar, carries the app ID, and keeps the `webcredentials` block passkeys need (with both entitlement files carrying the matching association); no archived web page is back under `public/`; `_headers` has no indented comment (Pages parses one as a header); the App Store id matches between the CTA and the Smart App Banner.
- **webauthn** — `node scripts/webauthn-test.mjs` and `node scripts/passkey-flow-test.mjs` on Node 22. Passkey verification is hand-rolled (no npm in this stack) and decides who gets a session, so both the cryptography and the endpoint flows are asserted rather than reviewed. No network; the flow test builds a real SQLite database from `schema.sql`.
- **swift** — `swift test` in `ShowPickerCore` inside the `swift:5.9` container. The package is Foundation-only and UI-free precisely so this needs no macOS runner; macOS minutes bill at 10× on a private repo. `SessionScopeTests` is the regression net for the 2026-08 logout bug; `ShowCalendarTests` pins the shared calendar rule the Calendar screen and the Up Next widget both read.

### `.github/workflows/pr-review.yml` ("Invariants review") — advisory

Reads `docs/INVARIANTS.md`, sends it with the PR diff to the Claude API (`scripts/invariants-review.py`), and comments any findings (`scripts/post-pr-comment.py`). **Never blocks a merge** — it always exits 0, because a reviewer that can be wrong shouldn't be able to stop work. It covers the judgement class the assertions can't express, e.g. "this new `@State` is derived from the session and nothing clears it on logout". The diff it reviews is `functions/`, `public/`, `ios/`, `tvos/`, `watch/` and `ShowPickerCore/` (never `archive/`), plus this PR's `docs/PRODUCT.md`, `docs/ARCHITECTURE.md` and `docs/INVARIANTS.md` changes as *context* — invariant 7 is satisfied by a `Platforms:` line in the docs, so without them every member-facing PR read as a parity violation. A docs-only PR still isn't reviewed: the code diff is what decides whether the review runs at all. Needs an `ANTHROPIC_API_KEY` **Actions** secret (the vibe-scoring key is a Pages secret and is not visible here); without it the script no-ops.

### `.github/workflows/security-nightly.yml` ("Nightly security + smoke")

09:20 UTC daily. Runs `scripts/smoke.sh` against production plus a TLS-expiry check, and **opens a GitHub issue** when anything fails. Deploys already run the same script, but that only covers the moment of deploy — this catches drift that arrives without one (an expired secret, a Cloudflare-side change, a migration applied out of band).

### `scripts/smoke.sh` and `scripts/check-static.sh`

`smoke.sh <base-url>` makes live assertions: the catch-all serves the marketing page (probed with an unknown path, retried), `/.env` returns no environment content whatever the edge answers with, no sign-in UI has returned to the landing page, security headers and CSP directives are present, the CSP no longer allows the retired Apple/Google/Turnstile sources, session-gated endpoints 401, admin endpoints 403, retired endpoints 410, calendar feeds 404 without their key, `/api/popular` names no members and hides `member_slugs` for an anonymous caller, every retired path 301s, and the AASA file is valid JSON served as `application/json` with its `/*` claim intact. `check-static.sh` needs no network and is the PR gate. Both print every failure rather than stopping at the first, and both run fine from a laptop.

Two things in `smoke.sh` look like fussiness and are not. Every request carries a browser `User-Agent`, because bare curl asking a production domain for `/.env` is shaped exactly like a vulnerability scanner and Cloudflare will sometimes answer it with a block page. And the catch-all and the leak probe are **separate assertions on separate paths** — they were one check against `/.env` until 2026-08, which meant any edge decision to block that path failed the deploy and reported it as "secrets may be leaking". The catch-all is now asked with an ordinary unknown path, and the leak probe passes on any answer that isn't environment content. Don't recombine them. `scripts/webauthn-test.mjs` and `scripts/passkey-flow-test.mjs` (Node 22, no network, no dependencies) round out the gate — see [Passkeys](#passkeys-migration-062).

### `.github/workflows/migrate.yml` ("Apply D1 migration")
- Trigger: manual dispatch only, with a `file` input (bare `NNN_*.sql` resolves under `migrations/`).
- Steps: checkout, install wrangler, `wrangler d1 execute shows-db --remote --file=<file>`.
- Since `deploy.yml` already applies pending migrations automatically, this is only needed to apply a migration *ahead of* merging its code, or to run one against prod outside of a `main` push.
- Required secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

### `.github/workflows/backup.yml`
- Trigger: daily at 03:00 UTC, or manual dispatch.
- Steps: install rclone, install Node + wrangler, `wrangler d1 export shows-db --remote --output /tmp/...`, upload to Google Drive (`gdrive:Shows-Backups/`), prune drive backups older than 30 days, prune `failed_logins` rows older than 7 days.
- Required secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RCLONE_CONF` (full rclone config including drive token).

### `.github/workflows/enrich-backfill.yml` ("Enrich backfill")
- Trigger: manual dispatch only. Inputs: `rounds`, `max_tmdb` (TV rows per round), `sleep_seconds` (pause between rounds), `max_retries`.
- Loops `POST /api/enrich` with `X-Cron-Secret`, after one prioritised pass over the Trending titles. Full passes, never `mode: posters` — see the comment at the top of the file for why. Stops early once a round reports no candidates.
- **A failing round is retried, not fatal** (2026-08). The endpoint sits behind Cloudflare, and a deliberately slow pass — many small rounds with a real pause between them — is exactly the shape of run that eventually meets an edge blip. A single 503 used to abort the job and throw away every completed round with it; one run lost 439 applied updates to a round-74 `error code: 1102`. Each round now retries up to `max_retries` times with growing backoff. Three outcomes, deliberately distinct:
  - **401/403 → immediate hard fail, no retries.** The secret is wrong or missing, so every remaining round would fail identically. Retrying just delays the report.
  - **Any other failure, after retries, with updates already applied → warn, stop, exit 0.** The work is committed to D1 and the rotation is oldest-enriched-first, so the next run resumes where this one stopped. The log says which round stopped it and what the running total was.
  - **Any other failure, after retries, with nothing yet applied → hard fail.** Nothing worked, so this is a broken endpoint rather than a blip, and it should page.
- Both `curl` calls end in `|| true`: the step runs under `bash -e`, where a connection failure inside `$(...)` would exit the job before the status check could classify it. Don't remove them — the check on `$http` is what decides.
- Required secret: `CRON_SECRET` (Actions), matching the Pages secret of the same name.

## Excluded members

`functions/_shared/excluded-members.js` exports a list of member slugs that are skipped from taste aggregation (popular, recommendations). Use this when an operator-only or test member's library would skew the social signals.

## Conventions that aren't obvious

- **`updated_at` is sacred.** Enrichment writes `enriched_at` so member intent (`updated_at != created_at`) stays clean. Don't bump `updated_at` from background jobs.
- **Seeded rows have NULL `created_at` and `updated_at`.** This is intentional — it makes the seed-only query single-sided and cheap.
- **Network URLs that look like `/search`, `/s?`, or `/?q=` are placeholders.** The frontend renders these as plain text instead of links; sync-urls and calendar feed treat them as missing.
- **Member display names disambiguate dynamically.** `/api/members` counts first-name collisions and appends `last_initial` only when it would otherwise be ambiguous.
- **Slug `dorothy` was renamed to `whitt`.** A permanent 301 in `_redirects` covers the old URL. She has since gone back to displaying as Dorothy (migration 025 updated her name and login email) — the slug stays `whitt`.
- **One renderer per platform, never hand-rolled markup per screen.** `public/show-renderer.js` renders every row and detail body on the web; `ShowRow.swift` does the same job in Swift. Both came back to that rule the hard way (five row implementations on the web in 2026-08), and it holds on either side.
- **Always clean up branches when a chunk of work is done.** After the work is merged to `main` and pushed live, delete the feature branch — local and remote. Caveat: in the Claude-Code-on-the-web remote environment the git proxy rejects remote-branch deletion (HTTP 403) and the GitHub MCP server has no delete-branch tool, so the remote branch may have to be deleted from GitHub's UI/API outside that environment. The local branch can always be deleted.
