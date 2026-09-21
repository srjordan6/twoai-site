// /press/feed.xml: the last 72 hours of The Politics of AI, as RSS 2.0, built
// from content/politics/digest.json on every build. Each item is one record,
// a lobbying filing, a contribution, a bill update or a roll call, with its
// source link and its uid as the guid. No summary is written by a model; the
// title is the record's own facts. 2026-09-21.
import { readFileSync } from 'node:fs';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function GET() {
  let doc: any = null;
  try { doc = JSON.parse(readFileSync('content/politics/digest.json', 'utf8')); } catch { doc = null; }
  const rows: any[] = Array.isArray(doc?.rows) ? doc.rows : [];
  const label: Record<string, string> = { lobbying: 'Lobbying filing', contribution: 'Contribution', bill: 'Bill update', vote: 'Roll call' };
  const items = rows.map((r) => {
    const when = r.at ? new Date(r.at) : null;
    return `    <item>
      <title>${esc((label[r.kind] || r.kind) + ': ' + r.title)}</title>
      <link>${esc(r.source)}</link>
      <guid isPermaLink="false">theworldofai-${esc(r.uid)}</guid>
      ${when && !isNaN(when.getTime()) ? `<pubDate>${when.toUTCString()}</pubDate>` : ''}
      <description>${esc(`${label[r.kind] || r.kind}. uid ${r.uid}. Source linked. The World of AI records the filing, not a judgment about it.`)}</description>
    </item>`;
  }).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>The Politics of AI, daily record</title>
    <link>https://theworldofai.org/press/</link>
    <description>New AI lobbying filings, contributions from AI company and AI-focused political committees, AI bill updates and roll calls in Congress, from the last 72 hours. Generated ${esc(doc?.generated ?? '')}.</description>
    <language>en-us</language>
${items}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
