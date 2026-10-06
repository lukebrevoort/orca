/** Small, synthetic, old messages for indexed-search UI journeys. */
import type { createDatabaseClient } from "../src/db/client.ts";
import { threads, emails, emailLabels } from "../src/db/schema.ts";
export function seedSearchFixture(db: ReturnType<typeof createDatabaseClient>["db"], accountId: string, prefix: string, inboxLabelId: string, newerNonmatchingMessages = 0) {
  for (let i = 1; i <= newerNonmatchingMessages; i++) {
    const id = `${prefix}-nonmatching-${String(i).padStart(3, "0")}`;
    const date = new Date(Date.UTC(2025, 0, 1, 0, 0, i));
    db.insert(threads).values({ id: `thread-${id}`, accountId, providerThreadId: id, subject: "Unrelated stored history", latestReceivedAt: date, messageCount: 1, isRead: true }).run();
    db.insert(emails).values({ id, accountId, threadId: `thread-${id}`, providerMessageId: id, fromName: "History Fixture", fromAddress: "history@example.test",
      subject: "Unrelated stored history", snippet: "Ordinary synthetic history", bodyText: "No matching text here.", receivedAt: date, internalDate: date, isRead: true,
      humanSignal: 9, humanClassification: "likely_human", humanClassificationReasons: "[]" }).run();
    db.insert(emailLabels).values({ id: `${id}-inbox`, emailId: id, labelId: inboxLabelId }).run();
  }
  for (let i = 1; i <= 12; i++) {
    const suffix = String(i).padStart(2, "0");
    const threadId = `${prefix}-thread-${suffix}`;
    const messageId = `${prefix}-message-${suffix}`;
    const subject = `Orcabeacon record ${suffix}`;
    const date = new Date(Date.UTC(2020, 0, 1, 0, 0, i));
    db.insert(threads).values({ id: threadId, accountId, providerThreadId: threadId, subject, latestReceivedAt: date, messageCount: 1, isRead: true }).run();
    db.insert(emails).values({ id: messageId, accountId, threadId, providerMessageId: messageId,
      fromName: "Search Fixture", fromAddress: "indexed-fixture@example.com", subject, snippet: "A synthetic archived appointment record.",
      bodyText: `Orcabeacon fixture body ${suffix}. Reservation detail oceanblue.`,
      toRecipients: JSON.stringify([{ name: "Fixture Owner", email: "owner@example.test" }]), ccRecipients: "[]", bccRecipients: "[]", references: "[]",
      receivedAt: date, internalDate: date, isRead: true, humanSignal: 9, humanClassification: "likely_human", humanClassificationReasons: "[]" }).run();
    db.insert(emailLabels).values({ id: `${messageId}-inbox`, emailId: messageId, labelId: inboxLabelId }).run();
  }
}
