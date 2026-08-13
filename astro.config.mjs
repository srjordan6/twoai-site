import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Static output; content is fetched from the twoai-content repo by
// scripts/fetch-content.mjs before every build (see package.json prebuild).
export default defineConfig({
  site: 'https://theworldofai.org',
  integrations: [sitemap({
    // MCP server detail pages carry registry metadata rather than our own
    // writing; they render noindex and stay out of the sitemap so the two
    // signals agree. The /mcp/ hub remains indexed.
    filter: (page) => !/\/mcp\/[^/]+\/$/.test(page) || page.endsWith('/mcp/'),
  })],
  build: { format: 'directory' },
});
