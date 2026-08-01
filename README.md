# twoai-site

The Astro front end for [theworldofai.org](https://theworldofai.org): the
consumer atlas of AI laws, lawsuits, and language, built on the SRJ data
platform.

Content is a generated artifact. The daily `srj-pipeline` cron renders SQL
into the [twoai-content](https://github.com/srjordan6/twoai-content) repo;
`scripts/fetch-content.mjs` pulls that repo before every build; Cloudflare
builds and serves the static output. No content is ever edited here.

Brand assets in `public/brand/` come from the delivered logo kit
(theworldofai-logo-kit.zip). Blueprint:
TheWorldOfAI-Build-Blueprint-2026-08-01.docx (SRJ architecture records).
