import type { InboxMessage, MailAccount } from "@orca/shared";

export const demoAccount: MailAccount = {
  id: "acct_demo",
  provider: "gmail",
  email: "luke@example.com",
  displayName: "Luke Brevoort",
};

export const demoMessages: InboxMessage[] = [
  {
    id: "msg_1",
    provider: "gmail",
    providerMessageId: "gmail_1",
    threadId: "thread_1",
    from: { name: "Maya Chen", email: "maya@example.com" },
    subject: "Launch notes for Orca Mail",
    snippet: "Here are the launch notes — let me know what you think about the pinned people flow.",
    receivedAt: "2026-07-03T16:20:00.000Z",
    unread: true,
    labels: ["INBOX"],
  },
  {
    id: "msg_1_reply",
    provider: "gmail",
    providerMessageId: "gmail_1_reply",
    threadId: "thread_1",
    from: { name: "Luke Brevoort", email: "luke@example.com" },
    subject: "Re: Launch notes for Orca Mail",
    snippet: "I like the pinned people direction. Let's keep the first version read-only.",
    receivedAt: "2026-07-03T17:12:00.000Z",
    unread: false,
    labels: ["SENT"],
  },
  {
    id: "msg_2",
    provider: "gmail",
    providerMessageId: "gmail_2",
    threadId: "thread_2",
    from: { name: "Maya Chen", email: "maya@example.com" },
    subject: "Re: Design review deck",
    snippet: "Attached the updated slides. The blur overlay feels much calmer now.",
    receivedAt: "2026-07-02T11:05:00.000Z",
    unread: false,
    labels: ["INBOX"],
  },
  {
    id: "msg_3",
    provider: "gmail",
    providerMessageId: "gmail_3",
    threadId: "thread_3",
    from: { name: "Jon Rivera", email: "jon@example.com" },
    subject: "Product review — week 26",
    snippet: "Can we walk through the compose canvas behavior on Thursday?",
    receivedAt: "2026-07-01T09:40:00.000Z",
    unread: true,
    labels: ["INBOX"],
  },
  {
    id: "msg_4",
    provider: "gmail",
    providerMessageId: "gmail_4",
    threadId: "thread_4",
    from: { name: "Anika Lee", email: "anika@example.com" },
    subject: "Design direction",
    snippet: "Orca palette should stay monochrome — white or black with just a whisper of color.",
    receivedAt: "2026-06-30T18:15:00.000Z",
    unread: false,
    labels: ["INBOX"],
  },
  {
    id: "msg_5",
    provider: "gmail",
    providerMessageId: "gmail_5",
    threadId: "thread_5",
    from: { name: "Dana Brooks", email: "dana@example.com" },
    subject: "Sprint planning",
    snippet: "Maya mentioned you might join the inbox filtering discussion.",
    receivedAt: "2026-06-29T14:00:00.000Z",
    unread: false,
    labels: ["INBOX"],
  },
  {
    id: "msg_6",
    provider: "gmail",
    providerMessageId: "gmail_6",
    threadId: "thread_6",
    from: { name: "Maya Chen", email: "maya@example.com" },
    subject: "Coffee next week?",
    snippet: "Would love to sync on the pinned contacts model in person if you're around.",
    receivedAt: "2026-06-28T08:30:00.000Z",
    unread: false,
    labels: ["INBOX"],
  },
];

export const messageBodies: Record<string, string> = {
  msg_1:
    "Hey Luke,\n\nHere are the launch notes for Orca Mail. The big shift is treating pinned people as filters, not shortcuts into a single thread.\n\nLet me know what you think.\n\n— Maya",
  msg_1_reply:
    "I like the pinned people direction. Let's keep the first version read-only and make sure the thread view never assumes HTML is safe to render.\n\n— Luke",
  msg_2: "Updated the deck with the blur treatment on the full shell — sidebar included.\n\n— Maya",
  msg_3:
    "Thursday works for me. I'd like to see the compose canvas feel more like a blank page than a reply bar.\n\n— Jon",
  msg_4: "Keeping the palette orca-simple: black or white surfaces, one accent at most.\n\n— Anika",
  msg_5: "Adding you to the thread about inbox filtering — Maya had great notes.\n\n— Dana",
  msg_6: "Any time Tuesday or Wednesday morning works.\n\n— Maya",
};

export function messageIncludesPerson(message: InboxMessage, personName: string) {
  const needle = personName.toLowerCase();
  const fromName = message.from.name?.toLowerCase() ?? "";
  const fromEmail = message.from.email.toLowerCase();
  const haystack = `${fromName} ${fromEmail} ${message.subject} ${message.snippet}`.toLowerCase();
  return fromName.includes(needle) || fromEmail.includes(needle) || haystack.includes(needle);
}
