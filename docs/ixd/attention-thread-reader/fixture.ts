import { accountFixture, inboxFixture, type InboxMessage, type ThreadDetail } from "../../../packages/shared/src/index";

// All people, content and destinations below are invented. No provider access.
export const account = { ...accountFixture, displayName: "Alex Morgan", email: "alex@example.com" };
export const behaviors = ["notify", "focus", "normal", "quiet", "hidden"] as const;
export const labels = { notify: "Notify", focus: "Focus", normal: "Normal", quiet: "Quiet", hidden: "Hidden" };
const authors = [{ name: "Maya Chen", email: "maya@example.com" }, { name: "Alex Morgan", email: "alex@example.com" }, { name: "Noah Reed", email: "noah@example.com" }];
const changes = ["The east entrance will stay open during the installation.", "Please use the revised floor plan for the reading room.", "The workshop starts at 10:30, with a quiet hour before lunch.", "We can move the welcome table away from the lift.", "The printed guide needs a larger type size.", "The ramp inspection is complete; the path is clear."];
export const messages = Array.from({ length: 24 }, (_, index) => {
  const current = index === 21 ? "The final accessibility walk-through is booked for Friday at 09:00. Please confirm who can join.\n\nOne change: the north door needs to remain unlocked until everyone has arrived." : `${changes[index % changes.length]}\n\nUpdate ${index + 1}: this is the unique contribution from this message. Keep it available when reading the full conversation.`;
  const quote = index ? Array.from({ length: Math.min(index, 8) }, (_, q) => `> ${"> ".repeat(q % 3)}Update ${index - q}: ${changes[(index - q) % changes.length]}`).join("\n") : "";
  // Adversarial inline answer AFTER a quote must remain recoverable.
  const inlineAnswer = index === 11 ? "\n\nUnique inline answer: use entrance C, not entrance B." : "";
  const bodyText = current + (quote ? `\n\nOn an earlier day, Maya wrote:\n${quote}` : "") + inlineAnswer;
  const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const { threadId: ignored, ...base } = inboxFixture[0]!;
  return {
    ...base, id: `synthetic-message-${index + 1}`, accountId: account.id, provider: "gmail" as const,
    providerMessageId: `synthetic-provider-${index + 1}`, from: authors[index % 3]!,
    to: [authors[(index + 1) % 3]!], cc: index % 5 === 0 ? [authors[(index + 2) % 3]!] : [], bcc: [],
    subject: "Reading room · opening weekend", snippet: current.split("\n")[0]!,
    bodyText, bodyHtml: index % 3 === 0 ? `<p>${escape(current).replaceAll("\n\n", "</p><p>")}</p><p><a href="https://example.com/plan" target="_blank" rel="noopener noreferrer">Review the floor plan</a></p>${quote ? `<blockquote>${escape(quote).replaceAll("\n", "<br>")}</blockquote>` : ""}${inlineAnswer ? `<p>${escape(inlineAnswer)}</p>` : ""}` : null,
    receivedAt: new Date(Date.UTC(2026, 9, 1 + Math.floor(index / 3), 9 + index % 3)).toISOString(), unread: index >= 21,
    labels: ["INBOX"], attentionBehavior: "focus" as const, internetMessageId: `<synthetic-${index}@example.com>`, references: [],
    attachments: index === 21 ? [{ id: "synthetic-attachment", filename: "reading-room-plan.pdf", mimeType: "application/pdf", size: 42800 }] : [],
  };
});
export const thread: ThreadDetail = {
  account,
  thread: { id: "synthetic-long-thread", provider: "gmail", providerThreadId: "synthetic-provider-thread", subject: messages[0]!.subject,
    latestReceivedAt: messages[23]!.receivedAt, messageCount: 24, labels: ["INBOX"], participants: authors,
    readState: "unread", attention: { hasUnread: true, hasStarred: false, hasDraft: false, humanSignal: 9, attentionBehavior: "focus" } },
  messages,
};
export const inbox: InboxMessage[] = behaviors.flatMap((behavior, i) => Array.from({ length: 2 }, (_, j) => ({
  ...inboxFixture[0]!, id: `row-${behavior}-${j}`, providerMessageId: `row-provider-${behavior}-${j}`,
  accountId: account.id, threadId: j === 0 && behavior === "focus" ? thread.thread.id : `thread-${behavior}-${j}`,
  from: authors[(i + j) % authors.length]!, subject: behavior === "focus" && !j ? thread.thread.subject : ["Volunteer rota", "Room signs", "Supplier receipt", "Monthly digest", "Archived announcement"][i]!,
  snippet: j ? "All fixture content is synthetic and safe to share." : "Here&amp;#39;s the update for the opening weekend.",
  attentionBehavior: behavior, receivedAt: new Date(Date.UTC(2026, 9, behavior === "focus" ? 5 - j : 8 - j, 10)).toISOString(), unread: j === 0,
})));
