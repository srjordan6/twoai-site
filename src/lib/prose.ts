/**
 * capParagraphs: enforce the site's standing rule that no paragraph runs
 * longer than five sentences.
 *
 * Stephen, 2026-09-10: "no paragraph on the site will have more than 4 or 5
 * sentences." An audit of every long-form prose table on 2026-09-10 found 612
 * paragraphs over that limit across 34,749 measured (1.8%), the worst at 24
 * sentences in one block. All of it is model-written analysis, cached on a
 * hash of the page's own data and rewritten only when that data changes, so
 * hand-editing the database fixes today's violations and lets tomorrow's
 * regeneration reintroduce new ones. Enforcing it at render time instead means
 * every paragraph that has ever been written this way, and every one a model
 * writes next month, is capped without anyone auditing again.
 *
 * The split happens in two stages. Existing blank-line paragraph breaks are
 * respected first, because they are the author's own structure and a
 * six-sentence block the writer clearly intended as one thought should not be
 * cut at an arbitrary point if it is close. Only a paragraph that still
 * exceeds the limit after that is further split, on sentence boundaries, into
 * pieces of at most `max` sentences each.
 *
 * Sentence detection is intentionally simple: split after ., !, or ? when
 * followed by whitespace and a capital letter, a digit, or an opening quote,
 * or when it ends the string. It will occasionally miscount an abbreviation
 * or a decimal figure - "Fig. 2 shows..." reads as two sentences - which is
 * the same trade-off Reading.astro already made for paragraph breaks. An
 * occasional early split is a page that looks slightly more segmented than
 * intended; a paragraph left at eight sentences because the splitter was
 * too clever to trust is the actual failure mode this exists to prevent.
 */
const SENTENCE_BOUNDARY = /[.!?]+(?=\s+[A-Z0-9"'\u2018\u201c]|\s*$)/g;

function splitSentences(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(SENTENCE_BOUNDARY);
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    out.push(text.slice(last, end).trim());
    last = end;
  }
  const tail = text.slice(last).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

export function capParagraphs(source: string | null | undefined, max = 5): string[] {
  if (!source) return [];
  const rough = String(source)
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const result: string[] = [];
  for (const para of rough) {
    const sentences = splitSentences(para);
    if (sentences.length <= max) {
      result.push(para);
      continue;
    }
    // Chunk into the minimum number of pieces, distributed evenly, so a
    // paragraph of six sentences becomes 3+3 rather than 5+1 - the latter
    // reads as an abandoned afterthought.
    const chunks = Math.ceil(sentences.length / max);
    const perChunk = Math.ceil(sentences.length / chunks);
    for (let i = 0; i < sentences.length; i += perChunk) {
      result.push(sentences.slice(i, i + perChunk).join(' '));
    }
  }
  return result;
}
