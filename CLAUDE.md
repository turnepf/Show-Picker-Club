# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Show Picker Club — a multi-tenant TV-show/movie tracker, live at [showpicker.club](https://showpicker.club) and publicly listed on the App Store. Each member has a slug (`/patrick`, `/amy`, …) and keeps four ranked lists (Watching, Awaiting, Loved, Next Up). The native SwiftUI apps for iPhone/iPad/Mac, Apple TV and Apple Watch are the product members actually use; the browser app is back and keeps parity with iPhone/iPad (see `docs/PRODUCT.md#web-app-status`) and the Cloudflare backend in this repo serves both.

**Despite the name, this is not a small private club any more — don't design as if it were.** Signup is open and self-service (email code / Apple / Google), the universal app is on the public App Store, and the membership is dozens of people rather than a couple of friends. Privacy moved *inside* the product: **private groups** and **households** are joined by invite link only, and group membership — not club membership — is what lets two members see or touch each other's libraries. So "another member" is not a synonym for "a friend": private memos (notes, watching-with text, recommended-by) stay owner-only, the social features (Also watching, vibe, cross-library reads) are group-scoped, and the one cross-member *write* that exists, Watching With, is allowed precisely because a group is a relationship both people opted into. The word *club* in the name and the UI is branding, not an access model.

**Stack:** Static HTML + vanilla JS (no framework, no build step) in `public/`; Cloudflare Pages Functions (file-system-routed JS) in `functions/`; Cloudflare D1 (SQLite) with the `DB` binding from `wrangler.toml`; TMDB for enrichment (OMDB retired 2026-07) and Watchmode for watch links; Claude API for vibe trait scoring; Twilio/Resend for login codes.

## Documentation map

Read these before making non-trivial changes — they are detailed and current:

