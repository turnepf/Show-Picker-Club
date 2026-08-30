// Group icons (migration 066): the curated SF Symbol set and named palette a
// creator can pick from, mirrored in the apps (ShowPickerCore.GroupIcon). The
// server is the gate — a value outside these sets never reaches the DB, so
// clients can render whatever arrives without re-validating.

export const GROUP_ICONS = new Set([
  'person.2.fill', 'person.3.fill', 'house.fill', 'sofa.fill', 'tv.fill',
  'film.fill', 'theatermasks.fill', 'star.fill', 'heart.fill', 'flame.fill',
  'sparkles', 'moon.stars.fill', 'sun.max.fill', 'bolt.fill', 'crown.fill',
  'gamecontroller.fill', 'pawprint.fill', 'leaf.fill', 'book.fill',
  'music.note', 'globe.americas.fill', 'airplane', 'fork.knife',
  'cup.and.saucer.fill',
]);

export const GROUP_COLORS = new Set([
  'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple',
  'pink', 'brown',
]);

// Read an icon/color field off a request body: a key that's absent means
// "leave it alone", null or '' means "clear it", anything else must come from
// the curated set. Returns { ok, present, value } — value is null when
// clearing.
export function readIconField(body, key, allowed) {
  if (!body || !(key in body)) return { ok: true, present: false };
  const v = body[key];
  if (v === null || v === '') return { ok: true, present: true, value: null };
  if (typeof v !== 'string' || !allowed.has(v)) return { ok: false };
  return { ok: true, present: true, value: v };
}
