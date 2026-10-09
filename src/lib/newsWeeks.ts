/**
 * The news week (Stephen, 2026-10-09): /this-week-in-ai/ holds the week's
 * headline stories, vendor news and When AI Goes Wrong, chosen from the daily
 * pages by traffic and importance. srj-pipeline's twoaiNewsWeeks writes one
 * file per ISO week to content/newsweek/ and freezes it a week after it
 * ends, so the archive does not shift.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';

export interface NewsWeekItem {
  title: string;
  href: string;
  date: string;
  teaser?: string;
  source?: string;
  outlets?: number;
  views?: number;
  uid?: string;
}

export interface NewsWeek {
  slug: string;
  label: string;
  start: string;
  end: string;
  generated?: string;
  current?: boolean;
  counts: { stories: number; vendor: number; incidents: number };
  stories: NewsWeekItem[];
  vendor: NewsWeekItem[];
  incidents: NewsWeekItem[];
}

let cache: NewsWeek[] | null = null;

/** Every news week, newest first. */
export function loadNewsWeeks(): NewsWeek[] {
  if (cache) return cache;
  const out: NewsWeek[] = [];
  if (existsSync('content/newsweek')) {
    for (const f of readdirSync('content/newsweek')) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const w = JSON.parse(readFileSync(`content/newsweek/${f}`, 'utf8'));
        if (!w.slug) continue;
        w.stories = w.stories || [];
        w.vendor = w.vendor || [];
        w.incidents = w.incidents || [];
        w.counts = w.counts || { stories: w.stories.length, vendor: w.vendor.length, incidents: w.incidents.length };
        out.push(w);
      } catch {
        /* a malformed file is skipped */
      }
    }
  }
  out.sort((a, b) => b.slug.localeCompare(a.slug));
  return (cache = out);
}

export const plural = (n: number, s: string, p?: string) => `${n} ${n === 1 ? s : p || s + 's'}`;
