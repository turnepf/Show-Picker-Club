# Project notes

## Working preferences

- **Never put `#` comments in terminal commands meant for the user to paste.**
  Pasted into their zsh, comment lines execute as garbage commands and break
  the sequence. Give bare commands in separate code blocks and explain them
  in prose around the blocks instead.

- **Never watch PRs, CI, or deployments, and never offer to.** Watching burns
  tokens while polling. When work involves a PR or deploy, just give the link
  and let the user watch it themselves.
- **End every completed task with an explicit close-out.** When the work is
  done, don't wait to be asked — state plainly: what shipped, anything still
  pending on the user (merges, migrations, secrets, verifications), whether
  branches are cleaned up, and whether the session is safe to archive. If
  something is not done, say what and why instead of going quiet.
- **"Safe to archive" always comes with the branch-deletion link.** Remote
  branch deletes are often blocked from the session (403), so whenever a
  close-out says the session is safe to archive, include the GitHub link to
  delete the session's merged branch, in the filtered form
  `https://github.com/turnepf/Show-Picker-Club/branches/all?query=<branch-name>`
  (shows just that branch with its trash-can delete button).
