// /ai-news/vendor/feed.xml: vendor announcements this site surfaced in the last
// 14 days, as RSS 2.0, newest first. Stephen, 2026-09-25, for Google News.
// Built from content/news/vendor.json on every build. Thin posts, the ones the
// pipeline marked has_page false, are left out: the feed carries what a reader
// or an index should open, and those pages carry noindex for a reason.
import { readFileSync, existsSync } from 'node:fs';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function collectVendorPosts(days = 14) {
  let data: any = null;
  try { data = existsSync('content/news/vendor.json') ? JSON.parse(readFileSync('content/news/vendor.json', 'utf8')) : null; } catch { data = null; }
  const seen = new Set<string>();
  const out: Array<{ slug: string; title: string; summary: string; date: string; vendor: string }> = [];
  const cutoff = Date.now() - days * 86400000;
  const push = (it: any, vendor: string) => {
    if (!it?.slug || seen.has(it.slug) || it.has_page === false) return;
    seen.add(it.slug);
    const d = String(it.posted_on ?? it.date ?? '').slice(0, 10);
    if (!d || isNaN(new Date(d).getTime()) || new Date(d).getTime() < cutoff) return;
    out.push({ slug: it.slug, title: String(it.title ?? ''), summary: String(it.summary ?? ''), date: d, vendor });
  };
  for (const a of data?.archive ?? []) push(a, a.vendor);
  for (const v of data?.vendors ?? []) for (const it of v.items ?? []) push(it, v.vendor);
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out.filter((s) => s.title);
}

export async function GET() {
  const items = collectVendorPosts(14).map((s) => `    <item>
      <title>${esc(s.vendor ? `${s.vendor}: ${s.title}` : s.title)}</title>
      <link>https://theworldofai.org/ai-news/vendor/${s.slug}/</link>
      <guid isPermaLink="true">https://theworldofai.org/ai-news/vendor/${s.slug}/</guid>
      <pubDate>${new Date(s.date + 'T12:00:00Z').toUTCString()}</pubDate>
      <description>${esc(s.summary || `An announcement from ${s.vendor}, surfaced ${s.date}, with a link to the original post.`)}</description>
    </item>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>The World of AI, vendor announcements</title>
    <link>https://theworldofai.org/ai-news/vendor/</link>
    <atom:link href="https://theworldofai.org/ai-news/vendor/feed.xml" rel="self" type="application/rss+xml" />
    <description>Product, model and platform announcements from AI companies, surfaced daily from their own newsrooms and linked to the original post. Edited by Stephen Jordan.</description>
    <language>en-us</language>
${items}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
