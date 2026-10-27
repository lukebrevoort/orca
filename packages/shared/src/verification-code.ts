/** Offsets are UTF-16 positions in bodyText (or snippet). Subject is confidence only.
 * Only the first 20,000 UTF-16 units of each input are inspected. ASCII codes only.
 */
export function detectVerificationCodes(input: { subject?: string | null; bodyText?: string | null; snippet?: string | null }): { code: string; start: number }[] {
  const text = (input.bodyText || input.snippet || "").slice(0, 20_000);
  const subject = (input.subject || "").slice(0, 20_000);
  const keyword = /\b(?:code|passcode|one-time|OTP|verification|verify|security code|sign[- ]in|login|2FA|PIN|confirmation code)\b/gi;
  const subjectSignal = new RegExp(keyword.source, "i").test(subject);
  const signals = [...text.matchAll(keyword)].map(m => ({ start: m.index, end: m.index + m[0].length }));
  if (!subjectSignal && !signals.length) return [];
  const results: { code: string; start: number }[] = [];
  let signalIndex = 0;
  // Bounded repetitions: no unbounded backtracking even for very large mail.
  // Space-separated groups must each contain a digit so adjacent prose stays outside the code.
  const candidates = /(?<![A-Za-z0-9\u200B-\u200D])(?!(?:CODE|OTP|PIN|VERIFY|LOGIN|2FA) )(?:[A-Za-z]-[0-9]{4,8}|[A-Z0-9]{1}-[A-Z0-9]{3,7}|[A-Z0-9]{2}-[A-Z0-9]{2,6}|[A-Z0-9]{3}-[A-Z0-9]{1,5}|[A-Z0-9]{4}-[A-Z0-9]{1,4}|[A-Z0-9]{5}-[A-Z0-9]{1,3}|[A-Z0-9]{6}-[A-Z0-9]{1,2}|[A-Z0-9]{7}-[A-Z0-9]{1,1}|(?=[A-Z0-9]{0,7}[0-9][A-Z0-9]{0,7} )(?:[A-Z0-9]{1} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{3,7}|[A-Z0-9]{2} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{2,6}|[A-Z0-9]{3} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{1,5}|[A-Z0-9]{4} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{1,4}|[A-Z0-9]{5} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{1,3}|[A-Z0-9]{6} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{1,2}|[A-Z0-9]{7} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{1,1})|[A-Z0-9]{4,8})(?![A-Za-z0-9\u200B-\u200D])/g;
  const tokens = [...text.matchAll(/\S+/g)];
  let tokenIndex = 0;
  const scripts = [...text.matchAll(/<script\b[^<>]*>[\s\S]*?(?:<\/script\s*>|$)/gi)];
  // Exclude whole dates: the candidate may combine the day and year.
  const dates = [...text.matchAll(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(?:0?[1-9]|[12][0-9]|3[01]),?\s+[0-9]{4}\b/gi)];
  let dateIndex = 0;
  let scriptIndex = 0;
  for (const match of text.matchAll(candidates)) {
    const start = match.index, end = start + match[0].length;
    while (dateIndex < dates.length && dates[dateIndex]!.index + dates[dateIndex]![0].length <= start) dateIndex++;
    if (dates[dateIndex] && dates[dateIndex]!.index < end) continue;
    if (/^(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR|GU|VI|MP) [0-9]{5}$/.test(match[0])) continue;
    if (/^(?:19|20)[0-9]{2}[- /](?:0?[1-9]|1[0-2])$/.test(match[0])) continue;
    const code = match[0].replace(/^[A-Za-z]-(?=[0-9]{4,8}$)/, "").replace(/[ -]/g, "");
    if (!/^(?:[0-9]{4,8}|(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{6,8})$/.test(code)) continue;
    while (signalIndex < signals.length && signals[signalIndex]!.end < start - 80) signalIndex++;
    if (!subjectSignal && (!signals[signalIndex] || signals[signalIndex]!.start > end + 80)) continue;
    while (tokenIndex + 1 < tokens.length && tokens[tokenIndex + 1]!.index <= start) tokenIndex++;
    const token = tokens[tokenIndex]?.[0] || "";
    if (/:\/\/|www\.|@/i.test(token)) continue;
    while (scriptIndex < scripts.length && scripts[scriptIndex]!.index + scripts[scriptIndex]![0].length <= start) scriptIndex++;
    if (scripts[scriptIndex] && scripts[scriptIndex]!.index <= start) continue;
    const before = text.slice(Math.max(0, start - 35), start);
    const after = text.slice(end, end + 20);
    if (/(?:order|tracking|invoice|ref)\b(?:\s+(?:code|passcode|OTP|PIN)\b[^\n]{0,24}|(?![^\n]{0,24}\b(?:code|passcode|OTP|PIN)\b)[^\n]{0,24})$/i.test(before)) continue;
    if (/[$€]\s*$/.test(before) || /^\.[0-9]{2}/.test(after) || /[0-9][.:/\-]$/.test(before) || /^[.:/\-][0-9]/.test(after)) continue;
    if (/\([0-9]{2,4}\)\s*$/.test(before)) continue;
    if (/\+[^A-Za-z\n]*$/.test(before) || /[0-9][ -]$/.test(before) || /^[ -][0-9]/.test(after)) continue;
    if (/\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR|GU|VI|MP)\s+$/.test(before) && /^[0-9]{5}$/.test(code)) continue;
    if (/^(?:19|20)[0-9]{2}$/.test(code) && (/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*$/i.test(before) || /^\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/i.test(after))) continue;
    if (!results.some(result => result.code === code)) results.push({ code, start });
    if (results.length === 2) break;
  }
  return results;
}
