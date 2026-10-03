/**
 * The AI CWE list, read once from content/news/cwes.json: every weakness
 * class (MITRE's CWE) that at least one AI CVE on the tracker is filed under,
 * ranked by how many AI CVEs it holds. Shared by /ai-news/cwes/ and the table
 * on the Application and Product Security page.
 *
 * theworldofai bridge row 385 and Stephen, 2026-10-03: track CWE numbers the
 * way CVE numbers are tracked, a page explaining CWE, and a listing of every
 * CWE number associated with AI.
 */
import { readFileSync, existsSync } from 'node:fs';

export type CweRow = {
  cwe_id: string; num: number; uid: string; name: string; abstraction: string;
  count: number; kev: number; critical: number; high: number; latest: string;
  summary: string; rank: number;
};

type CweListDoc = {
  generated: string; total: number; cves_classed: number; cves_unclassed: number; mitre_total: number;
  cwes: CweRow[]; unlisted: { cwe_id: string; count: number }[];
};

let cache: CweListDoc | null = null;

export function cweList(): CweListDoc {
  if (cache) return cache;
  const p = 'content/news/cwes.json';
  const empty = { generated: '', total: 0, cves_classed: 0, cves_unclassed: 0, mitre_total: 0, cwes: [], unlisted: [] };
  if (!existsSync(p)) return (cache = empty);
  const d = JSON.parse(readFileSync(p, 'utf8'));
  cache = { ...empty, ...d, cwes: Array.isArray(d.cwes) ? d.cwes : [], unlisted: Array.isArray(d.unlisted) ? d.unlisted : [] };
  return cache;
}
