import type { ContactPermission, Env, IndexedAsset, SmartScopeRule } from "./types";

export const EMBEDDING_DIM = 256;

const CONCEPT_SYNONYMS: Record<string, string[]> = {
  china: ["china", "beijing", "shanghai", "great wall", "bund", "asia", "chinese", "temple", "trip", "travel"],
  japan: ["japan", "tokyo", "kyoto", "shrine", "asia", "trip", "travel"],
  travel: ["trip", "vacation", "holiday", "flight", "hotel", "landmark", "journey"],
  beach: ["beach", "ocean", "sea", "surf", "surfing", "waves", "coast", "summer", "water"],
  passport: ["passport", "id", "identification", "visa", "citizenship", "travel document", "scan"],
  tax: ["tax", "taxes", "irs", "w2", "1099", "return", "accountant", "finance", "filing"],
  invoice: ["invoice", "receipt", "bill", "payment", "vet", "clinic", "medical"],
  pet: ["dog", "puppy", "cat", "pet", "vet", "golden retriever"],
};

function hashFeature(token: string): [number, number] {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const idx = h % EMBEDDING_DIM;
  const sign = ((h >>> 16) & 1) === 0 ? 1.0 : -1.0;
  return [idx, sign];
}

export function l2Normalize(vec: number[]): number[] {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm < 1e-9) return vec.map(() => 0);
  return vec.map((x) => Number((x / norm).toFixed(6)));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-9 ? dot / denom : 0;
}

export function embedTextLocal(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  const cleaned = text.toLowerCase().trim();
  if (!cleaned) return vec;

  const words = cleaned.match(/[a-z0-9]+/g) || [];
  const wordSet = new Set(words);

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const [idx, sign] = hashFeature(`w:${w}`);
    vec[idx] += 2.2 * sign;
    if (w.length >= 5) {
      const [pIdx, pSign] = hashFeature(`stem:${w.slice(0, 4)}`);
      vec[pIdx] += 1.1 * pSign;
    }
    if (i + 1 < words.length) {
      const [bIdx, bSign] = hashFeature(`bi:${w}_${words[i + 1]}`);
      vec[bIdx] += 1.4 * bSign;
    }
  }

  for (const [concept, terms] of Object.entries(CONCEPT_SYNONYMS)) {
    const matched = terms.some((t) => (t.includes(" ") ? cleaned.includes(t) : wordSet.has(t)));
    if (matched) {
      const [cIdx, cSign] = hashFeature(`concept:${concept}`);
      vec[cIdx] += 3.5 * cSign;
      for (const syn of terms.slice(0, 5)) {
        const [sIdx, sSign] = hashFeature(`w:${syn}`);
        vec[sIdx] += 0.9 * sSign;
      }
    }
  }

  return l2Normalize(vec);
}

export async function embedQueryEdge(query: string, env: Env): Promise<number[]> {
  if (env.EMBEDDING_GEMMA_URL) {
    try {
      const res = await fetch(`${env.EMBEDDING_GEMMA_URL.replace(/\/$/, "")}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "embeddinggemma-2", input: `task: search result | query: ${query}` }),
      });
      if (res.ok) {
        const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
        return l2Normalize(data.data[0].embedding.slice(0, EMBEDDING_DIM));
      }
    } catch {
      // Fallback to edge embedder
    }
  }
  return embedTextLocal(query);
}

export function evaluateAssetPermission(
  asset: IndexedAsset,
  permission: ContactPermission | null,
  queryEmbedding?: number[]
): "allow_trusted" | "allow_smart_scope" | "ask_owner" | "deny" {
  const tagsLower = new Set(asset.tags.map((t) => t.toLowerCase()));
  if (tagsLower.has("private") || tagsLower.has("hidden") || tagsLower.has("vault")) {
    return "deny";
  }
  if (!permission) return "ask_owner";
  for (const ex of permission.excluded_tags) {
    if (tagsLower.has(ex.toLowerCase())) return "deny";
  }
  if (permission.tier === "trusted") return "allow_trusted";
  if (permission.tier === "smart_scope") {
    for (const rule of permission.smart_scopes) {
      if (matchesSmartScope(asset, rule, queryEmbedding)) return "allow_smart_scope";
    }
    return "ask_owner";
  }
  return "ask_owner";
}

function matchesSmartScope(asset: IndexedAsset, rule: SmartScopeRule, _qVec?: number[]): boolean {
  const tagsLower = new Set(asset.tags.map((t) => t.toLowerCase()));
  for (const ex of rule.excluded_tags || []) {
    if (tagsLower.has(ex.toLowerCase())) return false;
  }
  if (rule.media_types && rule.media_types.length > 0 && !rule.media_types.includes(asset.media_type)) {
    return false;
  }
  const haystack = `${asset.location} ${asset.title} ${asset.filename} ${asset.summary} ${asset.tags.join(" ")}`.toLowerCase();
  if (rule.locations && rule.locations.length > 0) {
    if (!rule.locations.some((loc) => haystack.includes(loc.toLowerCase()))) return false;
  }
  if (rule.people && rule.people.length > 0) {
    const peopleSet = new Set(asset.people.map((p) => p.toLowerCase()));
    for (const rp of rule.people) {
      const rpl = rp.toLowerCase();
      if (!peopleSet.has(rpl) && !haystack.includes(rpl)) return false;
    }
  }
  if (rule.semantic_query && rule.semantic_query.trim()) {
    const words = rule.semantic_query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const lexHit = words.length > 0 && words.every((w) => haystack.includes(w));
    if (!lexHit) {
      const rVec = embedTextLocal(rule.semantic_query);
      if (cosineSimilarity(rVec, asset.embedding) < (rule.similarity_threshold || 0.24)) return false;
    }
  }
  return true;
}
