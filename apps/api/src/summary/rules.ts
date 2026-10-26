import type { SummaryResponse } from "@orca/shared";
import type { emails, agentEvents, threadReminders } from "../db/schema.ts";
import { classifyHumanSignal } from "../classification/human-signal.ts";

export const summaryWindowMs = 14 * 24 * 60 * 60 * 1000;
export const summaryMessageLimit = 500;
const dayMs = 24 * 60 * 60 * 1000;
// Routing has no score constant on this base. Reuse the classifier's direct
// recipient policy rather than introducing an independent numeric threshold.
const humanThreshold = classifyHumanSignal({ sender: { email: "sender@example.test", name: null }, recipients: [], recipientRelationship: "direct", reply: { hasInReplyTo: false, referenceCount: 0 }, headerSignals: [], providerSignals: [] }).score!;
export type SummaryMessage = Pick<typeof emails.$inferSelect, "id" | "accountId" | "threadId" | "fromAddress" | "toRecipients" | "subject" | "snippet" | "bodyText" | "receivedAt" | "isRead" | "humanSignal" | "humanClassification" | "humanClassificationReasons">;
export type SummaryEvent = Pick<typeof agentEvents.$inferSelect, "accountId" | "ownerUserId" | "messageId" | "threadId" | "lifecycleState" | "title" | "whyThisMatters"> & { sourceMessage?: SummaryMessage };
export type SummaryReminder = Pick<typeof threadReminders.$inferSelect, "accountId" | "threadId" | "status"> & { sourceMessage?: SummaryMessage };
export interface SummaryInput {
  userId: string;
  account: { id: string; userId: string; providerEmail: string };
  messages: SummaryMessage[];
  events: SummaryEvent[];
  reminders: SummaryReminder[];
}
const address = (value: string | null) => (value ?? "").trim().toLowerCase();
function reasonsOf(value: string | null): string[] | null {
  if (value === null) return [];
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every(v => typeof v === "string") ? parsed : null; } catch { return null; }
}
function direct(value: string | null, accountEmail: string): boolean {
  try { const parsed: unknown = JSON.parse(value ?? "[]"); return Array.isArray(parsed) && parsed.some(v => typeof v === "object" && v !== null && "email" in v && typeof v.email === "string" && address(v.email) === accountEmail); } catch { return false; }
}
/** Pure, bounded-window summary. From is the sole direction signal: a spoofed
 * From matching the account is treated as outbound; no authenticity is inferred.
 * Days are elapsed 24-hour periods, independent of local timezone/DST.
 */
export function buildSummary(input: SummaryInput, now: Date): SummaryResponse {
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid summary time");
  if (input.account.userId !== input.userId) throw new Error("Mail account was not found");
  const own = address(input.account.providerEmail);
  const messages = input.messages.filter(m => m.accountId === input.account.id && m.receivedAt && Number.isFinite(m.receivedAt.getTime()) && m.receivedAt.getTime() <= now.getTime() && m.receivedAt.getTime() >= now.getTime() - summaryWindowMs)
    .sort((a, b) => b.receivedAt!.getTime() - a.receivedAt!.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, summaryMessageLimit);
  const latest = new Map<string, SummaryMessage>();
  for (const m of messages) if (!latest.has(m.threadId)) latest.set(m.threadId, m);
  const needs = new Map<string, SummaryResponse["needsYou"][number]>();
  const waiting: SummaryResponse["waitingOn"] = [];
  const item = (m: SummaryMessage, reasons: string[]) => ({ source: { messageId: m.id, threadId: m.threadId }, reasons, title: m.subject ?? "", snippet: m.snippet ?? "", sender: m.fromAddress ?? "", receivedAt: m.receivedAt!.toISOString() });
  for (const m of messages) {
    const reasons = reasonsOf(m.humanClassificationReasons);
    if (reasons === null) continue;
    const last = latest.get(m.threadId)!;
    if (address(m.fromAddress) !== own && address(last.fromAddress) !== own && !messages.some(reply => reply.threadId === m.threadId && address(reply.fromAddress) === own && reply.receivedAt!.getTime() >= m.receivedAt!.getTime()) && (!m.isRead || last.id === m.id) && direct(m.toRecipients, own) && (m.humanClassification === "likely_human" || (m.humanSignal !== null && m.humanSignal >= humanThreshold)) && !needs.has(m.threadId))
      needs.set(m.threadId, item(m, ["direct_recipient", m.isRead ? "latest_inbound" : "unread", ...reasons]));
  }
  for (const m of latest.values()) {
    if (reasonsOf(m.humanClassificationReasons) === null) continue;
    if (address(m.fromAddress) === own && now.getTime() - m.receivedAt!.getTime() > 3 * dayMs)
      waiting.push({ ...item(m, ["latest_message_from_account", "no_later_inbound"]), days: Math.floor((now.getTime() - m.receivedAt!.getTime()) / dayMs) });
  }
  for (const event of input.events) {
    if (event.accountId !== input.account.id || event.ownerUserId !== input.userId || !["new", "seen"].includes(event.lifecycleState)) continue;
    const m = event.sourceMessage ?? messages.find(m => m.id === event.messageId && m.threadId === event.threadId);
    if (!m || m.accountId !== input.account.id || m.id !== event.messageId || m.threadId !== event.threadId || !m.receivedAt || !Number.isFinite(m.receivedAt.getTime()) || m.receivedAt > now || reasonsOf(m.humanClassificationReasons) === null) continue;
    const existing = needs.get(m.threadId);
    if (existing) existing.reasons.push("agent_event", event.whyThisMatters);
    else needs.set(m.threadId, { ...item(m, ["agent_event", event.whyThisMatters]), title: event.title });
  }
  for (const reminder of input.reminders) {
    if (reminder.accountId !== input.account.id || reminder.status !== "resurfaced") continue;
    const m = reminder.sourceMessage ?? latest.get(reminder.threadId);
    if (!m || m.accountId !== input.account.id || m.threadId !== reminder.threadId || !m.receivedAt || !Number.isFinite(m.receivedAt.getTime()) || m.receivedAt > now || reasonsOf(m.humanClassificationReasons) === null) continue;
    const existing = needs.get(m.threadId);
    if (existing) existing.reasons.push("resurfaced_reminder");
    else needs.set(m.threadId, item(m, ["resurfaced_reminder"]));
  }
  const needsYou = [...needs.values()].slice(0, 20);
  const waitingOn = waiting.slice(0, 20);
  const routine = messages.filter(m => reasonsOf(m.humanClassificationReasons) !== null && m.humanClassification === "automated_or_bulk").length;
  return { accountId: input.account.id, needsYou, waitingOn, codes: { available: false, items: [] }, draftedReplies: { available: false, items: [] }, routine: { count: routine }, counts: { needsYou: needsYou.length, waitingOn: waitingOn.length, codes: 0, draftedReplies: 0, routine } };
}
