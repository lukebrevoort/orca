import { describe, expect, test } from "bun:test";
import { isBoundedMailSearchQuery, mailSearchTerms } from "./mail-search.ts";

describe("literal mail search terms", () => {
  test("normalizes whitespace, case and duplicate terms", () => {
    expect(mailSearchTerms("  Harbor\tconfirmed\nHARBOR  ")).toEqual(["harbor", "confirmed"]);
    expect(mailSearchTerms("\u00a0harbor\u2003confirmed")).toEqual(["harbor", "confirmed"]);
    expect(mailSearchTerms("  ")).toEqual([]);
  });
  test("groups exact phrases without interpreting operators or SQL characters", () => {
    expect(mailSearchTerms('harbor "appointment is confirmed"')).toEqual(["harbor", "appointment is confirmed"]);
    expect(mailSearchTerms('25% BK_42 C:\\art OR \'quote\'')).toEqual(["25%", "bk_42", "c:\\art", "or", "'quote'"]);
    expect(mailSearchTerms('"')).toEqual(['"']);
    expect(mailSearchTerms('""')).toEqual(['""']);
    expect(mailSearchTerms('confirmed"')).toEqual(['confirmed"']);
  });
  test("bounds terms and never truncates excess query constraints", () => {
    const many = Array.from({ length: 16 }, (_, index) => String.fromCharCode(0x4e00 + index)).join(" ");
    expect(mailSearchTerms(many)).toHaveLength(16);
    expect(isBoundedMailSearchQuery(`${many} extra`)).toBe(false);
    expect(() => mailSearchTerms(`${many} extra`)).toThrow("at most 16");
    expect(mailSearchTerms("repeat ".repeat(20))).toEqual(["repeat"]);
    expect(mailSearchTerms("x".repeat(200))).toEqual(["x".repeat(200)]);
    expect(() => mailSearchTerms("x".repeat(201))).toThrow(RangeError);
  });
});
