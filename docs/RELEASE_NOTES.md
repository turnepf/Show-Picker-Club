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

## Unreleased — the update after 1.3

Nothing here is in 1.3 (build 22). Start the next What's New from this section.

```
Trending shows more than ten now. Tap More at the bottom of the list.

Trending also counts the right things: a show only counts if someone is
watching it, awaiting it, or loved it. Titles parked on Next Up were
padding the list without anybody having started them.

New: Favorite Actors, on Home. The people who keep turning up across your
Watching, Awaiting and Loved lists, with the shows that put them there —
tap one to open it — and a link to everything else they've been in.

Nothing to set up — it reads your own lists. iPhone and iPad.

Next Up has a genre filter now. Tap the sort button and pick a genre —
handy once Next Up has grown past the point of reading it all.

The medium and large widgets are poster grids now — proper artwork
instead of cramped rows, and tapping a poster opens that show.

When someone tags you as watching a show together, the show that lands on
your list now says who added it — so a title you don't recognize explains
how it got there.
```

### What this covers

- Trending expands from 10 to 50 behind a **More** button, on iPhone Home and
  the iPad detail column (#TBD). `?limit=` on `/api/popular` and group Trending.
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
- **Medium/large widgets redesigned as poster grids** — Up Next and Trending
  both drop the 38×57-thumbnail rows for the small widget's full-bleed poster
  look, three across (medium) or three-by-two (large), each poster its own
  deep link. Up Next keeps its "how soon" badge and the premiere/finale label.
  iPhone/iPad/Mac; the extra-large Trending grid on iPad/Mac keeps its rows.

---

## 1.3 (build 22) — uploaded 2026-08-18, not yet submitted

Covers everything merged since **1.2 / build 20**, the build on the Store.
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
