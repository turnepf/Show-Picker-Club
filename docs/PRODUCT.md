# Show Picker Club — Product

This is the product-level reference for what Show Picker Club does, who it's for, the major flows, and the rules that shape the user experience. For implementation details, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## What it is

A shared tracker for a small private TV/movie club. Each member maintains their own four ranked lists. The home page combines those into a club view: most-watched shows, member browsing, cross-library search. Logged-in members get personalized recommendations and a calendar feed of upcoming premieres.

## Who it's for

A closed group of friends and family (~20 members in production). Everyone has a member slug (e.g. `/whitt`), signs in with a one-time code (text/email) or Sign in with Apple, and has full edit rights over their own lists. No public registration.

## The four lists

Every member has exactly four lists. They are intentionally narrow and force a clear judgement:

| List           | What it means                                              | Color  |
|----------------|------------------------------------------------------------|--------|
| **Watching**   | Currently watching a season or movie.                      | Green  |
| **Waiting**    | Finished the current season; waiting on the next.          | Blue   |
| **Recommending** | Watched and would recommend; happy to talk about it.    | Purple |
| **Up Next**    | Heard about it, want to watch — not committed yet.         | Orange |

Shows can also be **Archived** (hidden from lists, kept in DB for de-dupe and history).

### Quick actions

The Watching list has one-tap promotions to keep the lists honest:

- **Watched it →** moves to Recommending.
- **Season done →** moves to Waiting.

Waiting and Recommending each have a **back to Watching** button. Up Next has **Start watching**.

## Show data

