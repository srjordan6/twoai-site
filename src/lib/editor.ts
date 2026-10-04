// THE EDITOR, ONE IDENTITY. theworldofai bridge row 420, 2026-10-03: the
// ProfilePage on /stephen-jordan/ carries this Person as its main entity, and
// every NewsArticle names the same Person as editor, so search engines tie
// the bylines to one identity. Wikidata and ORCID are the identifiers that
// make the tie verifiable.
export const EDITOR_ID = 'https://theworldofai.org/stephen-jordan/#person';

export const EDITOR_PERSON = {
  '@type': 'Person',
  '@id': EDITOR_ID,
  name: 'Stephen R. Jordan',
  jobTitle: 'Editor',
  url: 'https://theworldofai.org/stephen-jordan/',
  worksFor: { '@type': 'Organization', name: 'SRJ Consulting & Services LLC', url: 'https://srjconsultingservices.com/' },
  sameAs: [
    'https://www.wikidata.org/wiki/Q140622333',
    'https://orcid.org/0009-0009-6913-0886',
    'https://www.linkedin.com/in/stephenrjordan/',
  ],
  alumniOf: [
    { '@type': 'CollegeOrUniversity', name: 'West Texas A&M University' },
    { '@type': 'CollegeOrUniversity', name: 'East Texas A&M University' },
  ],
};
