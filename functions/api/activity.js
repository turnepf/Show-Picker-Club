export async function onRequestGet(context) {
  const { env } = context;

  const { results } = await env.DB.prepare(
    `SELECT s.title, s.list, s.member_slug, h.name as member_name, s.created_at
     FROM shows s
     JOIN members h ON h.slug = s.member_slug
     WHERE s.archived = 0
     ORDER BY s.created_at DESC
     LIMIT 15`
  ).all();

  // Deduplicate bulk adds: group by member + timestamp (within 2 seconds)
  const feed = [];
  let lastKey = '';
  let lastBatch = [];

  for (const r of results) {
    const firstName = r.member_name.split(' ')[0];
    const key = `${r.member_slug}|${r.created_at}`;
    if (key === lastKey || (lastBatch.length > 0 && r.member_slug === lastBatch[0].member_slug && Math.abs(new Date(r.created_at) - new Date(lastBatch[0].created_at)) < 2000)) {
      lastBatch.push(r);
    } else {
      if (lastBatch.length > 0) {
        flushBatch(lastBatch, feed);
      }
      lastBatch = [r];
    }
    lastKey = key;
  }
  if (lastBatch.length > 0) flushBatch(lastBatch, feed);

  return new Response(JSON.stringify({ feed: feed.slice(0, 10) }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function flushBatch(batch, feed) {
  const firstName = batch[0].member_name.split(' ')[0];
  const list = batch[0].list;
  const listLabel = { watching: 'Watching', waiting: 'Awaiting', recommending: 'Recommending', next: 'Up Next' }[list] || list;

  if (batch.length === 1) {
    feed.push({
      text: `${firstName} added "${batch[0].title}" to ${listLabel}`,
      time: batch[0].created_at,
    });
  } else {
    feed.push({
      text: `${firstName} added ${batch.length} shows to ${listLabel}`,
      time: batch[0].created_at,
    });
  }
}