A show row holds: title, network, network URL (deep link to the show on that network's site), recommended-by attribution, rating (IMDB), notes, movie flag, series-complete flag, watching-with field, plus auto-enriched genres, cast, next-season premiere date, and finale date.

Members only fill in title, network, and recommender — the rest is automatic. OMDB returns the canonical title + IMDB rating + cast. TMDB returns next-season dates, finale dates, the "ended" flag, and genres. Network URL is sourced via Watchmode (deep links straight to the show on the streaming service) on insert and edit, in the background — members never paste a URL. If Watchmode can't resolve a title or network, the row falls back to the network's search page until an admin fills it in via `/url-cleanup`.

The network dropdown lists only the modern streaming-service brand (HBO Max, Paramount+, Peacock, Hulu, Disney+, Apple TV+, Amazon Prime Video, Netflix, Starz, AMC+, Food Network, Fox) with parenthetical aliases that name the sub-brands they carry (e.g. "Paramount+ (including CBS, MTV, Comedy Central, Nickelodeon, BET, Showtime)"). If a member ever submits an old or sub-brand name like `HBO`, `NBC`, `Bravo`, or `FX` — via API or by pasting — it gets folded to the canonical streamer on save. See [`ARCHITECTURE.md`](ARCHITECTURE.md#networks) for the full mapping.

## Authentication

A member logs in with a one-time code sent to their phone (SMS via Twilio Verify) or email (via Resend, validated against `login_otps`), or with Sign in with Apple (iOS app). All paths resolve to an existing member and set a 30-day HttpOnly session cookie. There are no static per-member passwords.

Failed logins are rate-limited: 5 attempts per IP in any 15-minute window returns a 429 with `Retry-After`. Failed-login rows are pruned daily.

Anyone can browse any member's lists without logging in. Only the logged-in member can edit their own list. Suggesting a show to another member also requires a session.

## Home page

The landing page (`/`) shows:

1. **My Shows link** — appears for logged-in members, jumps to their own page.
2. **What Members Are Watching** — top 10 shows by overlap across the club's Watching lists. Tap + to add to your own list. Seed-only members are excluded from this calculation.
3. **Members** — the six members with the longest Watching lists are featured at the top (Waiting count is the tiebreaker). A "Browse all members ▾" disclosure underneath reveals the rest of the roster, alphabetized, so anyone is reachable. The point of the featured row is to lead with members who actually have something on their list worth looking at.
4. **Search all libraries** — opens a modal that searches every active show across every member by title or actor. Each result shows the owning member and the list it's on; logged-in users can tap + to add to their own list.
5. **What's New** — a dated changelog of recent features (collapsed by default after a few entries).

## Member page (`/<slug>`)

Tabs across the top for the four lists. Each show row collapses to one line (title, network, rating, badges), and tapping the title expands it to show genre, cast, recommender, dates, watching-with, and notes.

Two pieces of metadata are **always visible** under the row (not collapsed):

- **Waiting list:** "Next up: 5/9 – 6/15" — premiere date (and finale if known). The label is "Next up" rather than "Next season" because midseason episode dates can also appear here.
- **Up Next list:** "Recommended by Whitt" — surfaces attribution without an expand.

### Up Next — "Picks for you"

Logged-in members viewing their own Up Next list see a "★ Picks for you" section **above** the actual list (placed there in May 2026 because picks were getting buried). The picks are computed server-side and explained in [`ARCHITECTURE.md`](ARCHITECTURE.md#recommendations).

Each pick has a + button to one-tap-add to your Up Next list. After being added, it disappears from the picks section.

### Suggest a show

Any logged-in member can suggest a show to any other member via the **Suggest a Show for ...** button at the bottom of any list. The suggestion lands on that member's Up Next list with the recommender attribution pre-filled and "Suggested · &lt;your notes&gt;" prepended to the notes.

### Share to another list / member

The **+** button on any show row opens a share modal. The original member can copy the show to their own other list (rare) or to any other member's Up Next. The whole show — including rating, network link, cast, and notes — carries over.

### Edit, archive

Logged in as yourself, every row gets Edit and Archive buttons inline. Editing re-runs enrichment if the title changes. Archive sets `archived=1`; archived shows are still searchable but don't appear in lists, popular, picks, recommendations, or vibe.

## Sort and toggle controls

Footer of each list:

- **Sort:** by Rating (default), A–Z, or Date Added.
- **Toggle pills:** Ratings, Networks, Recommended By, Dates, Notes, Genres — each can be hidden globally.

## Search

Two search experiences:

- **Per-member search** (button in the member-page header) — searches *that member's* library, including archived rows. Title and actor filters.
- **Cross-library search** (button below the members list on the landing page) — searches every active show across every member. Each result shows the owning member and list. Logged-in users can add picks to their own list directly.

Both use the same modal in two modes.

## Calendar feed

Each member has a personal iCal feed at:

```
https://showpicker.club/calendar/<slug>.ics       (HTTPS for Google / Fantastical)
webcal://showpicker.club/calendar/<slug>.ics      (Subscribe in Apple Calendar)
```

The feed contains one all-day event per known **next-season premiere date** and per known **season finale date** for shows on that member's Watching and Waiting lists. Event titles are `<Show> on <Network>` (no "next season" wording because midseason dates also appear). Event URL deep-links to the show on the network's site (when known); event description includes the recommender and a link back to the member's app page.

Calendar apps re-fetch the feed on their own schedule (Apple Calendar typically every hour; the feed sets a 24-hour `REFRESH-INTERVAL` hint).

A "📅 Calendar feed" link in each member-page footer opens the `webcal://` URL, which Apple Calendar recognizes as a one-tap subscribe.

## Subscriptions (`/subscriptions`)

A private audit that helps a member trim streaming spend, reached from a "💸 Subscriptions" link on their own member page (logged-in members only).

The page reads the shows already on your lists, groups them by streaming service, and gives each service a plain-English call:

- **Keep** — you're actively watching something there right now.
- **Pause & save** — nothing to watch this minute, but a show you're waiting on has a known next-season date. It tells you the month to **cancel now and resubscribe** (e.g. "resubscribe around Oct 2026, when Tulsa King returns").
- **Pause (renewal TBA)** — you're waiting on a renewal with no announced date yet.
- **Start or skip** — shows queued up there but nothing started.
- **Cancel candidate** — every show there is finished; nothing pulls you back.

The top of the page sums it up: services tracked, estimated monthly spend, and roughly how much you could save right now. Each service shows a "Why?" expander listing the exact shows behind its verdict, so the recommendation is never a black box.

You stay in control: every service has a **Subscribed / Paused / Cancelled** toggle (the verdict is only a suggestion), an editable monthly price (pre-filled with a sensible default per service), and — for paused services — a **resubscribe date**. Setting that date drops a "Resubscribe to <Service>" reminder onto your [calendar feed](#calendar-feed), right next to your premiere and finale dates. You can also **add a service** you pay for that has no tracked shows (a sports or music package) so the monthly total reflects everything.

Prices are editable defaults — approximate US standard-plan rates that each member can correct to what they actually pay. Implementation in [`ARCHITECTURE.md`](ARCHITECTURE.md#subscription-audit).

## Vibe (`/vibe`)

A taste-profile view. Pick any member from the dropdown to see:

- **Cluster identity** — one of seven personas (Warm Comfort Viewer, Prestige Drama Loyalist, Dark Complexity Seeker, Satirical Cynic, Power Game Watcher, Chaos Goblin, Curious Omnivore) with a one-line tagline.
- **Top and bottom trait signals** — the dimensions where they index highest and lowest vs the club mean, with little bars.
- **Cluster blend** — top three clusters they pattern-match against, with similarity scores.
- **Balance reads** — warmth vs darkness, cynicism vs optimism, etc.
- **Aligned shows** — picks from their own library that score highest on their dominant traits, grouped by list. One-tap add to your own Up Next.

The cluster algorithm and trait list are detailed in [`ARCHITECTURE.md`](ARCHITECTURE.md#vibe-system).

Vibe profiles require a logged-in session — anyone in the club can view any other member's vibe, but the page prompts a login if you visit it logged-out.

## Suggestions to non-members

Not currently supported — the suggest button is only available to logged-in members. Outside guests would need to be added as a member first.

## Reporting (`/reporting`, auth-required)

A small operator dashboard:

- **DAU / WAU / MAU** — distinct sessions that have pinged within each window (1 / 7 / 30 days).
- **New, edited, archived counts** — per show, in day/week/month/all-time windows.
- **Totals** — members, active shows, archived shows, shows per list.
- **Top networks** and **top shared titles** across the club.

Recently removed: "Most active members," "Recently archived," "Seed-only members," "Member activity." The data sources for those queries still exist if they need to be restored.

## Admin tools

Three secret-protected admin pages (all require the `ADMIN_SECRET` value to be entered in the page):

- **/setup** — create a new member. Enter a name plus the phone and/or email they'll receive login codes at; the page generates a slug, picks 8 seed shows from highly-rated club picks (2 per list), and copies them in as `added_by='seed'` rows. The new member sees these on first login.
- **/url-cleanup** — queue of shows missing a real network URL (still on a generic search link). Operator can paste a deep link; the page pushes it to every member's copy of that show.
- **/vibe-admin** — batch-score show traits using Claude. Picks shows missing a `show_traits` row, sends each title to Claude with a calibration prompt that asks for 27 trait scores (0–1), writes the result back. Used to backfill the trait data that powers Vibe.

There is no admin role in the session model — admin actions are gated purely by knowing the `ADMIN_SECRET`.

## Member lifecycle

- **Created** by an operator via `/setup` (or by hand-INSERT during bootstrap).
- **Seeded** with 8 shows automatically (2 per list, drawn from the existing club's highly-rated picks).
- **Logs in** for the first time with a one-time code (text or email), or Sign in with Apple.
- **Engages** by editing notes, moving shows between lists, adding new shows, archiving, or sharing. Any of these flips the member out of "seed-only" status and they begin showing in popular, recommendations, and vibe.
- **Goes dormant** when 60 days pass without a session ping; the member card disappears from the home page picker until they come back. They're still reachable by direct URL.

## Future / not built

A few intentional omissions:

- No notifications (calendar feed substitutes for premiere alerts).
- No comments or threads — discussion happens off-app.
- No public sign-up or invitation tokens.
- No mobile app — the PWA covers it.

## Backlog

- **Social login — Google.** ~~Sign in with Apple~~ shipped in the iOS app
  (`/auth/apple`, mapping the Apple ID email back to an existing member's
  `member_emails` row, then remembering the Apple `sub` in
  `member_apple_ids`). Google would layer on the same way: an additional
  sign-in path that maps the SSO email to a seeded member, keeping seeding
  operator-controlled (no public sign-up).

- **Open signup ("request access" flow).** Anyone can submit name +
  email on a `/signup` page. Submission lands in a `pending_signups`
  table and notifies the operator. Operator approves from `/members`
  with one click, which runs the existing create-member flow and emails
  the new member a welcome with their first login code. Keeps the
  trust model identical to today (operator vets every member) but
  removes the operator as the bottleneck for inbound interest. No
  CAPTCHA / Turnstile needed at this scale since the human approval
  gate already kills automated abuse.

- **SMS login codes via Twilio A2P 10DLC.** Shelved June 2026 after
  two rejections (consent-required, then person-to-person). Email-OTP
  is doing the job. Revisit only if a member can't use email, if
  Twilio's small-sender lane improves, or if we switch to a provider
  with friendlier verification (Vonage, Sinch). Server-side already
  accepts `channel: 'sms'` on `/auth/request-code`; just the
  `sendSms()` half is stubbed.
