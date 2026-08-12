# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Show Picker Club — a multi-tenant TV-show/movie tracker for a small private club, live at [showpicker.club](https://showpicker.club). Each member (`/patrick`, `/whitt`) keeps four ranked lists (Watching, Awaiting, Loved, Next Up). The native SwiftUI apps for iOS, tvOS and watchOS are the product members actually use; the web frontend is frozen (see `docs/PRODUCT.md#web-app-status`) and the Cloudflare backend in this repo serves both.

**Stack:** Static HTML + vanilla JS (no framework, no build step) in `public/`; Cloudflare Pages Functions (file-system-routed JS) in `functions/`; Cloudflare D1 (SQLite) with the `DB` binding from `wrangler.toml`; OMDB + TMDB for enrichment; Claude API for vibe trait scoring; Twilio/Resend for login codes.

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
public/            Deployed static pages — marketing only since the 2026-08
                   teardown: index.html (pitch + Trending + App Store link),
                   privacy/terms/sms, styles.css, favicon.svg,
                   sw.js (tombstone — the PWA was retired 2026-08; don't delete
                   the file, see ARCHITECTURE.md), _headers (CSP), _redirects
archive/web/       The retired web member app + admin tools. Moved here, NOT
                   deleted, and outside the Pages build output so none of it
                   deploys. See ARCHITECTURE.md#frontend-pages.
functions/
├── api/           /api/* endpoints (one file per route; [param].js for dynamic segments)
├── auth/          login, logout, request-code, apple, google, enroll, check, config
├── calendar/      [slug].js — per-member iCalendar feed (?key=<calendar_token>)
└── _shared/       auth, admin, enrichment, networks, sms, email, vibe-*, demo, enroll…
migrations/        Numbered D1 upgrades (auto-applied on deploy when pending)
schema.sql         Complete schema for fresh databases
ShowPickerCore/    Shared Swift package (models) used by all Apple targets
ios/  tvos/        SwiftUI apps; open ShowPickerClub.xcworkspace at the repo root
scripts/           apply-migrations.sh, member-engagement.sh, vibe-diagnose.mjs
                   (operator tools)
```

## Commands

There is **no package.json or linter** — the web side has no build step. Verification is by reading, local preview, and four checks that run in CI and also run fine from a laptop:

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
`?member=<slug>` returns that member and nobody else.

```bash
node scripts/reporting-platform-test.mjs
```

`/api/reporting`'s admin gate and the unit its platform breakdown is counted
in. It counts **people, not sessions**: four iPhone sessions across two members
read as 2, a member on three platforms is 1 on each row (so the rows don't sum
to Active members), and a member-less tvOS session still counts as one device
rather than collapsing into a phantom person.

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

The rules all three enforce are written down in `docs/INVARIANTS.md`; adding a rule there also extends the advisory PR review.

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
- **Everyone self-enrolls.** Signing up (email code / Apple / Google) is the only way a member row is created, and a new member is immediately a full member. Retired 2026-08 (migration 058): `members.approved` and the held state, the `signup_requests` table, the `/join` form, the operator approval queue, `admin-member-approve`, manual member creation, `SELF_ENROLL`, and `DEMO_APPLE_FALLBACK`. `createMember()` lives in `functions/_shared/create-member.js` and only `_shared/enroll.js` calls it. **The matching Swift cleanup is deferred until after the App Store launch** — the iOS app keeps its (now inert, gracefully-degrading) approval queue, signup models, and `WelcomeIntroPanel.swift` so the launch archive stays on known-good code. Don't touch the Apple targets for this until those apps have shipped.
- **Public surface is deliberately tiny** (roster first names, Trending, catalog-level show detail, auth endpoints). Everything derived from members' libraries requires a session. Keep it that way.
- **Enrichment:** synchronous on insert (`_shared/enrichment.js`, TMDB preferred, OMDB fallback), plus background `POST /api/enrich` fired from member pages. New rows inherit a sibling copy's real `network_url` when one exists.
- **Networks:** `_shared/networks.js` is the source of truth for canonical streaming-service names, aliases, and search-URL templates. All incoming `network` values pass through `canonicalNetwork()`.
- **Vibe:** 27-trait fingerprints per title (`show_traits`, scored by Claude via `/api/admin-vibe-fill`), matched to 7 clusters in `/api/vibe`.
- **Feature flags via secrets:** `DEMO_LOGIN_EMAIL`/`DEMO_LOGIN_CODE` (App Review demo account with auto-reset), inert when unset. Signup is always open — there is no kill switch and no approval step.
- **Retired 2026-07:** all cross-member writes (suggest-a-show, share-to-member) — those endpoints return 410. "Picks for You" (`/api/recommendations`) is no longer called by any client but kept for compatibility.
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

- **The web member app is gone (2026-08). Build features for the Apple apps.**
  `showpicker.club` is a marketing site now — pitch, Trending shelf, App Store
  link — and every retired path 301s to it. New member-facing features go to
  iOS/iPad; do **not** build them for the web, and don't offer to. What still
  gets worked on there: security fixes, anything actually broken, the `/api/*`
  endpoints (the apps depend on them), and the marketing page itself. The old
  SPA and the four admin tools live in `archive/web/` — moved, not deleted, so
  restoring any of it is a `git mv` plus a `_redirects` edit. There is no web
  sign-in any more; the login UI was part of the SPA. See
  `docs/PRODUCT.md#web-app-status` and `docs/ARCHITECTURE.md#frontend-pages`.

- **Feature requests still name their platforms.** The product ships on
  iOS/iPad, tvOS, and watchOS. When a feature is requested, state which get it
  and which don't (tvOS is view-only, watch is read-only) — parity gaps between
  the Apple targets are still expensive to rediscover. Just don't add "and the
  web" to that list unless asked. There is no in-app What's New — release
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
