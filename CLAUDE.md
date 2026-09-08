# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Show Picker Club — a multi-tenant TV-show/movie tracker, live at [showpicker.club](https://showpicker.club) and publicly listed on the App Store. Each member has a slug (`/patrick`, `/whitt`, …) and keeps four ranked lists (Watching, Awaiting, Loved, Next Up). The native SwiftUI apps for iPhone/iPad/Mac, Apple TV and Apple Watch are the product members actually use; the browser app is back as a secondary surface (see `docs/PRODUCT.md#web-app-status`) and the Cloudflare backend in this repo serves both.

**Despite the name, this is not a small private club any more — don't design as if it were.** Signup is open and self-service (email code / Apple / Google), the universal app is on the public App Store, and the membership is dozens of people rather than a couple of friends. Privacy moved *inside* the product: **private groups** and **households** are joined by invite link only, and group membership — not club membership — is what lets two members see or touch each other's libraries. So "another member" is not a synonym for "a friend": private memos (notes, watching-with text, recommended-by) stay owner-only, the social features (Also watching, vibe, cross-library reads) are group-scoped, and the one cross-member *write* that exists, Watching With, is allowed precisely because a group is a relationship both people opted into. The word *club* in the name and the UI is branding, not an access model.

**Stack:** Static HTML + vanilla JS (no framework, no build step) in `public/`; Cloudflare Pages Functions (file-system-routed JS) in `functions/`; Cloudflare D1 (SQLite) with the `DB` binding from `wrangler.toml`; TMDB for enrichment (OMDB retired 2026-07) and Watchmode for watch links; Claude API for vibe trait scoring; Twilio/Resend for login codes.

## Documentation map

Read these before making non-trivial changes — they are detailed and current:

- **`docs/ARCHITECTURE.md`** — the implementation source of truth: full DB schema, complete route/auth table, enrichment pipeline, vibe system, calendar feed, CI workflows, and a "Conventions that aren't obvious" section.
- **`docs/PRODUCT.md`** — product behavior and user-facing rules (the four lists, quick actions, auth flows).
- **`docs/INVARIANTS.md`** — the rules that must hold across the product, each with the enforcer that checks it. Read before adding an endpoint or session-derived UI state.
- **`docs/APP_STORE_SUBMISSION.md`** — Apple review/submission checklist.
- **`docs/RELEASE_NOTES.md`** — the What's New text for the next App Store update. Add user-facing changes to its *Unreleased* section as they merge.
- **`README.md`** — setup from scratch, secrets list, deploy/backup overview.
- **`ios/README.md`** / **`tvos/README.md`** — building, TestFlight, share extension, offline support.
- **`DESIGN.md`** + **`.impeccable/design.json`** — visual design system (OKLCH palette, list colors).

When you change behavior that these docs describe, update the docs in the same PR.

## Repo layout and what actually deploys

Only `public/` (static assets) and `functions/` (Pages Functions) are deployed — `pages_build_output_dir = "public"` in `wrangler.toml`. Everything else (`schema.sql`, `migrations/`, `docs/`, workflows) stays out of the served output. **Never pass `.` as a deploy directory.**

```
public/            Everything deployed. index.html IS the member SPA — it is
                   the root and the catch-all target, so /patrick renders that
                   member's lists (see _redirects; no other shape works).
                   download.html is the App Store pitch at /download.
                   Alongside them: groups/vibe/rate-backlog/
                   subscriptions, welcome, the four admin tools (members,
                   reporting, url-cleanup, vibe-admin), the shared scripts
                   (shell/nav/show-renderer/app-banner), privacy/terms/sms,
                   styles.css, favicon.svg, sw.js (tombstone — the PWA was
                   retired 2026-08; don't delete the file, see ARCHITECTURE.md),
                   _headers (CSP), _redirects. See
                   ARCHITECTURE.md#frontend-pages.
functions/
├── api/           /api/* endpoints (one file per route; [param].js for dynamic segments)
├── auth/          login, logout, request-code, apple, google, enroll, check, config
├── calendar/      [slug].js — per-member iCalendar feed (?key=<calendar_token>)
└── _shared/       auth, admin, enrichment, networks, sms, email, vibe-*, demo, enroll…
migrations/        Numbered D1 upgrades (auto-applied on deploy when pending)
schema.sql         Complete schema for fresh databases
ShowPickerCore/    Shared Swift package (models) used by all Apple targets
ios/  tvos/        SwiftUI apps; open ShowPickerClub.xcworkspace at the repo root
                   (the watch app and the widgets are targets under ios/)
roku/              Native Roku channel (SceneGraph/BrightScript) against the same
                   /api/*. On main but never compiled or run — Roku has no
                   simulator — so it is not a shipping platform; see
                   roku/NEXT_STEPS.md
scripts/           apply-migrations.sh, member-engagement.sh, vibe-diagnose.mjs
                   (operator tools)
```

