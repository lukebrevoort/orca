import { useEffect, useMemo, useState } from "react";
import type { InboxMessage, MailAccount, MailContact } from "@orca/shared";
import { inboxResponseSchema, meResponseSchema } from "@orca/shared";

type MailboxItem = {
  label: string;
  count?: number;
  active?: boolean;
};

type PersonItem = {
  initials: string;
  name: string;
  context: string;
  unread?: boolean;
};

const pinnedPeople: PersonItem[] = [
  { initials: "MC", name: "Maya Chen", context: "Launch notes", unread: true },
  { initials: "JR", name: "Jon Rivera", context: "Product review" },
  { initials: "AL", name: "Anika Lee", context: "Design direction" },
];

const frequentContacts: PersonItem[] = [
  { initials: "DB", name: "Dana Brooks", context: "3 threads this week" },
  { initials: "KS", name: "Kai Shah", context: "Last seen yesterday" },
  { initials: "NP", name: "Nina Patel", context: "Shared planning" },
];

const mailboxes: MailboxItem[] = [
  { label: "Inbox", active: true },
  { label: "Sent" },
  { label: "Spam", count: 2 },
  { label: "All Mail" },
];

export function App() {
  const [account, setAccount] = useState<MailAccount | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();

    async function loadInbox() {
      setStatus("loading");
      setErrorMessage(null);

      try {
        const [meResult, inboxResult] = await Promise.allSettled([
          fetchJson("/v1/me", meResponseSchema, abortController.signal),
          fetchJson("/v1/inbox", inboxResponseSchema, abortController.signal),
        ]);

        if (abortController.signal.aborted) {
          return;
        }

        if (meResult.status === "fulfilled") {
          setAccount(meResult.value);
        }

        if (inboxResult.status === "fulfilled") {
          setAccount((currentAccount) => currentAccount ?? inboxResult.value.account);
          setMessages(inboxResult.value.messages);
          setStatus("ready");
          return;
        }

        setMessages([]);
        setStatus("error");
        setErrorMessage(
          meResult.status === "rejected"
            ? getErrorMessage(meResult.reason)
            : getErrorMessage(inboxResult.reason),
        );
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        setMessages([]);
        setStatus("error");
        setErrorMessage(getErrorMessage(error));
      }
    }

    void loadInbox();

    return () => {
      abortController.abort();
    };
  }, []);

  const mailboxItems = useMemo(
    () =>
      mailboxes.map((mailbox) =>
        mailbox.label === "Inbox"
          ? {
              ...mailbox,
              count: status === "ready" ? messages.length : undefined,
            }
          : mailbox,
      ),
    [messages.length, status],
  );

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Mailbox navigation">
        <header className="sidebar-header">
          <div className="brand">Orca</div>
          <button className="compose-button" type="button">
            Compose
          </button>
        </header>

        <label className="search-field">
          <span>Search mail</span>
          <input placeholder="People, subjects, words" />
        </label>

        <SidebarSection title="Pinned People" items={pinnedPeople} />
        <SidebarSection title="Frequent Contacts" items={frequentContacts} />

        <section className="sidebar-section mailbox-section">
          <h2>Mailboxes</h2>
          <nav className="nav-list">
            {mailboxItems.map((mailbox) => (
              <a
                aria-current={mailbox.active ? "page" : undefined}
                href={`/${mailbox.label.toLowerCase().replaceAll(" ", "-")}`}
                key={mailbox.label}
              >
                <span>{mailbox.label}</span>
                {mailbox.count ? <small>{mailbox.count}</small> : null}
              </a>
            ))}
          </nav>
        </section>
      </aside>

      <section className="content-pane" aria-label="Inbox preview">
        <header className="pane-header">
          <div>
            <p>Human inbox</p>
            <h1>Inbox</h1>
          </div>
          <div className={`account-chip${account ? "" : " account-chip-muted"}`}>
            {account
              ? `${formatProvider(account.provider)} · ${account.email}`
              : "Connecting account..."}
          </div>
        </header>

        <section className="inbox-body" aria-live="polite">
          {status === "loading" ? (
            <InboxStatusState
              eyebrow="Loading inbox"
              title="Connecting to the read-only API"
              description="Pulling your account and inbox list into Orca."
            />
          ) : null}

          {status === "error" ? (
            <InboxStatusState
              eyebrow="Inbox unavailable"
              title="We couldn't load your inbox"
              description={errorMessage ?? "Try again once the API is reachable."}
            />
          ) : null}

          {status === "ready" && messages.length === 0 ? (
            <InboxStatusState
              eyebrow="Inbox empty"
              title="No messages yet"
              description="When synced mail arrives, your inbox list will appear here."
            />
          ) : null}

          {status === "ready" && messages.length > 0 ? (
            <ol className="message-list">
              {messages.map((message) => (
                <li key={message.id}>
                  <article
                    className={`message-row${message.unread ? " message-row-unread" : ""}`}
                  >
                    <span className="message-avatar" aria-hidden="true">
                      {getInitials(message.from)}
                    </span>
                    <div className="message-copy">
                      <div className="message-meta">
                        <strong>{message.from.name ?? message.from.email}</strong>
                        <span>{formatReceivedAt(message.receivedAt)}</span>
                      </div>
                      <div className="message-subject-row">
                        <h2>{message.subject || "(no subject)"}</h2>
                        {message.unread ? <span className="message-badge">Unread</span> : null}
                      </div>
                      <p>{message.snippet}</p>
                    </div>
                  </article>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function SidebarSection({ title, items }: { title: string; items: PersonItem[] }) {
  return (
    <section className="sidebar-section">
      <h2>{title}</h2>
      <div className="person-list">
        {items.map((item) => (
          <button className="person-row" key={item.name} type="button">
            <span className="avatar">{item.initials}</span>
            <span className="person-copy">
              <strong>{item.name}</strong>
              <small>{item.context}</small>
            </span>
            {item.unread ? <span className="unread-dot" /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function InboxStatusState({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <p>{eyebrow}</p>
      <h2>{title}</h2>
      <span>{description}</span>
    </div>
  );
}

type JsonSchema<T> = {
  parse(value: unknown): T;
};

async function fetchJson<T>(
  input: string,
  schema: JsonSchema<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(input, { signal });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status} ${response.statusText}`.trim());
  }

  return schema.parse(await response.json());
}

function formatProvider(provider: MailAccount["provider"]) {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function getInitials(contact: MailContact) {
  const source = contact.name ?? contact.email;
  const initials = source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return initials || "?";
}

function formatReceivedAt(receivedAt: string) {
  const date = new Date(receivedAt);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const now = new Date();
  const options: Intl.DateTimeFormatOptions =
    date.toDateString() === now.toDateString()
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" };

  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "An unexpected error occurred while loading inbox data.";
}
