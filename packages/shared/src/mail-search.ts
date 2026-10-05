/** Stored-mail search uses literal substrings: every term must match one message.
 * Double quotes group an exact phrase; no operators, stemming, or typo expansion.
 * Empty/unclosed quotes remain literal so they cannot broaden a search to all mail.
 */
export function mailSearchTerms(query: string): string[] {
  // Both public search schemas cap input at 200 characters. Keep internal/demo
  // callers bounded too, without silently dropping constraints from a long query.
  if (query.length > 200) throw new RangeError("Mail search is limited to 200 characters");
  const terms = [...query.trim().matchAll(/"([^"]+)"|(\S+)/gu)]
    .map(match => (match[1] ?? match[2]!).toLocaleLowerCase());
  const unique = [...new Set(terms)];
  if (unique.length > 16) throw new RangeError("Use at most 16 distinct search terms or quoted phrases");
  return unique;
}

export function isBoundedMailSearchQuery(query: string): boolean {
  try { mailSearchTerms(query); return true; } catch { return false; }
}
