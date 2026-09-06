/**
 * THE STORY UID, minted the way the pipeline mints it.
 *
 * Every story is an entity and carries an 8-hex uid, sha256("story:" + slug)
 * truncated to 8 characters - the same twoaiUID("story:"+slug) the Go archive
 * stage writes. The pipeline stamps it on archive rows, but news.json is
 * written by publish_news every morning and carries no uid, so every story
 * still in the day's briefing rendered without one. Stephen, 2026-09-06: no
 * news story has its own uid. The slug is the story's stable natural key, so
 * the uid is a pure function of it and is identical whichever side computes
 * it; this helper exists so the templates never invent a second scheme.
 *
 * Prefer the pipeline's value when present; compute only when it is absent.
 */
import { createHash } from 'node:crypto';

export function storyUid(slug: string | undefined | null, given?: string | null): string {
  if (given) return given;
  if (!slug) return '';
  return createHash('sha256').update(`story:${slug}`).digest('hex').slice(0, 8);
}

/**
 * THE INCIDENT UID.
 *
 * Same rule, different kind. An AI Incident Database record is an entity on
 * this site and twoai_entities mints its uid as sha256("incident:" + the AIID
 * incident number), truncated to 8. Stephen, 2026-09-06: no uids in the logged
 * harms section. There were none anywhere - not on the briefing entries, not on
 * the hub preview, and the incident permalink at /ai-news/incident/{id}/ had no
 * stamp at all, so the one kind of record on this site that is a report of real
 * harm was the one nobody could cite.
 *
 * NOT page_uid. The incident page document carries page_uid, which is minted
 * from the document's path (page:news/incident-1650.json) and identifies the
 * page, not the incident. The entity uid identifies the incident itself and is
 * what the register, the graph and any citation should agree on. Where the two
 * differ, this is the one to show.
 */
export function incidentUid(id: string | number | undefined | null, given?: string | null): string {
  if (given) return given;
  if (id === undefined || id === null || id === '') return '';
  return createHash('sha256').update(`incident:${id}`).digest('hex').slice(0, 8);
}

/**
 * A summary that is a language model declining to write one is not a summary.
 * On 2026-09-06 the briefing published "I appreciate you sharing this, but I'm
 * unable to complete your request." as the summary of a story about New York
 * City's school AI ban. The pipeline is the place to stop that; this is the
 * page refusing to print it in the meantime. Returns '' so callers fall back
 * to the headline and the sources, which are real.
 */
const REFUSAL = /\b(unable to (complete|fulfil|fulfill|help with)|can(?:'|no)t (help|assist|complete)|as an ai (language )?model|i(?:'m| am) (sorry|not able))\b/i;

export function cleanSummary(text: string | undefined | null): string {
  const t = String(text ?? '').trim();
  return REFUSAL.test(t) ? '' : t;
}
