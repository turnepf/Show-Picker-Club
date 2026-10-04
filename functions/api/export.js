// GET /api/export — plain-text export of the signed-in member's own four
// lists, so members can take their data with them (no lock-in). Session
// required; always exports the caller's OWN lists (private notes are not
// included, and there's no ?member= — you can only export yourself).
//
// Output is a simple text file, one section per list:
//
//   Patrick's Show Picker Club lists
//   Exported 2026-07-20
//
//   Watching
//   Severance on Apple TV+
//   The Bear on Hulu
//
//   Awaiting
//   ...
//
// Served with Content-Disposition: attachment so browsers download it; the
// web button and the iOS share sheet both consume this same endpoint.

import { getSession } from '../_shared/auth.js';

// Display order + labels, matching the app's list tabs (public/shell.js).
const LISTS = [
  ['watching', 'Watching'],
  ['waiting', 'Awaiting'],
  ['recommending', 'Loved'],
  ['next', 'Next Up'],
];

function showLine(row) {
  let line = (row.title || '').trim();
  if (!line) return null;
  if (row.network) line += ` on ${row.network}`;
  return line;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }
  const slug = session.member_slug;

  const member = await env.DB.prepare('SELECT name FROM members WHERE slug = ?')
    .bind(slug).first().catch(() => null);
  const name = (member && member.name) ? member.name : slug;

  const { results } = await env.DB.prepare(
    `SELECT title, network, list
       FROM shows_v
      WHERE member_slug = ? AND archived = 0
      ORDER BY title COLLATE NOCASE`
  ).bind(slug).all();

  const byList = new Map(LISTS.map(([key]) => [key, []]));
  for (const row of (results || [])) {
    const bucket = byList.get(row.list);
    if (!bucket) continue; // ignore any rows outside the four known lists
    const line = showLine(row);
    if (line) bucket.push(line);
  }

  const today = new Date().toISOString().slice(0, 10);
  const out = [`${name}'s Show Picker Club lists`, `Exported ${today}`];
  for (const [key, label] of LISTS) {
    out.push('', label);
    const lines = byList.get(key);
    out.push(lines.length ? lines.join('\n') : '(none)');
  }
  const body = out.join('\n') + '\n';

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="showpicker-${slug}.txt"`,
      'Cache-Control': 'no-store',
    },
  });
}
