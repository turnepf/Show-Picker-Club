# Release notes

The **What's New** text for App Store Connect. There is no in-app What's New
screen any more (retired 2026-08 along with `whats-new.json`, `whats-new.html`
and `WhatsNewView`), so this file is where release notes live.

**How to use this file.** Add to *Unreleased* as user-facing work merges —
while you still remember why it mattered — rather than reconstructing it from
`git log` on submission day. When a version ships, move that section under a
heading with its version and date and start a fresh *Unreleased*.

**Voice.** Written for members, not for engineers: what changed for them and
why it's better. No file names, endpoints, or internal terms. Apple shows the
first two or three lines before "more", so the most useful change goes first.

---

## Unreleased — the update after 1.4.1

**Anyone in the group can rename it or change its icon**, not just whoever
started it — the option simply wasn't there for anyone else before. If
someone else renames the group or picks a new icon, you'll see a quick note
about it the next time you open the group. On iPhone and iPad.

*(Server-side, live for everyone the moment it deploys — no app update
required. Listed so the story is complete; the member-facing halves are in
1.4.1 below.)*

- Movies have genres again. The background pass that fills a film's details
  was only ever reaching films missing their artwork, so 125 of 137 movies
  carried no genre, description or running time at all. The visible symptom:
  filtering Next Up by genre hid every movie, because no movie matched any
  genre. The backlog drains on its own now.
- Movies show their streaming service's logo on Apple TV. Films never carried
  one — the badge TV shows have comes from a field TMDB doesn't publish for
  movies — so a film's card sat blank where a series' card showed Max or
  Netflix. It now comes from the service the film actually streams on. A movie
  you can only rent still shows none, because it streams nowhere — as does one
  whose service the film isn't actually listed on, rather than showing the
  wrong company's logo.

---

## 1.4.1 (build 24) — version bumped 2026-09-08; not yet archived

Covers everything merged since **1.4 / build 23**, which reached the App Store
on **2026-08-26**. A point release rather than 1.5: the changes are refinements
to surfaces that already shipped, plus one new group feature that lives inside
the group screen.

Applies to **iPhone, iPad and Mac**. **Apple TV** gets the group icons on its
group tiles and the group's Watch Next board, both read-only. The **watch** is
unchanged — it has no groups at all. The **web app** predates all of it and
stays that way on purpose (`docs/PRODUCT.md#web-app-status`).

**Archive from a Mac running release Xcode.** The version bump is committed
(`MARKETING_VERSION = 1.4.1`, `CURRENT_PROJECT_VERSION = 24`, in both
`ios/ShowPickerIOS.xcodeproj` and `tvos/ShowPickerTV.xcodeproj`), so the
archiving Mac needs only a pull — no Xcode edits before Product → Archive.

**Expect to create the version records in the UI.** 1.4 shipped on all three
platforms, so iPhone, Apple TV and Mac each need a fresh 1.4.1 record. When
`POST /v1/appStoreVersions` refuses with *"You cannot create a new version of
the App in the current state"*, App Store Connect's own ＋ Version or Platform
button creates it without complaint. That was the lesson from 1.4; it costs
nothing to reach for the UI first.

All platforms carry the same What's New text, byte for byte. The block below
is 2,492 characters against Apple's 4,000 cap.

