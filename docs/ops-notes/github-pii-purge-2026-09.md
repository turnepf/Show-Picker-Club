# GitHub PII purge — Support Ticket 4761537

Tracking note for an in-progress GitHub Support request to fully purge member
PII (phone numbers, email addresses) from repo history, ahead of eventually
making this repo public. Not part of the product itself — kept here so the
status and context survive across sessions.

## Background

Old commits contained private members' phone numbers and email addresses
(personal contact info, not a rotatable credential). Patrick rewrote history
with `git-filter-repo` and force-pushed all branches/tags to remove it from
the current tree.

- First affected commit (old → new): `437bfae662e285dadb1ace5b5ab023b1a9b4b68b`
  → `11392b8c2e782b392a7a6d8c58488bc8954f0e6f`
- The PII is **not** in the current codebase — only reachable via the old,
  rewritten-away commit, so long as nothing still references it.

## The problem

GitHub found the old commit SHA still referenced by ~400 pull requests
(#4–#448, with some gaps) because merging a commit into a branch makes it
part of every subsequent PR's history on that branch. A single remaining
reference anywhere blocks garbage collection from actually purging the data.

GitHub Support offered two options:
1. Delete each of those PRs entirely, or
2. Just delete their internal references (dereferences the diffs/data,
   keeps PR comments/discussion history intact)

## Decision

Went with **option 2 — dereference only**. It satisfies the actual goal
(make the sensitive data unreachable so it can be garbage-collected) without
losing ~400 PRs' worth of discussion history for no added privacy benefit.

Reply sent to the ticket on 2026-09-22 confirming option 2 and asking GitHub
to proceed with garbage collection once references are cleared.

## Status

**Waiting on GitHub Support** to dereference the PRs and run garbage
collection. Ticket 4761537.

## Follow-ups once GitHub confirms

- Verify the old SHA (`437bfae662e285dadb1ace5b5ab023b1a9b4b68b`) no longer
  resolves anywhere on the repo (no branch, tag, PR, or fork reference).
- Open question Patrick still needs to weigh in on: GitHub's note that
  "any sensitive data that has been exposed should definitely be considered
  compromised" — whether affected members should be proactively notified,
  separate from the technical purge.
- Before actually flipping the repo to public: a fuller audit for anything
  else that shouldn't ship publicly — secrets/credentials in scripts or
  migration files, real member data in seed/test fixtures, hardcoded
  personal paths or account IDs (Apple Developer team ID, Cloudflare account
  ID, `~/.appstoreconnect`, `~/.roku`, etc.). Not started yet — this note
  only covers the PII-purge ticket.
