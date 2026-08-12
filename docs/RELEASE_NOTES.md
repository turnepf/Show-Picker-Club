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

Applies to iPhone, iPad and Mac. Apple TV and Apple Watch are unchanged.

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
