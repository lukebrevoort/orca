import Foundation

@main struct WireSmoke {
    static func main() async throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let connection = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let url = URL(string: connection["apiURL"] as! String)!
        guard url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? ""),
              connection["userId"] as? String == "ios-fixture-user" else {
            fatalError("This check only accepts the isolated mobile fixture on literal loopback")
        }
        let token = connection["accessToken"] as! String
        let client = APIClient(baseURL: url) { token }
        let session: AuthSession = try await client.request("v1/auth/session")
        guard session.user?.id == "ios-fixture-user" else { fatalError("Refusing a non-fixture session") }
        let accounts = try await client.accounts()
        let account = accounts[0]
        let inbox = try await client.inbox(accountId: account.id, view: "normal", query: nil)
        guard let row = inbox.messages.first else { fatalError("Fixture inbox is empty") }
        let detail = try await client.thread(row.threadId, accountId: account.id)
        let message = detail.messages[0]
        let context = DraftContext(kind: "reply", threadId: detail.thread.id, messageId: message.id, providerMessageId: message.providerMessageId, providerThreadId: detail.thread.providerThreadId, inReplyTo: nil, references: [])
        var content = DraftContent(to: [Recipient(name: nil, email: "wire-check@example.com")], subject: "Native Swift wire check", body: DraftBody(text: "Draft before update", html: nil), context: context)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(content)) as! [String: Any]
        precondition((encoded["body"] as! [String: Any])["html"] is NSNull)
        precondition((encoded["to"] as! [[String: Any]])[0]["name"] is NSNull)
        precondition((encoded["context"] as! [String: Any])["inReplyTo"] is NSNull)
        let draft = try await client.createDraft(accountId: account.id, content: content)
        content.body.text = "Updated safely from the production Swift client"
        let updated = try await client.updateDraft(draft.id, accountId: account.id, revision: draft.revision, content: content)
        let key = UUID().uuidString
        let sent = try await client.sendDraft(draft.id, accountId: account.id, revision: updated.revision, idempotencyKey: key)
        let replay = try await client.sendDraft(draft.id, accountId: account.id, revision: updated.revision, idempotencyKey: key)
        precondition(sent.status == "sent" && replay.status == "sent")
        let ledger = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: (connection["directory"] as! String) + "/deliveries.json"))) as! [[String: Any]]
        precondition(ledger.filter { $0["draftId"] as? String == draft.id }.count == 1, "Replayed send must create exactly one fixture delivery")
        print("PASS: Swift accounts/inbox/thread/create/update/send/replay; required null fields preserved")
    }
}
