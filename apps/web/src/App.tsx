import type { InboxMessage } from "@orca/shared";

const previewMessages: InboxMessage[] = [
  {
    id: "msg_preview_1",
    provider: "gmail",
    providerMessageId: "preview-gmail-1",
    threadId: "thread_preview_1",
    from: {
      name: "Maya Chen",
      email: "maya@example.com",
    },
    subject: "First Orca preview",
    snippet: "A quiet shell for human messages is ready for real inbox data.",
    receivedAt: "2026-06-28T17:30:00.000Z",
    unread: true,
    labels: ["INBOX"],
  },
];

export function App() {
  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Mailbox navigation">
        <div className="brand">Orca</div>
        <nav className="nav-list">
          <a aria-current="page" href="/">
            Inbox
          </a>
          <a href="/sent">Sent</a>
          <a href="/spam">Spam</a>
          <a href="/all">All Mail</a>
        </nav>
      </aside>

      <section className="content-pane" aria-label="Inbox preview">
        <header className="pane-header">
          <p>Local preview</p>
          <h1>Inbox</h1>
        </header>

        <div className="message-list">
          {previewMessages.map((message) => (
            <article className="message-row" key={message.id}>
              <div>
                <strong>{message.from.name}</strong>
                <p>{message.subject}</p>
              </div>
              <span>{message.unread ? "Unread" : "Read"}</span>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
