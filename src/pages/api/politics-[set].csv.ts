// CSV versions of The Politics of AI datasets, built at build time from the
// same content/politics/*.json files that /api/politics-*.json mirror, so the
// two formats can never disagree. 2026-09-21, for the press room.
//
// Columns are the keys of the records, in the order the pipeline writes them.
// Arrays (bill numbers, agencies, FEC ids) are joined with a semicolon so a
// spreadsheet keeps one row per record. Every row keeps its uid and source.
import { readFileSync } from 'node:fs';

const SETS = ['lobbying', 'money', 'bills', 'members'];

export function getStaticPaths() {
  return SETS.map((set) => ({ params: { set } }));
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET({ params }: { params: { set: string } }) {
  let doc: any = null;
  try { doc = JSON.parse(readFileSync(`content/politics/${params.set}.json`, 'utf8')); } catch { doc = null; }
  const rows: any[] = Array.isArray(doc?.rows) ? doc.rows : [];
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const lines = [
    `# ${doc?.title ?? params.set}. Generated ${doc?.generated ?? 'unknown'}. ${doc?.citation ?? ''}`.trim(),
    cols.join(','),
    ...rows.map((r) => cols.map((c) => cell(r[c])).join(',')),
  ];
  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/csv; charset=utf-8' },
  });
}
