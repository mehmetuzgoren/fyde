// Natural-language "send" commands for Fyde Chat and the Vexo #69 wristband.
//
// Pure helpers (no D1 / network) so the grammar stays easy to reason about:
//   "Vexo, send that to John"            -> reference to the last files in the conversation
//   "Vexo send my cat picture to John"   -> describe files to find in the library
//   "text Maya the surfing video"        -> double-object form + iMessage channel
//   "share those with my wife by email"  -> relationship recipient + explicit channel

import type { ContactPermission, IndexedAsset, MediaType, SendChannel } from "./types";
import { mediaTermMatch, mediaWords } from "./mediaTerms.ts";

// ---------------------------------------------------------------------------
// Wake word
// ---------------------------------------------------------------------------

// Deepgram renders "Vexo" a few different ways; accept the common ones at the start.
const WAKE_WORD_RE =
  /^\s*(?:(?:hey|hi|ok|okay|yo)[\s,]+)?(?:vex\s?o|vexa|vexxo|vixo|vecso|vekso|bexo|vex)(?:'s|s)?\b[\s,.:;!?-]*/i;

export function stripWakeWord(raw: string): { text: string; wake: boolean } {
  const m = raw.match(WAKE_WORD_RE);
  if (!m) return { text: raw.trim(), wake: false };
  return { text: raw.slice(m[0].length).trim(), wake: true };
}

// ---------------------------------------------------------------------------
// Command grammar
// ---------------------------------------------------------------------------

export interface SendCommand {
  verb: string;
  channel: SendChannel | null;
  recipientPhrase: string;
  itemPhrase: string;
  /** Second reading of an ambiguous double-object phrase, tried if the first finds no recipient. */
  alternative?: { recipientPhrase: string; itemPhrase: string };
}

const VERB_CHANNEL: Record<string, SendChannel | null> = {
  send: null,
  share: null,
  forward: null,
  give: null,
  text: "imessage",
  imessage: "imessage",
  "i-message": "imessage",
  message: "imessage",
  email: "email",
  "e-mail": "email",
  mail: "email",
};

const LEADING_FILLER_RE =
  /^(?:(?:please|pls|can you|could you|would you|will you|can u|go ahead and|i want to|i'd like to|i would like to|let's|lets|now|just|and)\s+)+/i;
const TRAILING_FILLER_RE =
  /\s+(?:too|also|as well|again|now|right now|please|for me|asap|real quick|thanks|thank you)$/i;
const CHANNEL_TAIL_RE =
  /\s+(?:via|by|over|on|through|in|using|with)\s+(imessage|i-message|i message|messages|text message|text|sms|email|e-mail|mail|fyde direct|fyde)$/i;
// Permission phrasing ("give Maya full access") belongs to the permissions branch, not sends.
const PERMISSION_HINT_RE = /\b(access|permission|permissions|trusted|allow|ask first|smart scope)\b/i;
const DETERMINERS = new Set([
  "my", "the", "that", "this", "those", "these", "it", "them", "our", "all", "a", "an",
  "some", "every", "everything", "both", "his", "her", "their", "what", "whatever",
]);

function channelFromWord(word: string): SendChannel {
  const w = word.toLowerCase();
  if (/(email|e-mail|mail)/.test(w)) return "email";
  if (/fyde/.test(w)) return "fyde_direct";
  return "imessage";
}

/** Parses "send <items> to <recipient>" style commands. Returns null when it is not a send. */
export function parseSendCommand(input: string): SendCommand | null {
  let s = input
    .trim()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
  s = s.replace(LEADING_FILLER_RE, "");
  if (PERMISSION_HINT_RE.test(s)) return null;

  const verbMatch = s.match(/^(send|share|forward|give|text|imessage|i-message|message|email|e-mail|mail)\b[,]?\s*(.*)$/i);
  if (!verbMatch) return null;
  const verb = verbMatch[1].toLowerCase();
  let rest = verbMatch[2].trim().replace(/,/g, " ").replace(/\s+/g, " ");
  let channel: SendChannel | null = VERB_CHANNEL[verb] ?? null;

  // Strip trailing politeness/"too" and an explicit channel tail, in any order.
  for (let i = 0; i < 4; i++) {
    const before = rest;
    rest = rest.replace(TRAILING_FILLER_RE, "");
    const ch = rest.match(CHANNEL_TAIL_RE);
    if (ch) {
      channel = channelFromWord(ch[1]);
      rest = rest.slice(0, ch.index).trim();
    }
    if (rest === before) break;
  }

  // Form 1: "<items> to|with <recipient>" — use the LAST preposition so
  // "photos from our trip to Kyoto to Maya" resolves to Maya.
  const prepRe = /\s(?:to|with)\s/gi;
  let lastIdx = -1;
  let lastLen = 0;
  for (const m of rest.matchAll(prepRe)) {
    lastIdx = m.index ?? -1;
    lastLen = m[0].length;
  }
  if (rest.toLowerCase().startsWith("to ")) {
    // "send to John" (no items) — treat as reference to the conversation.
    return { verb, channel, recipientPhrase: rest.slice(3).trim(), itemPhrase: "" };
  }
  if (lastIdx >= 0) {
    return {
      verb,
      channel,
      itemPhrase: rest.slice(0, lastIdx).trim(),
      recipientPhrase: rest.slice(lastIdx + lastLen).trim(),
    };
  }

  // Form 2 (double object): "send John my cat picture", "text Maya the video".
  const tokens = rest.split(" ").filter(Boolean);
  if (tokens.length === 0) return { verb, channel, recipientPhrase: "", itemPhrase: "" };
  const nextDeterminer = tokens.findIndex((t, i) => i > 0 && DETERMINERS.has(t.toLowerCase()));
  const first = tokens[0].toLowerCase();
  if (DETERMINERS.has(first)) {
    // "send that" — items only. "send my wife the tax return" — maybe a relationship
    // recipient; the caller tries `alternative` when the primary reading has no recipient.
    const alternative =
      (first === "my" || first === "our") && nextDeterminer > 1
        ? { recipientPhrase: tokens.slice(0, nextDeterminer).join(" "), itemPhrase: tokens.slice(nextDeterminer).join(" ") }
        : undefined;
    return { verb, channel, recipientPhrase: "", itemPhrase: rest, alternative };
  }
  if (nextDeterminer === -1) {
    // "send John" / "email Sarah Lee": whole phrase may be the name; "send John photos": name + items.
    return {
      verb,
      channel,
      recipientPhrase: tokens[0],
      itemPhrase: tokens.slice(1).join(" "),
      alternative: tokens.length <= 3 ? { recipientPhrase: rest, itemPhrase: "" } : undefined,
    };
  }
  return {
    verb,
    channel,
    recipientPhrase: tokens.slice(0, nextDeterminer).join(" "),
    itemPhrase: tokens.slice(nextDeterminer).join(" "),
  };
}

// ---------------------------------------------------------------------------
// What to send
// ---------------------------------------------------------------------------

export type ItemCount = "one" | "many" | "auto";

export interface ItemSpec {
  /** reference = "that/it/those" (use the conversation); recent = "my latest photo"; describe = search the library. */
  mode: "reference" | "recent" | "describe";
  contentTokens: string[];
  query: string;
  mediaTypes: MediaType[];
  count: ItemCount;
}

const MEDIA_NOUNS: Record<string, { type: MediaType | null; plural: boolean; content?: boolean }> = {
  photo: { type: "photo", plural: false }, photos: { type: "photo", plural: true },
  picture: { type: "photo", plural: false }, pictures: { type: "photo", plural: true },
  pic: { type: "photo", plural: false }, pics: { type: "photo", plural: true },
  image: { type: "photo", plural: false }, images: { type: "photo", plural: true },
  shot: { type: "photo", plural: false }, shots: { type: "photo", plural: true },
  selfie: { type: "photo", plural: false, content: true }, selfies: { type: "photo", plural: true, content: true },
  screenshot: { type: "photo", plural: false, content: true }, screenshots: { type: "photo", plural: true, content: true },
  video: { type: "video", plural: false }, videos: { type: "video", plural: true },
  clip: { type: "video", plural: false }, clips: { type: "video", plural: true },
  movie: { type: "video", plural: false }, movies: { type: "video", plural: true },
  footage: { type: "video", plural: true },
  pdf: { type: "document", plural: false }, pdfs: { type: "document", plural: true },
  doc: { type: "document", plural: false }, docs: { type: "document", plural: true },
  document: { type: "document", plural: false }, documents: { type: "document", plural: true },
  scan: { type: "document", plural: false, content: true }, scans: { type: "document", plural: true, content: true },
  file: { type: null, plural: false }, files: { type: null, plural: true },
  attachment: { type: null, plural: false }, attachments: { type: null, plural: true },
  item: { type: null, plural: false }, items: { type: null, plural: true },
};

// Words that point back at the conversation rather than describing content.
const REFERENCE_WORDS = new Set([
  "that", "this", "it", "those", "these", "them", "same", "one", "ones", "thing", "things", "stuff",
  "result", "results", "above", "found", "showed", "shown", "show", "sent", "got", "previous",
]);
const RECENCY_WORDS = new Set(["latest", "newest", "last", "recent", "most", "just", "took", "taken", "uploaded", "added"]);
const FILLER_WORDS = new Set([
  "the", "a", "an", "my", "our", "your", "his", "her", "their", "of", "from", "in", "on", "at", "for",
  "about", "and", "or", "me", "i", "we", "us", "you", "what", "which", "whatever", "all", "some", "both",
  "every", "everything", "please", "again", "also", "too", "here", "there", "over", "just", "s",
]);
const PLURAL_CUES = new Set(["all", "those", "these", "them", "both", "everything", "ones", "things"]);
const SINGULAR_CUES = new Set(["that", "this", "it", "one"]);

export function analyzeItemPhrase(phrase: string): ItemSpec {
  const tokens = phrase
    .toLowerCase()
    .replace(/[^a-z0-9@'\s-]/g, " ")
    .replace(/'s\b/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const mediaTypes: MediaType[] = [];
  let pluralNoun = false;
  let singularNoun = false;
  let hasReference = false;
  let hasRecency = false;
  const content: string[] = [];

  for (const t of tokens) {
    const media = MEDIA_NOUNS[t];
    if (media) {
      if (media.type && !mediaTypes.includes(media.type)) mediaTypes.push(media.type);
      if (media.plural) pluralNoun = true;
      else singularNoun = true;
      if (media.content) content.push(t);
      continue;
    }
    if (REFERENCE_WORDS.has(t)) {
      hasReference = true;
      continue;
    }
    if (RECENCY_WORDS.has(t)) {
      hasRecency = true;
      continue;
    }
    if (FILLER_WORDS.has(t)) continue;
    if (t.length < 2 && !/\d/.test(t)) continue;
    content.push(t);
  }

  let count: ItemCount = "auto";
  if (pluralNoun || tokens.some((t) => PLURAL_CUES.has(t))) count = "many";
  else if (singularNoun || tokens.some((t) => SINGULAR_CUES.has(t))) count = "one";

  let mode: ItemSpec["mode"] = "describe";
  if (content.length === 0) {
    // "my latest photo" -> newest library item; "that"/"it"/"" -> the conversation.
    mode = hasRecency && !hasReference ? "recent" : "reference";
  }

  return { mode, contentTokens: content, query: content.join(" "), mediaTypes, count };
}

// ---------------------------------------------------------------------------
// Whole-word asset matching (substring matching lets "cat" hit "location")
// ---------------------------------------------------------------------------

export function assetWordSet(asset: IndexedAsset): Set<string> {
  const text = [
    asset.title,
    asset.filename,
    asset.location,
    asset.people.join(" "),
    asset.tags.join(" "),
    asset.ocr_text,
    asset.summary,
    asset.folder_path,
    ...(asset.video_moments || []).map((m) => m.label),
  ]
    .join(" ")
    .toLowerCase();
  return mediaWords(text);
}

export function countWordMatches(contentTokens: string[], words: Set<string>): number {
  return contentTokens.filter((token) => mediaTermMatch(token, words) > 0).length;
}

export interface RankedAsset {
  asset: IndexedAsset;
  matched: number;
  vectorScore: number;
}

/**
 * Keeps only confident matches: the best lexical tier, where at least half of the
 * spoken content words appear as whole words. Falls back to strong semantic-only
 * matches when nothing matches lexically.
 *
 * `vectorScore` must be the calibrated SearchHit.score from searchOwnerAssets (strong
 * matches ~0.6–0.95, near-misses ~0.45–0.5), not raw cosine. 0.6 is deliberately a
 * little above the 0.55 search cutoff because this path can send files automatically.
 */
export function pickConfidentMatches(
  ranked: RankedAsset[],
  contentTokens: string[],
  count: ItemCount,
  vectorOnlyThreshold = 0.6,
  maxItems = 10
): IndexedAsset[] {
  const need = Math.max(1, Math.ceil(contentTokens.length / 2));
  const lexical = ranked.filter((r) => r.matched >= need);
  let tier: RankedAsset[];
  if (lexical.length > 0) {
    const best = Math.max(...lexical.map((r) => r.matched));
    tier = lexical.filter((r) => r.matched === best);
  } else {
    tier = ranked.filter((r) => r.vectorScore >= vectorOnlyThreshold);
  }
  tier.sort((a, b) => b.matched - a.matched || b.vectorScore - a.vectorScore);
  const picked = tier.map((r) => r.asset);
  return count === "one" ? picked.slice(0, 1) : picked.slice(0, maxItems);
}

// ---------------------------------------------------------------------------
// Who to send to
// ---------------------------------------------------------------------------

export interface RecipientCandidate {
  name: string;
  handle?: string | null;
  userId?: string | null;
  email?: string;
  phone?: string;
  relationship?: string;
  perm?: ContactPermission | null;
  /** True for the user's own contacts (permission rows / accepted friends). */
  isContact: boolean;
}

export type RecipientResolution =
  | { kind: "match"; candidate: RecipientCandidate }
  | { kind: "email"; email: string }
  | { kind: "ambiguous"; options: RecipientCandidate[] }
  | { kind: "none" };

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function normName(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/'s$/, "")
    .replace(/[^a-z0-9@._+\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueBy(cands: RecipientCandidate[]): RecipientCandidate[] {
  const seen = new Set<string>();
  const out: RecipientCandidate[] = [];
  for (const c of cands) {
    const key = c.userId || `name:${normName(c.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function resolveRecipient(phrase: string, candidates: RecipientCandidate[]): RecipientResolution {
  const raw = phrase.trim();
  const email = raw.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (email) return { kind: "email", email: email[0].toLowerCase() };

  const p = normName(raw).replace(/^(?:my|our)\s+/, "");
  if (!p) return { kind: "none" };

  const contacts = candidates.filter((c) => c.isContact);
  const tiers: Array<(c: RecipientCandidate) => boolean> = [
    (c) => normName(c.handle) === p || normName(c.userId) === p,
    (c) => normName(c.name) === p,
    (c) => !!c.relationship && normName(c.relationship) === p,
    (c) => normName(c.name).split(" ")[0] === p,
  ];

  // Contacts first (more specific), then the global directory for exact handle/name only.
  for (const test of tiers) {
    const hits = uniqueBy(contacts.filter(test));
    if (hits.length === 1) return { kind: "match", candidate: hits[0] };
    if (hits.length > 1) return { kind: "ambiguous", options: hits };
  }

  // Speech-to-text slips ("Jon" for "John", "Maia" for "Maya"): one edit away, contacts only.
  if (p.length >= 3) {
    const fuzzy = uniqueBy(
      contacts.filter((c) => {
        const first = normName(c.name).split(" ")[0];
        return [first, normName(c.handle), normName(c.name)].some((n) => n.length >= 3 && levenshtein(n, p) <= 1);
      })
    );
    if (fuzzy.length === 1) return { kind: "match", candidate: fuzzy[0] };
    if (fuzzy.length > 1) return { kind: "ambiguous", options: fuzzy };
  }

  const globals = candidates.filter((c) => !c.isContact);
  for (const test of tiers.slice(0, 2)) {
    const hits = uniqueBy(globals.filter(test));
    if (hits.length === 1) return { kind: "match", candidate: hits[0] };
    if (hits.length > 1) return { kind: "ambiguous", options: hits };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Permission wording
// ---------------------------------------------------------------------------

export function describeHoldReason(
  recipientName: string,
  perm: ContactPermission | null | undefined,
  privateTitles: string[],
  outOfScopeCount: number,
  totalCount: number
): string {
  if (privateTitles.length > 0) {
    const first = `“${privateTitles[0]}”`;
    return privateTitles.length === 1
      ? `${first} is marked private`
      : `${first} and ${privateTitles.length - 1} other item(s) are marked private`;
  }
  if (!perm) return `${recipientName} isn't one of your contacts yet`;
  switch (perm.tier) {
    case "ask_first":
      return `${recipientName} is set to Ask First`;
    case "send_only":
      return `${recipientName} is set to Send Only`;
    case "smart_scope":
      if (outOfScopeCount >= totalCount) {
        return totalCount === 1
          ? `it's outside ${recipientName}'s Smart Scope`
          : `they're outside ${recipientName}'s Smart Scope`;
      }
      return `${outOfScopeCount} of the ${totalCount} items ${outOfScopeCount === 1 ? "is" : "are"} outside ${recipientName}'s Smart Scope`;
    default:
      return `${recipientName}'s permissions don't cover this yet`;
  }
}
