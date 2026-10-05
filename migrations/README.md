# migrations/

Upgrades for the **existing** production database. A new database starts from
`schema.sql` (the complete current schema) and never runs these.

## Squashed 2026-10-05

Migrations 001 through 082 were deleted here once production had applied all
82 of them and `schema.sql` was verified to match production column for
column. Read them in git history: `git show c2f07a9:migrations/<file>`, or
`git log --diff-filter=D -- migrations/`. Docs that say "migration 067" mean
those files.

## Adding one

- Name it `NNN_what_it_does.sql`, numbering on from **083**. Never reuse an old
  name: `schema_migrations` on production records all 82, and a reused name
  would be skipped as already applied.
- Make the same change to `schema.sql` in the same PR.
- It applies on the next push to `main` (`scripts/apply-migrations.sh`, run by
  `deploy.yml` before the Pages deploy), and only once.
- A change that drops a column or table, or deletes rows, goes in an operator
  script that Patrick runs after a backup instead (see
  `~/ShowPickerBackups/cleanup-show-picker.sh`).