## Commands

There is **no package.json or linter** — the web side has no build step. Verification is by reading, local preview, and the checks below, most of which run in CI (`.github/workflows/pr-checks.yml`) and all of which run fine from a laptop:

```bash
bash scripts/check-static.sh
```

Repo-shape invariants, no network — the PR gate. Every API endpoint gated, redirects present, AASA well-formed, no archived web page back under `public/`.

```bash
bash scripts/smoke.sh https://showpicker.club
```

Live assertions against a running site: auth gates, security headers, public-surface leakage, redirects, universal links. Runs after every deploy and nightly.

```bash
node scripts/webauthn-test.mjs && node scripts/passkey-flow-test.mjs
```

Passkeys, in two suites: the hand-rolled WebAuthn verification (no npm in this
stack, so `_shared/webauthn.js` implements CBOR/COSE/ECDSA itself), and the
endpoint flows driven against a real SQLite database built from `schema.sql`.
No network, no dependencies — Node 22 for `node:sqlite`.

```bash
node scripts/activity-feed-test.mjs && node scripts/admin-member-detail-test.mjs
```

The two endpoints behind the member page's admin strip, on the same harness.
`/api/activity` stays session-gated, `?member=<slug>` returns only what that
member actually chose (no seeded starter rows), and a bulk import collapses
into one line **per list** rather than one line for the whole burst.
`/api/admin-member-emails` hands out login emails and phone numbers, so it
stays admin-only — a logged-in non-admin gets 403, not their own row — and
`?member=<slug>` returns that member and nobody else. `/api/admin-member-groups`
is the same gate on the one read of a private group from outside it: a
non-admin gets 403 even for a group they're in, and the payload carries
membership (names, rosters, creator) but never the group's shows.

```bash
node scripts/reporting-platform-test.mjs
```

`/api/reporting`'s admin gate and the unit its platform breakdown is counted
in. It counts **people, not sessions**: four iPhone sessions across two members
read as 2, a member on three platforms is 1 on each row (so the rows don't sum
to Active members), and a member-less tvOS session still counts as one device
rather than collapsing into a phantom person.

```bash
node scripts/watching-with-test.mjs
```

"Watching With" naming club members, on the same harness — the only
cross-member write in the codebase, so the properties are the ones that keep
it narrow. Only a member you share a private group with can be named (a
hand-typed outside slug writes nothing and doesn't fail the save); a copy they
already have is linked where it sits rather than moved or duplicated;
unlinking takes your name off and leaves their show alone; and the free text
still works, surviving a linked name being added and removed around it.

```bash
node scripts/group-suggestions-test.mjs
```

"Recommend to group" (migration 065), same harness — JC's pop-up on top of a
group-owned Watch Next board. The properties pinned are the ones that keep it
**pull-only**: recommending writes a card the group owns and touches nobody's
list; "Add to Next Up" runs under the recipient's session onto their own list
(existing copies honoured where they sit, archived ones revived, memos never
overwritten, `recommended_by` stamped only on a fresh copy); Dismiss is a
per-member mark that hides nothing from anyone else. Plus the bounds:
group-mates only in both directions, only a copy you own can be recommended,
duplicate titles fold into the existing card, a per-member daily ceiling,
removal by recommender or creator only, and leaving a group takes your cards
with you. See `docs/INVARIANTS.md` §12a.

```bash
node scripts/group-icons-test.mjs
```

Group icons (migration 066), same harness. The server is the only gate — an
icon or color outside the curated sets in `_shared/group-icons.js` is a 400 on
create and PATCH, so clients render what arrives without re-validating — and
the PATCH semantics that keep a rename from wiping an icon: absent key keeps,
null clears, creator only (same bar as rename).

```bash
node scripts/vibe-scope-test.mjs
```

`/api/vibe`'s scoping, same harness. Who may read whose vibe (session-gated,
group-scoped, a hand-typed outside slug is 403) and what the taste exclusion in
`_shared/excluded-members.js` does: it bounds club-level **math** — Trending,
neighbour pools, the aligned-picks pool — and never visibility. An excluded
member reads her own vibe and her group-mates read it too, symmetrically, and
her titles still reach the trait-fill queue so that profile isn't computed from
the sliver of her library someone else shares.

