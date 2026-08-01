import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Static output; content is fetched from the twoai-content repo by
// scripts/fetch-content.mjs before every build (see package.json prebuild).
export default defineConfig({
  site: 'https://theworldofai.org',
  integrations: [sitemap()],
  build: { format: 'directory' },
});
