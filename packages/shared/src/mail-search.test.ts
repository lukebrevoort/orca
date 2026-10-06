import { expect, test } from "bun:test";
import { parseMailSearch, mailSearchQuerySchema, mailSearchCapabilitiesSchema } from "./mail-search.ts";

test("literal clauses preserve punctuation, quoted spacing and mixed short terms", () => {
  expect(parseMailSearch('AI update "confirmed  with Morgan" BK_42 50%').clauses).toEqual(["ai", "update", "confirmed  with morgan", "bk_42", "50%"]);
  expect(parseMailSearch("AI update").shortClauses).toEqual(["ai"]);
  expect(parseMailSearch("PR review REVIEW").anchors).toEqual(["review"]);
  expect(parseMailSearch('"a \\"quoted\\" phrase"').clauses).toEqual(['a "quoted" phrase']);
});

test("unsupported queries reject explicitly without dropping terms or changing coverage", () => {
  for (const query of ["AI", "AI PR", '""', '"unclosed', "word\0bad", "x".repeat(201), Array.from({ length: 17 }, (_, index) => `term${index}`).join(" ")]) {
    expect(() => parseMailSearch(query)).toThrow();
  }
  expect(mailSearchQuerySchema.safeParse({ query: "AI update", limit: 10 }).success).toBe(true);
  expect(mailSearchQuerySchema.safeParse({ query: "AI update", searchBodyText: true }).success).toBe(false);
});


test("capabilities strictly pair activation mode, coverage and parser semantics", () => {
  const legacy = { version: 1, ownerId: "owner", epoch: "opaque-epoch", mode: "legacy-metadata", coverage: "stored-metadata", semantics: "legacy-substring-v1" };
  const indexed = { ...legacy, mode: "indexed", coverage: "stored-plaintext", semantics: "literal-index-v3" };
  expect(mailSearchCapabilitiesSchema.safeParse(legacy).success).toBe(true);
  expect(mailSearchCapabilitiesSchema.safeParse(indexed).success).toBe(true);
  for (const invalid of [{ ...legacy, coverage: "stored-plaintext" }, { ...indexed, semantics: "legacy-substring-v1" }, { ...legacy, extra: true }, { ...legacy, ownerId: "" }, { ...legacy, epoch: "" }]) {
    expect(mailSearchCapabilitiesSchema.safeParse(invalid).success).toBe(false);
  }
});
