# Show Picker Club — Product

This is the product-level reference for what Show Picker Club does, who it's for, the major flows, and the rules that shape the user experience. For implementation details, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## What it is

A shared tracker for a small private TV/movie club. Each member maintains their own four ranked lists. The home page combines those into a club view: most-watched shows, member browsing, cross-library search. Logged-in members get a calendar feed of upcoming premieres.

## Who it's for

A group of friends and family (~20 members in production). Everyone has a member slug (e.g. `/whitt`), signs in with a one-time code (text/email), Sign in with Apple, or Sign in with Google, and has full edit rights over their own lists. Registration is open and self-service: anyone can create an account and is a full member the moment they do. There is no invite, no operator approval, and no way for the operator to create an account on someone's behalf.

## The four lists

Every member has exactly four lists. They are intentionally narrow and force a clear judgement:

| List           | What it means                                              | Color  |
|----------------|------------------------------------------------------------|--------|
| **Watching**   | Currently watching a season or movie.                      | Green  |
| **Awaiting**   | Finished the current season; waiting on the next.          | Blue   |
| **Loved**      | Watched and loved it; happy to talk about it.              | Purple |
| **Next Up**    | Heard about it, want to watch — not committed yet.         | Orange |

Shows can also be **Archived** (hidden from lists, kept in DB for de-dupe and history).

### Quick actions

The Watching list has one-tap promotions to keep the lists honest:

- **Watched it →** moves to Loved.
- **Season done →** moves to Awaiting.

Awaiting and Loved each have a **back to Watching** button. Next Up has **Start watching**.

## Show data

