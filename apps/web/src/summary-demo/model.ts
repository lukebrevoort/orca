export type AccountId = "work" | "personal";
export type Message = { id: string; subject: string; person: string };
export type Reply = Message & { body: string; status: "Draft" | "Edited" | "Approved" };
export type Attention = Message & { reason: string; handled: boolean };
export type Waiting = Message & { days: number; stopped: boolean; draft?: Reply };
export type Code = Message & { value: string; expiresAt: number };
export type Account = { attention: Attention[]; replies: Reply[]; waiting: Waiting[]; codes: Code[]; routine: Message[] };
export type DemoState = Record<AccountId, Account>;
export type Action =
  | { type: "handle"; id: string }
  | { type: "stop"; id: string }
  | { type: "follow-up"; id: string }
  | { type: "edit"; id: string; body: string }
  | { type: "approve"; id: string };
export const categories = ["Needs you", "Drafted replies", "Waiting on", "Codes"] as const;
export function isExpired(code: Code, now: number): boolean { return now >= code.expiresAt; }
export function countdown(code: Code, now: number): string {
  if (isExpired(code, now)) return "Expired";
  const seconds = Math.ceil((code.expiresAt - now) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} remaining`;
}
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
export function activeItems(account: Account, now: number) {
  return {
    attention: account.attention.filter(item => !item.handled),
    // Only fixture reply drafts contribute to this tile. Follow-up drafts belong to Waiting on.
    replies: account.replies.filter(item => item.status !== "Approved"),
    waiting: account.waiting.filter(item => !item.stopped),
    codes: account.codes.filter(item => !isExpired(item, now)),
  };
}
export function counts(account: Account, now: number): number[] {
  const active = activeItems(account, now);
  return [active.attention.length, active.replies.length, active.waiting.length, active.codes.length];
}
export function notificationLines(account: Account, now: number): string[] {
  return counts(account, now).map((count, index) => `${categories[index]}: ${count}`);
}
export function canApprove(reply: Reply): boolean { return reply.status !== "Approved" && Boolean(reply.body.trim()); }
function changeReply(reply: Reply, action: Action): Reply {
  if (reply.id !== action.id || reply.status === "Approved") return reply;
  if (action.type === "edit") return { ...reply, body: action.body, status: "Edited" };
  if (action.type === "approve" && canApprove(reply)) return { ...reply, status: "Approved" };
  return reply;
}
export function transition(state: DemoState, accountId: AccountId, action: Action): DemoState {
  const account = state[accountId];
  return { ...state, [accountId]: { ...account,
    attention: account.attention.map(item => item.id === action.id && action.type === "handle" ? { ...item, handled: true } : item),
    replies: account.replies.map(item => changeReply(item, action)),
    waiting: account.waiting.map(item => {
      if (item.draft?.id === action.id && !item.stopped) return { ...item, draft: changeReply(item.draft, action) };
      if (item.id !== action.id) return item;
      if (action.type === "stop") return { ...item, stopped: true };
      if (action.type === "follow-up" && !item.stopped && !item.draft) return { ...item, draft: {
        id: `${item.id}-draft`, subject: item.subject, person: item.person,
        body: "Just checking in. Do you have an update?", status: "Draft",
      } };
      return item;
    }),
  } };
}
