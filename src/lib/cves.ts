/**
 * The AI CVE list, read once from content/news/cves.json and shared by the
 * /ai-news/ foot, /ai-news/cves/, and the "Known vulnerabilities" block at the
 * bottom of tool, company and MCP server pages.
 *
 * Stephen, 2026-10-01: latest ten on /ai-news/, below everything already
 * there; every CVE kept on the list page; each one cross-referenced on the
 * page of the product it names.
 */
import { readFileSync, existsSync } from 'node:fs';

export type CveEntity = { kind: string; name: string; href: string; uid?: string };
export type CveRow = {
  cve_id: string; uid: string; published: string; product: string; vendor: string;
  cvss_score: number | null; cvss_severity: string; kev: boolean; summary: string;
  entities: CveEntity[];
};

let cache: { generated: string; total: number; kev: number; cves: CveRow[] } | null = null;

export function cveList() {
  if (cache) return cache;
  const p = 'content/news/cves.json';
  if (!existsSync(p)) return (cache = { generated: '', total: 0, kev: 0, cves: [] });
  const d = JSON.parse(readFileSync(p, 'utf8'));
  cache = { generated: d.generated ?? '', total: d.total ?? 0, kev: d.kev ?? 0, cves: Array.isArray(d.cves) ? d.cves : [] };
  return cache;
}

export function latestCves(n = 10): CveRow[] {
  return cveList().cves.slice(0, n);
}

/** CVEs whose matched entities point at this page, by its site href. */
export function cvesFor(href: string): CveRow[] {
  if (!href) return [];
  const h = href.endsWith('/') ? href : href + '/';
  return cveList().cves.filter((c) => (c.entities ?? []).some((e) => {
    const eh = (e.href || '').split('#')[0];
    return eh === h;
  }));
}

export function severityClass(sev: string): string {
  const s = (sev || '').toUpperCase();
  return s === 'CRITICAL' ? 'sev-critical' : s === 'HIGH' ? 'sev-high' : s === 'MEDIUM' ? 'sev-medium' : s === 'LOW' ? 'sev-low' : 'sev-none';
}