A show row holds: title, network, network URL (deep link to the show on that network's site), recommended-by attribution, rating (IMDB), notes, movie flag, series-complete flag, watching-with field, plus auto-enriched genres, cast, next-season premiere date, and finale date.

Members only fill in title, network, and recommender — the rest is automatic. TMDB returns the canonical title, audience rating, cast (with IMDB links), the creator/director (with an IMDB link), next-season dates, finale dates, the "ended" flag, and genres. Network URL is sourced via Watchmode (deep links straight to the show on the streaming service) on insert and edit, in the background — members never paste a URL. If Watchmode can't resolve a title or network, the row falls back to the network's search page until an admin fills it in via `/url-cleanup`.

The network dropdown lists the modern streaming-service brand (HBO Max, Paramount+, Peacock, Hulu, Disney+, Apple TV+, Amazon Prime Video, Netflix, Starz, AMC+, Food Network, Fox, BritBox, YouTube, MGM+), plus two **storefronts** — Apple TV (rent or buy) and Fandango at Home — for titles nothing streams yet, like a film still in its theatrical window. A storefront charges per view, so the Subscription Audit ignores those rows entirely rather than counting them toward a monthly bill. Entries carry parenthetical aliases that name the sub-brands they carry (e.g. "Paramount+ (including CBS, MTV, Comedy Central, Nickelodeon, BET, Showtime)"). If a member ever submits an old or sub-brand name like `HBO`, `NBC`, `Bravo`, or `FX` — via API or by pasting — it gets folded to the canonical streamer on save. See [`ARCHITECTURE.md`](ARCHITECTURE.md#networks) for the full mapping.

### Also watching (groups)

The show card names the other members of your groups who have that same title on their **Watching** list — an "Also watching: Alex, Dana" line sitting directly above Network. It appears wherever the card opens (your own list, another member's list, Trending, search), not only inside a group screen, and it's silent when nobody in your groups is watching it or you're in no groups.

Only people you already share a group with can appear, and only their first names — the line never reveals a stranger's library, and it shows nothing to a logged-out visitor. You and the member whose copy you're looking at are both left out (you know your own lists, and their list is already on screen).

Platforms: iPhone/iPad show it above Network on the show card; Apple TV shows the same line above the watch button (which is where the TV names the network). The watch app doesn't — private groups were dropped there. The web app is frozen and doesn't get it.

## Authentication

A member logs in with a passkey (iPhone/iPad), a one-time code sent to their phone (SMS via Twilio Verify) or email (via Resend, validated against `login_otps`), or with Sign in with Apple (iOS and tvOS). All paths resolve to an existing member and set a 30-day HttpOnly session cookie. There are no static per-member passwords.

### Passkeys

Face ID or Touch ID instead of waiting for a code. Shipped 2026-08.

**Adding one is a deliberate step, taken while signed in** — account menu → Passkeys → "Add a passkey for this iPhone". That ordering is the security model, not an inconvenience: a passkey is added by someone who has already proved the account is theirs, and only then becomes a way back in. It is never a way to sign up, and an unknown passkey at the sign-in screen is refused rather than turned into an account.

Once added, the login screen's "Sign in with a passkey" is one tap and a biometric — no email address, no code, nothing to type. The passkey lives in the iCloud Keychain, so adding it on an iPhone covers that member's iPad and Mac too.

**The offer comes after a code sign-in, not before one.** A member who signs in with an email or phone code — or who creates an account that way — lands on a final "Skip the code next time" step inside the same sheet, offering to add a passkey then and there. That moment is the whole design: they have just proved who they are (so registration is allowed) and just felt the friction the passkey removes. It is never a gate — they are signed in either way, and both buttons close the sheet.

Four rules keep it an offer rather than a nag:
- **Only when they have none.** Passkeys sync through the iCloud Keychain, so one added on an iPhone already covers that member's iPad — the check is "does this account have any passkey", not "does this device". If the check can't run (offline), the sheet just closes as it always did.
- **Not after Sign in with Apple.** That is already one tap and Face ID, so a passkey would save those members nothing and the offer would just be a screen bolted onto an instant flow. Codes are what a passkey replaces. An Apple member who later falls back to a code gets asked then.
- **"Not now" sticks**, including backing out of the system sheet, which is also an answer. It's re-offered after 30 days rather than never: getting members onto passkeys is what makes retiring the code channels possible (see Backlog), so a permanent decline would quietly give that up.
- **Passkey sign-ins skip it entirely**, and the account menu is always there for anyone who said no.

The Passkeys screen lists what's registered (label, last used) and removes any of them. Removing all of them is allowed and can't lock anyone out: the account's original sign-in method — Apple, Google, or an email code — never goes away.

**Platforms:** iPhone and iPad (including Mac Catalyst) get both sign-in and management. **tvOS doesn't** — passkey sign-in on a TV means a cross-device QR handshake with a phone, which is a worse experience than the code the Apple TV already asks for; it keeps Sign in with Apple and one-time codes. **watchOS doesn't** — it has no login of its own, taking its session from the iPhone over WatchConnectivity. **The web doesn't** — there is no web sign-in any more (see Web app status). The server-side relying party is the domain rather than the app, so a web client could be added later without members re-enrolling anything.

Failed logins are rate-limited: 5 attempts per IP in any 15-minute window returns a 429 with `Retry-After`. Failed-login rows are pruned daily.

The member roster and Trending are public, but browsing a member's lists requires a session (the server 401s member reads without one). Only the logged-in member can edit their own list.

## Home page

The landing page (`/`) shows:

1. **My Shows link** — appears for logged-in members, jumps to their own page. Logged-out visitors instead get a join-pitch card explaining what an account adds, under **one** button reading "Log in or sign up". One, not a "Create your free account" / "Already a member?" pair: both opened the same sheet, and the sheet is identifier-first — it works out whether you're new or returning from what you type. Two buttons to one destination only asked people to classify themselves before anything had happened. The button's label matches the sheet's own title on purpose, so a returning member taps it and lands on a screen that says the same words.
2. **Trending** — top 10 shows by how many members added them in the last 30 days. Tap + to add to your own list. Seed-only members are excluded from this calculation.
3. **Members** — the six members with the longest Watching lists are featured at the top (Awaiting count is the tiebreaker). A "Browse all members ▾" disclosure underneath reveals the rest of the roster, alphabetized, so anyone is reachable. The point of the featured row is to lead with members who actually have something on their list worth looking at.
4. **Search all libraries** — opens a modal that searches every active show across every member by title or actor. Each result shows the owning member and the list it's on; logged-in users can tap + to add to their own list.

## Member page (`/<slug>`)

Tabs across the top for the four lists. Each show row collapses to one line (title, network, rating, badges), and tapping the title expands it to show genre, cast, recommender, dates, watching-with, and notes.

Two pieces of metadata are **always visible** under the row (not collapsed):

- **Awaiting list:** "Next episode: 5/9" — the next premiere date only (the finale date is never shown here). The label is "Next episode" rather than "Next season" because midseason episode dates can also appear here.
- **Every list shows the premiere date when one exists** (since 2026-07): Loved and Next Up rows carry the same "📅 Next episode" line — a show you thought was done can drop a surprise season, and the date is the nudge to move it back to Watching.
- **Next Up list:** "Recommended by Dorothy" — surfaces attribution without an expand.

### The admin member screen (iPhone, iPad and Mac — admin sessions only)

**The member page carries nothing admin-only.** Opening someone's page as an admin shows exactly what that member sees — the point of going there is to see their view, and a header full of their phone numbers isn't part of it. The operator's view of a member is its own screen: **Admin → Manage members → that member**, which leads with who they are and follows with the controls that act on them.

That screen opens with:

- **Admin** — their name, any ADMIN/DISABLED tag, and `joined 2d ago via apple`, then:
  - slug, every login email and phone on file (selectable, so you can copy one)
  - last login, with the method they used — `last login 3d ago via Apple`
  - last activity
  - **`lists:`** — the four lists across with their current totals, including zeros
  - total shows and how many they've archived
  - **`30d:`** — adds per list in the last 30 days
  - every platform they've ever used the app from (iPhone, iPad, Apple Watch, Mac, Apple TV, web), lit when used and dim when not
- **Recent adds** — their eight most recent additions, newest first, with a relative timestamp. Bulk imports collapse to one line per list. Seeded starter rows never appear: a new member who has added nothing reads as having added nothing.
- **Open member page** — their four lists, exactly as they see them.
- then the editing controls (rename, emails, phones, make admin, disable).

The `lists:` totals and the "N shows" line under them come from the same query on the same terms (active, non-seed), so the four always sum to the one. `scripts/admin-member-detail-test.mjs` asserts it.

**The signup notification email lands here.** That email deep-links to `/<slug>`, and the question it raises — who is this, and are they using it? — is this screen's whole content, so for an **admin session opening someone else's slug** the link resolves to the admin member screen rather than the member page. Your own slug still opens your page, and a non-admin following any slug only ever gets the member page. On iPad and Mac the sidebar moves to Manage members underneath it, so Back lands somewhere useful.

**Mac** gets all of it: Catalyst runs the same split view as iPad, and both entitlement files claim `applinks:showpicker.club`, so tapping the email's button in Mail on the Mac opens the same screen it opens on the phone. tvOS and watchOS have no admin tools (view-only and read-only respectively), and there is no web member app to put them on.

### Suggest a show

Any logged-in member can suggest a show to any other member via the **Suggest a Show for ...** button at the bottom of any list. The suggestion lands on that member's Next Up list with the recommender attribution pre-filled and "Suggested · &lt;your notes&gt;" prepended to the notes.

### Share to another list / member

The **+** button on any show row opens a share modal. The original member can copy the show to their own other list (rare) or to any other member's Next Up. The whole show — including rating, network link, cast, and notes — carries over.

### Edit, archive

Logged in as yourself, every row gets Edit and Archive buttons inline. Editing re-runs enrichment if the title changes. Archive sets `archived=1`; archived shows are still searchable but don't appear in lists, trending, or vibe.

## Web app status

**The web member app was removed in 2026-08.** `showpicker.club` is now a
marketing site: a pitch, the club's public Trending shelf, and an App Store
link. Every retired path 301s to it.

The reasoning didn't change, it just finished. The web app had no users — every
member is on the iPhone/iPad app — and keeping two frontends in step was costing
real time: a full day in 2026-08 went into fixing drift *between* web surfaces
(five show-row implementations, two show-detail implementations, two sidebar
navs) and then porting the same fixes to Swift.

What this means in practice:

- **All member-facing work goes to iOS/iPad.** tvOS is view-only, watchOS is
  read-only, and there is no web target any more.
- **The backend is not frozen in any sense.** `functions/api/*` is what the apps
  run on, and it gets the same attention it always did.
- **There is no web sign-in.** The login UI lived in the SPA and went with it.
  The `/auth/*` endpoints are untouched, so restoring the page would restore the
  flow — but today the only way into an account is an Apple device.
- **The admin tools are iOS-only.** Reporting, Manage members, Show Cleanup and
  Vibe trait scoring are all in the app; the `public/` copies are archived.
- **Nothing was deleted.** The old pages live in `archive/web/` at the repo root,
  outside the Pages build output. Reverting is a `git mv` and a `_redirects`
  edit.

If a member ever asks for web access — an Android user, or someone who won't
install an app — that's the signal to revisit, and the code is still there to
revisit with.

## Native apps

The native iOS, tvOS and watchOS clients are where the product actually lives (see Web app status above; the PWA itself was retired in 2026-08). The watchOS app (paired to the iPhone) shows the four lists → shows → detail; its session is handed off from the phone, and member reads depend on that handed-off session (they are not public). There is deliberately no watch-face complication (one shipped briefly in 2026-07 and was retired — it rendered unreliably on device).

### Navigation standard

**Home leads, and Home is the launch screen — on every platform.** Wherever the app has a tab bar or a top-level nav list, Home is the first item, followed by My Shows; the app opens on Home whether or not a session is already stored. Signing in *during* a session still takes you straight to your lists (you asked for them), but restoring a session at launch does not.

iPhone and iPad satisfy this by construction — both are rooted at Home, with My Shows the first row of its nav list. On tvOS it's the tab order plus a launch rule: the sign-in jump to My Shows only fires from the Account tab, so a stored session resolving at launch leaves you on Home.

The **Groups** nav row carries a `NEW` flag on iPhone Home and in the iPad sidebar until the member opens Groups once (`seenGroups`, `@AppStorage`), after which it never comes back. It sits immediately after the word "Groups" as an accent-filled capsule rather than in SwiftUI's trailing `.badge()` slot — at the far right, in secondary grey, it read as a count and got lost against the row. A badge that never clears is decoration; this one has a job and then goes away.

The iOS app ships **home-screen widgets** on iPhone, iPad, and Mac (the Mac Catalyst build): **Trending** (public, the club's rolling top adds; small/medium/large + extra-large on iPad/Mac) and **Up Next** (the signed-in member's calendar by date; small/medium/large + iPhone Lock Screen). Tapping a show opens its card in the app via `showpicker.club/show/<id>` universal links. tvOS and watchOS have no widget equivalent.

**Up Next shows the next thing on your calendar, not the next premiere.** It carries exactly what the Calendar screen and the `.ics` feed carry — season premieres *and* season finales from Watching and Awaiting, one row per show (whichever of its two dates comes first), each row saying which it is ("Premieres Aug 20" / "Finale Aug 14"). Premieres alone left the widget empty for weeks at a stretch, since only a fraction of tracked shows have an announced return date at any moment. Empty now means genuinely nothing dated ahead.

## Sort and toggle controls

Footer of each list:

- **Sort:** by Rating (default), A–Z, Date Added, or **My Order (drag to sort)** on your own lists. On another member's page the same slot reads **"{Name}'s Order"** and sorts by their saved arrangement, read-only — no drag handles, and the server-side reorder endpoint only ever writes the session member's own rows. Picking My Order puts the list in reorder mode: every row grows a ☰ grab handle (with a how-to hint above the list) and dragging saves the order immediately. The order is stored per list on the server (`sort_order`), so it follows the member across web and iOS; which sort mode is active stays a per-device choice. Shows added after the last drag sink to the bottom of My Order until placed.
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

The feed contains one all-day event per known **next-season premiere date** and per known **season finale date** for shows on that member's Watching and Awaiting lists. Event titles are `<Show> on <Network>` (no "next season" wording because midseason dates also appear). Event URL deep-links to the show on the network's site (when known); event description includes the recommender and a link back to the member's app page.

Calendar apps re-fetch the feed on their own schedule (Apple Calendar typically every hour; the feed sets a 24-hour `REFRESH-INTERVAL` hint).

A "📅 Calendar feed" link in each member-page footer opens the `webcal://` URL, which Apple Calendar recognizes as a one-tap subscribe.

## Import a list

The other side of Export: a member arriving with a list they already keep somewhere else — Notes, a text file, an old spreadsheet, a message thread — can paste it in and have it sorted onto the four lists instead of typing it out one show at a time.

- **iPhone / iPad:** shipped. Reached two ways, both of which retire themselves once the member has a library: a card on **Home** while their library is empty (Home is the launch screen, so a new member sees it before they ever reach My Shows), and a slim row above their own list while they have five shows or fewer across all four lists. The empty state on their own Watching / Next Up list also offers it.
- **Apple TV / Apple Watch:** not offered (view-only / read-only surfaces).
- **Web:** not offered — the member app is retired.

How it goes:

1. **Paste.** A plain text box. Headings like "Currently watching" or "Favourites" are read as section markers and applied to the titles under them; a note next to a single title stays with that title.
2. **Read.** The paste is sent up and comes back as a list of titles, each matched against TMDB for its canonical spelling, year and poster. A long paste shows real progress rather than an indefinite spinner. **Nothing is written at this point.**
3. **Review.** Every title, with the list it landed on, editable. Tap the circle to leave one out, or change its list. The row says when a title was spelled differently from what was typed ("You wrote *Severence*"), when TMDB had no match (it's still offered, and goes in as typed), and when the member already has it.
4. **Add.** Only then are rows written, and only ever to the caller's own lists.

Details that matter in use:

- **Notes and people come along.** "Whitt told me about this", "with Dorothy", "s4 in September" and the streaming service are pulled out into the same fields the add form fills in — not left glued to the title.
- **Titles you already have are greyed out** and can't be ticked back on, archived ones included, so the screen never promises an add that silently doesn't happen.
- **No length limit.** A very long paste takes longer; it isn't truncated or capped. There is a per-day ceiling of 300 rows across imports and hand-adds together.
- **Artwork and cast fill in shortly after**, not at import time — the rows appear immediately with a poster and land fully enriched a little later.
- **The default list is Watching** when a paste has no structure to place a title. That means an unstructured import lands in the calendar feed too (which draws from Watching + Awaiting), which is the main reason the review step exists.

## Export your lists

So members never feel locked in, the account menu has an **Export my lists** action (logged-in members only) backed by `GET /api/export`. It returns a plain-text file of the caller's **own** lists — a section per list (`Watching`, `Awaiting`, `Loved`, `Next Up`), each show rendered as `Title on Network` (network dropped when absent), shows sorted alphabetically within each list. Private notes are not included.

- **Web:** downloads a `showpicker-<slug>.txt` file (served with `Content-Disposition: attachment`).
- **iPhone / iPad:** opens the standard share sheet so the file can go to Notes, Messages, Mail, Files, etc.
- **Apple TV / Apple Watch:** not offered (view-only / read-only surfaces).

## Subscriptions (`/subscriptions`)

A private audit that helps a member trim streaming spend, reached from a "💸 Subscriptions" link on their own member page (logged-in members only).

The page reads the shows already on your lists, groups them by streaming service, and gives each service a plain-English call:

- **Keep** — you're actively watching something there right now.
- **Pause & save** — nothing to watch this minute, but a show you're waiting on has a known next-season date. It tells you the month to **cancel now and resubscribe** (e.g. "resubscribe around Oct 2026, when Tulsa King returns").
- **Pause (renewal TBA)** — you're waiting on a renewal with no announced date yet.
- **Start or skip** — shows queued up there but nothing started.
- **Cancel candidate** — every show there is finished; nothing pulls you back.

The top of the page sums it up: services tracked, estimated monthly spend, and roughly how much you could save right now. Each service shows a "Why?" expander listing the exact shows behind its verdict, so the recommendation is never a black box.

**With a household, every show says whose it is.** Once you've invited someone to your household, the audit pools their lists with yours — so a service can be a "keep" on the strength of a show you've never started. Each row in the "Why?" list names the people who have that title, annotated with their own list when it differs from yours ("You · Dorothy (Next Up)"), and the keep verdict names the watcher outright: "Active now: Severance (Dorothy)." On a solo audit nothing changes — with only your own lists pooled, naming the viewer would say nothing.

You stay in control: every service has a **Subscribed / Paused / Cancelled** toggle (the verdict is only a suggestion), an editable monthly price (pre-filled with a sensible default per service), and — for paused services — a **resubscribe date**. Setting that date drops a "Resubscribe to <Service>" reminder onto your [calendar feed](#calendar-feed), right next to your premiere and finale dates. You can also **add a service** you pay for that has no tracked shows (a sports or music package) so the monthly total reflects everything.

Prices are editable defaults — approximate US standard-plan rates that each member can correct to what they actually pay. Implementation in [`ARCHITECTURE.md`](ARCHITECTURE.md#subscription-audit).

Platforms: iPhone and iPad only, the whole audit and the household viewer names with it. **Apple TV doesn't** — it's view-only, and cancelling a subscription isn't something you do from the couch with a remote. **The watch doesn't** — it's read-only, and a spend audit needs the toggles and price fields it has no room for. **The web doesn't** — `subscriptions.html` went to `archive/web/` in the 2026-08 teardown (see [Web app status](#web-app-status)); the API still returns everything the page used, so restoring it is a `git mv`.

## Vibe

A taste-profile view. Pick yourself, or anyone you share a [group](#also-watching-groups) with, to see:

- **Cluster identity** — one of eight personas (Warm Comfort Viewer, Prestige Drama Loyalist, Dark Complexity Seeker, Satirical Cynic, Power Game Watcher, Chaos Goblin, Curious Omnivore, Empathy & Healing Viewer) with a one-line tagline. You are matched against **the club** — where you sit relative to other members, not against the trait scale — so a taste everyone in the club shares doesn't decide anyone's persona. Two cases where the screen declines to assert: under five scored titles there is no persona at all (the traits and picks still show), and a member sitting between two clusters is told so instead of being handed the winner by a hair.
- **Top and bottom trait signals** — the dimensions where they index highest and lowest vs the club mean, with little bars.
- **Cluster blend** — top three clusters they pattern-match against, with similarity scores.
- **Balance reads** — warmth vs darkness, cynicism vs optimism, etc.
- **Aligned shows** — picks from their own library that score highest on their dominant traits, grouped by list. One-tap add to your own Next Up.

The cluster algorithm and trait list are detailed in [`ARCHITECTURE.md`](ARCHITECTURE.md#vibe-system).

Vibe profiles require a logged-in session, and the picker is scoped to people
you actually share a group with — the club roster used to be the answer, which
listed strangers. A slug outside that set is refused, not shown.

**Every group-mate's vibe is visible to every other group-mate, always.** A
library too sprawling to represent taste is kept out of the club's shared
signals — Trending, recommendation neighbours, the aligned-picks pool — but
that exclusion is about arithmetic, not privacy: it never hides a profile from
anyone, including its owner. Everyone in a group can already open everyone
else's library, so a vibe is no more private than the lists it reads. Titles
only an excluded member holds are still never offered to anyone else as picks.

Platforms: **iPhone and iPad**. **Apple TV doesn't** — it's view-only, and the
picker plus the add-a-pick flow need input the remote doesn't suit. **The watch
doesn't** — it's read-only and has no room for the trait bars. **The web
doesn't** — `vibe.html` went to `archive/web/` in the 2026-08 teardown (see
[Web app status](#web-app-status)); `/api/vibe` still serves the apps.

## Suggestions to non-members

Not currently supported — the suggest button is only available to logged-in members. Outside guests would need to be added as a member first.

## Reporting (`/reporting`, auth-required)

A small operator dashboard:

- **DAU / WAU / MAU** — distinct sessions that have pinged within each window (1 / 7 / 30 days).
- **New, edited, archived counts** — per show, in day/week/month/all-time windows.
- **People who rated** — distinct members who submitted a rating (new or changed), in the same day/week/month/all-time windows as the show counts above.
- **Totals** — members, active shows, archived shows, shows per list, ratings submitted, titles rated.
- **Top networks** and **top shared titles** across the club.

Recently removed: "Most active members," "Recently archived," "Seed-only members," "Member activity." The data sources for those queries still exist if they need to be restored.

## Admin tools

Three secret-protected admin pages (all require the `ADMIN_SECRET` value to be entered in the page):

- **/setup** — create a new member. Enter a name plus the phone and/or email they'll receive login codes at; the page generates a slug. New members start with an empty library — seeding a starter library of 8 popular picks was retired 2026-07; members created before then keep whatever seed rows they still have.
- **/url-cleanup** — queue of shows missing a real network URL (still on a generic search link). Operator can paste a deep link; the page pushes it to every member's copy of that show. Also surfaces **wrong titles**: shows whose name never matched a real title (no poster after enrichment) even though their link works. Most fix themselves — the real name is recovered from the show's own streaming-page link (og:title) during enrichment and when this page loads; only the ones automation can't confidently match are listed, and renaming re-enriches every copy and pulls the right poster.
- **/vibe-admin** — batch-score show traits using Claude. Picks shows missing a `show_traits` row, sends each title to Claude with a calibration prompt that asks for 27 trait scores (0–1), writes the result back. Used to backfill the trait data that powers Vibe.

There is no admin role in the session model — admin actions are gated purely by knowing the `ADMIN_SECRET`.

## Member lifecycle

- **Created** by an operator via `/setup` (or by hand-INSERT during bootstrap). Starts with an empty library — auto-seeding a starter library was retired 2026-07.
- **Logs in** for the first time with a one-time code (text or email), or Sign in with Apple.
- **Engages** by editing notes, moving shows between lists, adding new shows, archiving, or sharing. Any of these flips the member out of "seed-only" status and they begin showing in popular, recommendations, and vibe.
- **Goes dormant** when 60 days pass without a session ping; the member card disappears from the home page picker until they come back. They're still reachable by direct URL.

## Admin platform policy

Admin tooling lives on exactly two surfaces, kept at feature parity
(July 2026):

- **Web** (`/members` — the single member-administration hub — plus Show
  Cleanup / Vibe admin / Reporting; `/admin` now 301s to `/members`).
- **The universal iOS app** (Admin tab) — which covers iPhone, iPad, and the
  Mac Catalyst build in one codebase.

**tvOS and watchOS are view-only by design** — no admin screens, ever; the
TV's account screen shows a cosmetic "Operator" label and nothing more.
That's a deliberate scope call (a 10-foot UI is the wrong place for a ban
button), not a gap to fill.

Member management on both admin surfaces covers: roster with status badges
(ADMIN / DISABLED), always ordered by most recent library
activity (`last_activity_at` — no sort picker; members with no recorded
activity sink to the bottom), last activity timestamp and 30-day counts
(last login is no longer shown — activity is the engagement signal that
matters), rename (slug
and URL never change), email/phone editing, disable/enable
(kills sessions), and admin
promote/demote (`/api/admin-member-role`; the server refuses to demote the
last admin, and a full hand-off is promote-then-demote-yourself — this is
the path the `admin_must_demote_first` account-deletion error points at).
There is no new-members queue and nothing to approve — people sign
themselves up and are live immediately. (The iPhone/iPad app still carries
the old queue UI in its source until the post-launch cleanup build; with the
endpoints gone it always renders empty, so the operator sees the same thing
on both surfaces.) Above the roster, the same platform badges shown per-member
(iPhone, iPad, Apple Watch, Mac, Apple TV, Small Web, Large Web) double as a
filter on both surfaces — tap one to show only members who've ever used
that platform, tap it again to clear. When adding a member-management
capability, add it to both surfaces in the same change or note the
follow-up in the Backlog.

## Future / not built

A few intentional omissions:

- No notifications (calendar feed substitutes for premiere alerts).
- No comments or threads — discussion happens off-app.
- No public sign-up or invitation tokens.
- No hard delete of other members from admin UIs — disable (ban) plus
  self-service account deletion covers it.

## Backlog

- **Give each group an icon.** Groups are identified by name alone everywhere
  they appear — the Groups list and group detail on iPhone and iPad, the
  Groups tab and group tiles on Apple TV. A per-group icon (an SF Symbol the
  creator picks, or a color, or both) would make them recognizable at a
  glance and give the tiles something to be. Needs a column on `groups`, a
  picker in create/rename, and the icon rendered in every place a group name
  is shown. **Deferred until after the 1.2 build ships.**

- **Retire email-code login, and the third-party services that go with it.**
  Apple sign-in covers the Apple apps, which is where the product lives, and
  the apps are what members actually use. Every other sign-in path costs
  something: Twilio Verify bills per SMS and carries the A2P 10DLC campaign
  registration, and Resend delivers the email codes. Dropping them removes
  two vendors, two secrets, two failure modes, and the SMS consent
  disclosures that are already out of date (see the entry below).

  Sequencing matters, and the data to sequence it is only now being
  collected. Migration 059 stamps `sessions.auth_method` and
  `members.last_login_method`, and Reporting shows sign-ins per method over
  7/30/90 days plus how every account was created (`enrolled_via`). Read the
  90-day window — sessions slide, so a member who never signs in again is
  invisible in a short window — before retiring anything.

  **Passkeys (shipped 2026-08) are the migration path this entry was
  missing.** A member who enrolled by email and won't use Sign in with Apple
  no longer has to — they can add a passkey from inside a session and never
  need a code again, and `sessions.auth_method = 'passkey'` in Reporting says
  how many have. Retiring the code channels now means getting members onto
  passkeys first, not getting them onto Apple. Note the ordering constraint
  it does *not* solve: a passkey can only be added from a signed-in session,
  so the code channels have to outlive the last member who hasn't added one.

  What has to be true first:
  - Nobody's *only* way in is the channel being removed. `enrolled_via` says
    how each account was created; a member who enrolled by email and has
    never signed in with Apple needs a linked Apple identity, a passkey, or
    some other migration path before their email code disappears.
  - The web keeps whatever the Apple apps can't cover. Sign in with Apple on
    the web is a different integration from the native one; if the web is
    reduced to a marketing site (see Web app status), this gets easier.
  - App Review needs a working demo account. `DEMO_LOGIN_EMAIL` /
    `DEMO_LOGIN_CODE` is an email-code login today, so removing that path
    means giving Review another way in first.

  What comes out once it's done: Twilio (secrets, Verify service, the 10DLC
  campaign), Resend for login codes (transactional email may still be wanted
  elsewhere), `login_otps` / `enroll_otps`, `/auth/request-code`, the SMS
  half of `/auth/login`, `member_phones`, `public/sms.html`, and the SMS
  sections of the privacy policy.

- **SMS consent language promises retired notifications.** `public/sms.html`
  and the SMS section of `public/privacy.html` both say members receive texts
  "when another member recommends or shares a show with you". Those features
  were retired 2026-07 and their endpoints return 410, so those texts can no
  longer be sent. This is over-disclosure rather than under-disclosure, so
  it is not a compliance problem and there is no rush — but it is wrong.
  Not a drive-by fix: `sms.html` quotes verbatim the consent language
  registered with Twilio for A2P 10DLC, so the page and the registered
  campaign text have to change together. `sms.html` also still describes the
  club as "invitation-only", which stopped being true when approval was
  removed in 2026-08.

- **Member ratings.** (Amy Brownlee 7/16, Susan 7/22, Rob Maltzhan 7/23 —
  2026.) Members rate shows 1-10 (whole numbers), and those ratings show up
  alongside the IMDB number — friends' stars answer "Patrick liked it, so
  I'll like it too." Amy and Susan asked for the two halves separately
  (seeing others' ratings; being able to rate herself); Rob's ask (7/23) was
  both at once: "add a 1-10 rating & see other's rating." Design settled
  7/23, feedback gathered 7/24 (Google Doc sent to Amy/Rob/Susan), **shipped
  on web 7/24**:
  - **Scale:** 1-10, matching the existing "TMDB Rating" field's scale so
    the two numbers on the same card mean the same thing at a glance.
    (Feedback was split — Amy and Susan both suggested 1-5 for entry
    simplicity, Rob wanted 1-10 — settled on 1-10 for consistency with the
    other rating already on the card.) TMDB Rating itself now lives inside
    the Ratings section, directly above Show Picker Club Rating, instead of sitting
    apart in the catalog-data card below.
  - **Entry (shipped):** a 10-segment tap-row (not a slider or numeric
    field) — tap a position, it saves instantly, no Save button. One
    overall rating per show, plus optional independent per-season ratings
    (keyed off `seasons_released`). The "Ratings" section sits directly
    below "My Lists" on the show card.
  - **Visibility (shipped):** every card — regardless of viewer or which
    member's copy it is — shows the whole club's average (rounded to one
    decimal). Opening a show from a specific member's copy additionally
    shows that member's own rating as a separate line, so "which friend
    liked it" isn't lost in the aggregate.
  - **Entry gating (shipped):** a member can only enter their own rating on
    a show that's on one of their own lists, except Next Up — shows not yet
    watched only ever display the average. Enforced server-side
    (`PUT /api/shows/:id/rating`), not just hidden in the UI.
  - **Entry points (shipped, turned out to need no new work):** Trending
    and Search-all-libraries already open the same show-detail card
    (`openDetail()`) as a member's own page, and that card's "My Lists"
    section already scopes to the *viewer's own* copy rather than whoever's
    copy is being viewed — so a non-owner already only ever sees their own
    notes/fields (never the card-opener's), and the list chips already let
    any viewer add the show to their own list. The originally-anticipated
    "build a separate non-owner card" work wasn't actually needed.
  - **Public surface (shipped):** the catalog-level show detail (the one
    part of the app visible without logging in) also shows the deidentified
    club average — a deliberate, scoped exception to the otherwise-tiny
    public surface (member identity and individual scores never appear
    there).
  - **Cross-member identity (shipped):** ratings key off TMDB id
    (`tmdb_id`/`tmdb_type` on `shows`, migration 049), not any one member's
    row — see the TMDB-canonical-id work above. `show_ratings` (migration
    053) and `functions/_shared/ratings.js` own validation/aggregation.
  - **Bulk rate-your-backlog (shipped):** `/rate-backlog` — every active
    show not on Next Up (archived excluded — tried including it, cut it
    after actually using the flow), overall rating only, 10-segment
    tap-row, unrated shows sorted first. Each title links to its detail
    page (new
    `?show=<id>` deep link) to rate by season instead. Surfaced as "Rate my
    backlog" alongside Subscription audit in the sidebars and the mobile
    under-list row.
  - **Native support (shipped in code, not yet archived/submitted):**
    iOS/iPad get full entry + display — a "Ratings" section on
    `ShowDetailView` mirroring the web (TMDB Rating, Show Picker Club Rating, owner's
    rating, tap-row entry for overall + each season, gated to lists other
    than Next Up). tvOS and watchOS are view-only (TMDB Rating + Club
    Rating + owner's rating; rate from iPhone/iPad) — consistent with both
    already being view-only/read-only apps generally.
  - **Native bulk rate-your-backlog (shipped in code):** iOS/iPad get a
    "Rate my backlog" screen (`RateBacklogView`), mirroring
    `/rate-backlog` — every unrated overall show, tap-row entry, rated
    shows drop off the list immediately. Surfaced next to Subscription
    audit on Home, the iPad sidebar, and a member's own page. Season
    ratings aren't listed there by design; "Rate seasons" on a row opens
    the full detail screen. tvOS/watchOS don't get this screen — no entry
    UI on either app.
  - **Offline rating queue (shipped in code):** rating a show while
    offline (from the detail screen or the bulk backlog screen) queues it
    as a `.rate` `PendingMutation` instead of failing, same as any other
    offline edit — it replays automatically on reconnect. The tapped value
    is folded into local state right away so the UI doesn't wait on a
    server round-trip that hasn't happened yet, and an already-tapped show
    in the backlog list won't reappear before the queue actually syncs it.
  - **Not building yet:** clearing/un-rating a show once rated — revisit if
    it's requested.
  - **Ships as v1.1, build 19** — version bumped in both `ios/ShowPickerIOS.xcodeproj`
    and `tvos/ShowPickerTV.xcodeproj`; still needs an actual Xcode
    archive + TestFlight/App Store submission (can't be done from this
    environment — no Mac/Xcode here).

- **Episode-level ratings.** (Amy — 7/24/2026, feedback on the ratings
  design doc.) Rate individual episodes, not just overall/season, shared
  with other members watching the same show. A step below season-level
  granularity — not part of the ratings design above, captured here for
  later. Overlaps with the "Group watch / episode chat" scope question
  below (per-episode visibility, spoiler safety).

- **Similar-taste discovery.** (Susan — 7/24/2026, feedback on the ratings
  design doc.) Use member ratings to find other members with similar taste
  and surface what they're watching — "find people with similar tastes and
  see what they are watching," in her words. Adjacent to "Find something to
  watch" below, but driven by ratings rather than vibe traits.

- **Bracket competition.** (Amy — 7/2026.) A bracket-style tournament built
  from the group's shows, where members who have watched a show vote for
  their favorites round by round.

- **Find something to watch.** (Amy — 7/2026.) A picker that weighs which
  streaming services you actually have (the subscription-audit data already
  knows), how much time you have tonight, and what your ratings say about
  your taste — the vibe trait vectors could drive that last part.

- **Group watch / episode chat.** (Amy — 7/2026.) Chat about specific
  episodes with other members who are watching the same show. Note this
  cuts against the current "no comments or threads" stance above — needs a
  deliberate call on scope (per-episode threads? spoiler-safety by episode
  progress?) before building.

- **Deep-link pass, especially Apple TV.** (Patrick — 7/23/2026, reopened
  8/10/2026.) Patrick wants streaming deep links to work consistently across
  services, not one bug at a time. Current state on tvOS: only HBO Max and
  Apple TV+ land on the actual show page from their https URL
  (`deepLinksToShow` in `ShowDetailView.swift`); Amazon, Paramount+, Peacock,
  Hulu and Disney+ only get their app launched via a bare custom scheme; the
  rest have no mapping. Netflix is *not* in the working set despite being the
  largest network — worth an on-device retest. The agreed direction is to
  store an Apple TV (`tv.apple.com`) link as the reliable fallback while
  keeping `network` set to the service that actually carries the title, so
  the Subscription Audit stays honest. See "Apple links vs. stored network"
  in ARCHITECTURE.md.

- **Tag member friends.** (Patrick — 7/26/2026.) Let a member tag other
  members on a show — captured for later; scope (what a tag means, where it
  surfaces, whether it notifies) still to be defined. Note this brushes up
  against the retired cross-member writes (suggest-a-show / share-to-member,
  now 410) and the "no comments or threads" stance — needs a deliberate call
  before building.

- **Show Picker movie filter.** (Patrick — 7/26/2026.) A way to filter a
  member's lists (or the catalog) down to just movies vs. TV, using the
  existing `is_movie` flag on `shows`. Scope — which surfaces get the filter
  (web lists, Trending, search, native apps) — still to be defined.

## Shipped (formerly backlog)

- **Title-healing bandaids retired (July 2026).** Since TMDB type-ahead
  pinning made new rows arrive with canonical title, movie flag, poster,
  rating, and cast, the after-the-fact guessing machinery only served a
  legacy backlog that has now fully drained (the bad-titles and `title_ok`
  queues were verified empty in production before removal). Removed: the
  bad-titles queue + its auto-fix pass and the `title_ok` dismiss control
  (`admin-url-cleanup.js`, iOS `UrlCleanupView`; the `url-cleanup.html` web UI was archived in 2026-08);
  `titleFromUrl` og:title recovery (`_shared/title-fix.js` and its callers
  in `enrich.js` and the cleanup endpoint); the title-variant spelling
  retries and cross-type flip searches in `enrich.js`'s poster passes; and
  the OMDB title-guessing fallback in `_shared/enrichment.js`
  (`suggestions.js` was already a retired 410 stub). Kept:
  `fetchEnrichmentById`, the artwork sync/propagation passes, the URL queue
  and its conflict/mismatch tools, and the operator's manual `fix_title`
  rename (still shared by the URL queue). The `title_ok` column stays on
  `shows` as an inert, always-zero remnant — harmless to leave, and dropping
  it would need a migration for no benefit.

- **Social login — Google.** Shipped alongside Sign in with Apple:
  `/auth/google` verifies a Google ID token, maps the `sub` via
  `member_google_ids` (migration 031) then falls back to verified email,
  and self-enrolls. Gated on `GOOGLE_CLIENT_ID` (returns 501 until set).

- **Open signup.** Shipped first as a `/join` request form with an
  operator approval queue; simplified in 2026-08 to direct self-enrollment.
  Anyone signing up via email code, Apple, or Google becomes a full member
  immediately — the request form, the approval queue, the held-member state,
  and manual member creation are all gone. Abuse is handled by rate limits
  (daily circuit breaker, per-IP cap, Turnstile), not by a human gate.

- **SMS login codes.** Resolved by reworking the Twilio setup, which cleared
  the A2P 10DLC verification problem that had shelved it in June 2026.
