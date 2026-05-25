# Show Picker Club

A shared TV-show and movie tracker for a small club. Each member maintains four ranked lists (Watching, Waiting, Recommending, Up Next); the home page surfaces what everyone is watching, suggests picks based on neighbor overlap, and exposes a per-member iCalendar feed for upcoming premiere dates.

Live at [showpicker.club](https://showpicker.club).

- **Product overview & user flows:** [`docs/PRODUCT.md`](docs/PRODUCT.md)
- **Architecture, data model, endpoints:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## At a glance

- **Multi-tenant.** One deployment, many members. Each member is a slug (`/whitt`, `/patrick`) with their own lists and 4-digit login code.
- **Auto-enriched.** OMDB supplies IMDB ratings and canonical titles; TMDB supplies cast, next-season dates, finale dates, series-ended flags, and genres.
- **Social.** Suggest a show to another member, share a show across lists, see your closest taste-match, and get "Picks for you" computed from neighbors.
- **Vibe.** `/vibe` profiles each member's taste across 27 trait dimensions and assigns one of seven cluster identities.
- **Calendar feed.** `webcal://showpicker.club/calendar/<slug>.ics` keeps upcoming premieres and finales in Apple Calendar / Google Calendar / Fantastical.
- **PWA.** Installable to home screen.

## Tech stack

- **Frontend:** Static HTML + vanilla JS, no build step. Service worker for PWA support.
- **API:** Cloudflare Pages Functions (file-system-routed JavaScript handlers).
- **Database:** Cloudflare D1 (SQLite at the edge).
- **Enrichment:** OMDB API + TMDB API.
- **Vibe trait scoring:** Claude API (Sonnet 4.6 with prompt caching), admin-triggered batch only.
- **Auth:** Per-member 4-digit codes, HttpOnly session cookies, 30-day expiry.

## Project structure

Only `public/` (static assets) and `functions/` (Pages Functions) are deployed. Everything else — `schema.sql`, `docs/`, workflow files, backups — stays out of the build output dir so it can't be served.

```
├── public/                     Deployed static assets
│   ├── index.html              Landing + per-member SPA
│   ├── vibe.html               Member taste profiles
│   ├── reporting.html          Admin metrics (auth-gated)
│   ├── setup.html              Admin: create new member (secret-gated)
│   ├── url-cleanup.html        Admin: fix missing network URLs (secret-gated)
│   ├── vibe-admin.html         Admin: batch-score trait vectors (secret-gated)
│   ├── manifest.json           PWA manifest
│   ├── sw.js                   Service worker
│   ├── _headers                Security headers (CSP, HSTS, etc.)
│   └── _redirects              SPA fallback + legacy slug rewrites
├── functions/
│   ├── api/                    All /api/* endpoints
│   ├── auth/                   Login, logout, session check
│   ├── calendar/[slug].js      Per-member iCalendar feed
│   └── _shared/                Reusable helpers (auth, enrichment, vibe traits, vibe clusters)
├── docs/                       Product + architecture documentation
├── schema.sql                  Starter DB schema (not deployed)
├── wrangler.toml               Cloudflare config
└── .github/workflows/
    ├── deploy.yml              Push-to-main → Cloudflare Pages
    └── backup.yml              Daily D1 dump → Google Drive
```

Routing is documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Setup

### Prerequisites

- A [Cloudflare](https://cloudflare.com) account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- A free [OMDB API key](http://www.omdbapi.com/apikey.aspx)
- A free [TMDB API key](https://www.themoviedb.org/settings/api)
- *(Optional, for vibe trait scoring)* an [Anthropic API key](https://console.anthropic.com/)

### Steps

1. **Clone and create the D1 database.**
   ```bash
   git clone https://github.com/turnepf/Shows.git
   cd Shows
   wrangler d1 create shows-db
   ```
   Copy the returned `database_id` into `wrangler.toml`.

2. **Apply the schema.** Note that `schema.sql` is the starter shape; columns and tables added over time (`added_by`, `enriched_at`, `genres`, `sessions.last_seen_at`, etc.) are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#database). New deployments should apply the schema and then any subsequent ALTERs from that doc.
   ```bash
   wrangler d1 execute shows-db --remote --file=schema.sql
   ```

3. **Seed at least one member + login code.** New members are usually created via the admin `/setup` page once you're deployed; bootstrap by hand the first time.
   ```sql
   INSERT INTO members (slug, name, first_name) VALUES ('patrick', 'Patrick Turner', 'Patrick');
   INSERT INTO member_codes (member_slug, code, editor_name) VALUES ('patrick', '1234', 'patrick@example.com');
   ```

4. **Set API key secrets.** Use `printf` (not `echo`) so trailing newlines don't break runtime calls.
   ```bash
   printf "your-omdb-key"    | wrangler pages secret put OMDB_API_KEY    --project-name shows
   printf "your-tmdb-key"    | wrangler pages secret put TMDB_API_KEY    --project-name shows
   printf "your-tmdb-token"  | wrangler pages secret put TMDB_TOKEN      --project-name shows
   # Optional — only if you wire up the corresponding features:
   printf "sk-ant-..."       | wrangler pages secret put ANTHROPIC_API_KEY --project-name shows  # /vibe-admin trait scoring
   printf "your-watchmode"   | wrangler pages secret put WATCHMODE_API_KEY --project-name shows  # auto URL deep-links
   printf "ACxxxx"           | wrangler pages secret put TWILIO_ACCOUNT_SID --project-name shows # SMS
   printf "your-twilio-tok"  | wrangler pages secret put TWILIO_AUTH_TOKEN --project-name shows
   printf "+1336..."         | wrangler pages secret put TWILIO_PHONE_NUMBER --project-name shows
   printf "MGxxxx"           | wrangler pages secret put TWILIO_MESSAGING_SERVICE_SID --project-name shows
   ```

5. **Create the Pages project and do the first deploy.**
   ```bash
   wrangler pages project create shows
   wrangler pages deploy public --project-name shows
   ```
   `pages_build_output_dir = "public"` in `wrangler.toml` ensures only `public/` is uploaded. Functions at the repo root are picked up automatically. **Never pass `.` as the deploy directory** — it would publish secrets, backups, and `.env` files.

6. **(Optional) Add a custom domain** via the Cloudflare dashboard → Pages → your project → Custom domains.

## Deploys and backups

- **Production deploy** is automatic on push to `main` via `.github/workflows/deploy.yml`. The workflow runs `wrangler pages deploy`, then probes a few endpoints to confirm secrets aren't leaking and auth gates are still in place.
- **Daily D1 backup** at 03:00 UTC via `.github/workflows/backup.yml`. Dumps the full SQL to Google Drive (`gdrive:Shows-Backups/`), prunes backups older than 30 days, and prunes `failed_logins` rows older than 7 days from D1.

Both workflows require these GitHub Actions secrets:

| Secret                  | Used by              | Purpose                                              |
|-------------------------|----------------------|------------------------------------------------------|
| `CLOUDFLARE_API_TOKEN`  | deploy.yml, backup.yml | Pages:Edit + D1:Edit on the account               |
| `CLOUDFLARE_ACCOUNT_ID` | deploy.yml, backup.yml | The account ID                                    |
| `RCLONE_CONF`           | backup.yml             | Full `~/.config/rclone/rclone.conf` with gdrive token |

## License

MIT
