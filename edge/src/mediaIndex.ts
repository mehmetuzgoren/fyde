// EmbeddingGemma 2 multimodal indexing + search ranking for Fyde Edge.
//
// Photos and video keyframes are embedded from their pixels (not their file names) with
// Google DeepMind's EmbeddingGemma 2 on Workers AI, into the same 768-D space as text
// queries ("a cat on the couch" lands next to a photo of a cat on a couch). Documents are
// embedded as text. The approach follows DigUp (github.com/ARahim3/DigUp): media gets no
// task prefix, queries get "task: search result | query: ...", documents get
// "title: ... | text: ...", each video keyframe is its own searchable moment, and scores are
// calibrated per modality because text→image cosines sit lower than text→text cosines.
//
// Assets indexed before this (embedder_name "fyde-edge-mrl256", 256-D hashed bag-of-words)
// keep their old scoring until they are re-indexed (POST /api/assets/:id/reindex).

import { cosineSimilarity, embedTextLocal } from "./embedder";
import type { Env, IndexedAsset, SearchHit, VideoMoment } from "./types";

export const EG2_MODEL = "@cf/google/embeddinggemma-2";
export const EG2_EMBEDDER = "embeddinggemma-2-768";
export const EG2_DIM = 768;
export const LEGACY_EMBEDDER = "fyde-edge-mrl256";

/** Larger originals without a client preview are skipped (Worker memory / CPU). */
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
/** Native whole-video embedding (Workers AI samples 1 fps) for files up to this size. */
const MAX_INLINE_VIDEO_BYTES = 12 * 1024 * 1024;
const MAX_FRAMES = 24;
/** Frames in one multi-image "clip" embedding (each image costs ~265 of the 8,192 tokens). */
const MAX_CLIP_FRAMES = 16;
const FRAME_BATCH = 8;
/** Consecutive keyframes this similar are the same shot: keep the first. */
const DUPLICATE_FRAME_COSINE = 0.97;

export interface MediaInput {
  bytes: ArrayBuffer;
  mime: string;
}

export interface FrameInput extends MediaInput {
  t: number;
  label?: string;
}

export interface MediaParts {
  preview: MediaInput | null;
  frames: FrameInput[];
  duration: number | null;
}

export interface VectorFields {
  embedding: number[];
  embedder_name: string;
  video_moments: VideoMoment[];
  duration_sec?: number | null;
}

type AiLike = { run(model: string, inputs: unknown): Promise<unknown> };

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

export function isEg2Asset(a: Pick<IndexedAsset, "embedder_name" | "embedding">): boolean {
  return a.embedder_name === EG2_EMBEDDER && Array.isArray(a.embedding) && a.embedding.length === EG2_DIM;
}

function normalize(vec: ArrayLike<number>): number[] {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = norm < 1e-9 ? 0 : Math.round((vec[i] / norm) * 1e5) / 1e5;
  return out;
}

function meanVector(vecs: number[][]): number[] | null {
  if (vecs.length === 0) return null;
  const acc = new Array<number>(vecs[0].length).fill(0);
  for (const v of vecs) for (let i = 0; i < acc.length; i++) acc[i] += v[i];
  return normalize(acc);
}

function toBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  const native = (u8 as unknown as { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(u8);
  // Chunks are a multiple of 3 bytes, so their base64 strings concatenate cleanly.
  const CHUNK = 0x8000 * 3;
  let out = "";
  for (let i = 0; i < u8.length; i += CHUNK) {
    const part = u8.subarray(i, i + CHUNK);
    let bin = "";
    for (let j = 0; j < part.length; j += 0x8000) {
      bin += String.fromCharCode.apply(null, part.subarray(j, j + 0x8000) as unknown as number[]);
    }
    out += btoa(bin);
  }
  return out;
}

function decodeFloat32Base64(b64: string): Float32Array {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Float32Array(buf.buffer);
}

/** Formats Workers AI can decode. HEIC/AVIF return null: the client must send a JPEG preview. */
export function sniffImageMime(bytes: ArrayBuffer): string | null {
  const b = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

function sniffVideoMime(bytes: ArrayBuffer, declared: string): string | null {
  const b = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  // ISO-BMFF ("....ftyp"): MP4 and QuickTime/MOV (iPhone videos and Live Photos) both decode as video/mp4.
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "video/mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return declared.startsWith("video/") ? declared : null;
}

function imagePart(media: MediaInput) {
  const mime = sniffImageMime(media.bytes) || media.mime;
  return { type: "image_url", image_url: { url: `data:${mime};base64,${toBase64(media.bytes)}` } };
}

async function runEg2(env: Env, inputs: Record<string, unknown>): Promise<number[][] | null> {
  const ai = env.AI as AiLike | undefined;
  if (!ai) return null;
  try {
    const out = (await ai.run(EG2_MODEL, { ...inputs, dimensions: EG2_DIM })) as {
      data?: Array<{ index?: number; embedding: number[] | string }>;
    };
    const rows = out?.data;
    if (!rows || rows.length === 0) return null;
    return rows
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((r) => normalize(typeof r.embedding === "string" ? decodeFloat32Base64(r.embedding) : r.embedding));
  } catch (err) {
    console.warn(`[mediaIndex] ${EG2_MODEL} failed: ${String((err as Error)?.message || err).slice(0, 240)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Embedding entry points
// ---------------------------------------------------------------------------

const queryCache = new Map<string, number[]>();

export async function embedQueryEg2(env: Env, query: string): Promise<number[] | null> {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  const hit = queryCache.get(key);
  if (hit) return hit;
  const rows = await runEg2(env, { input: [`task: search result | query: ${query.trim()}`] });
  const vec = rows?.[0] ?? null;
  if (vec) {
    if (queryCache.size >= 256) queryCache.delete(queryCache.keys().next().value as string);
    queryCache.set(key, vec);
  }
  return vec;
}

export async function embedDocumentEg2(env: Env, title: string, text: string): Promise<number[] | null> {
  const body = text.replace(/\s+/g, " ").trim().slice(0, 6000) || "none";
  const rows = await runEg2(env, { input: [`title: ${title.trim() || "none"} | text: ${body}`] });
  return rows?.[0] ?? null;
}

export async function embedImageEg2(env: Env, media: MediaInput): Promise<number[] | null> {
  const rows = await runEg2(env, { messages: [{ role: "user", content: [imagePart(media)] }] });
  return rows?.[0] ?? null;
}

/** One embedding per frame (batched conversations). */
async function embedFramesEg2(env: Env, frames: FrameInput[]): Promise<Array<number[] | null>> {
  const out: Array<number[] | null> = [];
  for (let i = 0; i < frames.length; i += FRAME_BATCH) {
    const batch = frames.slice(i, i + FRAME_BATCH);
    const rows = await runEg2(env, { messages: batch.map((f) => [{ role: "user", content: [imagePart(f)] }]) });
    if (rows && rows.length === batch.length) {
      out.push(...rows);
    } else {
      // One unreadable frame must not sink its neighbours: retry one by one.
      for (const f of batch) out.push(await embedImageEg2(env, f));
    }
  }
  return out;
}

/** One embedding for the whole clip: its keyframes as interleaved images in one message. */
async function embedClipEg2(env: Env, frames: FrameInput[]): Promise<number[] | null> {
  if (frames.length === 0) return null;
  const picked = evenlySpaced(frames, MAX_CLIP_FRAMES);
  const rows = await runEg2(env, { messages: [{ role: "user", content: picked.map((f) => imagePart(f)) }] });
  return rows?.[0] ?? null;
}

async function embedVideoEg2(env: Env, media: MediaInput): Promise<number[] | null> {
  const mime = sniffVideoMime(media.bytes, media.mime);
  if (!mime) return null;
  const rows = await runEg2(env, {
    messages: [{ role: "user", content: [{ type: "video_url", video_url: { url: `data:${mime};base64,${toBase64(media.bytes)}` } }] }],
  });
  return rows?.[0] ?? null;
}

function evenlySpaced<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.floor(((i + 0.5) * items.length) / max)]);
  return out;
}

function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Request parsing (upload + reindex share this)
// ---------------------------------------------------------------------------

function isFile(v: unknown): v is File {
  return typeof v === "object" && v !== null && typeof (v as File).arrayBuffer === "function";
}

/**
 * Optional multipart fields sent by the Fyde apps alongside (or instead of) the original:
 *   preview       JPEG/PNG of a photo (~1536 px long side) — required for HEIC originals
 *   frame         video keyframe JPEGs (repeatable), in order
 *   frame_times   comma-separated seconds, one per frame
 *   frame_labels  "|"-separated on-device scene labels, one per frame (optional)
 *   duration_sec  video duration
 */
export async function readMediaParts(form: FormData | null): Promise<MediaParts> {
  if (!form) return { preview: null, frames: [], duration: null };
  const rawPreview: unknown = form.get("preview");
  const previewFile = isFile(rawPreview) && rawPreview.size > 0 ? rawPreview : null;
  const preview = previewFile ? { bytes: await previewFile.arrayBuffer(), mime: previewFile.type || "image/jpeg" } : null;

  const times = String(form.get("frame_times") || "")
    .split(",")
    .map((s) => Number.parseFloat(s.trim()));
  const labels = String(form.get("frame_labels") || "").split("|");
  const frames: FrameInput[] = [];
  const frameFields = (form.getAll("frame") as unknown[]).filter(isFile);
  for (let i = 0; i < frameFields.length && frames.length < MAX_FRAMES * 4; i++) {
    const f = frameFields[i];
    if (f.size === 0) continue;
    frames.push({
      bytes: await f.arrayBuffer(),
      mime: f.type || "image/jpeg",
      t: Number.isFinite(times[i]) ? Math.max(0, times[i]) : i,
      label: (labels[i] || "").trim() || undefined,
    });
  }
  frames.sort((a, b) => a.t - b.t);

  const dur = Number.parseFloat(String(form.get("duration_sec") || ""));
  return { preview, frames, duration: Number.isFinite(dur) && dur > 0 ? dur : null };
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

function legacyVectors(asset: IndexedAsset): VectorFields {
  return {
    embedding: embedTextLocal(
      `${asset.title} ${asset.filename} ${asset.location} ${asset.people.join(" ")} ${asset.tags.join(" ")} ${asset.summary}`
    ),
    embedder_name: LEGACY_EMBEDDER,
    video_moments: asset.video_moments || [],
  };
}

function documentText(asset: IndexedAsset): string {
  return [
    asset.filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
    asset.location && `Location: ${asset.location}`,
    asset.people.length > 0 && `People: ${asset.people.join(", ")}`,
    asset.tags.length > 0 && `Tags: ${asset.tags.join(", ")}`,
    asset.summary,
    asset.ocr_text,
  ]
    .filter(Boolean)
    .join(". ");
}

/**
 * Computes EmbeddingGemma 2 vectors for an asset. Falls back to the legacy hashed embedder
 * (still lexically searchable) when Workers AI is unavailable or the media can't be decoded.
 * `loadOriginal` is only called when the client didn't send a preview / keyframes.
 */
export async function computeAssetVectors(
  env: Env,
  asset: IndexedAsset,
  loadOriginal: () => Promise<MediaInput | null>,
  parts: MediaParts
): Promise<VectorFields> {
  if (!env.AI) return legacyVectors(asset);

  if (asset.media_type === "photo") {
    let source: MediaInput | null = parts.preview && sniffImageMime(parts.preview.bytes) ? parts.preview : null;
    if (!source) {
      const original = await loadOriginal();
      if (original && original.bytes.byteLength <= MAX_INLINE_IMAGE_BYTES && sniffImageMime(original.bytes)) source = original;
    }
    const vec = source ? await embedImageEg2(env, source) : null;
    return vec ? { embedding: vec, embedder_name: EG2_EMBEDDER, video_moments: [] } : legacyVectors(asset);
  }

  if (asset.media_type === "video") {
    const frames = evenlySpaced(parts.frames.filter((f) => sniffImageMime(f.bytes)), MAX_FRAMES);
    const moments: VideoMoment[] = [];
    const frameVecs = frames.length > 0 ? await embedFramesEg2(env, frames) : [];
    let last: number[] | null = null;
    frames.forEach((f, i) => {
      const vec = frameVecs[i];
      if (!vec) return;
      if (last && cosineSimilarity(last, vec) >= DUPLICATE_FRAME_COSINE) return;
      last = vec;
      moments.push({
        timestamp_sec: Math.round(f.t * 10) / 10,
        label: f.label ? `${f.label} @ ${formatTimestamp(f.t)}` : `Moment @ ${formatTimestamp(f.t)}`,
        embedding: vec,
      });
    });

    // Clip-level vector: the model's native video understanding when the file is small enough to
    // send (measured better than keyframes alone: 0.70 vs 0.66 for "mountain lake"), else the
    // keyframes as one multi-image input, else the mean of the moments.
    let clip: number[] | null = null;
    const original = await loadOriginal();
    if (original && original.bytes.byteLength <= MAX_INLINE_VIDEO_BYTES) clip = await embedVideoEg2(env, original);
    if (!clip && frames.length > 0) clip = (await embedClipEg2(env, frames)) ?? meanVector(moments.map((m) => m.embedding));
    if (!clip) return legacyVectors(asset);
    return {
      embedding: clip,
      embedder_name: EG2_EMBEDDER,
      video_moments: moments,
      ...(parts.duration ? { duration_sec: parts.duration } : {}),
    };
  }

  const vec = await embedDocumentEg2(env, asset.title, documentText(asset));
  return vec ? { embedding: vec, embedder_name: EG2_EMBEDDER, video_moments: [] } : legacyVectors(asset);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Calibration measured on real library photos/videos (2026-11-14): text→image cosines are
 * ~0.64–0.72 for true matches and ~0.49–0.63 otherwise; text→text sits ~0.1 higher.
 */
const CALIBRATION = {
  visual: { floor: 0.52, span: 0.2, gate: 0.6 },
  text: { floor: 0.62, span: 0.2, gate: 0.68 },
} as const;
const SEMANTIC_WEIGHT = 0.8;
const LEXICAL_WEIGHT = 0.2;
/**
 * Results scoring under this share of the best one are dropped (DigUp's "weaker matches").
 * Stricter when even the best result is only a possible match (e.g. "dog" in a library of cats).
 */
const STRONG_SCORE = 0.6;
const RELATIVE_CUT_STRONG = 0.5;
const RELATIVE_CUT_WEAK = 0.8;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "all", "my", "our", "your", "his", "her", "their", "me", "us",
  "files", "file", "photos", "photo", "pictures", "picture", "pics", "pic", "images", "image", "videos",
  "video", "clips", "clip", "documents", "document", "docs", "send", "get", "find", "show", "search",
  "in", "of", "to", "a", "an", "on", "at", "is", "are", "was", "that", "this", "those", "these", "some",
  "any", "please", "where", "when", "what", "which", "one", "ones",
]);

export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 2 || STOP_WORDS.has(w)) continue;
    // Light stemming so "laptops" finds "laptop" and "cats" finds "cat".
    const stem = w.length > 4 && w.endsWith("es") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
    if (!out.includes(stem)) out.push(stem);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesWordStart(haystack: string, term: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(term)}`, "iu").test(haystack);
}

function assetHaystack(a: IndexedAsset): string {
  return [
    a.title,
    a.filename.replace(/[_-]+/g, " "),
    a.location,
    a.people.join(" "),
    a.tags.join(" "),
    a.ocr_text,
    a.summary,
    (a.video_moments || []).map((m) => m.label).join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

function modalityOf(a: IndexedAsset): keyof typeof CALIBRATION {
  return a.media_type === "photo" || a.media_type === "video" ? "visual" : "text";
}

/**
 * Pool-relative z-scores (DigUp's "meaning" score): each cosine minus its modality's mean
 * (the pool mean while a modality has < 20 items), in standard deviations of the pool.
 */
function poolZScores(cos: number[], modality: string[]): number[] {
  if (cos.length === 0) return [];
  const all = cos.reduce((s, x) => s + x, 0) / cos.length;
  const sums = new Map<string, { sum: number; n: number }>();
  cos.forEach((c, i) => {
    const e = sums.get(modality[i]) || { sum: 0, n: 0 };
    e.sum += c;
    e.n += 1;
    sums.set(modality[i], e);
  });
  const centered = cos.map((c, i) => {
    const e = sums.get(modality[i])!;
    return c - (e.n >= 20 ? e.sum / e.n : all);
  });
  const mean = centered.reduce((s, x) => s + x, 0) / centered.length;
  const sd = Math.max(0.02, Math.sqrt(centered.reduce((s, x) => s + (x - mean) ** 2, 0) / centered.length));
  return centered.map((x) => (x - mean) / sd);
}

export interface QueryVectors {
  eg2: number[] | null;
  legacy: number[] | null;
}

export function rankAssets(assets: IndexedAsset[], query: string, q: QueryVectors, limit: number): SearchHit[] {
  const terms = queryTerms(query);
  const hits: SearchHit[] = [];

  // --- EmbeddingGemma 2 assets: calibrated semantic score + exact-word coverage ---
  const eg2 = q.eg2 ? assets.filter(isEg2Asset) : [];
  const scored = eg2.map((asset) => {
    const base = cosineSimilarity(q.eg2!, asset.embedding);
    let moment: VideoMoment | null = null;
    let momentCos = -1;
    for (const m of asset.video_moments || []) {
      if (m.embedding?.length !== EG2_DIM) continue;
      const c = cosineSimilarity(q.eg2!, m.embedding);
      if (c > momentCos) {
        momentCos = c;
        moment = m;
      }
    }
    const hay = assetHaystack(asset);
    const matched = terms.filter((t) => matchesWordStart(hay, t));
    return { asset, cos: Math.max(base, momentCos), moment, matched };
  });
  const z = poolZScores(
    scored.map((s) => s.cos),
    scored.map((s) => modalityOf(s.asset))
  );

  const eg2Hits: SearchHit[] = [];
  scored.forEach((s, i) => {
    const cal = CALIBRATION[modalityOf(s.asset)];
    const semanticOk = s.cos >= cal.gate && (scored.length < 4 || z[i] >= 0.5);
    if (s.matched.length === 0 && !semanticOk) return;
    const conf = Math.min(1, Math.max(0, (s.cos - cal.floor) / cal.span));
    const coverage = terms.length > 0 ? s.matched.length / terms.length : 0;
    const score = Math.min(0.99, SEMANTIC_WEIGHT * conf + LEXICAL_WEIGHT * coverage);

    const reasons: string[] = [];
    if (s.matched.length > 0) reasons.push(`Matched ${s.matched.slice(0, 3).join(", ")}`);
    if (semanticOk || s.matched.length === 0) {
      const kind = modalityOf(s.asset) === "visual" ? "visual" : "meaning";
      reasons.push(conf >= 0.55 ? `Strong ${kind} match` : `Possible ${kind} match`);
    }
    if (s.moment) reasons.push(`Video moment @ ${s.moment.timestamp_sec.toFixed(1)}s`);

    eg2Hits.push({
      asset: s.asset,
      score: Number(score.toFixed(4)),
      matched_moment_sec: s.moment ? s.moment.timestamp_sec : null,
      matched_moment_label: s.moment ? s.moment.label : null,
      match_reason: reasons.join(" • "),
    });
  });
  hits.push(...eg2Hits);

  // --- Legacy (not yet re-indexed) assets: the previous hashed-vector + substring scoring ---
  const legacyQ = q.legacy;
  for (const asset of assets) {
    if (q.eg2 && isEg2Asset(asset)) continue;
    const baseSim = legacyQ && !isEg2Asset(asset) ? cosineSimilarity(legacyQ, asset.embedding) : 0;
    let bestMomentSec: number | null = null;
    let bestMomentLabel: string | null = null;
    let bestMomentSim = -1;
    for (const m of asset.video_moments || []) {
      if (!legacyQ || m.embedding?.length === EG2_DIM) continue;
      let mSim = cosineSimilarity(legacyQ, m.embedding);
      if (terms.some((tok) => m.label.toLowerCase().includes(tok))) mSim += 0.22;
      if (mSim > bestMomentSim) {
        bestMomentSim = mSim;
        bestMomentSec = m.timestamp_sec;
        bestMomentLabel = m.label;
      }
    }
    const hay = assetHaystack(asset);
    const matched = terms.filter((t) => hay.includes(t));
    const score = Math.max(baseSim, bestMomentSim) + Math.min(0.45, matched.length * 0.18);
    if (score < 0.16 && matched.length === 0) continue;
    const reasons = [matched.length > 0 ? `Matched ${matched.slice(0, 3).join(", ")}` : "Multimodal vector similarity"];
    if (bestMomentSec !== null && bestMomentSim >= 0.18) {
      reasons.push(`Video moment @ ${bestMomentSec.toFixed(1)}s`);
    } else {
      bestMomentSec = null;
      bestMomentLabel = null;
    }
    hits.push({
      asset,
      score: Number(Math.min(0.99, score).toFixed(4)),
      matched_moment_sec: bestMomentSec,
      matched_moment_label: bestMomentLabel,
      match_reason: reasons.join(" • "),
    });
  }

  hits.sort((a, b) => b.score - a.score);
  // Drop results far below the best one once calibrated (EmbeddingGemma 2) scores are in play;
  // a pool of only legacy assets keeps its previous behaviour.
  const top = eg2Hits.reduce((m, h) => Math.max(m, h.score), 0);
  const best = hits[0]?.score ?? 0;
  const ratio = best >= STRONG_SCORE ? RELATIVE_CUT_STRONG : RELATIVE_CUT_WEAK;
  const kept = top > 0 ? hits.filter((h) => h.score >= best * ratio) : hits;
  return kept.slice(0, limit);
}