- **`docs/ARCHITECTURE.md`** — the implementation source of truth: full DB schema, complete route/auth table, enrichment pipeline, vibe system, calendar feed, CI workflows, and a "Conventions that aren't obvious" section.
- **`docs/PRODUCT.md`** — product behavior and user-facing rules (the four lists, quick actions, auth flows).
- **`docs/INVARIANTS.md`** — the rules that must hold across the product, each with the enforcer that checks it. Read before adding an endpoint or session-derived UI state.
- **`docs/APP_STORE_SUBMISSION.md`** — Apple review/submission checklist.
- **`docs/CONNECTOR_DIRECTORY.md`** — listing the MCP server in Anthropic's Connectors Directory: who can submit, the pre-submit checks, and every portal answer.
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
                   favorite-actors/subscriptions, welcome, the four admin tools (members,
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
                   /api/*. Runs on a real device via sideload (Roku has no
                   simulator) and carries the only build tooling in the repo —
                   `bsc` validation, one-command sideload, scriptable
                   remote/typing/screenshots (roku/sideload.mjs). Live in the
                   Roku Channel Store (2026-09), so it is a shipping platform
                   and counts for feature-parity statements. See roku/NEXT_STEPS.md
scripts/           apply-migrations.sh, member-engagement.sh, vibe-diagnose.mjs
                   (operator tools)
```

## Commands

**The web side still has no package.json, no build step and no linter** — verification there is by reading, local preview, and the checks below. The one exception is `roku/`, which carries its own `package.json` for BrighterScript and roku-deploy (see *Roku tooling* below); it is scoped to that directory on purpose, and nothing it installs is deployed. Most of these checks run in CI (`.github/workflows/pr-checks.yml`) and all of them run fine from a laptop:

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

`/api/reporting`'s admin gate and the unit its people numbers are counted in.
They count **people, not sessions or devices**: four iPhone sessions across two
members read as 2, one member's three Apple TVs / two Macs / four Rokus are one
user on each of those rows, and `signin_methods` reports people per method (four
Apple sign-ins by one person is 1) rather than sessions minted. A member on
three platforms is 1 on each row, so the rows don't sum to Active members. Every
count groups by the same `PERSON` expression, which falls back to a legacy
member-less session's own identity instead of counting one per device. A
session whose platform (or auth method) was never captured is **omitted**
rather than bucketed as "Unknown" — it only ever meant the dashboard failed to
ask — so the platform rows can sum to less than Active members as well as more.
`/auth/check` is the only writer of `sessions.platform`, so every web call must
send `X-Client-Platform`; `check-static.sh` fails the PR if one doesn't.
Also pins the **AI apps (MCP)** list (`mcp_connections`): one row per
*member* (every reconnect or second app folded in, "disconnected" only once all
are) with the person, app name, scope, dates and 30-day / all-time
calls and changes (`mcp_usage` is kept a year) —
admin-only like the rest, and never a client secret, client id or redirect.

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

Group icons (migration 066) and the rename/icon change notice (migration
068), same harness. The server is the only gate — an icon or color outside
the curated sets in `_shared/group-icons.js` is a 400 on create and PATCH, so
clients render what arrives without re-validating — and the PATCH semantics
that keep a rename from wiping an icon: absent key keeps, null clears, any
group member (not just the creator — Delete is the only rename/icon-adjacent
action still creator-only). Also pins the change notice: a real edit stamps
who/what/when on the group, `GET` surfaces it once to every other member who
was already in the group when it happened, never to the editor, and never to
someone who joined afterward.

```bash
node scripts/group-invite-lifecycle-test.mjs
```

The group invite's lifecycle (migration 070) and the cross-site gate on
redemption, from the 2026-09 security audit. Group membership is the privacy
unit, so both ways a membership row could be written without the group
agreeing are pinned here. **Redemption is a write riding a cookie-authenticated
GET**, so a cross-site top-level navigation used to join a signed-in member to
a stranger's group — `SameSite=Lax` permits exactly that navigation. The write
is refused when `Sec-Fetch-Site` says cross-site (falling back to `Origin`),
while native clients that send neither header are unaffected; the refusal is a
*preview*, so a cross-site caller learns nothing it didn't already hold. The
verb is still wrong — the write belongs on a POST — but both shipped clients
call it as a GET, so that split waits for a build. **A token was never
consumed, counted or cancellable**: the link stays shareable to several people
(10 uses), claimed by an atomic `UPDATE ... WHERE use_count < max_uses` so a
race can't overshoot, revocable by the issuer or the group's creator, deleted
when its issuer leaves, and dead if their membership ends some other way.
Revoked, exhausted, expired and issuer-departed all answer alike, and the
link-preview card in `functions/groups/join.js` goes generic for all of them —
a dead link never names the group it used to open. See `docs/INVARIANTS.md`
§26.

```bash
node scripts/show-edit-network-test.mjs
```

Who wins when the member and the stored link disagree about what service a
show is on. `PUT /api/shows/:id` read the network off the row's existing
`network_url` and let it beat the dropdown — fine when members pasted their
own links, but since Watchmode those arrive from a machine, so it let a
machine outrank a person: a row holding a `tv.apple.com` deep link **could
not be moved off Apple TV+ at all**, because every save read the old link and
put the network back, with no error to explain it. Pins that the member's
pick now wins, that a URL pasted *in the same edit* still decides (that one
is the member talking), that moving a row drops the link belonging to its old
service rather than pointing the Watch button into the wrong app, and that
the replacement link reaches only copies naming the new service — one member
moving their copy must not relink anybody else's. See `docs/INVARIANTS.md`
§20.

```bash
node scripts/show-edit-identity-test.mjs
```

Invariant §17 on the edit path, same harness and fake TMDB as the identity
suite. `PUT /api/shows/:id` re-enriches on every save. Given no `tmdb_id`, it
used to search by title and store the result, so restoring the 1974 Little
House on the Prairie from the archive, or editing its notes from a client
that sends no id, turned it into the 2026 remake. Pins that an edit with no
pick fetches a pinned row by its own pin, with no title search. A type-ahead
pick still re-points the row. A new title or a TV/movie flip still searches,
since the pin no longer describes the row. An unpinned row still resolves by
title. A pinned lookup that fails saves the edit and leaves identity alone
rather than guessing.

```bash
node scripts/url-cleanup-authz-test.mjs
```

Who may drive `/api/admin-url-cleanup`, and what the scheduled action on it
is allowed to decide. The page is the operator's — dismissing a title,
overwriting a link, renaming a show, picking the winner among networks
members disagree about — and all of that stays admin-session-only. Exactly
two actions also accept an `X-Cron-Secret`, `reclassify_storefronts` and
`inherit_networks`, because they are the two that **decide nothing**:
adopting a network only fills rows that have none, and only where every
other copy in the club already agrees, so a contested title is skipped
rather than resolved. The suite pins that skip, the idempotence, and that a
leaked secret reaches neither `dismiss`, `resolve_conflict`, `update`,
`rename` nor `list`. `inherit_networks` runs nightly as the first step of
`watch-urls-fill.yml` — it used to be a button on the page, clicked every
time the page was opened, which is a routine sweep rather than operator
judgment.

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
node scripts/tmdb-audit.mjs
```

How far the library is from "every show is a TMDB entry, named the way TMDB
names it". It's a read-only operator report: SELECTs through `npx wrangler d1
execute shows-db --remote` (or `--db <file>` for a local SQLite copy), plus
TMDB GETs when `TMDB_TOKEN` is set. It lists:
- **Rows with no `tmdb_id`,** each sorted into one of three groups:
  - copyable: exactly one entry is pinned under the same title elsewhere in
    the club;
  - ambiguous: a remake and its original are both pinned under that title;
  - none: nothing in the club matches, so with a token it shows TMDB's top
    search hit, as a suggestion only.
- **Entries whose copies carry different titles.**
- **Movie flags** that disagree with the pinned entry's type.
- **With a token:** every title that differs from TMDB's official name, and
  pins TMDB no longer serves.
- **What normalizing to one row per entry would collapse.**

It never selects memos or emails. `--json <file>` writes everything, and
`--all` lifts the 40-row cap per section. `scripts/tmdb-audit-test.mjs` pins
the classification against a fixture database and a fake TMDB.

```bash
node scripts/titles-test.mjs
```

(Test fixtures that describe a show the pre-normalizing way, with facts on
the copy, lift them into the shared row with `scripts/lib/seed-titles.mjs`.)

The shared one-row-per-show tables, `titles` and `title_cast` (migration
076), and the views member-facing reads go through: `shows_v` (migration 077)
for the show and `actors_v` (migration 078) for its cast, which is the shared
cast for every copy whose entry has one. This is normalizing the library: one row per TMDB entry instead of
the show's details repeated on every member's copy. What's pinned is that
the view has exactly the columns of `shows` (so switching a read changes
nothing about its shape), takes the title and shared details from `titles`
while member fields and the three per-member columns stay the member's, and
falls back to the copy when there's no shared row. Also that the tables
summarize the copies faithfully, built the same way by the migration, the
nightly rebuild and the sync after each write:
- one row per entry, each field taken from the freshest copy that has it;
- TMDB's own name, kept until TMDB gives another;
- the fullest cast any copy holds;
- no member field;
- an entry nothing points at is dropped;
- the migration's backfill is the same SQL as `rebuildTitles()`;
- a sync never throws, because it runs beside a member's save.

`admin-fix-tools-test.mjs` checks that the real add, edit and refresh paths
keep the table in step. See `docs/ARCHITECTURE.md#titles--title_cast-migration-076-normalizing-step-1`.

```bash
node scripts/asc.mjs status
```

The App Store Connect operator tool — `status`, `set-notes <version> <file>`,
`attach <version> <build>`, `upload <ipa|pkg>`. Reads and writes the app's
version records directly so a release doesn't depend on three identical
pastes into the web UI; `set-notes` re-reads Apple and compares SHA-256
against the local file, which is what actually enforces "byte-identical on
all three platforms". Credentials stay out of the repo (key in
`~/.appstoreconnect/private_keys/`, issuer in `~/.appstoreconnect/issuer_id`).
There is no `submit` subcommand on purpose — sending a version to review
stays a human decision. Used by the run sheet in
`docs/APP_STORE_SUBMISSION.md#6a-run-sheet-releasing-from-a-second-mac`.

```bash
node scripts/favorite-actors-test.mjs
```

`/api/favorite-actors`, Rate my backlog, and the list rule both Trending
queries share. Actors rank by a **rating-weighted** count: the member's overall
rating decides a title's weight (10/9/8 → 4/3/2, Loved at least 2 whatever it
was rated, unrated Watching/Awaiting 1, rated 7 or below off Loved dropped), an
archived show counts only when rated 8+, and `needs_ratings` flags fewer than 8
rated titles so the app offers Rate My Shows — whose backlog therefore lists
archived shows, one row per title, with its badge count pinned to the page. The
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
node scripts/amazon-url-test.mjs
```

The rule that decides whether the Watch button reaches a Prime Video title or
dumps the member on its home screen. Amazon publishes one title under several
hosts and **only `watch.amazon.com` is handed to the Prime Video app on tvOS**
(their app-association file claims that whole host; `www.amazon.com` maps its
paths to Amazon's *other* apps). The repair is possible because both hosts
carry the same `amzn1.dv.gti.*` id, so `_shared/amazon-urls.js` moves the id to
the host that works. The properties pinned are the refusals: an ASIN is **not**
a gti and Amazon rejects it in that parameter, so a row carrying only an ASIN
is left alone rather than rewritten into a dead link — a wrong deep link is
worse than one that merely opens the app, because the member lands on an error
instead of somewhere they can search. Same for a `primevideo.com` opaque id, a
retail `/dp/` page, a lookalike host, and anything that isn't Amazon.

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
safe only while its selection was empty. Also covers movie **service badges**:
`network_logo_url` was never written for films at all (TV reads it from TMDB's
`networks[0]`, which movies don't have), so it now comes off the flatrate
provider that names the network. That repair is `mode: 'logos'`, a deliberate
one-time sweep rather than part of the standing gate — a rent/buy-only film has
no provider and so no badge to fetch, and a permanent `network_logo_url IS
NULL` gate would re-select those rows on every page load forever. The test pins
that churn is impossible, and that the badge always matches the network the
card shows — taking TMDB's highest-priority provider instead put Amazon's logo
on an HBO Max card, so the lookup is keyed by the row's own network and a
service TMDB doesn't list gets no badge rather than a wrong one. And
`mode: 'movies'`, the movie half of the nightly rotation: a film with no gap
was never fetched again, so its streaming services and rating froze. Pins that
it selects complete films oldest first, skips the TV pass, leaves archived
complete films alone, and brings `streaming_on` and `vote_count` up to date
without touching the member's own fields. Both rotations fill before they
refresh: a row with a gap goes ahead of an older complete one, unless a pass
tried it in the last 20 hours — so a title TMDB has nothing for is retried
nightly instead of holding the front of every round. See
`docs/INVARIANTS.md` §19.

```bash
node scripts/enrich-imdb-status-test.mjs
```

Migration 073's four fields — the title's IMDb id, TMDB's status word, free /
free-with-ads services (`free_on`) and cast characters — all of which arrived
on the detail call enrichment already makes and were dropped. Pins that each is
stored and propagated, that `free_on` keeps asked-and-none (`''`) apart from
never-asked (NULL) the way `streaming_on` does, and that a malformed IMDb id
never reaches a URL. Nothing backfills them, so the part worth pinning is the
order: a **Watching or Next Up** row missing them goes ahead of the age
rotation (behind real gaps), but a hot row that already has them waits its
turn — otherwise a long Watching list would take every nightly slot and the
rest of the library would never refresh.

```bash
node scripts/auth-code-flow-test.mjs
```

The email login/signup code flow on the same harness, with a fake Resend that
refuses reserved domains the way the real one does — the demo account sending
no mail, native signup codes not being gated on a captcha no app can pass, and
a delivery failure surfacing instead of hiding behind `{success: true}`.
Also pins that **the hourly caps actually refuse**, which none of them did
until 2026-09: every window query compared a JavaScript ISO string against a
column carrying SQLite's `datetime('now')` format, and TEXT comparison is
byte-wise, so a same-day row always read as older than the bound and the
`COUNT(*)` came back zero. A cap that has never fired looks identical to a cap
that is working, so the cases assert the 429 and the un-sent message rather
than the count. The per-IP budget now also covers the signup branch, which
wrote a different table and returned before the shared check — one source
could spend the same allowance twice. See `docs/INVARIANTS.md` §25.

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
node scripts/shows-all-search-test.mjs
```

`?q=` on `/api/shows/all` — server-side cross-library search. The parameter is
**additive**: with no `q` the response is exactly the shape it has always been,
so the web and Apple clients that filter locally are untouched. It exists for
Roku, which cannot hold the club library in memory. The properties pinned are
the ones that make it safe to bolt a filter onto an endpoint that already had a
privacy rule: group scoping survives the filter (a stranger's matching row
stays invisible even when their title is typed exactly), the query is **text
rather than a pattern** (a bare `%` returns nothing, not everything, and a real
`%` in a title is still findable), a filtered response is bounded while an
unfiltered one stays unbounded, and a blank `q` reads as "no filter" rather
than "match nothing".

```bash
node scripts/shows-authz-test.mjs
```

Three rules on the `shows` row that a session gate alone doesn't enforce, all
three from the 2026-09 security audit and all three live when it ran. **A row
you may not write is a row you may not read** — `/api/shows/:id/move` scoped
its `UPDATE` by owner and then re-read by primary key alone, handing any
logged-in member somebody else's `notes`, `watching_with`, `recommended_by`
and `added_by` (a login email address); a refused move is now 404 and is
indistinguishable from an unallocated id, while the owner's own move — including
a re-move onto the list the row already sits on — still answers 200. **The
network name is markup by the time anyone reads it**, and `canonicalNetwork()`
echoes what it doesn't recognize, so both writers reject markup rather than
leaving every present and future read path to escape it. **A URL one member
pasted is not evidence for anybody else's row** — `sync-urls` only propagates a
`network_url` whose host canonicalizes to that row's own service, counts every
refusal in `skipped` so a missing domain shows up as a number to fix, and stops
at a copy pinned to a different `tmdb_id`.

```bash
node scripts/spend-limits-test.mjs
```

Per-member daily ceilings on upstream spend (migration 072, `member_spend`),
the URL sweep's gate, and household consent — from the 2026-09 audit, ahead
of the repo going public. The row caps only ever saw paths that insert, so an
edit, the suggest proxy, type-ahead, a duplicate add and the import's Claude
parse all spent on operator keys with no ceiling. Pins that a refusal makes
zero upstream calls, that each path degrades the way its clients already cope
(429 for parse/add/suggest, empty results for search, an edit that saves but
skips the lookup), that a duplicate add is refused before enrichment, that
`/api/sync-urls` is a no-op for a member session and runs for the nightly job
and admins, and that `PUT /api/household` can only narrow your set — nobody
joins a household without redeeming an invite, and the claimed side can see
the claim (`member_of`) and leave it. See `docs/INVARIANTS.md` §28.

```bash
node scripts/mcp-test.mjs
```

The MCP server at `/mcp` and the OAuth 2.1 server in front of it (migration
071, `docs/INVARIANTS.md` §27) — how a member's AI app (Claude, ChatGPT,
Claude Code) reads and changes their lists. **A connection gets the member's
permissions and no more**, because every tool calls the existing `/api`
handler in process with the member's session attached (`actingAs()` in
`_shared/auth.js`) instead of re-implementing the rules. Pins: only an access
token opens `/mcp` (a session cookie is a 401 — the endpoint takes writes);
the consent screen never redirects for an unknown client or unregistered
redirect, refuses a cross-site or wrong-session POST, and shows the real
redirect host beside the client's self-chosen name; PKCE S256 is mandatory and
a replayed code or rotated refresh token revokes the grant; a read-only grant
isn't shown write tools and can't call one; owner-only memos, group scoping,
another member's row and Watching With behave exactly as in the app; even an
admin's token never passes an admin gate. The one exception is the opt-in
`members:admin` scope, which lets an admin add, rate and archive shows on any
member's lists. It is offered only to admins and dropped on demotion, the
target's own rules still apply, and every change goes in `admin_actions`; revoke, ban and the daily caps take
effect on the next call. Connected apps (`/api/connected-apps`) is
cookie-session only, so an AI can't list or cut connections.

```bash
node scripts/admin-query-test.mjs
```

`/api/admin-query` and the `admin_query` MCP tool answer club-wide questions
about shows in one call ("how many unique shows", "how many from 2020 on",
"TV missing genres, per member") instead of one call per member. The
properties pinned are the ones that keep a broad read narrow. **Who:** an
admin session, or an admin's connection holding `members:admin`. The flag
that lets a connection in opens this endpoint and no other admin gate, and
a demoted or disabled admin is refused even while the token still lists the
scope. **What:** a spec over named fields, never SQL, so a quote is data and
an unknown field, op or measure is a 400. Private memos can be counted but
not returned, matched or grouped. Login emails (`added_by`) and private
groups (§13) aren't fields. **The numbers:** `titles` counts one TMDB entry
(or one title TMDB never matched). A per-genre or per-actor breakdown counts
a show once per value, while the totals still count it once. The demo
account and disabled members stay out. A date filter reads both stored
timestamp shapes, where a string comparison would drop `datetime('now')`'s.

```bash
node scripts/admin-fix-tools-test.mjs
```

The admin "fix it for a member" MCP tools: restore, move, delete, refresh,
and `admin_update_show`, which can re-point a show at the right TMDB entry,
rename that copy, change the service or Watch link, or flip TV/movie. Each
check guards against a call that looks like it worked but did the wrong
thing:
- **Identity.** An edit with no TMDB id re-guesses the entry from the title,
  which on a remade title swaps the 1974 original for the 2026 remake. Every
  admin edit carries the row's own pin unless it's changing it, and a
  re-point TMDB can't serve warns rather than succeeding.
- **The member's rows only.** A `show_id` that isn't the named member's is
  refused, and the row is untouched.
- **Memos untouched,** even when a call carries one.
- **A refresh is not an edit.** It stamps `enriched_at`, never `updated_at`,
  and it reaches the archived rows the nightly rotation skips.

Also pins that an add stores genres and the season count from its first
fetch, where they used to wait for the nightly job.

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

`StreamingOnTests` guards the other half of invariant §20 — the client rule
for `streaming_on`. A member's `network` is never overwritten, so the UI states
the difference instead: "Also on Hulu" when their service is one of several,
"Now on Paramount+" when it isn't among them at all, and **nothing** when TMDB
named no service or was never asked. Those last two must read alike — an empty
list means "asked, streams nowhere on a plan", nil means nobody looked, and
claiming the former on the latter asserts a fact never checked.

```bash
cd ShowPickerCore && swift test
```

Unit tests for the shared core (macOS, or Linux with a Swift toolchain — the package is deliberately Foundation-only so CI needs no macOS runner). `SessionScopeTests` guards the rule that session-derived UI state dies with the session.

### Roku tooling

Roku ships no simulator, so `roku/` carries the only build tooling in the repo.
Run these from `roku/` after `npm install`:

```bash
npx bsc --project bsconfig.json
```

BrighterScript validation of the whole channel — every call resolved against
its real component scope, every `onChange` handler checked against the script
that must define it, plus bslint for unused variables and name shadowing. This
runs in CI (the `roku` job). Before it existed, the only way to find a typo or
a missing function was to sideload and read the crash over telnet, so treat a
`bsc` failure as a compile error, because that is what it is. Two rules are
deliberately off: `aa-comma-style` (newline-separated associative arrays are
valid BrightScript and the style this channel is written in) and `no-print`
(the launch line that reports the device tier is load-bearing for testing).

```bash
node sideload.mjs info
node sideload.mjs
```

Device info, then validate-package-install in one command. `info` prints the
model, OS and graphics platform — the quickest way to see which tier
`DeviceProfile()` will pick (`opengl` = modern, anything else = legacy).
A sideload validates first and refuses to install a channel that fails, since
a validation error becomes a crash on the device. Credentials stay out of the
repo exactly like `scripts/asc.mjs`: `~/.roku/host` and `~/.roku/password`, or
`ROKU_HOST` / `ROKU_PASSWORD` for a one-off.

Two of the suites above — `watching-with-test.mjs` and `og-preview-test.mjs` — are **not** wired into `pr-checks.yml`. The pre-push hook runs them anyway, so in practice they run on every push from a configured machine; run them by hand if you've bypassed it.

**`main` is branch-protected (since the repo went public, 2026-09-27).** The six `pr-checks.yml` jobs — `static`, `webauthn`, `authcodes`, `roku`, `listimport`, `swift` — are required, admins included, and nothing reaches `main` except through a PR: no direct pushes, no force pushes. The advisory `review` job is deliberately not required. Merge with `gh pr merge <n> --squash --auto`, which merges once the checks go green; a plain `--squash` is refused while they're pending. Before this the repo was private on GitHub Free, where protection returns 403, and a PR squash-merged in one breath merged before its checks started (a red `static` job landed on `main` that way on 2026-09-19). A job renamed in `pr-checks.yml` must be renamed in the protection settings too, or every PR waits forever on a check that no longer exists.

**The pre-push hook is the fast local gate.** `.githooks/pre-push`, enabled with `git config core.hooksPath .githooks`, runs the static invariants plus every suite needing no network, container or `npm install` — about six seconds — so a failure shows up before the push rather than minutes later in CI. It derives that list from `pr-checks.yml` rather than repeating it, so adding a suite to CI adds it here for free. Bypass a genuinely unrelated push with `git push --no-verify`; don't bypass to skip a failure.

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
- Other workflows: daily D1 backup to Google Drive (`backup.yml`), daily demo reset, scheduled enrichment/vibe/watch-URL fills, and a monthly duplicate-account check (`dupe-check.yml`, emails Patrick — see "Possible duplicates" below) — the scheduled ones call admin endpoints with an `X-Cron-Secret` header.

## Architecture essentials

- **Routing** is Pages Functions file routing (`functions/api/shows/[id].js` → `/api/shows/:id`) layered over `public/_redirects` (SPA fallback `/*` → `/index.html`). The full route/method/auth table is in `docs/ARCHITECTURE.md#routing`.
- **Auth:** passkeys (WebAuthn, iOS/iPad and the web — added from inside a session, never a way to sign up), one-time codes (SMS via Twilio Verify, email via Resend), Sign in with Apple, Sign in with Google (web). Sessions are 30-day HttpOnly cookies; `_shared/auth.js#getSession(request, env)` is the gate every session-protected endpoint calls first. Admin = a session whose member row has `members.is_admin = 1`, checked via `_shared/admin.js#isAdmin()` — admin rights live in the DB, not in code or a secret.
- **Everyone self-enrolls.** Signing up (email code / Apple / Google) is the only way a member row is created, and a new member is immediately a full member. Retired 2026-08 (migration 058): `members.approved` and the held state, the `signup_requests` table, the `/join` form, the operator approval queue, `admin-member-approve`, manual member creation, `SELF_ENROLL`, and `DEMO_APPLE_FALLBACK`. `createMember()` lives in `functions/_shared/create-member.js` and only `_shared/enroll.js` calls it. The matching **Swift cleanup was deferred until the App Store launch, which has since happened** — the iOS app still carries the inert, gracefully-degrading approval queue, signup models and `WelcomeIntroPanel.swift` (`Models.swift`, `API.swift`, `ManageMembersView.swift`, `AdminView.swift`). Nothing blocks removing them now; it simply hasn't been done.
- **Private groups and households are the privacy unit — the club isn't.** Groups (migration 056: `groups`, `group_members`, `group_invites`) and households are joined by invite *link* only; there is no roster you can add somebody from. Every group route re-checks `group_members` and 403s otherwise, and only the creator can delete. Group membership is what scopes vibe reads, `GET /api/shows/all`, `group_watchers` ("Also watching"), Group Trending, the Watch Next recommendation board (migration 065, pull-only — see `docs/INVARIANTS.md` §12a), and who Watching With may name. iPhone/iPad create, invite, join, leave and delete; Apple TV browses groups read-only; the watch has no groups. In Swift, `SwiftUI.Group` collides with the model — spell it `ShowPickerCore.Group` in type position.
- **Three tiers of visibility, not two.** *Logged out:* roster first names, Trending, catalog-level show detail, auth endpoints — deliberately tiny, keep it that way. *Any logged-in member:* another member's list titles, but never their `notes`, `watching_with`, `recommended_by` or `added_by`, which are owner-only because with signup open other members are not all friends (`functions/api/shows.js`). *Group-mates only:* vibe, Also watching, cross-library reads, Watching With links. A new endpoint has to land in one of those three on purpose.
- **Enrichment:** synchronous on insert (`_shared/enrichment.js`, TMDB only — OMDB was retired 2026-07 and `rating` now carries TMDB's audience score), plus background `POST /api/enrich` fired from member pages. Watch links come from Watchmode (`_shared/watch-providers.js`), never pasted by a member. New rows inherit a sibling copy's real `network_url` when one exists.
- **Networks:** `_shared/networks.js` is the source of truth for canonical streaming-service names, aliases, and search-URL templates. All incoming `network` values pass through `canonicalNetwork()`. **The apps don't hardcode the list** — `networkCatalog()` serves it at the public `GET /api/networks`, `ShowPickerCore.NetworkCatalog` is the client model (with a bundled seed and a "never render an empty picker" rule), and `NetworkCatalogStore` caches it. Adding a network is a server-only change that reaches installed apps.
- **Vibe:** 26-trait fingerprints per title (`show_traits`, scored by Claude via `/api/admin-vibe-fill`), matched to 8 clusters in `/api/vibe`, scored against the club's own distribution rather than the trait scale; reads are group-scoped. (`docs/ARCHITECTURE.md` and `README.md` still say 27 traits / 7 clusters — `_shared/vibe-traits.js` and `_shared/vibe-clusters.js` are the counts that are right.)
- **Feature flags via secrets:** `DEMO_LOGIN_EMAIL`/`DEMO_LOGIN_CODE` (App Review demo account with auto-reset), inert when unset. Signup is always open — there is no kill switch and no approval step.
- **Retired 2026-07:** the open cross-member writes (suggest-a-show, share-to-member) — those endpoints still return 410, and the reason they're gone is that anyone could push a row onto anyone. **Watching With (2026-08) is the one cross-member write that exists now**, and it's the shape a new one would have to take: only a group-mate can be named, an existing copy is linked where it already sits rather than moved or duplicated, and unlinking touches only your own row (`_shared/watchers.js`, `scripts/watching-with-test.mjs`). "Picks for You" (`/api/recommendations`) is no longer called by any client but kept for compatibility.
- **The home page does not list members.** `/api/members` is still the roster source for the member-page sidebar, cross-library search, household, and the calendar-feed link — just not the landing page.
- **MCP server (2026-09):** `/mcp` lets a member's AI app act on their lists; OAuth under `/oauth/*` with the club as its own authorization server; `/connect` and `/connected-apps` are the web pages (OAuth is a browser flow — the one deliberate exception to the frozen web). New tools must call an existing handler through `_shared/mcp-tools.js`, never query around it, and account-shaped actions (invite redemption, household, account, passkeys, operator endpoints) stay out. The `members:admin` tools are the one admin power. They add, rate, archive, restore, move, delete, fix (TMDB entry, title, service, Watch link, TV/movie) and refresh another member's shows by running the member tools as that member (INVARIANTS §27). `admin_query` is their read-only companion: it calls `/api/admin-query`, the only admin endpoint a connection can reach, for club-wide stats in one call. See `docs/ARCHITECTURE.md#mcp-server`.
- **Native apps** call the same `/api/*` endpoints; shared models live in the repo-root `ShowPickerCore` package. tvOS is view-only. watchOS gets its session from the iPhone via WatchConnectivity. iOS has offline caching + a queued-write sync layer (`ios/ShowPickerIOS/Offline/`).

## Non-obvious conventions (violating these breaks features)

- **Member-facing reads use `shows_v` and `actors_v`; writes use `shows` and `actors`.** The view
  (migration 077) shows TMDB's name and the shared details from `titles`. A
  new read that shows a member anything selects `FROM shows_v`. A writer
  holding a TMDB payload passes it to `writeTitle()` (with
  `titleFieldsFromEnrichment()`), or members keep seeing the old details:
  copies can only fill the shared row (`syncTitle()`, the nightly rebuild),
  never overwrite it. A column added to `shows` must be
  added to `SHOWS_COLUMNS` in `_shared/titles.js`, and the view regenerated
  in a migration; `titles-test.mjs` fails until both are done.
- **`updated_at` is sacred.** Only member-initiated writes bump it; enrichment writes `enriched_at` instead. `updated_at != created_at` is how the app distinguishes member intent from background jobs.
- **Seeded rows have NULL `created_at`/`updated_at` and `added_by='seed'`.** The "seed-only member" check depends on exactly that signature.
- **Network URLs containing `/search`, `/s?`, or `/?q=` are placeholders**, not real deep links — the frontend, sync-urls, and calendar feed all treat them as missing.
- **Fresh versus existing databases.** `schema.sql` creates the current complete schema for a new database. `migrations/` upgrades existing databases only; never apply the historical migration set after loading `schema.sql`.
- **Secrets are set with `printf`, never `echo`** (trailing newlines break runtime API calls).
- **Delete feature branches once merged and live** — local and remote. In the Claude-Code-on-the-web environment the git proxy rejects remote branch deletion (403); the user deletes merged branches themselves from GitHub's post-merge screen.

## Working preferences

- **The web member app is back (restored 2026-08), and it is a full
  platform again (2026-10).** `showpicker.club/` is the app again — member slugs like `/patrick`
  render in a browser — and the App Store pitch lives at `/download`. Web
  sign-in (email/phone code, Apple, Google) works again. **The catch-all in
  `public/_redirects` can only be `/*  /index.html  200`**; pointing it at any
  other page 308-loops the entire site, which is how production went down on
  2026-08-13 (see `docs/ARCHITECTURE.md#the-catch-all-can-only-point-at-indexhtml`).
  Verify routing changes against `wrangler pages dev` before merging — a local
  emulator reproduces this exactly, and the post-deploy smoke test is a much
  more expensive way to find out.

  **The web keeps parity with iPhone/iPad (the freeze ended 2026-10-03).**
  Patrick's words: "No more leaving it behind." A member-facing feature that
  ships on iPhone/iPad ships on the web in the same PR, or in a follow-up PR
  named in the first one — not "later". The exceptions are things a browser
  can't do or that were retired on purpose (widgets, the share extension,
  shake-to-pick, the watch hand-off, offline/PWA — retired 2026-08). The
  freeze-era backlog is being closed in a series of PRs; until it's done,
  `docs/PRODUCT.md#web-app-status` lists what's still missing. The show card
  is one renderer (`public/show-renderer.js`) shared by `index.html` and
  `groups.html` — change it there, not per page.

- **Feature requests still name their platforms.** The product ships on
  iPhone/iPad, Mac (Catalyst — it runs the iPad split view and gets what iPad
  gets), tvOS and watchOS, under one universal App Store listing, plus a Roku
  channel in the Roku Channel Store. When a feature
  is requested, state which get it and which don't (tvOS is view-only, watch is
  read-only and has no groups at all) — parity gaps between the Apple targets
  are still expensive to rediscover, and the web is a further surface to name
  now that it's back, and so is Roku. There is no in-app What's New — release
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
  goes: commit → push → open the PR → `gh pr merge --squash --auto` → tell
  the user it merges into `main` once checks pass, ready to pull into Xcode. No "want me to merge?" round trip, and
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
  doesn't reach other testers, and it touches nothing Apple reviews.

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

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `turnepf/Show-Picker-Club`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels, used under their default names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