```
Recommend a show to your group. Found something the group needs to see? Open
the show, tap Recommend to group, and add a note if you like. Everyone in the
group gets asked about it the next time they open the group — one tap adds it
to their own Next Up, or they can dismiss it. Every recommendation also lives
on the group's new Watch Next board, so a pick someone dismissed can still be
added later. Nothing ever lands on anyone's lists except by their own tap.

JC's idea. Thank you, JC.

Your whole library, offline. The app now saves the posters, artwork, cast and
ratings for everything on your lists ahead of time — not just the shows you
happen to have opened recently. Go offline and every show on every list looks
and works the way it does online.

Widgets that work on a plane. The Trending and Up Next home screen widgets
remember what they last showed you. Lose the connection and they keep your
shows and their posters instead of going blank. Up Next keeps its dates
honest offline too: anything that has already aired drops off.

Give your groups a face. If you created a group, you can give it an icon —
pick a symbol and a color and it shows up everywhere the group does, so
Thursday Night Club and the family group stop looking like two lines of the
same text. Choose it when you create a group, or add one later from the
group's menu.

Your shows say where they stream now. Licensing moves, and the service you
noted when you added something can quietly stop carrying it. Show detail now
adds a line — "Also on Hulu" when it's on more than one, "Now on Paramount+"
when it has moved on entirely. Your own answer is left exactly as you set it;
this sits beside it.

The TV/Movies filter moved up top. On a list that mixes shows and movies, the
filter now lives in the sort menu in the corner — one place for sort, genre
and what kind — instead of a row of buttons sitting above the list.

Fixed:

• Picking a remake or a rerelease now sticks. If you chose the new version of
  a show from search — say the new Little House on the Prairie — the app used
  to quietly swap in the older show of the same name a little while later.
  Your exact pick is remembered for good now, and two shows that share a name
  no longer trade posters, casts or watch links.

• A plain title now means the current version of a show that has been remade.
  Adding or importing one without picking a year lands on the new show
  instead of the decades-old original that happens to share its name.
```

### What this covers

