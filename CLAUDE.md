# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Show Picker Club — a multi-tenant TV-show/movie tracker for a small private club, live at [showpicker.club](https://showpicker.club). Each member (`/patrick`, `/whitt`) keeps four ranked lists (Watching, Awaiting, Loved, Next Up). Web frontend + Cloudflare backend live in this repo alongside native SwiftUI apps for iOS, tvOS, and watchOS.

**Stack:** Static HTML + vanilla JS (no framework, no build step) in `public/`; Cloudflare Pages Functions (file-system-routed JS) in `functions/`; Cloudflare D1 (SQLite) with the `DB` binding from `wrangler.toml`; OMDB + TMDB for enrichment; Claude API for vibe trait scoring; Twilio/Resend for login codes.

## Documentation map

Read these before making non-trivial changes — they are detailed and current:

- **`docs/ARCHITECTURE.md`** — the implementation source of truth: full DB schema (production has columns beyond `schema.sql`), complete route/auth table, enrichment pipeline, vibe system, calendar feed, CI workflows, and a "Conventions that aren't obvious" section.
- **`docs/PRODUCT.md`** — product behavior and user-facing rules (the four lists, quick actions, auth flows).
- **`docs/APP_STORE_SUBMISSION.md`** — Apple review/submission checklist.
- **`README.md`** — setup from scratch, secrets list, deploy/backup overview.
- **`ios/README.md`** / **`tvos/README.md`** — building, TestFlight, share extension, offline support.
- **`DESIGN.md`** + **`.impeccable/design.json`** — visual design system (OKLCH palette, list colors).

When you change behavior that these docs describe, update the docs in the same PR.

## Repo layout and what actually deploys

Only `public/` (static assets) and `functions/` (Pages Functions) are deployed — `pages_build_output_dir = "public"` in `wrangler.toml`. Everything else (`schema.sql`, `migrations/`, `docs/`, workflows) stays out of the served output. **Never pass `.` as a deploy directory.**

```
public/            Deployed static pages: index.html (SPA), vibe, subscriptions,
                   members/reporting/url-cleanup/vibe-admin (admin tools; /admin 301s to /members),
                   sw.js + manifest.json (PWA), _headers (CSP), _redirects (SPA fallback)
functions/
├── api/           /api/* endpoints (one file per route; [param].js for dynamic segments)
├── auth/          login, logout, request-code, apple, google, enroll, check, config
├── calendar/      [slug].js — per-member iCalendar feed (?key=<calendar_token>)
└── _shared/       auth, admin, enrichment, networks, sms, email, vibe-*, demo, enroll…
migrations/        Numbered D1 migrations (NOT auto-applied — see below)
schema.sql         Starter schema only; docs/ARCHITECTURE.md describes the real shape
ShowPickerCore/    Shared Swift package (models) used by all Apple targets
ios/  tvos/        SwiftUI apps; open ShowPickerClub.xcworkspace at the repo root
scripts/           apply-migrations.sh, member-engagement.sh (operator tools)
```

## Commands

There is **no package.json, linter, or JS test suite** — the web side has no build step. Verification is by reading, local preview, and the post-deploy smoke test.

Local preview of the site + Functions (uses a local D1 unless you point it at remote):

```bash
wrangler pages dev public
```

