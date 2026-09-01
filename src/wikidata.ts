/**
 * Real-time Wikidata lookup: the tier between "our own pages" and the open web.
 *
 * WHY THIS SITS AHEAD OF WEB SEARCH. Three reasons, in order of weight.
 * Wikidata is CC0, so unlike a Wikipedia paragraph or a publisher's prose its
 * claims can be published on this site rather than only cited - which is the
 * difference between retaining an answer and holding a fact. It is free, so it
 * needs no daily cap and no budget counter. And it is structured, so a founder
 * arrives as an entity with a QID rather than as a sentence somebody has to
 * parse and trust.
 *
 * WHY IT IS REAL TIME RATHER THAN HARVESTED. A pipeline harvest can only
 * enrich entities the site already holds, and the questions that reach this
 * code are disproportionately about entities it does NOT hold - that is why
 * they reached a refusal. Harvesting is still worth doing for the 269 company
 * profiles, but it cannot answer "who founded DeepMind" when DeepMind is not
 * in twoai_entities at all. This can.
 *
 * WHAT IT WILL NOT DO. It does not write to a company profile. Facts land in
 * twoai_web_facts as `proposed` with their QID and property, and a separate
 * step promotes them. A public endpoint writing directly onto published pages
 * is how an unreviewed claim ends up under our own domain name.
 */

// Wikimedia asks every API client to identify itself. An unattributed bot is
// how a free service ends up rate-limiting a whole IP range.
const UA = "theworldofai.org (https://theworldofai.org; srj@srjconsultingservices.com)";

// The properties worth asking for, in the order a reader cares about them.
// Values that are themselves entities (P112 founders, P169 CEO, P159 HQ) come
// back as QIDs and get resolved to labels in one batched second call.
const PROPS: Array<{ pid: string; field: string; label: string; isEntity: boolean }> = [
  { pid: "P112", field: "founders", label: "Founded by", isEntity: true },
  { pid: "P571", field: "founded", label: "Founded", isEntity: false },
  { pid: "P159", field: "headquarters", label: "Headquarters", isEntity: true },
  { pid: "P169", field: "ceo", label: "Chief executive", isEntity: true },
  { pid: "P749", field: "parent", label: "Parent organisation", isEntity: true },
  { pid: "P1128", field: "employees", label: "Employees", isEntity: false },
  // P856 is not shown to the reader - it is the HARD IDENTIFIER. The standing
  // rule is that an external knowledge base is never matched to our records on
  // name alone; domain equality is the check. Carrying the official website
  // back from Wikidata is what makes safe promotion possible at all.
  { pid: "P856", field: "website", label: "Official website", isEntity: false },
];

export type WikidataFact = { field: string; label: string; value: string };
export type WikidataAnswer = {
  qid: string;
  title: string;
  description: string;
  url: string;
  facts: WikidataFact[];
};

export let lastWikidataError = "";

const wdFetch = async (url: string): Promise<any | null> => {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) {
    lastWikidataError = `wikidata HTTP ${r.status}`;
    return null;
  }
  return await r.json();
};

/**
 * Pull the likely subject out of a question. Capitalised words that are not
 * sentence-initial question words are the strongest signal available without
 * paying a model to do NER: "who founded DeepMind" yields DeepMind, "what does
 * the Colorado AI Act require" yields Colorado AI Act. When nothing is
 * capitalised we fall back to the content words, which is worse but not
 * nothing - Wikidata's own search does some of the work for us.
 */
export function subjectOf(question: string): string {
  const LEAD = new Set(["who", "what", "when", "where", "why", "how", "is", "was", "are",
    "were", "does", "did", "do", "the", "a", "an", "tell", "me", "about"]);
  const words = question.replace(/[?!.,]/g, "").split(/\s+/).filter(Boolean);
  const caps = words.filter((w, i) => /^[A-Z]/.test(w) && !(i === 0 && LEAD.has(w.toLowerCase())));
  if (caps.length) return caps.join(" ");
  return words.filter((w) => !LEAD.has(w.toLowerCase()) && w.length > 2).slice(0, 4).join(" ");
}

export async function wikidataLookup(question: string): Promise<WikidataAnswer | null> {
  lastWikidataError = "";
  const subject = subjectOf(question);
  if (!subject) {
    lastWikidataError = "no subject extracted";
    return null;
  }
  try {
    // 1. Find the entity.
    const search = await wdFetch(
      "https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=1&origin=*&search=" +
        encodeURIComponent(subject));
    const top = search?.search?.[0];
    if (!top?.id) {
      lastWikidataError = "no wikidata match for: " + subject;
      return null;
    }

    // 2. Read its claims.
    const ent = await wdFetch(
      "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&props=claims|labels|descriptions&languages=en&ids=" +
        top.id);
    const claims = ent?.entities?.[top.id]?.claims ?? {};

    // Collect entity-valued QIDs so their labels can be fetched in ONE call
    // rather than one call per founder.
    const needLabels = new Set<string>();
    const raw: Array<{ field: string; label: string; vals: string[]; isEntity: boolean }> = [];
    for (const p of PROPS) {
      const statements = claims[p.pid];
      if (!Array.isArray(statements) || !statements.length) continue;
      const vals: string[] = [];
      for (const st of statements.slice(0, 4)) {
        const dv = st?.mainsnak?.datavalue;
        if (!dv) continue;
        if (p.isEntity && dv.value?.id) {
          vals.push(dv.value.id);
          needLabels.add(dv.value.id);
        } else if (dv.type === "time" && dv.value?.time) {
          // +1994-01-01T00:00:00Z -> 1994. Precision below year is noise here.
          const m = String(dv.value.time).match(/^\+?(-?\d{1,4})-/);
          if (m) vals.push(m[1]);
        } else if (dv.type === "quantity" && dv.value?.amount) {
          vals.push(String(dv.value.amount).replace(/^\+/, ""));
        } else if (typeof dv.value === "string") {
          vals.push(dv.value);
        }
      }
      if (vals.length) raw.push({ field: p.field, label: p.label, vals, isEntity: p.isEntity });
    }

    // 3. Resolve QIDs to human labels, batched.
    const labels = new Map<string, string>();
    if (needLabels.size) {
      const ids = [...needLabels].slice(0, 50).join("|");
      const lab = await wdFetch(
        "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&props=labels&languages=en&ids=" + ids);
      for (const [qid, e] of Object.entries<any>(lab?.entities ?? {})) {
        const l = e?.labels?.en?.value;
        if (l) labels.set(qid, String(l));
      }
    }

    const facts: WikidataFact[] = raw.map((r) => ({
      field: r.field,
      label: r.label,
      // An entity value with no English label is DROPPED rather than shown.
      // Verified against Q15733006 (Google DeepMind): its P112 lists three
      // founders and one of them returned no en label, which would have
      // rendered a bare "Q16847797" to a reader. A QID is not an answer.
      value: r.vals
        .map((v) => (r.isEntity ? labels.get(v) ?? "" : v))
        .filter(Boolean)
        .join(", "),
    })).filter((f) => f.value);

    if (!facts.length) {
      lastWikidataError = "matched " + top.id + " but it carries none of the properties we read";
      return null;
    }

    return {
      qid: top.id,
      title: String(ent?.entities?.[top.id]?.labels?.en?.value ?? top.label ?? subject),
      description: String(ent?.entities?.[top.id]?.descriptions?.en?.value ?? top.description ?? ""),
      url: "https://www.wikidata.org/wiki/" + top.id,
      facts,
    };
  } catch (e: any) {
    lastWikidataError = String(e?.message ?? e).slice(0, 200);
    return null;
  }
}