```bash
node scripts/vibe-match-test.mjs
```

The matcher that turns a fingerprint into a cluster. Pins the properties a
distribution can't prove: a trait the whole club shares decides nobody, six
libraries separated by 0.03 land in six clusters rather than all reading
"Prestige Drama Loyalist", a cluster only votes on traits it names, an average
member gets ~50% and no daylight, and a club too small to have a distribution
falls back instead of dividing by an invented spread.

`scripts/vibe-cluster-report.mjs` is the companion operator tool — it scores
every member in a production snapshot under both the old and new matcher and
prints the two distributions side by side. Read-only, no deploy.

```bash
node scripts/networks-test.mjs
```

The canonical network table and the catalog the apps fetch from it. The alias
index is a Map built in list order, so a name claimed twice doesn't error — the
later entry silently wins, which is how the US `ABC` (a Hulu sub-brand) could
lose to Australia's ABC iview. Also pins the `/api/networks` payload (every
entry present, sections as consecutive runs a client can group by), that the
Swift seed left for a first offline launch never names a service the server
wouldn't canonicalize, and that a default price is never keyed to a name the DB
doesn't store. The client half — an empty or junk payload must not empty the
picker — is `NetworkCatalogTests` in `ShowPickerCore`.

```bash
CRON_SECRET=… node scripts/fill-enrichment-gaps.mjs --dry-run
```

Counts the titles holding no cast or no episode data, and enriches nothing.
Drop `--dry-run` to fill them. Needed because the 2026-08-11 rate-limit bug
stamped `enriched_at` on rows it *failed* to enrich, so they look done and
sit at the back of the oldest-first queue — `{mode:'gaps'}` selects on missing
data instead of age. Nothing schedules this; it's an operator tool for
draining that backlog once, and the Actions tab → **Fill enrichment gaps** is
the same thing with the secret already wired up (dry run by default). One-time
repairs live in Actions rather than the admin screens on purpose — a permanent
control for a job done once is clutter that outlives its reason. **Re-check
Apple TV+ rentals** is the other one (`scripts/reclassify-storefronts.mjs`),
draining the storefront rows that predate #337; its admin button was removed
when it moved.

```bash
node scripts/favorite-actors-test.mjs
```

`/api/favorite-actors` and the list rule both Trending queries share. The
endpoint is **owner-only** — it aggregates a whole library into a sharper
picture of taste than the list titles a group-mate can already read, so a
session gets its own actors and `?member=` is ignored rather than honoured.
Also pins that a person is counted once per *title* (the same show on two
lists is one credit), that a TMDB id and a bare name for the same person
collapse into one row — including a legacy name-only credit resolving through
the member's own library or the `people` bank, the split that once halved real
counts — that a credit with no `imdb_id` still counts instead of vanishing,
and that `show_cards` carries the member's own copies (one per title, with id,
network, rating, poster) alongside the legacy bare-title `shows` array. On the Trending side: Next Up never feeds the ranking
(`_shared/trending-lists.js`), and `?limit=` pages, caps at 50 and falls back
to 10 on junk.

```bash
node scripts/trending-cache-test.mjs
```

`/api/popular`'s daily snapshot (migration 067). Trending is computed once
per UTC day into `trending_cache` and every other request reads the one
cached row — the ranking is the most expensive read in the product and the
endpoint is public, which is how bots burned the whole free-tier daily D1
read budget on 2026-09-01. Pins that a later `?limit=` expansion pages the
cached 50 rather than recomputing or coming up short, that a title added
after the snapshot waits for tomorrow, that member names are resolved fresh
per session (slugs cached, names never), and that a stale, corrupt or
missing cache recomputes instead of erroring.

```bash
node scripts/enrich-identity-test.mjs
```

A stored `tmdb_id` is the row's identity, on the same harness with a fake
TMDB serving two entries that share one exact title (a remake next to the
original it remade, popularity-ordered the way the real index is). Pins the
rule that fixed the rerelease bug: the background `/api/enrich` passes fetch a
pinned row by its id instead of re-guessing from the title — which is how a
picked remake used to come back as the 1974 original — and every title-scoped
propagation (catalog fields, cast, artwork, inherited URLs) stops at a copy
pinned to a different id. Rows nothing ever pinned still resolve by title
search, store the id they resolve to, and among same-named entries prefer the
newest — a bare title means the current version of a remade show, and a
trailing "(YYYY)" pins that year's entry instead.

