// Per-member ICS calendar feed.
// URL: /calendar/<slug>.ics — subscribe in Apple Calendar / Google Calendar /
// Fantastical to get an always-updating view of upcoming season dates for the
// member's Watching and Waiting shows.

export async function onRequestGet(context) {
  const { env, params } = context;
  let slug = String(params.slug || '');
  if (slug.endsWith('.ics')) slug = slug.slice(0, -4);
  if (!slug) return new Response('Not found', { status: 404 });

  const member = await env.DB.prepare(
    `SELECT slug, name, first_name FROM members WHERE slug = ?`
  ).bind(slug).first();
  if (!member) return new Response('Not found', { status: 404 });

  const { results } = await env.DB.prepare(
    `SELECT id, title, network, network_url, list, recommended_by,
            next_season_date, season_end_date
     FROM shows
     WHERE member_slug = ? AND archived = 0
       AND list IN ('watching','waiting')
       AND (next_season_date IS NOT NULL OR season_end_date IS NOT NULL)`
  ).bind(slug).all();

  const calName = `${member.first_name || member.name}'s Shows`;
  const dtstamp = formatDtStamp(new Date());

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Showpicker//Shows Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(calName)}`,
    'X-WR-TIMEZONE:UTC',
    'REFRESH-INTERVAL;VALUE=DURATION:PT24H',
    'X-PUBLISHED-TTL:PT24H',
  ];

  const memberPageUrl = `https://showpicker.club/${slug}`;
  for (const s of results) {
    const url = isRealShowUrl(s.network_url) ? s.network_url : memberPageUrl;
    const desc = describeShow(s, slug, memberPageUrl);
    const summary = s.network ? `${s.title} on ${s.network}` : s.title;
    if (s.next_season_date) {
      lines.push(...buildEvent({
        uid: `show-${s.id}-premiere@showpicker.club`,
        dtstamp,
        date: s.next_season_date,
        summary,
        description: desc,
        url,
      }));
    }
    if (s.season_end_date && s.season_end_date !== s.next_season_date) {
      lines.push(...buildEvent({
        uid: `show-${s.id}-finale@showpicker.club`,
        dtstamp,
        date: s.season_end_date,
        summary,
        description: desc,
        url,
      }));
    }
  }

  lines.push('END:VCALENDAR');
  const ics = lines.map(foldLine).join('\r\n') + '\r\n';

  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${slug}-shows.ics"`,
      // Short cache so calendar apps see edits within the hour.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function buildEvent({ uid, dtstamp, date, summary, description, url }) {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${date.replace(/-/g, '')}`,
    `DTEND;VALUE=DATE:${nextDay(date)}`,
    `SUMMARY:${escapeIcs(summary)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    `URL:${escapeIcs(url)}`,
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
  ];
}

function isRealShowUrl(url) {
  return !!url && !url.includes('/search') && !url.includes('/s?') && url !== '#';
}

function describeShow(s, slug, memberPageUrl) {
  const bits = [`On ${slug}'s ${s.list} list`];
  if (s.recommended_by) bits.push(`Recommended by ${s.recommended_by}`);
  if (s.network) bits.push(`Network: ${s.network}`);
  bits.push(`More: ${memberPageUrl}`);
  return bits.join('. ') + '.';
}

function formatDtStamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

function escapeIcs(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545 line folding: split lines longer than 75 octets across continuation
// lines that start with a single space.
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  let i = 75;
  while (i < line.length) {
    parts.push(' ' + line.slice(i, i + 74));
    i += 74;
  }
  return parts.join('\r\n');
}
