// Which state a federal court sits in, read from the court's own name.
//
// CourtListener writes "District Court, N.D. California" and govinfo writes
// "United States District Court Northern District of California". Both carry
// the state name in full, so the state is found by looking for it, longest
// names first so that "West Virginia" is not read as "Virginia" and "New York"
// is not missed. A court of appeals covers several states and a caption with
// no state in it returns null: those cases are counted as federal appellate,
// never guessed into a state.

export const STATES: Array<[string, string]> = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];

const BY_LENGTH = [...STATES].sort((a, b) => b[1].length - a[1].length);

export const stateSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function courtState(court: string | undefined | null): { code: string; name: string; slug: string } | null {
  const c = String(court || '');
  if (!c || /court of appeals|circuit\b/i.test(c) && !/district court/i.test(c)) return null;
  for (const [code, name] of BY_LENGTH) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(c)) {
      // "Washington" inside "District of Columbia" style names never occurs,
      // but "D.C." style abbreviations do: those are caught below.
      return { code, name, slug: stateSlug(name) };
    }
  }
  if (/\bD\.?\s?D\.?C\b|\bD\.C\.|\bColumbia\b/i.test(c)) return { code: 'DC', name: 'District of Columbia', slug: 'district-of-columbia' };
  return null;
}

export function casesByState(cases: any[]): { byState: Record<string, any[]>; unplaced: any[] } {
  const byState: Record<string, any[]> = {};
  const unplaced: any[] = [];
  for (const c of cases || []) {
    const s = courtState(c.court);
    if (!s) { unplaced.push(c); continue; }
    (byState[s.code] ||= []).push(c);
  }
  return { byState, unplaced };
}
