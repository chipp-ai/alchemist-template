/**
 * Docs ranking helpers — pure logic, no DB.
 */

import { assert, assertEquals } from "@std/assert";
import { cosineSimilarity, keywordScore } from "@/services/docs/search.ts";

Deno.test("cosine: identical vectors → 1, orthogonal → 0", () => {
  assertEquals(Math.round(cosineSimilarity([1, 2, 3], [1, 2, 3]) * 1000) / 1000, 1);
  assertEquals(cosineSimilarity([1, 0], [0, 1]), 0);
});

Deno.test("cosine: ranks the nearer vector higher", () => {
  const q = [1, 1, 0];
  const near = [0.9, 1.1, 0];
  const far = [0, 0, 1];
  assert(cosineSimilarity(q, near) > cosineSimilarity(q, far));
});

Deno.test("cosine: zero vector → 0 (no NaN)", () => {
  assertEquals(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
});

Deno.test("keyword: scores by query-term overlap, ignores short stopwords", () => {
  // "to"/"a" are <=2 chars and dropped; "invite"/"teammate" count.
  const q = "how to invite a teammate";
  const hit = keywordScore(q, "Use the invites page to add a teammate to your org.");
  const miss = keywordScore(q, "Billing and subscription settings.");
  assert(hit > miss, "the relevant passage scores higher");
  assert(hit > 0 && miss === 0);
});

Deno.test("keyword: empty / stopword-only query → 0", () => {
  assertEquals(keywordScore("a to of", "anything here"), 0);
  assertEquals(keywordScore("", "anything"), 0);
});