```bash
node scripts/enrich-movie-detail-test.mjs
```

The movie half of the enrichment rotation, same harness and fake TMDB. A pass
must select on every field it writes: the movie pass fills eighteen (genres,
overview, runtime, tagline, studio…) but was gated on `poster_url IS NULL OR
network IS NULL`, so a film that inserted with artwork — the normal case —
never qualified again. That left 91% of the movie library with no genres, and
the genre filter on Next Up hiding every movie. Pins that a film missing only
its detail block is selected, that a complete one isn't re-fetched, that
`mode: 'gaps'` sees it *and* counts it in `remaining` (the counter used a
narrower predicate than the pass, so a dry run reported nothing to do over a
backlog of 125), that `mode: 'posters'` keeps its narrow artwork gate, and that
the loop stops on the subrequest budget — it had no check at all, which was
safe only while its selection was empty. See `docs/INVARIANTS.md` §19.

```bash
node scripts/auth-code-flow-test.mjs
```

The email login/signup code flow on the same harness, with a fake Resend that
refuses reserved domains the way the real one does — the demo account sending
no mail, native signup codes not being gated on a captcha no app can pass, and
a delivery failure surfacing instead of hiding behind `{success: true}`.

```bash
node scripts/import-list-test.mjs
```

The paste-a-list import on the same harness, with a deliberately badly-behaved
fake Claude — a hallucinated TMDB id and a title TMDB has never heard of. Pins
the rule that makes a model safe on a write path: Claude supplies titles, TMDB
supplies identity, and commit re-validates everything. Also covers paging (a
section heading surviving the seam between slices), duplicate handling, and the
import's own daily ceiling.

```bash
node scripts/og-preview-test.mjs
```

The three link-preview pages — `/show/:id`, `/groups/join`, `/household/join` —
on the same harness. These are the only pages that render member-adjacent rows
with **no session**, so the properties worth pinning are the negative ones: the
show card names the show but leaks no note, recommender or watching-with and
never says whose list it's on; a title full of quotes and markup can't break out
of a `content="…"` attribute; a non-TMDB image URL is dropped rather than
emitted into an `og:image` other people's clients fetch; and an unknown invite
token renders the same card as an expired one, so a dead link never confirms it
existed. Also guards the `og:image` on the marketing page, whose absence is why
every share used to arrive with no artwork.

```bash
cd ShowPickerCore && swift test
```

Unit tests for the shared core (macOS, or Linux with a Swift toolchain — the package is deliberately Foundation-only so CI needs no macOS runner). `SessionScopeTests` guards the rule that session-derived UI state dies with the session.

Two of the suites above — `watching-with-test.mjs` and `og-preview-test.mjs` — are **not** wired into `pr-checks.yml`; run them by hand when you touch what they cover.

The rules these checks enforce are written down in `docs/INVARIANTS.md`; adding a rule there also extends the advisory PR review.

Local preview of the site + Functions (uses a local D1 unless you point it at remote):

```bash
wrangler pages dev public
```

