import { getSession } from '../_shared/auth.js';

const LIST_LABELS = {
  watching: 'Watching',
  waiting: 'Awaiting',
  recommending: 'Loved',
  next: 'Next Up',
};

export async function onRequestGet(context) {
  const { env, request } = context;
  // Who-added-what activity is club-internal — members only. That covers the
  // per-member feed too: it's the member's own lists re-sorted by date, which
  // any signed-in member can already read off the member page. The admin-only
  // framing lives in the client (the iOS admin strip), not in this gate.
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  // ?member=<slug> narrows the feed to one member — what the operator wants
  // after a signup notification ("what has this person actually added?").
  // Without it, the club-wide feed, unchanged.
  const memberSlug = (url.searchParams.get('member') || '').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 10, 1), 50);
  // Over-fetch so batching has rows to collapse and still fills `limit`.
  const rowLimit = Math.min(limit * 4, 200);

  // The member-scoped query excludes seeded rows (added_by='seed', NULL
  // created_at): they're the operator's starter picks, not member activity, and
  // they would otherwise headline a new member's feed with shows they never
  // chose — the exact opposite of what the strip is asked. The club-wide query
  // is left as it was; NULL created_at sorts last under DESC, so seeds don't
  // reach the top of a feed that has any real activity in it.
  const scoped = memberSlug
    ? env.DB.prepare(
        `SELECT s.title, s.list, s.member_slug, h.name AS member_name, s.created_at
           FROM shows s
           JOIN members h ON h.slug = s.member_slug
          WHERE s.archived = 0
            AND s.member_slug = ?
            AND s.created_at IS NOT NULL
            AND COALESCE(s.added_by, '') != 'seed'
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT ?`
      ).bind(memberSlug, rowLimit)
    : env.DB.prepare(
        `SELECT s.title, s.list, s.member_slug, h.name AS member_name, s.created_at
           FROM shows s
           JOIN members h ON h.slug = s.member_slug
          WHERE s.archived = 0
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT ?`
      ).bind(rowLimit);

  const { results } = await scoped.all();

  // Collapse bulk adds: same member, same list, within 2 seconds of the row
  // that opened the batch. List has to match — without it a mixed import
  // collapsed into "added 5 shows to Watching" when only some of them were,
  // which is loud on a single-member feed where every row is the same person.
  //
  // Batches are kept per (member, list) rather than by walking consecutive
  // rows, because one import writes several lists inside the same second and
  // the rows come back interleaved. Adjacency-based grouping collapsed nothing
  // at all in that case — every row's neighbour belonged to a different list.
  // Results are newest-first, so recording each batch when its first row opens
  // it keeps the feed in that order.
  const open = new Map();
  const batches = [];
  for (const r of results) {
    const key = `${r.member_slug}|${r.list}`;
    const batch = open.get(key);
    if (batch && Math.abs(new Date(r.created_at) - new Date(batch.head.created_at)) < 2000) {
      batch.count++;
    } else {
      const fresh = { head: r, count: 1 };
      open.set(key, fresh);
      batches.push(fresh);
    }
  }

  const feed = batches.slice(0, limit).map((b) => render(b, memberSlug));
  return new Response(JSON.stringify({ feed }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// `text` is the rendered line (the shape this endpoint has always returned);
// the structured fields beside it let a client lay the same event out its own
// way. On a single-member feed the name is dropped from `text` — it's the
// subject of every line, and repeating it just pads the row.
function render({ head, count }, memberSlug) {
  const firstName = String(head.member_name || '').split(' ')[0];
  const listLabel = LIST_LABELS[head.list] || head.list;
  const subject = memberSlug ? '' : `${firstName} `;
  const verb = memberSlug ? 'Added' : 'added';
  const text = count === 1
    ? `${subject}${verb} "${head.title}" to ${listLabel}`
    : `${subject}${verb} ${count} shows to ${listLabel}`;
  return {
    text,
    time: head.created_at,
    title: head.title,
    count,
    list: head.list,
    list_label: listLabel,
    member_slug: head.member_slug,
    member_first_name: firstName,
  };
}