Run a migration against production D1 (requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`; usually done via the "Apply D1 migration" GitHub Action instead):

```bash
wrangler d1 execute shows-db --remote --file=migrations/NNN_name.sql
```

`scripts/apply-migrations.sh` applies all pending migrations, tracked in a self-owned `schema_migrations` table (first run baselines without executing).

The only automated tests are Swift (`ShareTitleParser` for the iOS share extension), runnable on a Mac only:

```bash
xcodebuild test -project ios/ShowPickerIOS.xcodeproj -scheme ShowPickerShareExtensionTests -destination 'platform=iOS Simulator,name=iPhone 16'
```

Apple builds: open `ShowPickerClub.xcworkspace` in Xcode (macOS). iOS + tvOS ship as one universal app (bundle id `net.patrickturner.showpickerios`); the build number is a single project-level `CURRENT_PROJECT_VERSION` shared by all targets — bump that one value before archiving.

## Deploys, migrations, and CI

- **Push to `main` deploys production automatically** (`.github/workflows/deploy.yml`), then smoke-tests: `/.env` must serve the SPA shell, security headers must be present, and auth-gated endpoints must 401.
- **Migrations are NOT applied on deploy.** After merging a migration the Functions depend on, run the "Apply D1 migration" workflow (Actions tab → pick the file) *before or with* the deploy, or the deployed code references columns production doesn't have.
- Other workflows: daily D1 backup to Google Drive (`backup.yml`), hourly demo reset, monthly dormant digest, and scheduled enrichment/vibe/watch-URL fills — the scheduled ones call admin endpoints with an `X-Cron-Secret` header.

## Architecture essentials

- **Routing** is Pages Functions file routing (`functions/api/shows/[id].js` → `/api/shows/:id`) layered over `public/_redirects` (SPA fallback `/*` → `/index.html`). The full route/method/auth table is in `docs/ARCHITECTURE.md#routing`.
- **Auth:** one-time codes (SMS via Twilio Verify, email via Resend), Sign in with Apple, Sign in with Google (web). Sessions are 30-day HttpOnly cookies; `_shared/auth.js#getSession(request, env)` is the gate every session-protected endpoint calls first. Admin = a session whose member row has `members.is_admin = 1`, checked via `_shared/admin.js#isAdmin()` — admin rights live in the DB, not in code or a secret.
- **Public surface is deliberately tiny** (roster first names, Trending, catalog-level show detail, auth endpoints). Everything derived from members' libraries requires a session. Keep it that way.
- **Enrichment:** synchronous on insert (`_shared/enrichment.js`, TMDB preferred, OMDB fallback), plus background `POST /api/enrich` fired from member pages. New rows inherit a sibling copy's real `network_url` when one exists.
- **Networks:** `_shared/networks.js` is the source of truth for canonical streaming-service names, aliases, and search-URL templates. All incoming `network` values pass through `canonicalNetwork()`.
- **Vibe:** 27-trait fingerprints per title (`show_traits`, scored by Claude via `/api/admin-vibe-fill`), matched to 7 clusters in `/api/vibe`.
- **Feature flags via secrets:** `SELF_ENROLL` (self-signup, off = invite-only), `DEMO_LOGIN_EMAIL`/`DEMO_LOGIN_CODE`/`DEMO_APPLE_FALLBACK` (App Review demo account with auto-reset). All inert when unset.
- **Retired 2026-07:** all cross-member writes (suggest-a-show, share-to-member) — those endpoints return 410. "Picks for You" (`/api/recommendations`) is no longer called by any client but kept for compatibility.
- **Native apps** call the same `/api/*` endpoints; shared models live in the repo-root `ShowPickerCore` package. tvOS is view-only. watchOS gets its session from the iPhone via WatchConnectivity. iOS has offline caching + a queued-write sync layer (`ios/ShowPickerIOS/Offline/`).

## Non-obvious conventions (violating these breaks features)

- **`updated_at` is sacred.** Only member-initiated writes bump it; enrichment writes `enriched_at` instead. `updated_at != created_at` is how the app distinguishes member intent from background jobs.
- **Seeded rows have NULL `created_at`/`updated_at` and `added_by='seed'`.** The "seed-only member" check depends on exactly that signature.
- **Network URLs containing `/search`, `/s?`, or `/?q=` are placeholders**, not real deep links — the frontend, sync-urls, and calendar feed all treat them as missing.
- **`schema.sql` is not the real schema.** Production D1 has columns and tables added by `migrations/`; `docs/ARCHITECTURE.md#database` is the authoritative description.
- **Secrets are set with `printf`, never `echo`** (trailing newlines break runtime API calls).
- **Slug `dorothy` 301s to `whitt`** and the member displays as Dorothy; don't "fix" either side.
- **Delete feature branches once merged and live** — local and remote. In the Claude-Code-on-the-web environment the git proxy rejects remote branch deletion (403); the user deletes merged branches themselves from GitHub's post-merge screen.

## Working preferences

- **Every feature request is a cross-platform conversation.** The product
  ships on web, iOS/iPad, tvOS, and watchOS. When a new feature or change is
  requested, always enumerate all platforms and state explicitly which get
  the feature and which don't (and why — e.g. tvOS is view-only, watch is
  read-only). Never silently implement for one platform; parity gaps that
  slip through are expensive to rediscover. What's New content is centralized
  in `public/whats-new.json` — update it (with platform tags) when shipping
  member-visible features.

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
- **End every completed task with an explicit close-out.** When the work is
  done, don't wait to be asked — state plainly: what shipped, anything still
  pending on the user (merges, migrations, secrets, verifications), whether
  branches are cleaned up, and whether the session is safe to archive. If
  something is not done, say what and why instead of going quiet.
- **No branch-deletion links in close-outs.** GitHub's post-merge screen
  already offers the branch delete, so don't paste `branches/all?query=…`
  links or remind about deleting merged branches — just say whether the
  branch is merged yet.