Run a migration against production D1 out of band (requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`; normally unnecessary — see below — but useful to apply a migration ahead of merging its code, or via the "Apply D1 migration" GitHub Action):

```bash
wrangler d1 execute shows-db --remote --file=migrations/NNN_name.sql
```

`scripts/apply-migrations.sh` applies all pending migrations, tracked in a self-owned `schema_migrations` table (first run baselines without executing).

The one suite that needs Xcode and a simulator, rather than just a Swift toolchain (`ShareTitleParser` for the iOS share extension) — everything above this point runs from a laptop with Node or Swift alone:

```bash
xcodebuild test -project ios/ShowPickerIOS.xcodeproj -scheme ShowPickerShareExtensionTests -destination 'platform=iOS Simulator,name=iPhone 16'
```

Apple builds: open `ShowPickerClub.xcworkspace` in Xcode (macOS). iOS + tvOS ship as one universal app (bundle id `net.patrickturner.showpickerios`); the build number is a single project-level `CURRENT_PROJECT_VERSION` shared by all targets — bump that one value before archiving.

## Deploys, migrations, and CI

- **Push to `main` deploys production automatically** (`.github/workflows/deploy.yml`), then smoke-tests: an unknown path must serve the marketing page, `/.env` must expose no environment content, security headers must be present, and auth-gated endpoints must 401. The smoke step retries for ~2 minutes — the edge keeps answering from the previous bundle for a while after `wrangler` returns, so a first-attempt failure means "not propagated yet", not "broken".
- **`deploy.yml` applies pending D1 migrations automatically**, in the same run, before the Pages deploy step (`scripts/apply-migrations.sh`, self-tracked via `schema_migrations`). Merging a migration in the same PR as the code that depends on it is the normal path and needs no extra operator step. The manual "Apply D1 migration" workflow (Actions tab → pick the file) is only for applying a migration *ahead of* merging its code, or running one against prod outside of a `main` push.
- Other workflows: daily D1 backup to Google Drive (`backup.yml`), daily demo reset, and scheduled enrichment/vibe/watch-URL fills — the scheduled ones call admin endpoints with an `X-Cron-Secret` header.

## Architecture essentials

- **Routing** is Pages Functions file routing (`functions/api/shows/[id].js` → `/api/shows/:id`) layered over `public/_redirects` (SPA fallback `/*` → `/index.html`). The full route/method/auth table is in `docs/ARCHITECTURE.md#routing`.
- **Auth:** passkeys (WebAuthn, iOS/iPad — added from inside a session, never a way to sign up), one-time codes (SMS via Twilio Verify, email via Resend), Sign in with Apple, Sign in with Google (web). Sessions are 30-day HttpOnly cookies; `_shared/auth.js#getSession(request, env)` is the gate every session-protected endpoint calls first. Admin = a session whose member row has `members.is_admin = 1`, checked via `_shared/admin.js#isAdmin()` — admin rights live in the DB, not in code or a secret.
- **Everyone self-enrolls.** Signing up (email code / Apple / Google) is the only way a member row is created, and a new member is immediately a full member. Retired 2026-08 (migration 058): `members.approved` and the held state, the `signup_requests` table, the `/join` form, the operator approval queue, `admin-member-approve`, manual member creation, `SELF_ENROLL`, and `DEMO_APPLE_FALLBACK`. `createMember()` lives in `functions/_shared/create-member.js` and only `_shared/enroll.js` calls it. The matching **Swift cleanup was deferred until the App Store launch, which has since happened** — the iOS app still carries the inert, gracefully-degrading approval queue, signup models and `WelcomeIntroPanel.swift` (`Models.swift`, `API.swift`, `ManageMembersView.swift`, `AdminView.swift`). Nothing blocks removing them now; it simply hasn't been done.
- **Private groups and households are the privacy unit — the club isn't.** Groups (migration 056: `groups`, `group_members`, `group_invites`) and households are joined by invite *link* only; there is no roster you can add somebody from. Every group route re-checks `group_members` and 403s otherwise, and only the creator can delete. Group membership is what scopes vibe reads, `GET /api/shows/all`, `group_watchers` ("Also watching"), Group Trending, the Watch Next recommendation board (migration 065, pull-only — see `docs/INVARIANTS.md` §12a), and who Watching With may name. iPhone/iPad create, invite, join, leave and delete; Apple TV browses groups read-only; the watch has no groups. In Swift, `SwiftUI.Group` collides with the model — spell it `ShowPickerCore.Group` in type position.
- **Three tiers of visibility, not two.** *Logged out:* roster first names, Trending, catalog-level show detail, auth endpoints — deliberately tiny, keep it that way. *Any logged-in member:* another member's list titles, but never their `notes`, `watching_with`, `recommended_by` or `added_by`, which are owner-only because with signup open other members are not all friends (`functions/api/shows.js`). *Group-mates only:* vibe, Also watching, cross-library reads, Watching With links. A new endpoint has to land in one of those three on purpose.
- **Enrichment:** synchronous on insert (`_shared/enrichment.js`, TMDB only — OMDB was retired 2026-07 and `rating` now carries TMDB's audience score), plus background `POST /api/enrich` fired from member pages. Watch links come from Watchmode (`_shared/watch-providers.js`), never pasted by a member. New rows inherit a sibling copy's real `network_url` when one exists.
- **Networks:** `_shared/networks.js` is the source of truth for canonical streaming-service names, aliases, and search-URL templates. All incoming `network` values pass through `canonicalNetwork()`. **The apps don't hardcode the list** — `networkCatalog()` serves it at the public `GET /api/networks`, `ShowPickerCore.NetworkCatalog` is the client model (with a bundled seed and a "never render an empty picker" rule), and `NetworkCatalogStore` caches it. Adding a network is a server-only change that reaches installed apps.
- **Vibe:** 26-trait fingerprints per title (`show_traits`, scored by Claude via `/api/admin-vibe-fill`), matched to 8 clusters in `/api/vibe`, scored against the club's own distribution rather than the trait scale; reads are group-scoped. (`docs/ARCHITECTURE.md` and `README.md` still say 27 traits / 7 clusters — `_shared/vibe-traits.js` and `_shared/vibe-clusters.js` are the counts that are right.)
- **Feature flags via secrets:** `DEMO_LOGIN_EMAIL`/`DEMO_LOGIN_CODE` (App Review demo account with auto-reset), inert when unset. Signup is always open — there is no kill switch and no approval step.
- **Retired 2026-07:** the open cross-member writes (suggest-a-show, share-to-member) — those endpoints still return 410, and the reason they're gone is that anyone could push a row onto anyone. **Watching With (2026-08) is the one cross-member write that exists now**, and it's the shape a new one would have to take: only a group-mate can be named, an existing copy is linked where it already sits rather than moved or duplicated, and unlinking touches only your own row (`_shared/watchers.js`, `scripts/watching-with-test.mjs`). "Picks for You" (`/api/recommendations`) is no longer called by any client but kept for compatibility.
- **The home page does not list members.** `/api/members` is still the roster source for the member-page sidebar, cross-library search, household, and the calendar-feed link — just not the landing page.
- **Native apps** call the same `/api/*` endpoints; shared models live in the repo-root `ShowPickerCore` package. tvOS is view-only. watchOS gets its session from the iPhone via WatchConnectivity. iOS has offline caching + a queued-write sync layer (`ios/ShowPickerIOS/Offline/`).

## Non-obvious conventions (violating these breaks features)

- **`updated_at` is sacred.** Only member-initiated writes bump it; enrichment writes `enriched_at` instead. `updated_at != created_at` is how the app distinguishes member intent from background jobs.
- **Seeded rows have NULL `created_at`/`updated_at` and `added_by='seed'`.** The "seed-only member" check depends on exactly that signature.
- **Network URLs containing `/search`, `/s?`, or `/?q=` are placeholders**, not real deep links — the frontend, sync-urls, and calendar feed all treat them as missing.
- **Fresh versus existing databases.** `schema.sql` creates the current complete schema for a new database. `migrations/` upgrades existing databases only; never apply the historical migration set after loading `schema.sql`.
- **Secrets are set with `printf`, never `echo`** (trailing newlines break runtime API calls).
- **Slug `dorothy` 301s to `whitt`** and the member displays as Dorothy; don't "fix" either side.
- **Delete feature branches once merged and live** — local and remote. In the Claude-Code-on-the-web environment the git proxy rejects remote branch deletion (403); the user deletes merged branches themselves from GitHub's post-merge screen.

## Working preferences

- **The web member app is back (restored 2026-08), but the Apple apps still
  lead.** `showpicker.club/` is the app again — member slugs like `/patrick`
  render in a browser — and the App Store pitch lives at `/download`. Web
  sign-in (email/phone code, Apple, Google) works again. **The catch-all in
  `public/_redirects` can only be `/*  /index.html  200`**; pointing it at any
  other page 308-loops the entire site, which is how production went down on
  2026-08-13 (see `docs/ARCHITECTURE.md#the-catch-all-can-only-point-at-indexhtml`).
  Verify routing changes against `wrangler pages dev` before merging — a local
  emulator reproduces this exactly, and the post-deploy smoke test is a much
  more expensive way to find out.

  **The web is frozen at its restored state: keep it functional, don't build
  for it.** Bug fixes, security fixes and anything that keeps it working, yes.
  New member-facing features, no — those go to iOS/iPad, and the web simply
  falls further behind on purpose. Don't offer to close the gap, and don't port
  a feature there as a bonus. It already predates Watching With and Also
  watching; name the gap rather than treating it as work. If Patrick wants
  something on the web he'll ask for it on the web. See
  `docs/PRODUCT.md#web-app-status`.

- **Feature requests still name their platforms.** The product ships on
  iPhone/iPad, Mac (Catalyst — it runs the iPad split view and gets what iPad
  gets), tvOS and watchOS, under one universal App Store listing. When a feature
  is requested, state which get it and which don't (tvOS is view-only, watch is
  read-only and has no groups at all) — parity gaps between the Apple targets
  are still expensive to rediscover, and the web is a further surface to name
  now that it's back. Don't count Roku: the channel in `roku/` has never run on
  a device. There is no in-app What's New — release
  notes go in the App Store update text instead (retired 2026-08, along with
  `whats-new.json`, `whats-new.html` and `WhatsNewView`). Collect that text in
  `docs/RELEASE_NOTES.md` under *Unreleased* as user-facing work merges, so
  submission day is a copy-paste rather than a `git log` archaeology session.

- **Home leads and Home is the launch screen, on every platform.** Home is the
  first tab / first nav item, My Shows second, and the app opens on Home even
  when a session is already stored. Signing in mid-session still jumps to My
  Shows. See `docs/PRODUCT.md#navigation-standard`.

- **Never put `#` comments in terminal commands meant for the user to paste.**
  Pasted into their zsh, comment lines execute as garbage commands and break
  the sequence. Give bare commands in separate code blocks and explain them
  in prose around the blocks instead.

- **Walk operational procedures ONE step at a time.** For any multi-step
  operator task (secrets, deploys, migrations, dashboard setup, DNS, etc.),
  give a single step, then stop and wait for the user to confirm it's done
  before giving the next. Never dump a numbered list of actions for them to
  track — they don't want to keep up with a checklist. Lead with the most
  urgent/blocking step first.

- **Never watch PRs, CI, or deployments, and never offer to.** Watching burns
  tokens while polling. When work involves a PR or deploy, just give the link
  and let the user watch it themselves.

- **Open and merge the PR yourself — don't wait to be asked.** Finished work
  goes: commit → push → open the PR → squash-merge it → tell the user it's on
  `main` and ready to pull into Xcode. No "want me to merge?" round trip, and
  no reminders that the user has to compile the Apple targets — they know.

- **Whether you can build the Apple targets depends on where you're running.**
  Claude Code on the web has no Swift toolchain: never imply a build was run
  there. A local session on Patrick's Mac does have one — Xcode is installed,
  `cd ShowPickerCore && swift test` works, and `xcodebuild` against the
  `ShowPickerIOS` scheme works. Check before assuming (`which xcodebuild`).
  When the toolchain is there, **compile Swift changes rather than shipping
  them unverified**, and say plainly which it was. A green
  `** BUILD SUCCEEDED **` is evidence; SourceKit's silence in the editor is
  not — see the SourceKit note below.

- **Patrick's iPhone can be installed to directly from a local session.** His
  iPhone 16 Pro is paired (`xcrun devicectl list devices`), so the loop is
  `xcodebuild build -workspace ShowPickerClub.xcworkspace -scheme ShowPickerIOS
  -destination 'id=<device-id>' -allowProvisioningUpdates`, then `xcrun
  devicectl device install app`, then `... process launch`. Omit
  `-derivedDataPath` so it reuses the existing Xcode cache, and run the build
  in the background — even warm it outlasts a foreground timeout. Signing needs
  no keychain setup. **Ask first** — it's his physical device — and be clear
  that this is a debug install to his phone only: it is NOT TestFlight, it
  doesn't reach Whitt, and it touches nothing Apple reviews.

- **SourceKit "Cannot find type 'Show' / 'Theme' / 'AuthStore' in scope" on
  files under `ios/` or `tvos/` is noise, not a real error.** The tell is that
  the whole module fails to resolve at once — app-local types, ShowPickerCore
  types and SwiftUI helpers all go missing together — because the file is being
  analyzed without the Xcode project's module graph. A real error from an edit
  is localized to what was edited. Don't chase these, and never "fix" correct
  code to satisfy them; compile instead.
- **End every completed task with an explicit close-out.** When the work is
  done, don't wait to be asked — state plainly: what shipped, anything still
  pending on the user (merges, migrations, secrets, verifications), whether
  branches are cleaned up, and whether the session is safe to archive. If
  something is not done, say what and why instead of going quiet.
- **No branch-deletion links in close-outs.** GitHub's post-merge screen
  already offers the branch delete, so don't paste `branches/all?query=…`
  links or remind about deleting merged branches — just say whether the
  branch is merged yet.
