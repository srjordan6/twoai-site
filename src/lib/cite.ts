// THE UID IN EVERY CITATION. Stephen, 2026-10-08: whenever a page asks to be
// cited, the citation carries the page's identifier, so a reader who quotes
// "vLLM." The World of AI Glossary, theworldofai.org/ai-glossary/vllm/ also
// carries the uid that names that record on this site and in its API.
//
// A page that has a record uid (a term, a company, a section, a story, a
// person, a paper) cites that uid, the same one its uid badge shows. A page
// with no record behind it (a calculator, an index, a static page) cites a
// stable identifier derived from its own path, the first eight hex digits of
// sha256("url:" + path), so it never changes between builds.
import { createHash } from 'node:crypto';

export function citeUID(pathname: string, explicit?: string | null): string {
  const e = explicit == null ? '' : String(explicit).trim();
  if (/^[0-9a-f]{8}$/i.test(e)) return e.toLowerCase();
  const path = '/' + (pathname || '/').replace(/^\/+|\/+$/g, '') + '/';
  return createHash('sha256').update('url:' + (path === '//' ? '/' : path)).digest('hex').slice(0, 8);
}
