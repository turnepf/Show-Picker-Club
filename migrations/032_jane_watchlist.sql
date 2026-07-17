-- Jane's starter library (2026-07): create the member and load her list.
--
-- Patrick collected Jane's shows off-platform; everything goes on the
-- Watching list per his instructions. Titles she has already finished
-- carry a "Watched" note (plus any extra context from the source list).
-- Titles are normalized to their canonical names so enrichment matches
-- (e.g. "Slowhorses" -> "Slow Horses", "Death by Lightening" -> "Death by
-- Lightning"); networks are canonical values from _shared/networks.js and
-- only set where stated on the list or unambiguous. Three titles were kept
-- exactly as written because no canonical match is clear: "Bernie's",
-- "Marshalls", "Ponies".
--
-- The member insert is skipped if a 'jane' row already exists (e.g. she was
-- enrolled via the /members admin page first). If she was created there,
-- login contacts are already on file; otherwise add her phone/email from
-- the admin page — this migration creates no contact rows.
--
-- Rows are inserted with added_by NULL and real timestamps — the documented
-- signature for member-intent rows (docs/ARCHITECTURE.md, "Seed-only
-- definition") — so reporting counts Jane as engaged, not seed-only.
-- Posters, cast, dates, and watch URLs backfill via the scheduled
-- enrichment jobs.
--
-- Usually applied via the "Apply D1 migration" GitHub Action, or by hand:
--   wrangler d1 execute shows-db --remote --file=migrations/032_jane_watchlist.sql
--
-- Both statements are guarded with NOT EXISTS, so re-running is a no-op.

INSERT INTO members (slug, name, first_name, last_initial, last_name, calendar_token, approved)
SELECT 'jane', 'Jane''s Shows', 'Jane', NULL, NULL, lower(hex(randomblob(16))), 1
WHERE NOT EXISTS (SELECT 1 FROM members WHERE slug = 'jane');

WITH new_shows(title, network, movie, recommended_by, notes) AS (VALUES
  -- To watch
  ('Boardwalk Empire',            'HBO Max',            0, NULL,    NULL),
  ('A Man in Full',               'Netflix',            0, NULL,    NULL),
  ('Full Swing',                  'Netflix',            0, NULL,    NULL),
  ('The Sinner',                  'Netflix',            0, NULL,    'Bill Pullman'),
  ('The Highwaymen',              'Netflix',            1, NULL,    NULL),
  ('All the Light We Cannot See', 'Netflix',            0, NULL,    NULL),
  ('Better Call Saul',            'Netflix',            0, NULL,    NULL),
  ('The Substance',               NULL,                 1, NULL,    NULL),
  ('Emilia Pérez',                'Netflix',            1, NULL,    NULL),
  ('Anora',                       NULL,                 1, NULL,    NULL),
  ('The Day of the Jackal',       'Peacock',            0, NULL,    NULL),
  ('The Gilded Age',              'HBO Max',            0, NULL,    'Also on Amazon Prime'),
  ('Ray Donovan',                 'Paramount+',         0, NULL,    NULL),
  ('Drops of God',                'Apple TV+',          0, NULL,    NULL),
  ('Shrinking',                   'Apple TV+',          0, NULL,    NULL),
  ('Sirens',                      'Netflix',            0, NULL,    'Looks good'),
  ('The Wire',                    'HBO Max',            0, NULL,    NULL),
  ('Hacks',                       'HBO Max',            0, NULL,    NULL),
  ('The Sopranos',                'HBO Max',            0, NULL,    NULL),
  ('Animal Kingdom',              NULL,                 0, NULL,    NULL),
  ('The Americans',               'Hulu',               0, NULL,    'Watched 2 seasons'),
  ('Bernie''s',                   NULL,                 0, 'Terry', NULL),
  ('Severance',                   'Apple TV+',          0, NULL,    NULL),
  ('Adolescence',                 'Netflix',            0, NULL,    NULL),
  ('Hostiles',                    NULL,                 1, 'Myers', NULL),
  ('American Primeval',           'Netflix',            0, 'Myers', NULL),
  ('No Escape',                   NULL,                 1, 'Myers', NULL),
  ('Marshalls',                   NULL,                 0, NULL,    NULL),
  ('The Studio',                  'Apple TV+',          0, NULL,    'Watched 2 episodes & stopped'),
  ('The Residence',               'Netflix',            0, NULL,    NULL),
  ('White House Plumbers',        'HBO Max',            0, NULL,    NULL),
  ('Death by Lightning',          'Netflix',            0, NULL,    'Historical — 4 episodes'),
  ('Slow Horses',                 'Apple TV+',          0, NULL,    NULL),
  ('Ponies',                      NULL,                 0, NULL,    NULL),
  -- Already watched
  ('Black Rabbit',                'Netflix',            0, NULL,    'Watched'),
  ('The Pitt',                    'Amazon Prime Video', 0, NULL,    'Watched'),
  ('His and Hers',                NULL,                 0, NULL,    'Watched'),
  ('The Beast in Me',             'Netflix',            0, NULL,    'Watched'),
  ('Landman',                     'Paramount+',         0, NULL,    'Watched'),
  ('Nobody Wants This',           'Netflix',            0, NULL,    'Watched'),
  ('The Morning Show',            'Apple TV+',          0, NULL,    'Watched (season 4)'),
  ('The Thursday Murder Club',    'Netflix',            1, NULL,    'Watched'),
  ('The Diplomat',                'Netflix',            0, NULL,    'Watched'),
  ('Only Murders in the Building','Hulu',               0, NULL,    'Watched (season 5)'),
  ('House of Guinness',           'Netflix',            0, NULL,    'Watched'),
  ('MobLand',                     'Paramount+',         0, NULL,    'Watched'),
  ('Yellowstone',                 'Peacock',            0, NULL,    'Watched'),
  ('Heretic',                     NULL,                 1, NULL,    'Watched'),
  ('Black Doves',                 'Netflix',            0, NULL,    'Watched'),
  ('Your Friends & Neighbors',    'Apple TV+',          0, NULL,    'Watched — Jon Hamm'),
  ('The Old Man',                 'Hulu',               0, NULL,    'Watched'),
  ('Conclave',                    NULL,                 1, NULL,    'Watched'),
  ('The Night Agent',             'Netflix',            0, NULL,    'Watched'),
  ('Outer Banks',                 'Netflix',            0, NULL,    'Watched (Oct 10)'),
  ('Lioness',                     'Paramount+',         0, NULL,    'Watched'),
  ('Zero Day',                    'Netflix',            0, NULL,    'Watched')
)
INSERT INTO shows (title, network, list, movie, recommended_by, notes, member_slug)
SELECT n.title, n.network, 'watching', n.movie, n.recommended_by, n.notes, 'jane'
FROM new_shows n
WHERE NOT EXISTS (
  SELECT 1 FROM shows s
  WHERE s.member_slug = 'jane' AND LOWER(s.title) = LOWER(n.title)
);
