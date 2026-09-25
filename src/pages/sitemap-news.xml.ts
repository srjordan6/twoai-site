// /sitemap-news.xml: the Google News sitemap. Stephen, 2026-09-25. Google
// reads only articles published in the last two days from a news sitemap, and
// wants at most 1,000 of them, so this carries exactly that: today's and
// yesterday's briefings and vendor announcements, each with the publication
// name, language and date. It is rebuilt on every deploy, which is several
// times a day, so it tracks the daily news pages as they publish. Listed in
// robots.txt beside the main sitemap index.
import { collectStories } from './ai-news/feed.xml';
import { collectVendorPosts } from './ai-news/vendor/feed.xml';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function GET() {
  const entries: Array<{ loc: string; date: string; title: string }> = [];
  for (const s of collectStories(2)) entries.push({ loc: `https://theworldofai.org/ai-news/${s.uid}/`, date: s.date, title: s.title });
  for (const v of collectVendorPosts(2)) entries.push({ loc: `https://theworldofai.org/ai-news/vendor/${v.slug}/`, date: v.date, title: v.vendor ? `${v.vendor}: ${v.title}` : v.title });
  const urls = entries.slice(0, 1000).map((e) => `  <url>
    <loc>${esc(e.loc)}</loc>
    <news:news>
      <news:publication>
        <news:name>The World of AI</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>${esc(e.date)}</news:publication_date>
      <news:title>${esc(e.title)}</news:title>
    </news:news>
  </url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${urls}
</urlset>
`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
