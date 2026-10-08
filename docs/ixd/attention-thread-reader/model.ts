import type { InboxMessage, ThreadDetailMessage } from "../../../packages/shared/src/index";
import { behaviors } from "./fixture";
export function groupAttention(rows: readonly InboxMessage[]) {
  return behaviors.map(behavior => ({ behavior, messages: rows.filter(r => r.attentionBehavior === behavior).toSorted((a,b) => b.receivedAt.localeCompare(a.receivedAt)) })).filter(g => g.messages.length);
}
export function initialMessage(messages: readonly ThreadDetailMessage[]) {
  return messages.find(m => m.unread) ?? messages.at(-1);
}
// Conservative, lossless preview only. A later non-quote line means the entire
// body stays visible. We deliberately do not classify forwarded prose.
export function splitTrailingQuote(body: string) {
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const first = lines.findIndex((line, i) => i > 0 && /^\s*On .+wrote:\s*$/.test(line));
  if (first < 0 || !lines.slice(first + 1).some(l => /^\s*>/.test(l)) || lines.slice(first + 1).some(l => l.trim() && !/^\s*>/.test(l))) return { current: body, quote: "" };
  return { current: lines.slice(0, first).join(""), quote: lines.slice(first).join("") };
}
export function decodePreview(value: string) {
  let text = value;
  for (let i = 0; i < 2; i++) text = text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, code: string) => ({amp:"&",lt:"<",gt:">",quot:'"',apos:"'","#39":"'"}[code]!));
  return text;
}
