/**
 * Two more free, structured tiers ahead of any paid web search.
 *
 * OPENALEX (CC0) answers about PEOPLE and INSTITUTIONS. The local corpus holds
 * 809,501 works but no researcher profiles, so "who is Demis Hassabis" is
 * unanswerable from our own tables today while the live API answers it in one
 * call.
 *
 * A DATA-QUALITY FINDING THAT SHAPED THIS FILE. Testing that exact query, the
 * API returned the right person by every metric that matters - h-index 92,
 * 196,933 citations, topics in reinforcement learning and neural mechanisms -
 * and gave his last known institution as John Brown University. That is wrong.
 * Author disambiguation across a 250-million-work corpus produces affiliation
 * errors, and an affiliation is exactly the kind of fact a reader would take
 * at face value. So last_known_institutions is NOT surfaced. Works count,
 * citation count, h-index and topics are computed over the author's own
 * publication record and are trustworthy; the ORCID is carried so anyone can
 * check the identity themselves. Publishing a wrong employer under our own
 * domain to look more complete is the trade this site exists not to make.
 *
 * HUGGING FACE answers about MODELS, which is the most on-topic question class
 * an AI reference site can receive and the one gap not already harvested.
 * Metadata only - downloads, likes, task, library, tags, creation date. Model
 * card prose is left alone: cards carry their own licences and reproducing
 * them is the same mistake as republishing a publisher's abstract.
 */

const UA = "theworldofai.org (https://theworldofai.org; srj@srjconsultingservices.com)";

export type LookupFact = { field: string; label: string; value: string };
export type LookupAnswer = {
  source: "openalex" | "huggingface";
  sourceLabel: string;
  title: string;
  description: string;
  url: string;
  facts: LookupFact[];
};

export let lastLookupError = "";

const getJson = async (url: string): Promise<any | null> => {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) {
    lastLookupError = `HTTP ${r.status} from ${new URL(url).host}`;
    return null;
  }
  return await r.json();
};

const num = (n: any) => (typeof n === "number" ? n.toLocaleString("en-US") : "");

/**
 * People and institutions, from OpenAlex. Only fires when the question looks
 * like it is about a person: an author lookup on "what is RAG" would return a
 * confident profile of somebody irrelevant, which is worse than nothing.
 */
export async function openAlexAuthor(subject: string, question: string): Promise<LookupAnswer | null> {
  if (!/\b(who|whose|author|researcher|scientist|professor)\b/i.test(question)) return null;
  if (!subject) return null;
  try {
    const d = await getJson(
      "https://api.openalex.org/authors?per-page=1&search=" + encodeURIComponent(subject));
    const a = d?.results?.[0];
    if (!a?.display_name) {
      lastLookupError = "no openalex author for: " + subject;
      return null;
    }
    const stats = a.summary_stats ?? {};
    const facts: LookupFact[] = [];
    if (a.works_count) facts.push({ field: "works", label: "Published works", value: num(a.works_count) });
    if (a.cited_by_count) facts.push({ field: "cited_by", label: "Times cited", value: num(a.cited_by_count) });
    if (stats.h_index) facts.push({ field: "h_index", label: "h-index", value: String(stats.h_index) });
    const topics = (a.topics ?? []).slice(0, 4).map((t: any) => t?.display_name).filter(Boolean);
    if (topics.length) facts.push({ field: "topics", label: "Research topics", value: topics.join(", ") });
    if (a.orcid) facts.push({ field: "orcid", label: "ORCID", value: String(a.orcid).replace(/^https?:\/\/orcid\.org\//, "") });
    if (!facts.length) return null;
    return {
      source: "openalex",
      sourceLabel: "OpenAlex",
      title: String(a.display_name),
      description: "Researcher profile built from published works",
      url: String(a.id ?? "https://openalex.org"),
      facts,
    };
  } catch (e: any) {
    lastLookupError = String(e?.message ?? e).slice(0, 200);
    return null;
  }
}

/**
 * Models and datasets, from the Hugging Face Hub. Fires on model-shaped
 * questions only, for the same reason as above.
 */
export async function huggingFaceModel(subject: string, question: string): Promise<LookupAnswer | null> {
  if (!/\b(model|models|llm|checkpoint|weights|fine-?tun\w*|dataset)\b/i.test(question)
      && !/\b(llama|mistral|qwen|gemma|phi|falcon|deepseek|whisper|stable diffusion)\b/i.test(question)) {
    return null;
  }
  if (!subject) return null;
  try {
    const list = await getJson(
      "https://huggingface.co/api/models?limit=1&sort=downloads&direction=-1&search=" +
        encodeURIComponent(subject));
    const top = Array.isArray(list) ? list[0] : null;
    if (!top?.modelId && !top?.id) {
      lastLookupError = "no hugging face model for: " + subject;
      return null;
    }
    const id = String(top.modelId ?? top.id);
    const m = (await getJson("https://huggingface.co/api/models/" + id)) ?? top;
    const facts: LookupFact[] = [];
    if (m.pipeline_tag) facts.push({ field: "task", label: "Task", value: String(m.pipeline_tag).replace(/-/g, " ") });
    if (m.library_name) facts.push({ field: "library", label: "Library", value: String(m.library_name) });
    if (typeof m.downloads === "number") facts.push({ field: "downloads", label: "Downloads (30 days)", value: num(m.downloads) });
    if (typeof m.likes === "number") facts.push({ field: "likes", label: "Likes", value: num(m.likes) });
    if (m.createdAt) facts.push({ field: "created", label: "First published", value: String(m.createdAt).slice(0, 10) });
    const tags = (m.tags ?? []).filter((t: string) =>
      !t.startsWith("arxiv") && !t.startsWith("license:") && !t.startsWith("base_model")).slice(0, 8);
    if (tags.length) facts.push({ field: "tags", label: "Tags", value: tags.join(", ") });
    const lic = (m.tags ?? []).find((t: string) => t.startsWith("license:"));
    if (lic) facts.push({ field: "license", label: "Licence", value: lic.slice(8) });
    if (!facts.length) return null;
    return {
      source: "huggingface",
      sourceLabel: "Hugging Face",
      title: id,
      description: "Model metadata from the Hugging Face Hub",
      url: "https://huggingface.co/" + id,
      facts,
    };
  } catch (e: any) {
    lastLookupError = String(e?.message ?? e).slice(0, 200);
    return null;
  }
}
