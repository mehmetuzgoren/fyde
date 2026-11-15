// Close visual concepts bridge the vocabulary people use and image-classifier tags.
// Keep unrelated subjects (such as cats and dogs) in separate groups.
const RELATED_TERMS = [
  ["kayak", "kayaking", "kayaker", "canoe", "canoeing", "raft", "rafting", "paddle", "paddling", "whitewater"],
  ["bike", "biking", "bicycle", "bicycling", "cycle", "cycling"],
  ["hike", "hiking", "trek", "trekking"],
  ["cat", "kitten", "feline"],
  ["dog", "puppy", "canine"],
  ["sunset", "sundown", "dusk"],
];

export function stemMediaWord(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && /(sh|ch|x|z|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

export function mediaWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(stemMediaWord));
}

const relatedByWord = new Map<string, Set<string>>();
for (const terms of RELATED_TERMS) {
  const words = new Set(terms.map(stemMediaWord));
  for (const word of words) relatedByWord.set(word, words);
}

/** Exact words rank ahead of related concepts; neither matches inside another word. */
export function mediaTermMatch(term: string, words: Set<string>): number {
  const stem = stemMediaWord(term);
  if (words.has(stem)) return 1;
  const related = relatedByWord.get(stem);
  return related && [...related].some((word) => words.has(word)) ? 0.75 : 0;
}
