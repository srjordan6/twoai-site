// ONE COMPANY, TWO RECORDS: FOLD THE RETIRED ONE INTO THE ONE THAT STAYS.
//
// AMD was tracked twice: as AMD (b54d3e84, from the tools catalog, first
// published 2026-09-11) and as ADVANCED MICRO DEVICES INC (6b518abb, the SEC
// registrant, first published 2026-09-14), which carries the filings, the
// stock and the lobbying record. From 2026-09-22 the templates retired the
// earlier record into the SEC one. theworldofai asked on 2026-10-03 (bridge
// row 409) for the merge to sit under the EARLIER uid, with no published URL
// changed. So b54d3e84 is the AMD page again and shows both records' data,
// and 6b518abb still answers, with a canonical, a meta refresh and noindex
// pointing at b54d3e84.
//
// The merge happens here, on the fetched content, rather than in the
// pipeline, because a dozen pipeline stages enrich a company doc by its own
// uid (SEC facts by CIK, stocks, lobbying, harvest, pins) and each would
// need teaching. Done once on the fetched files, every page and every lookup
// that reads content/ sees one AMD.
//
// What it does, for each from -> to in company-moves.json:
//   companies/<to>.json    gains every field it lacks from <from>; profile
//                          fields merge key by key, products, cases, mcp and
//                          pinned_news are unioned, aliases gain the other
//                          record's name.
//   companies/<from>.json  gains company.moved_to, which the templates read
//                          for the canonical, the refresh and noindex.
//   companies/index.json   drops <from> and keeps <to> with a page.
//   companies/stocks.json  by_company and pending_by_company copy across.
//   tech/dc-op-<from>.json copied to dc-op-<to>.json when that is missing.
//   every other file       "/companies/<from>/" links become "/companies/<to>/".

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const isEmpty = (v) =>
  v === undefined || v === null || v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

const unionBy = (a, b, key) => {
  const out = Array.isArray(a) ? [...a] : [];
  const seen = new Set(out.map(key));
  for (const x of Array.isArray(b) ? b : []) {
    const k = key(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
};

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJSON = (p, v) => writeFileSync(p, JSON.stringify(v));

function mergeDocs(to, from, fromUid) {
  const out = { ...to };
  for (const [k, v] of Object.entries(from)) {
    if (k === 'company' || k === 'pinned_news') continue;
    if (isEmpty(out[k]) && !isEmpty(v)) out[k] = v;
  }
  out.pinned_news = unionBy(to.pinned_news, from.pinned_news, (p) => p?.uid || p?.url || p?.headline);
  if (out.pinned_news.length === 0) out.pinned_news = null;

  const tc = to.company || {};
  const fc = from.company || {};
  const c = { ...tc };
  for (const [k, v] of Object.entries(fc)) {
    if (['uid', 'name', 'profile', 'products', 'cases', 'mcp', 'aliases', 'has_page', 'moved_to'].includes(k)) continue;
    if (isEmpty(c[k]) && !isEmpty(v)) c[k] = v;
  }
  c.profile = { ...(fc.profile || {}), ...(tc.profile || {}) };
  for (const [k, v] of Object.entries(fc.profile || {})) {
    if (isEmpty(c.profile[k]) && !isEmpty(v)) c.profile[k] = v;
  }
  c.products = unionBy(tc.products, fc.products, (p) => (p?.name || '').toLowerCase());
  c.cases = unionBy(tc.cases, fc.cases, (x) => x?.slug || x?.name);
  c.mcp = unionBy(tc.mcp, fc.mcp, (x) => x?.slug || x?.name);
  c.aliases = unionBy(tc.aliases, [...(fc.aliases || []), fc.name].filter(Boolean), (a) => String(a).toLowerCase());
  c.has_page = true;
  c.merged_from = unionBy(tc.merged_from, [fromUid], (x) => x);
  out.company = c;
  return out;
}

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, fn);
    else if (name.endsWith('.json')) fn(p);
  }
}

export function mergeMovedCompanies(root = 'content', movesFile = 'scripts/company-moves.json') {
  if (!existsSync(movesFile) || !existsSync(join(root, 'companies'))) return [];
  const moves = readJSON(movesFile);
  const done = [];
  for (const [fromUid, toUid] of Object.entries(moves)) {
    if (fromUid.startsWith('_')) continue;
    const fromPath = join(root, 'companies', `${fromUid}.json`);
    const toPath = join(root, 'companies', `${toUid}.json`);
    if (!existsSync(fromPath) || !existsSync(toPath)) {
      console.warn(`company-merge: ${fromUid} -> ${toUid} skipped, a record is missing`);
      continue;
    }
    const from = readJSON(fromPath);
    const to = readJSON(toPath);
    writeJSON(toPath, mergeDocs(to, from, fromUid));
    from.company = { ...(from.company || {}), moved_to: toUid };
    writeJSON(fromPath, from);

    const idxPath = join(root, 'companies', 'index.json');
    if (existsSync(idxPath)) {
      const idx = readJSON(idxPath);
      const list = idx.companies || idx.items || [];
      const kept = list.filter((c) => c?.uid !== fromUid);
      const toEntry = kept.find((c) => c?.uid === toUid);
      if (toEntry) toEntry.has_page = true;
      if (idx.companies) idx.companies = kept;
      else if (idx.items) idx.items = kept;
      if (typeof idx.total === 'number') idx.total = kept.length;
      writeJSON(idxPath, idx);
    }

    const stocksPath = join(root, 'companies', 'stocks.json');
    if (existsSync(stocksPath)) {
      const s = readJSON(stocksPath);
      for (const key of ['by_company', 'pending_by_company']) {
        if (s[key] && s[key][fromUid] && !s[key][toUid]) s[key][toUid] = s[key][fromUid];
      }
      writeJSON(stocksPath, s);
    }

    const opFrom = join(root, 'tech', `dc-op-${fromUid}.json`);
    const opTo = join(root, 'tech', `dc-op-${toUid}.json`);
    if (existsSync(opFrom) && !existsSync(opTo)) writeFileSync(opTo, readFileSync(opFrom));

    const needle = `/companies/${fromUid}/`;
    const repl = `/companies/${toUid}/`;
    let relinked = 0;
    walk(root, (p) => {
      if (p === fromPath) return;
      const txt = readFileSync(p, 'utf8');
      if (!txt.includes(needle)) return;
      writeFileSync(p, txt.split(needle).join(repl));
      relinked++;
    });
    console.log(`company-merge: ${fromUid} folded into ${toUid}, links rewritten in ${relinked} files`);
    done.push([fromUid, toUid]);
  }
  return done;
}
