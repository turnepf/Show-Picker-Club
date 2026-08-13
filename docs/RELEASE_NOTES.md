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

## Unreleased — next App Store update

Applies to iPhone, iPad and Mac, plus a round of Apple TV fixes and a much
faster Apple Watch app.

```
"Watching with" now knows who your people are.

• Adding a show? Pick anyone you share a group with instead of typing
  their name. The show goes on their list too, and their copy names you
  back — so you both see who you're watching it with.

• Pick more than one. Sunday night is rarely just two people.

• If they already have the show, it stays exactly where they put it —
  nothing gets moved or duplicated.

• Anyone who isn't in the app, just type their name like always.

Take someone off and the show stays on their list. It's theirs now.

Thayná's idea. Thank you, Thayná.
```

```
Links you share now say what you're sharing.

• Send someone a show and it arrives as "Severance on Show Picker Club",
  with the artwork — instead of the same blank "Show Picker Club" card
  every time, no matter what you sent.

• Group invites say which group. "Join Thursday Night Club on Show Picker
  Club" rather than a link they have to take on faith.

• Household invites do the same, naming whoever sent it.

Tapping any of them still opens straight to the right place in the app, and
if they don't have it yet, it takes them to the App Store — then the same
link works.
```

```
Your lists open the moment you raise your wrist.

• The Apple Watch app used to sit on a spinner while it fetched everything
  from scratch — slowest exactly when you'd just raised your wrist and had a
  second to look. It now shows the lists it already had, instantly, and
  quietly refreshes them behind you.

• It works with no signal at all. Out of range of your phone, off Wi-Fi, on
  a plane — your lists are still there, with a note telling you how old they
  are so you know what you're looking at.

• If your watch ever does lose its sign-in, it now says so right away, and
  tells you to open Show Picker on your iPhone — instead of thinking about
  it for five seconds and then giving up.
```

```
On Apple TV, the button that takes you to a show now works again.

• Netflix, Paramount+, MGM+, Hulu and Prime Video all opened to nothing.
  They open their apps again. Peacock, Disney+, HBO Max and Apple TV+ were
  already fine and still are — HBO Max and Apple TV+ still land you on the
  actual show.

• The Watch button and the list buttons are readable now. They used to be
  dim until you selected them, and the list buttons went pale on pale once
  you did.

• The Watch button no longer pauses before it will let you press it.
```

```
Bringing over a list you already keep somewhere else is much easier now.

• Paste a list whenever you like. Importing used to quietly disappear once
  your library filled up — it's now always there, in the account menu and on
  a button above My Shows.

• A Paste button. One tap drops in whatever you've copied, instead of a long
  press in the text box.

• An example to follow. The import screen shows what a list can look like —
  a heading, a title, the service it's on — and it stays put while you paste
  and tidy up, so you can check yours against it.

Importing is also on iPad and Mac now, where it wasn't offered before.

PBS is also in the network list now, so Masterpiece, PBS Kids and everything
else you watch there can be filed where it belongs.

Pluto TV joins the network list too. It's free, so it shows up in the
Subscription Audit at $0 a month — no bill to cut.

Adding a show now starts on the list you're looking at. Tap + while you're on
Awaiting and it goes to Awaiting — you can still switch lists before saving.
```

### What this covers

- Permanent import entry points — account menu and the My Shows toolbar; iPad
  and Mac previously had no way in at all (#362).
- Paste button and the worked example card on the import screen (#363).
- PBS added as a canonical network, with Passport, Masterpiece and PBS Kids
  folded in as aliases.
- Add Show opens on the list you're viewing instead of always Watching —
  reported by Thayná, who kept landing awaited shows in Watching.

Earlier merged work is not listed here — this file starts at 2026-08-11, so
anything user-facing that shipped before that and has not yet reached the App
Store needs adding by hand before the next submission.