- **Recommend to group** (#417) — pull-only Watch Next boards, JC's pop-up.
  Recommending writes a card the group owns and touches nobody's list; "Add to
  Next Up" runs under the recipient's own session. Bounded by group membership
  in both directions and a per-member daily ceiling. `docs/INVARIANTS.md` §12a,
  pinned by `scripts/group-suggestions-test.mjs`.
- **Full-library offline caching** (#419) — posters, artwork, cast and ratings
  prefetched for every list rather than only recently-opened shows, plus
  widget-side caching so Trending and Up Next survive no connection. Up Next
  filters already-aired entries from the cached copy.
- **Group icons** (#420, migration 066) — curated symbol and color sets, with
  the server as the only gate: anything outside `_shared/group-icons.js` is a
  400 on create and PATCH, so clients render what arrives. Absent key keeps,
  null clears, creator only. `scripts/group-icons-test.mjs`.
- **TV/Movies filter folded into the sort menu** (#420) — one control for sort,
  genre and kind on mixed lists, replacing the button row.
- **The member's exact TMDB pick survives enrichment** (#416) — background
  `/api/enrich` passes a pinned row by id instead of re-guessing from the
  title, and every title-scoped propagation stops at a copy pinned to a
  different id. `scripts/enrich-identity-test.mjs`.
- **A bare title resolves to the newest version of a remade show** (#418), with
  a trailing "(YYYY)" pinning that year's entry.

*(Server-side, already live for everyone — listed so the story is complete, no
app update required.)*

- Trending is now computed once per UTC day into a one-row cache and served
  from there (#424, migration 067). The ranking is the most expensive read in
  the product and the endpoint is public; bot traffic burned the whole
  free-tier daily D1 read budget through it on 2026-09-01. Members see the
  same list, refreshed daily rather than per request; a title added today
  appears tomorrow. `scripts/trending-cache-test.mjs`, invariant §18.
- The four scheduled cron workflows now fail loudly on a Cloudflare bot
  challenge instead of reporting success (#422). `demo-reset.yml` had stayed
  green for two days while no reset actually ran.
- The SMS consent text on `sms.html` and `privacy.html` no longer promises
  message types the product doesn't send (#420).

---

## 1.4 (build 23) — released on the App Store 2026-08-26; supersedes 1.3

Covers everything merged since **1.2.1 / build 21**, the last build that
actually reached the Store.

**1.3 was never submitted.** Its version record sat in App Store Connect at
`READY_FOR_REVIEW` with build 22 attached and `submittedDate` null — prepared
on 2026-08-17 and then left, so no member ever received it. 1.4 therefore
supersedes it, and the What's New below is the **merged** 1.3 + 1.4 text.
Merging mattered: 1.3's text alone was 3977 characters against Apple's 4000
cap, so roughly 1700 characters had to come out to fit both. The merged block
is 3715 characters.

Renaming the existing 1.3 records to 1.4 — rather than creating new ones — was
the plan of record and it worked on both iPhone and Apple TV: neither had been
submitted, so the version string was still editable, and build 22 gave way to
build 23. A build only appears for attaching when its
`CFBundleShortVersionString` matches the record, so build 23 (1.4) cannot
attach to a record still named 1.3.

**The Mac had no 1.3 record to rename, and the API would not create one.**
macOS had never been prepared for 1.3, so 1.2.1 was still its newest record.
`POST /v1/appStoreVersions` refused with *"You cannot create a new version of
the App in the current state"* — the app already had 1.4 in flight on the other
two platforms. A probe with a throwaway version string drew the same error, so
the block is the app's state and not the version number. **App Store Connect's
own UI creates it happily** (＋ Version or Platform → macOS → 1.4); only the API
path is closed. Expect that on any release where one platform runs ahead of
another, and reach for the UI for the record rather than hunting for an
endpoint that does it.

All three platforms carry the same What's New text, byte for byte.

Applies to iPhone, iPad and Mac, plus the Apple TV button-contrast and
VoiceOver fixes. The watch and the web pick up the server-side items (group
ordering, storefront names, the big-library fix, the cast de-duplication) with
no client change; the rest is iPhone/iPad/Mac only.

```
"Watching with" now knows who your people are.

• Pick anyone you share a group with instead of typing their name. The show
  goes on their list too, and their copy names you back.

• Pick more than one. Sunday night is rarely just two people.

• If they already have the show, it stays exactly where they put it —
  nothing moved, nothing duplicated. Take someone off later and it stays on
  their list. It's theirs now.

• Anyone who isn't in the app, just type their name like always.

Thayná's idea. Thank you, Thayná.

Sign in with your face instead of waiting on a code. Sign in with a code
once and the app offers to save a passkey — after that it's Face ID or Touch
ID and you're in. There's one door in now instead of two: a single "Log in
or sign up" button that works out which you are from whatever you type.

New: Favorite Actors, on Home. The people who keep turning up across your
Watching, Awaiting and Loved lists, with the shows that put them there — tap
one to open it. Nothing to set up; it reads your own lists.

Links you share now say what you're sharing. Send someone a show and it
arrives as "Severance on Show Picker Club", with the artwork. Group invites
name the group, household invites name whoever sent it.

Your lists open the moment you raise your wrist. The Apple Watch app used to
sit on a spinner; it now shows the lists it already had, instantly, and
refreshes them quietly behind you. It works with no signal at all, and tells
you how old the lists are.

Trending shows more than ten now — tap More at the bottom. It also counts
the right things: a show only counts if someone is watching it, awaiting it
or loved it. Titles parked on Next Up were padding the list.

Next Up has a genre filter. Tap the sort button and pick a genre.

The medium and large widgets are poster grids now — proper artwork instead
of cramped rows, and tapping a poster opens that show.

Bringing over a list you keep somewhere else is much easier. Paste a list
whenever you like — it's always there now, in the account menu and above My
Shows, and on iPad and Mac where it wasn't offered at all.

Shows now say how many episodes there are, not just how many seasons. Four
seasons of Severance is 19 episodes; four of Grey's Anatomy is 90.

Movies you can only rent or buy now say where — "Apple TV (rent or buy)"
instead of no platform at all — and there's always a "Where to watch" link.

The network list has grown: PBS, Pluto TV, and the British and Australian
services — BBC iPlayer, ITVX, Channel 4, NOW, Stan, Binge, ABC iview and
more. The free ones sit at $0 in the Subscription Audit — no bill to cut.

When someone tags you as watching a show together, the show that lands on
your list now says who added it. Your groups are listed alphabetically.

On Apple TV, the buttons for Netflix, Paramount+, Hulu and Prime Video open
their apps again, buttons are readable instead of dark-on-dark, and
VoiceOver reads a show's title straight from its poster.

On a Mac or an iPad with a keyboard, Command-F opens search and Command-R
refreshes.

Fixed:

• A library past about a hundred shows had stopped loading at all.

• A cast list no longer names the same actor twice when they played more
  than one part.

• A group or household invite link that had expired used to look like it
  worked. Now it says so.

• Signing up while the app was already open left you with almost nothing
  until you force-quit.

• The Subscription Audit stopped counting rentals as subscriptions. One
  Apple rental made it look like you paid for Apple TV+ monthly.

• The Up Next widget sat empty for weeks at a stretch. It shows finales as
  well as premieres now.

• Everyone in a group gets a different vibe now.
```

### What this covers

- Trending expands from 10 to 50 behind a **More** button, on iPhone Home and
  the iPad detail column (#388). `?limit=` on `/api/popular` and group Trending.
- Both Trending queries now count Watching/Awaiting/Loved only, never Next Up —
  the shared rule lives in `_shared/trending-lists.js`. **Sarah spotted this on
  Group Trending**, and it turned out to be true of club Trending too: neither
  query filtered on list at all. It's also what makes her longer lists worth
  reading, since expanding to 50 would otherwise just surface more of the
  maybe-pile.
- **Favorite Actors** (Nico's idea) — derived top-ten actors from the member's
  own lists, with IMDB links. iPhone/iPad/Mac; not tvOS, watch or web. The
  shows under each actor draw as standard show rows and open the show card
  (`show_cards` on `/api/favorite-actors`; the bare-title `shows` array stays
  for older clients). Counts no longer split one person in two when some
  credits predate TMDB person ids — legacy name-only credits resolve through
  the member's own library, then the `people` bank, before falling back to the
  name (Patrick hit this as a wall of "2 shows").
- **Genre filter on Next Up** (Liza's idea) — options built from the list's own
  genres intersected with TMDB's top-level set, so it never offers a dead
  filter. Ignored while reordering; names itself in the empty state.
  iPhone/iPad/Mac.
- **A tagged-in show names its tagger** (Paula found the gap — a movie
  appeared on her list with nothing saying why). Owner-only `added_by_member`
  on `/api/shows?member=<self>` and `/api/shows/:id`, resolved from the row's
  `added_by` email; the show card renders "Added by <name>" beside Watching
  with. iPhone/iPad/Mac; not tvOS, watch or web (they render only the
  `watching_with` string).
- **Rent/buy-only movies name their storefront** (Paula, via group Trending —
  tapping into a movie's details listed no platform). Enrichment now falls
  back to the storefront ("Apple TV Store", "Fandango at Home") when no
  subscription service streams a title, everywhere `network` is filled, and
  the background movie pass retroactively fills copies that predate this. The
  show card also renders the aggregator "Where to watch" link even when there
  is no network to name (iPhone/iPad/Mac; tvOS and watch pick up the filled
  network from the API without a client change, web likewise).
- **A failed invite stops pretending it worked** — following a dead group or
  household link swallowed the error and walked you into the "you're in"
  screen (or, on iPad, just left you on the Groups tab). Both now surface a
  toast, from one app-wide error surface (`ErrorCenter`) that the remaining
  silent write paths — the URL cleanup fix, the vibe rescore controls — also
  use. iPhone/iPad/Mac.
- **⌘F and ⌘R** open search and refresh on Mac Catalyst and an iPad with a
  keyboard, from a real menu-bar command group. Mac and iPad only.
- **Apple TV button contrast** — the system button style takes its unfocused
  plate from the box's appearance, which on our always-dark canvas could come
  out black-on-dark. Sign-in, delete-account, Add a Show and the Home retry
  button now pin light-on-dark unfocused and black-on-white focused, and the
  Trending shelf moves focus as a unit so up reaches the tab bar. tvOS only.
- **One list order, defined once** — the premiere/rating comparator was copied
  into the phone, the TV and the watch; it now lives in `ShowPickerCore`
  (`ShowSorting.swift`) with tests pinning the rule the copies kept losing: an
  undated show sorts *last*, and rating only breaks a tie. No visible change,
  three fewer places to drift.
- **A cast list can't credit the same actor twice** — TMDB sends one credit
  per role, so a dual part arrived as a doubled name on the cast line;
  `dedupeCast()` now collapses them at enrichment time, and the background
  cast refresh heals rows that already carry the double. All platforms (the
  data is fixed at the source).
- **The Groups list is alphabetical** — `GET /api/groups` orders by name
  (case-insensitive) instead of newest-first. No client re-sorts, so this one
  server change lands on iPhone/iPad/Mac, Apple TV and the web at once.
- **Medium/large widgets redesigned as poster grids** — Up Next and Trending
  both drop the 38×57-thumbnail rows for the small widget's full-bleed poster
  look, three across (medium) or three-by-two (large), each poster its own
  deep link. Up Next keeps its "how soon" badge and the premiere/finale label.
  iPhone/iPad/Mac; the extra-large Trending grid on iPad/Mac keeps its rows.
- **A 100+ show library stopped loading entirely** (#401). D1 binds at most 100
  parameters per query and the watchers lookup built one `IN (...)` per owned
  row, so the day a member crossed 100 active shows their own list started
  500ing — and only theirs, since the lookup runs just for the owner. Chunked,
  and written up as invariant 15. Server-side: already fixed for every surface
  without this build.
- **One cast row per person** (#408). TMDB sends one credits entry per role, so
  a dual part arrived as the same actor twice and the wholesale refresh healed
  any manual cleanup right back. Deduped before the billing cap in both the
  add-time enricher and the background refresh, which now repairs existing
  doubles on its own. Server-side.

Merged but deliberately **not** in the What's New text:

- **The session cookie moved to the Keychain** (#407) — it was being shared
  between the app, Share Extension, widgets and watch app through App Group
  UserDefaults, an unencrypted plist. `ShowPickerCore.SessionStore` keeps it in
  the Keychain instead and migrates the plaintext copy on first read, so
  upgrading signs nobody out. **This one needs the build** — it is the only
  client-side change here that members can't already have. Left out of the
  member text because "we improved how your login is stored" reads as an
  admission rather than a feature.
- Admin and operator work invisible to members: the reporting-table escaping
  and list validation on edit (#405), the enrichment-gap and storefront
  backfills (#393, #394), the vibe trait-fill cron dropping to daily (#400),
  and smoke-test retries (#399).

---

## 1.3 (build 22) — NEVER SUBMITTED; folded into 1.4

Prepared 2026-08-17 and then left: the App Store Connect version record stayed
at `READY_FOR_REVIEW` with `submittedDate` null, so this never reached review
and no member ever saw it. **Its What's New text below is superseded** — the
member-facing half was merged into 1.4's block above, trimmed to fit the 4000
character cap. Kept here as the record of what shipped in the binary.

Covers everything merged since **1.2 / build 20**.
Applies to iPhone, iPad and Mac, plus a round of Apple TV fixes and a much
faster Apple Watch app.

**Apple caps What's New at 4000 characters** and the blocks below are the
submission text — they currently run just under the limit, so anything added from here
needs something cut.

```
"Watching with" now knows who your people are.

• Pick anyone you share a group with instead of typing their name. The
  show goes on their list too, and their copy names you back.

• Pick more than one. Sunday night is rarely just two people.

• If they already have the show, it stays exactly where they put it —
  nothing moved, nothing duplicated. Take someone off later and it stays
  on their list. It's theirs now.

• Anyone who isn't in the app, just type their name like always.

Thayná's idea. Thank you, Thayná.
```

```
Sign in with your face instead of waiting on a code.

Sign in with a code once and the app offers to save a passkey — after
that it's Face ID or Touch ID and you're in. On iPhone and iPad.

There's one door in now instead of two: a single "Log in or sign up"
button that works out which you are from whatever you type.
```

```
Links you share now say what you're sharing.

• Send someone a show and it arrives as "Severance on Show Picker Club",
  with the artwork — instead of the same blank card every time.

• Group invites name the group. Household invites name whoever sent it.

They still open straight to the right place in the app — and to the App
Store first, if they don't have it yet.
```

```
Your lists open the moment you raise your wrist.

• The Apple Watch app used to sit on a spinner while it fetched
  everything from scratch. It now shows the lists it already had,
  instantly, and refreshes them quietly behind you.

• It works with no signal at all — away from your phone, off Wi-Fi, on a
  plane — and tells you how old the lists are.

• If your watch loses its sign-in, it says so right away instead of
  thinking about it for five seconds and giving up.
```

```
On Apple TV, the button that takes you to a show works again.

• Netflix, Paramount+, MGM+, Hulu and Prime Video all opened to nothing.
  They open their apps again, and HBO Max and Apple TV+ still land you on
  the show itself.

• The Watch button and the list buttons are readable now, and the Watch
  button no longer pauses before it will let you press it.
```

```
Bringing over a list you keep somewhere else is much easier now.

• Paste a list whenever you like. Importing used to disappear once your
  library filled up — it's now always there, in the account menu and above
  My Shows, and on iPad and Mac where it wasn't offered at all.

• A Paste button, plus an example to follow that stays put while you
  paste and tidy up.

The network list has grown: PBS, Pluto TV, and the British and Australian
services — BBC iPlayer, ITVX, Channel 4, Channel 5, NOW, Stan, Binge,
Foxtel, ABC iview, SBS On Demand, 9Now, 7plus and 10 play. It's in
alphabetical order now, and the free ones sit at $0 in the audit.
```

```
More about what you're actually signing up for.

• Shows now say how many episodes there are, not just how many seasons.
  Four seasons of Severance is 19 episodes; four of Grey's Anatomy is 90.
  Taglines too, and the original language when it isn't English.

• The Subscription Audit stopped counting rentals as subscriptions. One
  Apple rental made it look like you were paying for Apple TV+ monthly.

• In a household audit, "Active now" says who's watching and which of
  their lists it's on, instead of crediting the whole house.

• The Up Next widget sat empty for weeks at a stretch. It shows finales
  as well as premieres now, and says which you're looking at.

• Everyone in a group gets a different vibe now.
```

```
Fixed:

• Signing up while the app was already open left you with almost nothing
  — no My Shows, no Groups, no Calendar — until you force-quit.

• "Invite members" opened an empty sheet on the first tap. The link is
  there the first time now.

• The login screen no longer promises a text it can't send: codes by
  text only work for a number already on your account, and it says so.

• Logging out on iPad and Mac left the last screen behind the login card.

• Adding a show starts on the list you're looking at — tap + on Awaiting
  and it goes to Awaiting.
```

### What this covers

In the order of the blocks above:

- Watching With names group-mates instead of free text, multi-select, links an
  existing copy in place (#375); credited to Thayná (#376).
- Passkeys — WebAuthn sign-in, offered after a successful code sign-in (#322) —
  and a single "Log in or sign up" door (#325). iPhone/iPad only.
- Per-show and per-invite link previews, and the marketing page's own card
  (#373).
- Apple Watch cache-first launch, offline lists, and a straight answer when the
  session is gone (#372).
- Apple TV watch-link fixes and button legibility (#369).
- Permanent import entry points — account menu and the My Shows toolbar; iPad
  and Mac previously had no way in at all (#362) — plus the Paste button and
  worked-example card (#363).
- PBS as a canonical network (Passport, Masterpiece, PBS Kids folded in as
  aliases); Pluto TV (#366); UK and Australian networks (#384), sectioned in the
  picker and recognized by the share extension, free-to-air ones priced at $0
  and the paid non-US ones unpriced because the audit totals US dollars.
- Five stored TMDB fields, three of them displayed (#339); storefronts excluded
  from the Subscription Audit (#337) with per-row link matching and Fandango
  (#338); household audit viewer attribution (#341, iPhone/iPad only); the Up
  Next widget showing finales and labelling the date (#332, #333); vibe scored
  against the club distribution (#358), no over-claimed persona (#360), one
  persona per group member (#361).
- Roster refetch when a session arrives mid-launch (#334); the group invite
  sheet on the first tap (#344); honest SMS copy (#329); logout resetting the
  iPad/Mac sidebar and the iPhone stack (#320); Add Show opening on the current
  list (#368, #374).

Merged but deliberately **not** in the What's New text — admin- or
operator-only, or invisible to members: the network picker moving to the
backend (#385, which changes what a *future* "we added X" note requires — the
next network arrives without a release); the admin member profile and its group
detail (#349–#352, #383); reporting platform counts (#367); the tvOS Streaming
Link Check (#370, #371); URL-cleanup queue fixes (#336); enrichment reliability
and TMDB id persistence (#345–#348); the vibe diagnostic and cluster report
(#355, #356, #359); CI and smoke-test work (#321, #331); the App Review demo
code fix (#330); and the web member app's restoration (#377–#380), a browser
surface that is not part of this submission.
