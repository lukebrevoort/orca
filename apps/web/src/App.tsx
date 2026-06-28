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
  { label: "Inbox", count: 12, active: true },
  { label: "Sent" },
  { label: "Spam", count: 2 },
  { label: "All Mail" },
];

export function App() {
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
            {mailboxes.map((mailbox) => (
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
          <div className="account-chip">Gmail · luke@example.com</div>
        </header>

        <div className="empty-state">
          <p>Ready for sync</p>
          <h2>No message selected</h2>
          <span>
            The shell is ready for backend inbox data, thread reading, and full
            compose. Until then, this space stays intentionally quiet.
          </span>
        </div>
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
