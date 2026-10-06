/**
 * The "Translated from <language>" label.
 *
 * Stephen's standing rule, theworldofai bridge row 508, 2026-10-06:
 * everything visitors see on theworldofai.org is in English. The pipeline
 * (srj-pipeline twoai_english.go) puts a non-English headline into English
 * and keeps the publisher's own wording beside it, with the ISO 639-1 code of
 * its language: title_original and title_lang on incidents and their
 * reports, Headline_original and Headline_lang on news stories, Title_original
 * and Title_lang on each outlet's article. The page shows the English and
 * names the language it came from, never the code and never the original.
 */
export const LANG_NAMES: Record<string, string> = {
  nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
  ja: 'Japanese', zh: 'Chinese', ko: 'Korean', ru: 'Russian', uk: 'Ukrainian', ar: 'Arabic',
  fa: 'Persian', hi: 'Hindi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', gu: 'Gujarati',
  pa: 'Punjabi', kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi', ur: 'Urdu', sv: 'Swedish',
  da: 'Danish', no: 'Norwegian', nb: 'Norwegian', fi: 'Finnish', pl: 'Polish', tr: 'Turkish',
  he: 'Hebrew', id: 'Indonesian', ms: 'Malay', cs: 'Czech', sk: 'Slovak', el: 'Greek',
  hu: 'Hungarian', ro: 'Romanian', vi: 'Vietnamese', th: 'Thai', ca: 'Catalan', bg: 'Bulgarian',
  sr: 'Serbian', hr: 'Croatian', sl: 'Slovenian', lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian',
  ka: 'Georgian', hy: 'Armenian', tl: 'Filipino',
};

/** The English name of a language code; an unknown code reads as "another language". */
export function langName(code?: string | null): string {
  const c = String(code ?? '').trim().toLowerCase();
  return LANG_NAMES[c] ?? 'another language';
}

/**
 * The language a shown title was translated from, or '' when it was not
 * translated: no original, an original equal to what is shown, or English.
 */
export function translatedFrom(lang?: string | null, original?: string | null, shown?: string | null): string {
  const l = String(lang ?? '').trim().toLowerCase();
  if (!original || original === shown || l === 'en') return '';
  return l ? langName(l) : 'another language';
}
