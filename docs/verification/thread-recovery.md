# Thread recovery fixture

The synthetic tests exercise read-only recovery without contacting a mailbox:

```sh
bun test apps/api/src/thread-read-page.test.ts apps/web/src/thread-recovery.test.tsx
```

The API fixture creates 45 messages, including tied and missing dates, an oversized body and metadata, and a large attachment filename. It follows Earlier and Newer cursors, checks that oversized messages are explicitly unavailable, exercises a concurrent write between probing and reading, and checks cursor scope and response size. The web fixture checks explicit entry, replacement navigation and the absence of reply and forward controls. Native rendering requires Xcode and is not covered by these fixtures.

Recovery uses pages of at most 20 messages, returned newest-first by received timestamp, creation timestamp, then message ID. Null received dates follow dated messages. Each request uses a consistent database snapshot. Cursors bind the account mailbox revision: mail changes, including mark-read or unrelated sync, invalidate them and require an explicit restart at the latest page. Recovery itself does not mark mail read or automatically retry. Pages intentionally omit recipients and attachments, do not load remote images, and do not offer reply, forwarding or guidance. An oversized single message is shown as unavailable; viewing the complete original remains outside this slice. The legacy whole-thread endpoint and MCP `get_thread` retain their existing full-or-error behavior. MCP `get_thread_page` exposes a separate read-only page of redacted plain-text excerpts; HTML-only entries are identified without returning HTML.
