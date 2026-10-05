# Show Picker Club — Product

This is the product-level reference for what Show Picker Club does, who it's for, the major flows, and the rules that shape the user experience. For implementation details, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## What it is

A shared tracker for a small private TV/movie club. Each member maintains their own four ranked lists. The home page combines those into a club view: most-watched shows, member browsing, cross-library search. Logged-in members get a calendar feed of upcoming premieres.

## Who it's for

A group of friends and family (~20 members in production). Everyone has a member slug (e.g. `/quinn`), signs in with a one-time code (text/email), Sign in with Apple, or Sign in with Google, and has full edit rights over their own lists. Registration is open and self-service: anyone can create an account and is a full member the moment they do. There is no invite, no operator approval, and no way for the operator to create an account on someone's behalf.

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

The network dropdown lists the modern streaming-service brand (HBO Max, Paramount+, Peacock, Hulu, Disney+, Apple TV+, Amazon Prime Video, Netflix, Starz, AMC+, Food Network, Fox, BritBox, PBS, YouTube, MGM+, Pluto TV), plus two **storefronts** — Apple TV (rent or buy) and Fandango at Home — for titles nothing streams yet, like a film still in its theatrical window. A storefront charges per view, so the Subscription Audit ignores those rows entirely rather than counting them toward a monthly bill. Pluto TV is the opposite case — free and ad-supported, so it still gets an audit card (it's an app you open, not a purchase you make) but is priced at $0, and dropping it saves nothing. Entries carry parenthetical aliases that name the sub-brands they carry (e.g. "Paramount+ (including CBS, MTV, Comedy Central, Nickelodeon, BET, Showtime)"). If a member ever submits an old or sub-brand name like `HBO`, `NBC`, `Bravo`, or `FX` — via API or by pasting — it gets folded to the canonical streamer on save. See [`ARCHITECTURE.md`](ARCHITECTURE.md#networks) for the full mapping.

Below the US services, the dropdown carries a **United Kingdom** section (BBC iPlayer, ITVX, Channel 4, Channel 5, NOW — Sky's channels fold into NOW) and an **Australia** section (Stan, Binge, Foxtel, ABC iview, SBS On Demand, 9Now, 7plus, 10 play), sectioned rather than merged so they don't crowd the list for members who never pick from them. BritBox stays in the US list where it belongs — it's the BBC/ITV export service sold to Americans, not what someone in Britain watches. The free-to-air catch-up services are priced at $0 in the Subscription Audit the way Pluto TV is; NOW, Stan, Binge and Foxtel arrive with **no** default price, because the audit totals US dollars and a converted guess would quietly corrupt the total — the member sets their own. Sharing into the app from those services works too: an iPlayer or Stan link is recognized on the way in. The picker's contents come from the server (`GET /api/networks`) rather than being compiled into the app, so the next network added shows up on phones already installed instead of waiting on an App Store release — the apps keep a copy of the last list they saw, and a shipped-in fallback for a first launch with no signal. iPhone/iPad/Mac and the web (since 2026-10, as `<optgroup>` sections, keeping its built-in list as the fallback) both draw the picker from it; Apple TV is view-only, and the watch has no add screen at all. Typed or pasted regional names canonicalize on every surface regardless, since that happens on the server.

### Watching with

The "Watching with" field on a show is still free text — "my sister", "the group chat", anyone at all. What's new is that when the person is a **member you share a private group with**, you can pick them from a list instead of typing their name, and picking them does something.

Naming a group-mate:

- Puts the show on **their list too**, on the same list you have it on. If they already have it, nothing moves — it stays on whatever list they put it on, in the order they put it, and no second copy appears. If they'd archived it, it comes back.
- **Names you back** on their copy's Watching with. It's a shared fact about an evening, so it reads the same from both sides rather than being a note you keep about them.
- Can be **more than one person** at a time. Each of them sees you named on their copy — not each other, since you may share a group with both of them while they share none with each other.

Unticking someone takes your name off their copy and unlinks the two. **It does not remove the show from their list** — it arrived, they may have started watching it, and deleting it is theirs to do. Deleting your own copy does the same cleanup: your name comes off every copy that was linked to it.

Only people you already share a group with are offered, and only they can be named — a member of the club you have no group with is not on the list and can't be reached by hand. This is the only place in the app where one member writes to another member's library; [`INVARIANTS.md`](INVARIANTS.md) §12 has the rules that keep it narrow. If you're in no groups, the field is exactly the plain text box it always was.

Who's named stays as private as the field itself: only you see the Watching with on your own rows, whether it's a typed name or a linked member.

Platforms: **iPhone/iPad** get the picker (in the Add/Edit sheet). **Apple TV and the watch** render the resulting text like they always have — both are view-only, so neither can tag. **The web** gets the same picker in its Add/Edit form (2026-10).

### Where it streams now

`network` on a show is **the member's own record** and is never overwritten —
they pick it when they add a title, and enrichment only fills a blank. That
makes it drift: licensing moves and the row doesn't. By 2026-09, 45% of films
named a service TMDB no longer listed.

Rather than correct someone's answer, show detail adds a line beside it:

- **"Also on Hulu"** — their service is one of several TMDB lists.
- **"Now on Paramount+"** — their service isn't among them any more.
- **Nothing** — their service is the only one listed (the row above already
  says it), *or* TMDB named no subscription service, *or* TMDB was never asked.
  The last two read alike on purpose: an empty list means "asked, streams
  nowhere on a plan", which is ordinary for a rental, and never-asked means
  nobody looked. Claiming the former on the latter would assert a fact we
  never checked.

Services are named in the same vocabulary as `network` itself, so a member
comparing the two never has to know that TMDB's "Max" is our "HBO Max". A
provider that maps to no service we can name — "Starz Amazon Channel" — is
left out rather than shown. See `docs/INVARIANTS.md` §20.

Adopting one of the named services — editing the show and picking it — is the
member answering the line, so it stops saying it: the note narrows to whatever
is still worth naming, or disappears when their pick was the only one listed.
Changing the network also **clears the service badge**, which was derived from
the service they just replaced; a blank badge is correct where a stale one is
a lie, and the next `mode: 'logos'` sweep refills it.

Platforms: **iPhone/iPad** show it as a Streaming row under Network (Mac via
Catalyst). **Apple TV** shows it in the metadata block above the watch button,
where that screen already names the network. **The watch doesn't** — it has no
show detail screen to put it on. **The web** shows it as an "Also on" / "Now
on" row under Network, the same rule.

### Also watching (groups)

The show card names the other members of your groups who have that same title on their **Watching** list — an "Also watching: Alex, Dana" line sitting directly above Network. It appears wherever the card opens (your own list, another member's list, Trending, search), not only inside a group screen, and it's silent when nobody in your groups is watching it or you're in no groups.

Only people you already share a group with can appear, and only their first names — the line never reveals a stranger's library, and it shows nothing to a logged-out visitor. You and the member whose copy you're looking at are both left out (you know your own lists, and their list is already on screen).

Platforms: iPhone/iPad and the web show it above Network on the show card; Apple TV shows the same line above the watch button (which is where the TV names the network). The watch app doesn't — private groups were dropped there.

### Watch Next (group recommendations)

Every group has a **Watch Next board**: a shared list of titles members have recommended to the group, sitting on the group screen next to Trending. It's JC's pop-up on top of a group-owned board (shipped 2026-08, migration 065).

Recommending: on a show that's on one of **your own** lists, tap **Recommend to group** (in the My Lists section of the show card). If you're in several groups you pick one; you can attach a short note, and the note is **visible to the whole group** — it's addressed to them, unlike the private Notes on your own rows. The show lands on the group's board as a card naming you.

Receiving: next time a group-mate opens the group, they get a pop-up — *"JC has recommended Lanterns"*, with the note underneath — and two buttons:

- **Add to Next Up** puts the title on **their own** Next Up list. If they already have it somewhere, nothing moves and no duplicate appears — the card just shows where it already sits. A copy created this way says "Recommended by JC" in the Recommended-by field.
- **Dismiss** clears the pop-up **for them only**. The card stays on the board for everyone else, and they can still add it from the board later — a dismiss isn't final.

Unanswered cards are asked about one at a time; your own recommendations never pop up at you. The board shows every card with who recommended it, the note, and who has added it so far. The recommender can retract their own card; the group's creator can remove any card. There is **no push notification** — delivery is the group screen itself, by design (the pop-up is attention enough; see the ceilings in [`INVARIANTS.md`](INVARIANTS.md) §12a).

Nothing about recommending touches anyone's list. Adding is each member's own tap onto their own list — the retired suggest-a-show's problem (anyone pushing rows onto anyone) structurally can't recur, because the feature contains no cross-member write at all. Watching With remains the only one.

Platforms: **iPhone/iPad** get all of it — recommend, pop-up, board (Mac via Catalyst). **Apple TV** shows the board as a read-only Watch Next shelf on the group screen — a couch is where "what should we watch next" gets asked — but can't recommend or answer. **The watch doesn't** — it has no groups. **The web** gets all of it too: Recommend to group on the show card, the pop-up on opening a group, and the board as a Watch Next tab (Remove in place of the swipe).

### Which build am I on

The account menu on Home ends with a readout: `1.4.1 (24) · 8784b9a` — version,
build number, and the commit the binary was built from. Disabled, because it is
a readout rather than an action.

The commit is the point. Version and build alone can't identify a binary during
testing: several different builds ship as the same `1.4.1 (24)` before a
release is cut, so "am I on the one with the fix?" has no answer without it. A
`Stamp git commit` build phase writes `GitCommit` into Info.plist at build
time; when the source isn't a git checkout it writes `unknown`, and the app
drops the suffix entirely rather than showing that to someone who installed
from the App Store.

Platforms: **iPhone/iPad** (Mac via Catalyst) — it lives in the account menu,
which only they have. **Apple TV and the watch don't** — neither has that menu,
and neither is a target you side-load successive test builds onto. **The web
doesn't** — frozen at its restored state, and a browser reload is never
ambiguous about which version it just fetched.

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

**Platforms:** iPhone and iPad (including Mac Catalyst) get both sign-in and management. **tvOS doesn't** — passkey sign-in on a TV means a cross-device QR handshake with a phone, which is a worse experience than the code the Apple TV already asks for; it keeps Sign in with Apple and one-time codes. **watchOS doesn't** — it has no login of its own, taking its session from the iPhone over WatchConnectivity. **The web does** (2026-10): "Sign in with a passkey" in the login sheet, the "Skip the code next time" offer after a code sign-in (same 30-day "Not now"), and **Passkeys…** in the account menu to add or remove them. The relying party is the domain rather than the app, so it is the same credential everywhere — nobody re-enrolls, and a passkey synced to the browser (or offered from a phone) signs in there too.

Failed logins are rate-limited: 5 attempts per IP in any 15-minute window returns a 429 with `Retry-After`. Failed-login rows are pruned daily.

The member roster and Trending are public, but browsing a member's lists requires a session (the server 401s member reads without one). Only the logged-in member can edit their own list.

## Home page

The landing page (`/`) shows:

1. **My Shows link** — appears for logged-in members, jumps to their own page. Logged-out visitors instead get a join-pitch card explaining what an account adds, under **one** button reading "Log in or sign up". One, not a "Create your free account" / "Already a member?" pair: both opened the same sheet, and the sheet is identifier-first — it works out whether you're new or returning from what you type. Two buttons to one destination only asked people to classify themselves before anything had happened. The button's label matches the sheet's own title on purpose, so a returning member taps it and lands on a screen that says the same words.
2. **Trending** — top shows by how many members added them in the last 30 days, ten at a time with a **More** button that expands to 50. Tap + to add to your own list. Seed-only members are excluded from this calculation, and so is **Next Up**: only Watching, Awaiting and Loved adds count, because bookmarking a show is not yet a statement that anybody is watching it. Group Trending uses the same rule and the same expansion — Sarah spotted the miss there first, and it turned out neither query had ever filtered on list.
3. **No member list.** Home doesn't list members; the roster is an admin view in the apps, ordered most recently active first, where *active* means using the app, not only changing a list: adding or editing a (non-seed) show, or opening an app or bringing it back from the background (to the hour). Only admins get that order or those times — a logged-out caller gets names alone, a member gets names and list counts, both alphabetical. Mechanics in `docs/ARCHITECTURE.md` (`last_activity_at`).

   Platforms: the **order** is server-side, so every roster gets it. What **counts as an open** differs: **iPhone/iPad and Mac** (Catalyst) check in on launch and on every return to the foreground (from 1.4.4); **Apple TV** the same (from 1.4.4); the **web** on every page load. **The watch doesn't** — it takes its session from the iPhone and never calls the check. Older app versions count cold launches only until members update.
4. **Search** — the magnifying glass opens **Find a Show** everywhere — apps, web and Roku (see [Search](#search)): search any title and add it.

## Favorite Actors

A list of the people who keep turning up in the shows **you rated highly,
loved, or are watching**, capped at ten. Each row names the actor, says how
many of your shows they're in, and links out to their IMDB page for
everything else they've been in. Under the name, the shows that put them there
draw as **standard show rows** — poster, network, rating — and tapping one
opens the same show card every other screen opens; they're the member's own
copies, just reached via the person.

**Ratings lead (2026-09).** Each of your titles is worth a weight, and an
actor ranks by the sum across their titles — so two shows you rated 10 beat
three you never rated:

| Your title | Weight |
|---|---|
| Rated 10 / 9 / 8 overall | 4 / 3 / 2 |
| On **Loved**, whatever you rated it | at least 2 — Loved trumps a low rating |
| On Watching or Awaiting, unrated | 1 |
| Rated 7 or below (and not on Loved) | left out |
| **Archived** and rated 8 or higher | counts, by its rating |
| Archived otherwise, or on **Next Up** | left out |

Only the **overall** rating counts — one great season doesn't make a favourite
of the whole cast. A show copy that's archived says *Archived* under it, in
orange, and any rated copy says *You rated 9*. The count on each actor is still
titles, not weight.

**Announcing the change.** Until a member opens Favorite Actors once, its
link on Home (and the iPad/web sidebars) carries an **UPDATED** pill — the
Groups *NEW* flag, reworded — and that first visit opens on a **"New
algorithm!"** card explaining that ratings of 8+ now count most. Both retire
per device on that visit (`seenFavoriteActorsUpdate` in `@AppStorage` on
Apple, `localStorage` on the web). A future ranking change can bring them back
by using a new key.

**Rate your shows.** Until you've rated **8** titles (overall, off Next Up), a
*Rate your shows* row sits at the top of the page and opens Rate My Shows. It
sits alongside the actors, never in place of them: the list works unrated, and
ratings are what sharpen it. Rate My Shows lists archived shows for exactly
this reason — see the *Member ratings* entry further down.

**Nothing here is curated.** There is no "favourite" flag and no way to add
one: the signal is already in the library and your ratings, and a second list
to maintain would only decay. Next Up is excluded for the same reason Trending
excludes it.

Two credits for the same person are one person: enrichment stores a TMDB person
id per actor, and a credit predating it (a bare name) resolves to the id the
member's own library already knows for that name, then to the id the club-wide
people bank knows, before falling back to the name itself. Without that
resolution the same actor split into two half-counted rows — which is how a
library full of favourites once rendered as a wall of "2 shows". A credit with
no IMDB id still counts — the row renders without a link rather than
disappearing and quietly changing the count.

**Platforms:** iPhone and iPad, and Mac via Catalyst (it gets the iPad sidebar
entry). **Apple TV doesn't** — it's view-only and has no per-member reads of
this kind. **The watch doesn't** — it's read-only and a list of links out to a
browser is useless on a wrist. **The web does** (2026-09, at Patrick's
request — an explicit exception to the [frozen web](#web-app-status)):
`/favorite-actors`, linked from the Home and member-page sidebars and under
the list on a phone, draws the same payload the same way — the *Rate your
shows* card, each actor linking to IMDB, their show rows with *Archived* and
*You rated 9* captions, and a click opening the show on your own page.

Owner-only: the endpoint reads the session's own member and takes no `?member=`
parameter. This aggregates a whole library into a sharper picture of taste than
the list titles a group-mate can already browse, so it does not follow the
group-scoped tier that Vibe and Also watching use.

Idea from Nico.

## Member page (`/<slug>`)

Tabs across the top for the four lists. Each show row collapses to one line (title, network, rating, badges), and tapping the title expands it to show genre, cast, recommender, dates, watching-with, and notes.

Two pieces of metadata are **always visible** under the row (not collapsed):

- **Awaiting list:** "Next episode: 5/9" — the next premiere date only (the finale date is never shown here). The label is "Next episode" rather than "Next season" because midseason episode dates can also appear here.
- **Every list shows the premiere date when one exists** (since 2026-07): Loved and Next Up rows carry the same "📅 Next episode" line — a show you thought was done can drop a surprise season, and the date is the nudge to move it back to Watching.
- **Next Up list:** "Recommended by Rosa" — surfaces attribution without an expand.

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
- **Groups** — every private group they're in, newest first, each with its size and who created it ("4 members · created by Stacy Matos"). Tapping one opens the group's roster; tapping anyone on that roster opens *their* admin member screen, which lists their groups, so an operator can walk outward from whoever they started with. A member in no groups says so.
- **Recent adds** — their eight most recent additions, newest first, with a relative timestamp. Bulk imports collapse to one line per list. Seeded starter rows never appear: a new member who has added nothing reads as having added nothing.
- **Open member page** — their four lists, exactly as they see them.
- then the editing controls (rename, emails, phones, make admin, disable).

The `lists:` totals and the "N shows" line under them come from the same query on the same terms (active, non-seed), so the four always sum to the one. `scripts/admin-member-detail-test.mjs` asserts it.

**Groups is the one place a private group is visible from outside it, and it stops at membership.** An admin sees names, rosters, sizes and who created a group they aren't in — a smaller disclosure than the login emails and phone numbers the same screen already shows them. What the group is *watching* isn't there: no shared library, no group trending, no lists. Reading a group doesn't join the admin to it, and it doesn't widen their own vibe, Also watching or cross-library results by a single row. A logged-in non-admin gets nothing at all from that endpoint, including for groups they belong to — they have the Groups screen for those. See [`INVARIANTS.md` §13](INVARIANTS.md#13-a-groups-membership-is-legible-to-admins-its-content-never-is).

**The signup notification email lands here.** That email deep-links to `/<slug>`, and the question it raises — who is this, and are they using it? — is this screen's whole content, so for an **admin session opening someone else's slug** the link resolves to the admin member screen rather than the member page. Your own slug still opens your page, and a non-admin following any slug only ever gets the member page. On iPad and Mac the sidebar moves to Manage members underneath it, so Back lands somewhere useful.

**Mac** gets all of it: Catalyst runs the same split view as iPad, and both entitlement files claim `applinks:showpicker.club`, so tapping the email's button in Mail on the Mac opens the same screen it opens on the phone. tvOS and watchOS have no admin tools (view-only and read-only respectively), and there is no web member app to put them on.

### Suggest a show

Any logged-in member can suggest a show to any other member via the **Suggest a Show for ...** button at the bottom of any list. The suggestion lands on that member's Next Up list with the recommender attribution pre-filled and "Suggested · &lt;your notes&gt;" prepended to the notes.

### Share to another list / member

The **+** button on any show row opens a share modal. The original member can copy the show to their own other list (rare) or to any other member's Next Up. The whole show — including rating, network link, cast, and notes — carries over.

### Edit, archive

Logged in as yourself, every row gets Edit and Archive buttons inline. Editing re-runs enrichment if the title changes. Archive sets `archived=1`; archived shows are still searchable but don't appear in lists, trending, or vibe.

## Web app status

**The web member app is back** (restored 2026-08, four weeks after the teardown
that removed it), and it is the site root again, as it was before: opening
`showpicker.club` gives you the app, and `/patrick` renders that member's lists
in a browser. The App Store pitch moved to `/download`, which is what the
listing and the Ads campaign point at, and it links back into the app.

The layout isn't a preference — it's the only shape Cloudflare Pages supports.
A first attempt put the app at `/app` and left the pitch on the root; the
catch-all rewrite that makes member slugs work can only point at `index.html`,
and pointing it anywhere else took the whole site down for a few minutes on
2026-08-13. [`ARCHITECTURE.md`](ARCHITECTURE.md#the-catch-all-can-only-point-at-indexhtml)
has the three rules that were tried and what each one does.

What this means in practice:

- **Member pages keep their own URLs.** `/patrick` renders Patrick's lists with
  the URL intact, which is also what lets iOS resolve it against the
  associated-domains file and open the native app instead.
- **Web sign-in works again.** Email code, phone code, Sign in with Apple and
  Sign in with Google all live in the SPA's login sheet; the `/auth/*` endpoints
  never changed, so nothing server-side had to be rebuilt.
- **`welcome.html` is a real conversion URL again.** Fresh web signups land
  there, which is the page the Smart campaign's conversion tracking watches.
- **The admin tools are back on the web too** — Reporting, Manage members, Show
  Cleanup and Vibe trait scoring — alongside their iOS counterparts.
- **The layout is mobile-first**, which is how it always was: the SPA was built
  phone-first and widens into a split view on iPad and desktop. No separate
  small-screen build exists or is needed.

**The web keeps up now (2026-10-03).** From its restoration until October the
web was frozen on purpose — fixes only, no features — so it fell behind iOS by
design. Patrick ended that: "No more leaving it behind." A member-facing
feature ships on the web alongside iPhone/iPad. The only exceptions are things a
browser can't do or that were retired deliberately: home-screen widgets, the
share extension, shake to pick, the watch hand-off, and offline support (the
PWA was retired in 2026-08 and stays retired).

**Closing the freeze-era gap**, in order, one PR each:

1. Show card — Also watching, Also on / Now on, tagline, language, episode
   count, the finale date, each co-creator linked, Added by, Share; Trending
   "More"; Connected apps in the account menu; shared show links open in a
   browser. **Done.**
2. List controls — Next Up genre filter, TV / Movies filter, quick moves and
   Archive with Undo from the list (a ⋯ menu on your own rows stands in for
   iOS's swipes), and "couldn't load" kept apart from "empty". **Done.**
3. Groups — Watch Next board and pop-up, Recommend to group, icons, change
   notice, rename by any member, invite limits, invite links that survive
   signing in, and the NEW flag on Groups. **Done.**
4. Add / edit — the Watching With member picker, the server's network list,
   the Archived toggle, multi-line Notes. **Done.** (Find a Show on someone
   else's page still opens the short "add to my list" form.)
5. Calendar screen; household invite and join. **Done.**
6. Import a list. **Done.**
7. Passkeys. **Done.**
8. Admin — member detail (groups and recent adds on Members), the missing
   Reporting sections (sign-in methods, account creation, calendar, logins),
   and the foreground vibe re-score with its per-title log. **Done.**

The freeze-era gap is closed. What remains different is deliberate: no
widgets, share extension, shake to pick, watch hand-off or offline mode (none
is a browser thing, and the PWA stays retired); group icons drawn as emoji
rather than SF Symbols; and Find a Show on someone else's page still opens the
short "add to my list" form. New work keeps parity from here — see
CLAUDE.md's working preferences.

## Native apps

The native iOS, tvOS and watchOS clients are where the product actually lives (see Web app status above; the PWA itself was retired in 2026-08). The watchOS app (paired to the iPhone) shows the four lists → shows → detail; its session is handed off from the phone, and member reads depend on that handed-off session (they are not public). There is deliberately no watch-face complication (one shipped briefly in 2026-07 and was retired — it rendered unreliably on device).

### Navigation standard

**Home leads, and Home is the launch screen — on every platform.** Wherever the app has a tab bar or a top-level nav list, Home is the first item, followed by My Shows; the app opens on Home whether or not a session is already stored. Signing in *during* a session still takes you straight to your lists (you asked for them), but restoring a session at launch does not.

iPhone and iPad satisfy this by construction — both are rooted at Home, with My Shows the first row of its nav list. On tvOS it's the tab order plus a launch rule: the sign-in jump to My Shows only fires from the Account tab, so a stored session resolving at launch leaves you on Home.

**iPhone Duo** gets both layouts. Folded, the outer display is an ordinary iPhone and gets iPhone Home. Unfolded, the inner display is regular width and height, so it gets the iPad sidebar layout — the app chooses by size class, not by device, so any iPhone-family window with room for a sidebar gets one, while a large iPhone in landscape keeps the phone layout. Folding or unfolding keeps your place: the screen you were on (a member's lists, a show, a group, an admin tool) is reopened in the other layout. Two things don't carry over — which of the four lists My Shows had open (it reopens on Watching), and the Vibe, Subscription audit and Rate my backlog screens, which the phone reaches from Home rather than by address, so folding from one of them lands on Home. If a sheet is open (an edit, sign-in, search), the switch waits until it closes rather than discarding what you were typing. Partially folded, a show page gives its artwork one side of the crease and the details the other (artwork above when it stands like a laptop, beside when held like a book); flat or closed, and on every other device, the show page is unchanged.

The **Groups** nav row carries a `NEW` flag on iPhone Home and in the iPad sidebar until the member opens Groups once (`seenGroups`, `@AppStorage`), after which it never comes back. It sits immediately after the word "Groups" as an accent-filled capsule rather than in SwiftUI's trailing `.badge()` slot — at the far right, in secondary grey, it read as a count and got lost against the row. A badge that never clears is decoration; this one has a job and then goes away.

The iOS app ships **home-screen widgets** on iPhone, iPad, and Mac (the Mac Catalyst build): **Trending** (public, the club's rolling top adds; small/medium/large + extra-large on iPad/Mac) and **Up Next** (the signed-in member's calendar by date; small/medium/large + iPhone Lock Screen). Tapping a show opens its card in the app via `showpicker.club/show/<id>` universal links. tvOS and watchOS have no widget equivalent.

**Up Next shows the next thing on your calendar, not the next premiere.** It carries exactly what the Calendar screen and the `.ics` feed carry — season premieres *and* season finales from Watching and Awaiting, one row per show (whichever of its two dates comes first), each row saying which it is ("Premieres Aug 20" / "Finale Aug 14"). Premieres alone left the widget empty for weeks at a stretch, since only a fraction of tracked shows have an announced return date at any moment. Empty now means genuinely nothing dated ahead.

### Genre filter (Next Up)

Next Up carries a **genre dropdown** in the same menu as sort — "All Genres"
plus the genres actually present on that list, commonest first.

**Next Up only, on purpose.** It's the list that grows without limit — the
someday pile — so it's the one where "just show me the comedies" is how you
pick something. The other three stay short enough to read straight through.

Options are the intersection of the list's own genres with TMDB's top-level
set, so the menu never offers a filter that matches nothing and never fills
with the niche tags a title also carries. It appears only when there's more
than one genre to choose between; a one-option dropdown is furniture.

**One menu, on every surface that has it.** Sort, the TV / Movies filter and
the genre filter all sit behind a single sort-and-filter button
(`line.3.horizontal.decrease.circle`) at the right of the list title, as
pick-one sections with a checkmark. The web had them as three pills side by
side until 2026-10, which ran off the edge of a phone on Next Up — the one
list that shows all three. The web's icon fills in while a filter is
narrowing the list, so a short list never reads as the whole list.

Two rules keep it from lying: while drag-to-reorder is active the filter is
ignored, since repositioning rows against titles you can't see would write an
arrangement you didn't intend; and when a filter empties the screen the list
says *"Nothing on this list is Comedy"* rather than showing the empty-list
copy for a list that isn't empty.

**Platforms:** iPhone and iPad, Mac via Catalyst, and the web (a select beside
Sort). Not Apple TV or the watch.

Idea from Liza.

## Sort and toggle controls

Footer of each list:

- **Sort:** by Rating (default), A–Z, Date Added, or **My Order (drag to sort)** on your own lists. On another member's page the same slot reads **"{Name}'s Order"** and sorts by their saved arrangement, read-only — no drag handles, and the server-side reorder endpoint only ever writes the session member's own rows. Picking My Order puts the list in reorder mode: every row grows a ☰ grab handle (with a how-to hint above the list) and dragging saves the order immediately. The order is stored per list on the server (`sort_order`), so it follows the member across web and iOS; which sort mode is active stays a per-device choice. Shows added after the last drag sink to the bottom of My Order until placed.
- **Toggle pills:** Ratings, Networks, Recommended By, Dates, Notes, Genres — each can be hidden globally.

## Search

**Apps (iPhone, iPad, Mac): one search, and it's how you add a show.** The magnifying glass on Home, on My Shows (and ⌘F) opens **Find a Show**. What you type goes to TMDB, so every show or movie that exists turns up — not just the ones somebody in the club already has. Tapping a result opens Add Show with that exact entry pinned (poster, rating and cast come with it) on the list you were looking at; "Add “…” by hand" covers anything TMDB doesn't know. There is no separate **+** any more.

Why: a new member reached for the magnifying glass, which then searched only the shows their group-mates already had, found nothing, and concluded the show couldn't be added — the **+** that could add it looked like a different job. With libraries private to groups, what someone else has is context, not the thing being searched for.

The club still rides along as context:

- **On your lists** — your own copies whose title or cast matches, archived ones included (in orange). Tapping one opens its card, which is where Restore lives. A title you already have shows once, as your copy, not again as a TMDB result.
- **Who in your groups has it** — each result names the group-mates with that title and the list it's on ("Quinn · Watching, Amy · Loved"), matched by title and movie-vs-series. Nobody outside your groups is ever named.

The sheet stays open after an add — the show moves up into *On your lists*, which is the confirmation — so several can be added in a row. It's the same search on another member's page too — the magnifying glass there opens Find a Show rather than a search of their library, and an add goes to **your** lists (starting on Watching, since their list says nothing about yours). Their shows are already on screen, and a result names them if they have it.

**Apple TV** gets the same thing in its **Search** tab: TMDB results as poster cards, your own copies (archived included) in an *On your lists* row above them, and the group-mates who have a title under its poster when it's focused. Picking a result asks which list, adds it, and returns to the results. There is no "Add a Show" button on My Shows any more — the empty state points to Search. "Add … as typed" covers titles TMDB doesn't know; the TV can't set network, notes or Movie on those, same as it never could — edit on the phone.

**Web:** the same Find a Show, in the search modal behind the magnifying glass (home, sidebar and every member page; `/` or `n` on a member page). The + beside the page title is gone, as are the old per-member and all-libraries searches. Picking a result on your own page opens the full Add Show form seeded with the tab in view; anywhere else it opens the short "add to my list" form, since the page's lists aren't yours. Unlike the apps, the modal closes when you pick a result.

**Roku:** the same, in the channel's Search screen — see `roku/README.md`.

## Calendar feed

Each member has a personal iCal feed at:

```
https://showpicker.club/calendar/<slug>.ics       (HTTPS for Google / Fantastical)
webcal://showpicker.club/calendar/<slug>.ics      (Subscribe in Apple Calendar)
```

The feed contains one all-day event per known **next-season premiere date** and per known **season finale date** for shows on that member's Watching and Awaiting lists. Event titles are `<Show> on <Network>` (no "next season" wording because midseason dates also appear). Event URL deep-links to the show on the network's site (when known); event description includes the recommender and a link back to the member's app page.

Calendar apps re-fetch the feed on their own schedule (Apple Calendar typically every hour; the feed sets a 24-hour `REFRESH-INTERVAL` hint).

A "📅 Calendar feed" link in each member-page footer opens the `webcal://` URL, which Apple Calendar recognizes as a one-tap subscribe.

The **Calendar** nav row opens a Calendar screen on every surface that has one — iOS's `CalendarView` and, since 2026-10, the web's `/calendar` — listing the same dates grouped by month (one row per show, whichever of its premiere or finale comes first), with **Subscribe in Calendar** at the top. It used to be a bare `webcal://` link on the web.

## Import a list

The other side of Export: a member arriving with a list they already keep somewhere else — Notes, a text file, an old spreadsheet, a message thread — can paste it in and have it sorted onto the four lists instead of typing it out one show at a time.

- **iPhone / iPad / Mac:** shipped, reached two ways.

  **Permanently**, at any library size: **Paste a List…** in the account menu (the person icon — on iPhone Home, on the iPad and Mac sidebar), and a clipboard button in the **My Shows** toolbar on your own lists. Both are logged-in members only, and both write to the caller's own lists, so the toolbar button is absent on another member's page.

  **Plus onboarding nudges** that retire themselves once the member has a library: a card on **Home** while their library is empty (Home is the launch screen, so a new member sees it before they ever reach My Shows), and a slim row above their own list while they have five shows or fewer across all four lists. The empty state on their own Watching / Next Up list also offers it.

  The permanent entries were added because the nudges were originally the *only* way in: past five shows the feature became unreachable, even though the per-day ceiling below implies repeat use.
- **Apple TV / Apple Watch:** not offered (view-only / read-only surfaces).
- **Web:** the same three steps (paste → reading → review → add) since 2026-10, from **Paste a list…** in the account menu on every page, a card on Home while your library is empty, and a link in the empty state of your own lists. A plain list lands on the list you were looking at.

How it goes:

1. **Paste.** A plain text box. Headings like "Currently watching" or "Favourites" are read as section markers and applied to the titles under them; a note next to a single title stays with that title.
2. **Read.** The paste is sent up and comes back as a list of titles, each matched against TMDB for its canonical spelling, year and poster. A long paste shows real progress rather than an indefinite spinner. **Nothing is written at this point.**
3. **Review.** Every title, with the list it landed on, editable. Tap the circle to leave one out, or change its list. The row says when a title was spelled differently from what was typed ("You wrote *Severence*"), when TMDB had no match (it's still offered, and goes in as typed), and when the member already has it.
4. **Add.** Only then are rows written, and only ever to the caller's own lists.

Details that matter in use:

- **Notes and people come along.** "Quinn told me about this", "with Rosa", "s4 in September" and the streaming service are pulled out into the same fields the add form fills in — not left glued to the title.
- **Titles you already have are greyed out** and can't be ticked back on, archived ones included, so the screen never promises an add that silently doesn't happen.
- **No length limit.** A very long paste takes longer; it isn't truncated or capped. There is a per-day ceiling of 300 rows across imports and hand-adds together.
- **Artwork and cast fill in shortly after**, not at import time — the rows appear immediately with a poster and land fully enriched a little later.
- **A title the paste doesn't place lands on the list you opened the importer from.** Paste a bare list of titles while looking at Next Up and they go to Next Up; from Watching, Watching. Headings in your paste still win — "Loved" over a title puts it on Loved wherever you started. The two Home doors have no list in view, so they use Watching.
- **That fallback is why the review step exists.** Watching feeds the calendar (which draws from Watching + Awaiting), so a list that lands there lands in a subscribed feed too.

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

**With a household, every show says whose it is.** Once you've invited someone to your household, the audit pools their lists with yours — so a service can be a "keep" on the strength of a show you've never started. Each row in the "Why?" list names the people who have that title, annotated with their own list when it differs from yours ("You · Rosa (Next Up)"), and the keep verdict names the watcher outright: "Active now: Severance (Rosa)." On a solo audit nothing changes — with only your own lists pooled, naming the viewer would say nothing.

You stay in control: every service has a **Subscribed / Paused / Cancelled** toggle (the verdict is only a suggestion), an editable monthly price (pre-filled with a sensible default per service), and — for paused services — a **resubscribe date**. Setting that date drops a "Resubscribe to <Service>" reminder onto your [calendar feed](#calendar-feed), right next to your premiere and finale dates. You can also **add a service** you pay for that has no tracked shows (a sports or music package) so the monthly total reflects everything.

Prices are editable defaults — approximate US standard-plan rates that each member can correct to what they actually pay. Implementation in [`ARCHITECTURE.md`](ARCHITECTURE.md#subscription-audit).

Platforms: iPhone and iPad only, the whole audit and the household viewer names with it. **Apple TV doesn't** — it's view-only, and cancelling a subscription isn't something you do from the couch with a remote. **The watch doesn't** — it's read-only, and a spend audit needs the toggles and price fields it has no room for. **The web has it** — `subscriptions.html` came back with the 2026-08 restore (see [Web app status](#web-app-status)), reading the same API the iOS audit does, and since 2026-10 the same household screen: invite by link (Share / Copy), Remove per person, and a household link opened in a browser accepts there (signing in first if needed).

## Vibe

A taste-profile view. Pick yourself, or anyone you share a [group](#also-watching-groups) with, to see:

- **Cluster identity** — one of eight personas (Warm Comfort Viewer, Prestige Drama Loyalist, Dark Complexity Seeker, Satirical Cynic, Power Game Watcher, Chaos Goblin, Curious Omnivore, Empathy & Healing Viewer) with a one-line tagline. You are matched against **the club** — where you sit relative to other members, not against the trait scale — so a taste everyone in the club shares doesn't decide anyone's persona. **Nobody in your group gets the same persona as you** while there are personas left to hand out: comparing is the fun, and it dies if half the group reads the same. That deliberately costs some accuracy — if you and a group-mate really are the same, one of you is shown the closest vibe nobody else claimed, and the tagline says so. Two cases where the screen declines to assert: under five scored titles there is no persona at all (the traits and picks still show), and a member sitting between two clusters is told so instead of being handed the winner by a hair.
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
has it** — `vibe.html` came back with the 2026-08 restore (see
[Web app status](#web-app-status)), on the same `/api/vibe`.

## Connect an AI app (MCP)

Members can connect **Claude, ChatGPT or Claude Code** to their account and
use Show Picker Club by chatting: "what's on my Next Up that's under an
hour?", "add The Bear to Watching", "I finished Severance — move it to Loved
and rate it a 9", "what are people in my groups watching that I'm not?".

- **Connecting.** `showpicker.club/connect` has an **Add to Claude** button
  (Claude's add-connector dialog, pre-filled), the server URL to copy for
  ChatGPT, and the one-line command for Claude Code. The AI app then sends
  the member to a Show Picker sign-in and consent screen: it names the app and
  the site it will return to, and **Make changes** can be unticked to connect
  read-only. Signing up there works too — it's the normal sign-in sheet.
- **What it can do** is what the member can do in the app, through the same
  rules: read their own lists (notes included), see group-mates' lists and
  the group board, search the catalog and their groups' libraries, Trending;
  and — if allowed to make changes — add, edit, move, reorder, rate, archive,
  restore and delete their own shows, name group-mates in Watching With,
  recommend to a group and answer recommendations, create a group, make an
  invite link and leave a group.
- **What it can't:** join a group (invite links are opened by people), rename
  or delete a group, anything household, account settings, passkeys, import,
  admin tools — even on an admin's account. It sees other people's lists only
  through shared groups, never their private notes.
- **Limits.** 1,000 changes and 1,000 catalog searches per member per day from
  connected apps, resetting at midnight UTC; the AI app is told when a limit is
  hit. Reading lists doesn't count toward either, so bulk work (rating a list
  of a hundred shows) fits in a day. The change limit is set by the
  `MCP_DAILY_WRITE_LIMIT` Pages variable, 1,000 when unset.
- **Disconnecting.** `showpicker.club/connected-apps` lists each connected app
  (where it lives, read-only or not, last used) with **Disconnect**, which
  takes effect immediately. Removing the connector inside the AI app does the
  same. A connection left unused for 90 days expires on its own.

Platforms: it's a server feature, so it works for **every member regardless
of device** — it runs inside their AI app, not ours. The connect, consent and
Connected apps screens are **web pages** because OAuth sign-in is a browser
flow; that's the one deliberate exception to the frozen web, not a web
feature. **iPhone/iPad** (and Mac via Catalyst) get **AI MCP…** (the Connected Apps screen) in the
account menu, next to Passkeys: the same list with Disconnect (swipe, or
right-click on Mac) and a link out to `/connect`. **Apple TV, the watch and
Roku don't** — nothing to manage from there; the web page covers everyone.

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
- **/vibe-admin** — batch-scores show traits using Claude, sending each title a calibration prompt that asks for 27 trait scores (0–1) and writing the result back. Filling missing scores runs only on the daily cron now (no button on the page); the page's own control starts or cancels a full re-score of every existing report, for when the prompt or model improves.

There is no admin role in the session model — admin actions are gated purely by knowing the `ADMIN_SECRET`.

### Streaming Link Check (Apple TV, admin sessions only)

A diagnostic, not a member feature: Account tab → **Streaming Link Check…**,
shown only to an admin session. It lists every candidate URL scheme the tvOS
Watch button would try, one button each, and pressing one attempts the open on
*that* Apple TV. Green check means the device opened it, red x means it refused,
hollow means untried; a pass switches apps, so results are written to
`UserDefaults` the moment the completion fires and are still on screen when you
come back. Each service carries what the last audit established (Peacock and
Disney+ opened 8/12/2026; Netflix's vendor removed deep links in a Sept 2025
update; Paramount+ reported broken since Nov 2023) so a fresh red x reads as
"still broken upstream" rather than "new regression."

It exists because streaming services retire their tvOS URL schemes without
notice and a real device is the only place to find out. Before it, the loop was
"notice a dead Watch button on some show, guess which leg failed, ship a build
to find out." The scheme table lives in `StreamingApps.swift` so the check and
the Watch button read the same source — a diagnostic that reports schemes
production no longer tries is worse than none.

A second section, **"Does it open on the show?"**, asks the question the scheme
rows structurally can't: a bare `scheme://` has nowhere to put a show id, so a
green row up there only ever meant "the app launched". Each row here is a real
title with the real `network_url` the club stored for it, so a red row means
the link is dead rather than that the sample was mistyped. Apple TV+ and HBO
Max double as **controls** — they are known to land on the show, so if either
fails the device or the build is at fault, not the vendor. Read the dot
narrowly on this section: it records that the device *accepted* the URL, which
Prime Video proved is not the same as landing on the show (it accepts, then
says it can't stream the title).

**What it found, 9/10/2026: Prime Video deep links are alive.** The club stores
Amazon links in four shapes and only one reaches the show —
`watch.amazon.com/detail?gti=…` opens Prime Video *on the title*, while
`amazon.com/gp/video/detail/<ASIN>`, `amazon.com/<slug>/dp/<ASIN>` and
`primevideo.com/detail/<id>` all fail. Of 110 Prime rows carrying a URL, 32
were the working shape, 31 `gp/video`, 28 retail `/dp/`, 19 `primevideo.com`.
That reframes a dead Watch button on Prime from "the vendor blocks us" to "the
row holds the wrong shape", which is ours to repair.

Platforms: **Apple TV only, and deliberately so** — the thing being tested is
whether *this* tvOS device opens *this* streaming app, which no other platform
can answer on its behalf. **iPhone and iPad don't** get it: their Watch button
opens https deep links through the web, a different mechanism with a different
failure mode, and the iOS Admin tab is where member management lives, not device
diagnostics. **The watch doesn't** — read-only, and it opens nothing. **The web
doesn't** — device diagnostics belong in the Admin tab, not the browser app
(see [Web app status](#web-app-status)).
This is the one exception to the "no admin screens on tvOS" rule below.

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

**tvOS and watchOS are view-only by design** — no *member-management* admin
screens; the TV's account screen shows a cosmetic "Operator" label, plus the
one operator tool that has to run on the device it's testing
([Streaming Link Check](#streaming-link-check-apple-tv-admin-sessions-only),
8/2026). Nothing on the TV reads or writes another member's data.
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
    the web is a different integration from the native one, and the browser
    app uses it again since the 2026-08 restore (see Web app status).
  - App Review needs a working demo account. `DEMO_LOGIN_EMAIL` /
    `DEMO_LOGIN_CODE` is an email-code login today, so removing that path
    means giving Review another way in first.

  What comes out once it's done: Twilio (secrets, Verify service, the 10DLC
  campaign), Resend for login codes (transactional email may still be wanted
  elsewhere), `login_otps` / `enroll_otps`, `/auth/request-code`, the SMS
  half of `/auth/login`, `member_phones`, `public/sms.html`, and the SMS
  sections of the privacy policy.

- **Registered A2P campaign text is behind the site.** The site half was
  fixed 2026-08-30: `public/sms.html` and the SMS section of
  `public/privacy.html` now describe login codes as the only text we send,
  and no longer call the club "invitation-only" or promise the
  recommend/share alerts retired in 2026-07. What remains is the operator
  half the old entry warned about: the consent language registered with
  Twilio for the A2P 10DLC campaign still carries the old wording, so the
  registered campaign text needs updating (Twilio console) to match the
  page's consent block verbatim. Until then the registration over-discloses
  message types we no longer send — not a compliance emergency, but the two
  texts should say the same thing again. (This whole entry dissolves if the
  SMS channel is retired first — see the entry above.)

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
  8/10/2026; **on-device audit done 8/12/2026**, see
  ARCHITECTURE.md#tvos-watch-button.) Patrick wants streaming deep links to
  work consistently across services, not one bug at a time. The 8/12 pass
  walked every network the club carries on a real Apple TV and fixed what it
  found, so all eight now at least launch their app. What remains open is the
  harder half: only HBO Max and Apple TV+ land on the actual *show*.
  Everything else opens its app to the home screen, because those services
  don't publish a show-level entry point tvOS will accept.

  The previously agreed direction — store an Apple TV (`tv.apple.com`) link as
  a universal fallback while keeping `network` set to the service that
  actually carries the title — is **not** superseded, but note the 8/12
  finding that killed the client-side version of it: looking a title up in
  Apple's catalog from the app (iTunes Search) matched episode titles across
  the whole catalog and sent members to the wrong show entirely. If this is
  revisited, the Apple link has to be resolved server-side against a real id
  and stored, never guessed by title at tap time. See "Apple links vs. stored
  network" in ARCHITECTURE.md.

- **Karma scoreboard.** (Roger — 8/13/2026.) Participation earns points and a
  leaderboard ranks the club: watching shows, rating them, adding to lists and
  recommending all score. Roger's framing — "the more you participate ... the
  more points you score on the board."

  Most of the raw material is already recorded. `shows.updated_at` is bumped
  only by member-initiated writes (enrichment stamps `enriched_at` instead), so
  the database already distinguishes a member doing something from a background
  job doing it to them; `show_ratings` has the ratings; `/api/activity` already
  reconstructs a who-added-what feed and already knows to skip seeded rows
  (`added_by='seed'`, NULL `created_at`) so a starter list doesn't read as
  activity. A first scoring pass is closer to a query than a feature.

  Three questions to answer before building, none of them technical:

  - **What it does to the four lists.** They are deliberately narrow and
    "force a clear judgement" — points for adding rewards volume, which is the
    opposite pressure. If this ships, the scoring probably has to favour acts
    of judgement (rating a show, promoting Watching → Loved, marking a season
    done) over acts of accumulation (adding a title). Worth deciding
    explicitly rather than discovering it from a padded Next Up.
  - **Who can see whose score.** A leaderboard is a new cross-member surface,
    and cross-member reads are group-scoped everywhere else (see
    [`INVARIANTS.md`](INVARIANTS.md) §12 and the Vibe scoping rules). Club-wide
    or per-group is a product call; either way it needs a session, and it must
    not become a public surface. Note also `_shared/excluded-members.js`, which
    bounds club-level *math* today — whether an excluded member appears on a
    leaderboard is the same question in a new place.
  - **Whether a two-member club wants a ranking at all.** Production is small,
    and a leaderboard between two people is a different social object than one
    between twenty. A personal streak or a "your year in shows" summary may be
    the same idea at the right size.

  Platforms if built: **iPhone/iPad** get the board and whatever earns points.
  **Apple TV** could display it — it's view-only, and a leaderboard is a fine
  thing to render on a TV — but earns nothing there. **The watch doesn't**;
  read-only and no room. **The web doesn't** — it's frozen at its restored
  state (see [Web app status](#web-app-status)).

## Shipped (formerly backlog)

- **Member ratings.** (Amy 7/16, Susan 7/22, Rob 7/23 —
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
  - **Bulk rate-your-backlog (shipped):** `/rate-backlog` — every show
    not on Next Up, **archived included** (it was left out once — "tried
    including it, cut it after actually using the flow" — and came back
    2026-09 because Favorite Actors now counts an archived show rated 8 or
    higher, so the page it sends people to has to be able to rate one).
    Archived rows say *Archived* instead of a list name, and a title held
    twice (say, archived and live) is one row. Overall rating only, 10-segment
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
  - **Shipped in v1.1 (build 19)** and long since on the Store — every build
    through 1.4 (build 23) carries the native ratings UI. Confirmed done
    2026-08-30; nothing left on this entry.

- **Give each group an icon** (backlogged 2026-08, shipped in code
  2026-08-30). A per-group SF Symbol plus a named accent color, from curated
  sets, so groups are recognizable at a glance everywhere their name appears.
  Migration 066 adds nullable `icon` and `color` to `groups`;
  `functions/_shared/group-icons.js` is the server-side allowlist (a value
  outside it is a 400, so clients render what arrives without
  re-validating), and `ShowPickerCore.GroupIcon` mirrors the same sets for
  the picker. Create and PATCH (absent key = leave alone, null = clear)
  carry the fields. **iPhone/iPad** pick and render (badge on the Groups
  list rows, the group detail header, the create sheet, and a "Change icon"
  sheet); **Apple TV** renders the badge on group tiles and the detail
  header, view-only as ever; the watch has no groups. The **web** picks and
  renders them too (2026-10), drawing each symbol as an emoji on the same
  tinted disc, since a browser has no SF Symbols. A group that
  never picked gets a neutral default badge rather than a hole. Needs the
  next app build to be visible in the apps.

- **Renaming and re-icon-ing a group are open to any member, not just its
  creator** (backlogged 2026-09, shipped in code 2026-09-08). The original
  Change icon build gated both on `is_creator` — Patrick hit it directly: a
  group he was a member of but hadn't created showed no Change icon option
  at all. Migration 068 lifts the bar on `PATCH /api/groups/[id]` to any
  group member (Delete stays creator-only). To keep an edit from being a
  silent takeover, the group remembers who last touched its name/icon and
  what, and `GET /api/groups/[id]` tells every *other* member once — a
  banner at the top of the group screen, "X renamed the group" / "X changed
  the group's icon" / both — the first time they open it after the change;
  never to the member who made it, never to a member who joined afterward,
  and never a second time. **iPhone/iPad** only, matching where the edit
  itself lives. Needs the next app build.

- **Show Picker movie filter** (Patrick — 7/26/2026). Shipped as the
  TV/Movies filter on a member's lists on iPhone/iPad/Mac, using `is_movie`:
  originally a chip row under the list header, moved 2026-08-30 into the
  sort/filter menu at the top (per Patrick — same menu as sort and the Next
  Up genre filter), with counts on each option. Only offered on a list that
  holds both kinds; remembered per list; ignored while reordering. Trending,
  search, tvOS and watch don't have it — nobody has asked there. The web
  has had it since 2026-10, in the same single menu.

- **Share / recommend a show within a group** (JC, via Jennifer —
  8/23/2026; JC's pop-up proposal 8/25/2026), shipped 2026-08 as
  [Watch Next](#watch-next-group-recommendations). Built exactly to the
  settled direction: a group-owned board with pull-only adoption, wearing
  JC's UI — a "Recommend to group" button, and a pop-up ("JC has recommended
  Lanterns") with Dismiss or Add to Next Up as its delivery layer. Zero new
  cross-member writes (Watching With remains the only one); the note on a
  card is group-visible by design; delivery is in-app on the next visit to
  the group, no push infrastructure. Migration 065 (`group_suggestions` +
  per-member `group_suggestion_responses`); rules in
  [`INVARIANTS.md`](INVARIANTS.md) §12a, enforced by
  `scripts/group-suggestions-test.mjs`. Shipped minimal per the retired
  feature's autopsy — recommend + pop-up + board, no votes, no comments, no
  threading — to see whether JC's group actually uses it before elaborating.

- **Tag member friends** (Patrick — 7/26/2026), shipped 2026-08 as
  [Watching with](#watching-with). The scope question the backlog entry
  flagged — "this brushes up against the retired cross-member writes and the
  no-comments stance, needs a deliberate call" — was answered by making the
  tag *the existing Watching With field* rather than a new social object.
  Deliberately: no notifications, no threads, no inbox, nothing to accept.
  A tag names a person in a field that already existed, and its one side
  effect is the show landing on their list. Migration 064 (`show_watchers`),
  gated on shared private-group membership; see
  [`INVARIANTS.md`](INVARIANTS.md) §12 for why that gate is what made the
  cross-member write acceptable when suggest-a-show and share-to-member were
  not.

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
  rename (still shared by the URL queue). In 2026-10 the conflict tool,
  `fix_title`, `re_enrich` and the missing-posters queue went too, with
  `_shared/title-fix.js`: TMDB names every show now and the nightly passes
  fill details by TMDB id. The `title_ok` column stays on
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
