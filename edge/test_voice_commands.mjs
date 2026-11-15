// Unit tests for the "Vexo, send that to John" grammar (no wrangler needed).
// Run: node test_voice_commands.mjs   (Node >= 23 strips TypeScript types natively)
import assert from "node:assert/strict";
import {
  analyzeItemPhrase,
  assetWordSet,
  countWordMatches,
  parseSendCommand,
  pickConfidentMatches,
  resolveRecipient,
  stripWakeWord,
} from "./src/voiceCommands.ts";

// Wake word variants Deepgram produces
for (const raw of ["Vexo, send that to John.", "Hey Vexo send that to John", "vexa: send that to John", "Okay Vexo. send that to John"]) {
  assert.deepEqual(stripWakeWord(raw), { text: raw.replace(/^.*?(send)/i, "$1").trim(), wake: true }, raw);
}
assert.equal(stripWakeWord("Send that to John").wake, false);

// Grammar
const cases = [
  ["send that to John", { recipientPhrase: "John", itemPhrase: "that", channel: null }],
  ["send my cat picture to John", { recipientPhrase: "John", itemPhrase: "my cat picture", channel: null }],
  ["can you send the photos from our trip to Kyoto to Maya please", { recipientPhrase: "Maya", itemPhrase: "the photos from our trip to Kyoto" }],
  ["text Maya the surfing video", { recipientPhrase: "Maya", itemPhrase: "the surfing video", channel: "imessage" }],
  ["send John my cat picture", { recipientPhrase: "John", itemPhrase: "my cat picture" }],
  ["share those with my wife by email", { recipientPhrase: "my wife", itemPhrase: "those", channel: "email" }],
  ["send it to John too", { recipientPhrase: "John", itemPhrase: "it" }],
  ["email Sarah", { recipientPhrase: "Sarah", itemPhrase: "" , channel: "email" }],
  ["send that", { recipientPhrase: "", itemPhrase: "that" }],
];
for (const [input, want] of cases) {
  const got = parseSendCommand(input);
  assert.ok(got, input);
  for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${input} -> ${k}`);
}
assert.deepEqual(parseSendCommand("send my wife the tax return").alternative, { recipientPhrase: "my wife", itemPhrase: "the tax return" });
assert.equal(parseSendCommand("give Maya full access"), null, "permission phrasing is not a send");
assert.equal(parseSendCommand("find my China photos"), null);

// What to send
assert.equal(analyzeItemPhrase("that").mode, "reference");
assert.equal(analyzeItemPhrase("").mode, "reference");
assert.deepEqual(analyzeItemPhrase("those videos"), { mode: "reference", contentTokens: [], query: "", mediaTypes: ["video"], count: "many" });
assert.deepEqual(analyzeItemPhrase("my cat picture"), { mode: "describe", contentTokens: ["cat"], query: "cat", mediaTypes: ["photo"], count: "one" });
assert.equal(analyzeItemPhrase("my latest photo").mode, "recent");

// Whole-word matching: "cat" must not match "location"
const asset = (id, title, extra = {}) => ({
  id, title, filename: `${id}.jpg`, location: "", people: [], tags: [], ocr_text: "", summary: "", folder_path: "",
  video_moments: [], media_type: "photo", ...extra,
});
const surf = asset("surf", "Surfing Waves at Pacifica Beach", { summary: "Great location for a vacation" });
const cat = asset("cat", "Milo the Cat on the Couch", { tags: ["cat", "pet"] });
assert.equal(countWordMatches(["cat"], assetWordSet(surf)), 0);
assert.equal(countWordMatches(["cats"], assetWordSet(cat)), 1);
const rank = (list, tokens) => list.map((a) => ({ asset: a, matched: countWordMatches(tokens, assetWordSet(a)), vectorScore: 0.2 }));
assert.deepEqual(pickConfidentMatches(rank([surf, cat], ["cat"]), ["cat"], "one").map((a) => a.id), ["cat"]);
assert.deepEqual(pickConfidentMatches(rank([surf], ["dog"]), ["dog"], "one"), [], "no confident match -> nothing");

// Recipients
const people = [
  { name: "John Appleseed", handle: "johnapple", userId: "u_john", isContact: true },
  { name: "Maya", handle: "maya", userId: "maya", relationship: "Wife", isContact: true },
  { name: "John Stranger", handle: "johnny", userId: "u_x", isContact: false },
];
assert.equal(resolveRecipient("John", people).candidate?.userId, "u_john", "first name prefers contacts");
assert.equal(resolveRecipient("Jon", people).candidate?.userId, "u_john", "one-letter slip");
assert.equal(resolveRecipient("my wife", people).candidate?.userId, "maya");
assert.equal(resolveRecipient("@johnny", people).candidate?.userId, "u_x", "exact handle reaches the directory");
assert.equal(resolveRecipient("Bob", people).kind, "none");
assert.equal(resolveRecipient("john@example.com", people).kind, "email");
assert.equal(
  resolveRecipient("Maya", [...people, { name: "Maya Lopez", userId: "u_ml", isContact: true }]).candidate?.userId,
  "maya",
  "exact name beats first-name match"
);

console.log("voiceCommands: all assertions passed");
