import XCTest
@testable import Orca

private final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (status: Int, data: Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler, let url = request.url else { throw URLError(.badServerResponse) }
            let result = try handler(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: result.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: result.data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private func requestBodyData(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open(); defer { stream.close() }
    var data = Data(), buffer = [UInt8](repeating: 0, count: 4_096)
    while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count > 0 { data.append(buffer, count: count) }
        else if count == 0 { return data }
        else { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
    }
}

final class OrcaTests: XCTestCase {
    @MainActor func testFreshInstallUsesProductionAPIWithoutServerSetup() {
        let previous = UserDefaults.standard.string(forKey: "apiBaseURL")
        UserDefaults.standard.removeObject(forKey: "apiBaseURL")
        defer { UserDefaults.standard.set(previous, forKey: "apiBaseURL") }

        let state = AppState()
        XCTAssertEqual(state.baseURLText, "https://orca-api-production-fbf9.up.railway.app")
        XCTAssertNotNil(state.validatedBaseURL(state.baseURLText))
    }
    @MainActor func testBaseURLRequiresCleanRootOrigin() {
        let state = AppState()
        XCTAssertNotNil(state.validatedBaseURL("https://mail.example.com"))
        XCTAssertNil(state.validatedBaseURL("https://user:secret@mail.example.com"))
        XCTAssertNil(state.validatedBaseURL("https://mail.example.com/api"))
        XCTAssertNil(state.validatedBaseURL("https://mail.example.com?token=secret"))
        XCTAssertNil(state.validatedBaseURL("http://mail.example.com"))
    }
    @MainActor func testUnknownAccountNotificationDoesNotRoute() {
        let state = AppState(); state.accounts = DemoData.accounts; state.selectedAccountID = DemoData.accounts[0].id; state.phase = .ready
        state.routeNotification(["threadId": "thread-unknown", "accountId": "other-account"])
        XCTAssertNil(state.routedThread); XCTAssertEqual(state.selectedAccountID, DemoData.accounts[0].id)
    }
    @MainActor func testOwnedAccountNotificationSelectsAccountAndThread() {
        let state = AppState(); state.accounts = DemoData.accounts; state.selectedAccountID = nil; state.phase = .ready
        state.routeNotification(["threadId": "thread-owned", "accountId": DemoData.accounts[0].id])
        XCTAssertEqual(state.selectedAccountID, DemoData.accounts[0].id); XCTAssertEqual(state.routedThread?.id, "thread-owned")
    }
    @MainActor func testNotificationDoesNotRouteUntilSessionIsReady() {
        let state = AppState(); state.accounts = DemoData.accounts; state.selectedAccountID = nil; state.phase = .configuring
        state.routeNotification(["threadId": "thread-owned", "accountId": DemoData.accounts[0].id])
        XCTAssertNil(state.selectedAccountID); XCTAssertNil(state.routedThread)
    }
    func testInboxDecodesExistingWireContract() throws {
        let json = #"{"accounts":[],"messages":[],"nextCursor":null,"counts":{"focus":1,"normal":2,"quiet":3,"hidden":4,"all":10}}"#.data(using: .utf8)!
        let page = try JSONDecoder().decode(InboxPage.self, from: json); XCTAssertEqual(page.counts.all, 10)
    }
    func testNotificationPreferencesAreIdentityScopedAndDefaultToInbox() throws {
        let suite = "OrcaTests.notifications.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)); defer { defaults.removePersistentDomain(forName: suite) }
        let store = NotificationPreferenceStore(defaults: defaults)
        XCTAssertEqual(store.load(scope: "https://one.example|user-a"), .inboxOnly)
        store.save(NotificationSelection(inbox: false, spaceIds: ["destination:projects"]), scope: "https://one.example|user-a")
        XCTAssertEqual(store.load(scope: "https://one.example|user-a"), NotificationSelection(inbox: false, spaceIds: ["destination:projects"]))
        XCTAssertEqual(store.load(scope: "https://one.example|user-b"), .inboxOnly)
        XCTAssertEqual(store.load(scope: "https://two.example|user-a"), .inboxOnly)
    }
    func testLegacyNotificationOffMigratesOnceWithoutLeakingToAnotherIdentity() throws {
        let suite = "OrcaTests.notifications.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)); defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("off", forKey: "notificationMode")
        let store = NotificationPreferenceStore(defaults: defaults)
        XCTAssertEqual(store.load(scope: "origin|first-user"), .off)
        XCTAssertEqual(store.load(scope: "origin|second-user"), .inboxOnly)
        XCTAssertNil(defaults.string(forKey: "notificationMode"))
    }
    func testNotificationSelectionEncodingUsesInboxAndUniqueOpaqueSpaceIDs() throws {
        let selection = NotificationSelection(inbox: false, spaceIds: ["view:today", "destination:projects", "destination:projects"]).normalized()
        XCTAssertEqual(selection.spaceIds, ["destination:projects", "view:today"])
        XCTAssertEqual(selection, NotificationSelection(inbox: false, spaceIds: ["destination:projects", "view:today"]).normalized())
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(selection)) as? [String: Any])
        XCTAssertEqual(json["inbox"] as? Bool, false)
        XCTAssertEqual(json["spaceIds"] as? [String], ["destination:projects", "view:today"])
    }
    func testPushClientUsesNotificationSelectionContractAndDecodesCatalog() async throws {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: configuration)) { "token" }
        var requests = [URLRequest]()
        StubURLProtocol.handler = { request in
            requests.append(request)
            if request.url?.path == "/v1/mobile/push/catalog" {
                return (200, ##"{"defaultSelection":{"inbox":true,"spaceIds":[]},"spaces":[{"id":"destination:projects","kind":"destination","name":"Projects","color":"#70867d"}]}"##.data(using: .utf8)!)
            }
            let body = try requestBodyData(request)
            XCTAssertFalse(body.isEmpty)
            let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertNil(json["notificationMode"])
            XCTAssertEqual((json["notificationSelection"] as? [String: Any])?["inbox"] as? Bool, false)
            XCTAssertEqual((json["notificationSelection"] as? [String: Any])?["spaceIds"] as? [String], ["destination:projects"])
            return (200, #"{"device":{"installationId":"phone","environment":"sandbox","notificationSelection":{"inbox":false,"spaceIds":["destination:projects"]},"generation":2,"registeredAt":"2026-09-23T00:00:00Z","lastSeenAt":"2026-09-23T00:00:00Z","updatedAt":"2026-09-23T00:00:00Z","disabledAt":null,"disabledReason":null},"push":{"configured":true,"disabledReason":null}}"#.data(using: .utf8)!)
        }
        defer { StubURLProtocol.handler = nil }

        let catalog = try await client.notificationCatalog()
        XCTAssertEqual(catalog.defaultSelection, .inboxOnly); XCTAssertEqual(catalog.spaces.first?.name, "Projects")
        let registration = try await client.registerDevice(installationId: "phone", token: "ab", environment: "sandbox", selection: NotificationSelection(inbox: false, spaceIds: ["destination:projects"]))
        XCTAssertEqual(registration.device.notificationSelection.spaceIds, ["destination:projects"])
        XCTAssertEqual(requests.map { $0.url?.path }, ["/v1/mobile/push/catalog", "/v1/mobile/devices/phone"])
    }
    func testDraftWireEncodingEmitsRequiredNullFields() throws {
        let context = DraftContext(kind: "reply", threadId: "t", messageId: "m", providerMessageId: "pm", providerThreadId: "pt", inReplyTo: nil, references: [])
        let content = DraftContent(to: [Recipient(name: nil, email: "person@example.com")], body: DraftBody(text: "Hello", html: nil), context: context)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(content)) as? [String: Any])
        let recipient = try XCTUnwrap((json["to"] as? [[String: Any]])?.first), body = try XCTUnwrap(json["body"] as? [String: Any]), encodedContext = try XCTUnwrap(json["context"] as? [String: Any])
        XCTAssertTrue(recipient["name"] is NSNull); XCTAssertTrue(body["html"] is NSNull); XCTAssertTrue(encodedContext["inReplyTo"] is NSNull)
    }
    func testPKCEProducesURLSafeChallenge() { let verifier = PKCE.verifier(), challenge = PKCE.challenge(verifier); XCTAssertGreaterThanOrEqual(verifier.count, 43); XCTAssertFalse(challenge.contains("=")); XCTAssertFalse(challenge.contains("+")); XCTAssertFalse(challenge.contains("/")) }
    func testLocalDraftSurvivesStoreRecreationAndKeepsSendKey() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString); var draft = LocalDraft(ownerScope: "https://one.example", accountId: "account-a"); draft.content.subject = "Safe across termination"
        let first = DraftStore(directory: directory); try await first.save(draft); let sending = try await first.prepareSend(draft.id); let second = DraftStore(directory: directory); let restored = await second.all(ownerScope: "https://one.example", accountId: "account-a")
        XCTAssertEqual(restored.first?.content.subject, "Safe across termination"); XCTAssertEqual(restored.first?.idempotencyKey, sending.idempotencyKey); XCTAssertEqual(restored.first?.deliveryState, "sending")
    }
    func testDraftsAreAccountIsolated() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString); let store = DraftStore(directory: directory); try await store.save(LocalDraft(ownerScope: "one", accountId: "a")); try await store.save(LocalDraft(ownerScope: "two", accountId: "a")); let a = await store.all(ownerScope: "one", accountId: "a"); let b = await store.all(ownerScope: "two", accountId: "a"); XCTAssertEqual(a.count, 1); XCTAssertEqual(b.count, 1)
    }
    func testRecipientValidationRejectsPartialInvalidList() {
        let view = ComposeView()
        XCTAssertTrue(view.recipientsAreValid("one@example.com, two@example.com", allowingEmpty: false))
        XCTAssertFalse(view.recipientsAreValid("one@example.com, not-an-address", allowingEmpty: false))
        XCTAssertFalse(view.recipientsAreValid("one@example.com,", allowingEmpty: false))
    }
    func testReadOnlyCapabilityBlocksOnlyNormalSendAndShowsWebRepairPath() {
        let account = MailAccount(id: "gmail", provider: "gmail", email: "me@example.com", displayName: "Me", avatarUrl: nil, capabilities: MailCapabilities(read: true, send: false, draft: false))
        let normal = ComposeView.sendPermissionGate(account: account, deliveryState: "local")
        XCTAssertTrue(normal.blocksNormalSend); XCTAssertEqual(normal.guidance, "This Gmail connection is read-only. In Orca on the web, open Settings → Gmail → Enable drafts and sending, then reconnect if prompted. Your draft remains editable.")
        for state in ["sending", "ambiguous", "rejected"] { XCTAssertFalse(ComposeView.sendPermissionGate(account: account, deliveryState: state).blocksNormalSend) }
        var unsupported = account; unsupported.provider = "outlook"
        XCTAssertEqual(ComposeView.sendPermissionGate(account: unsupported, deliveryState: "local").guidance, "Sending is not supported for this provider yet. Your draft remains editable in Orca.")
    }
    func testKeepBothRequiresUnreservedLocalAndRemoteDrafts() {
        XCTAssertTrue(ComposeView.canKeepBoth(remoteDeliveryStatus: "draft", localDeliveryState: "local", hasDeliveryKey: false))
        XCTAssertFalse(ComposeView.canKeepBoth(remoteDeliveryStatus: "sending", localDeliveryState: "local", hasDeliveryKey: false))
        XCTAssertFalse(ComposeView.canKeepBoth(remoteDeliveryStatus: "draft", localDeliveryState: "ambiguous", hasDeliveryKey: false))
        XCTAssertFalse(ComposeView.canKeepBoth(remoteDeliveryStatus: "draft", localDeliveryState: "local", hasDeliveryKey: true))
    }
    func testRejectedCopyRequiresConfirmedTerminalRejection() {
        XCTAssertTrue(ComposeView.canEditRejectedCopy(remoteDeliveryStatus: "rejected", localDeliveryState: "rejected"))
        XCTAssertFalse(ComposeView.canEditRejectedCopy(remoteDeliveryStatus: "ambiguous", localDeliveryState: "rejected"))
        XCTAssertFalse(ComposeView.canEditRejectedCopy(remoteDeliveryStatus: "rejected", localDeliveryState: "sending"))
    }
    func testRejectedDeliveryStateIsDurable() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString); let store = DraftStore(directory: directory); let draft = LocalDraft(ownerScope: "o", accountId: "a")
        try await store.save(draft); _ = try await store.prepareSend(draft.id); let rejected = try await store.markRejected(draft.id)
        let restored = await DraftStore(directory: directory).all(ownerScope: "o", accountId: "a")
        XCTAssertEqual(rejected?.deliveryState, "rejected"); XCTAssertEqual(restored.first?.deliveryState, "rejected")
    }
    func testReopenedDraftPreservesReplyContext() {
        let context = DraftContext(kind: "reply", threadId: "t", messageId: "m", providerMessageId: "pm", providerThreadId: "pt", inReplyTo: "<m@example.com>", references: [])
        let draft = LocalDraft(ownerScope: "origin|user", accountId: "a", content: DraftContent(context: context))
        XCTAssertEqual(ComposeView(localDraft: draft).content().context, context)
    }
    func testCorruptDraftFileIsPreservedAndBlocksOverwrite() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appending(path: "drafts.json"), original = Data("not-json".utf8); try original.write(to: file)
        let store = DraftStore(directory: directory)
        let recoveryMessage = await store.recoveryMessage(); XCTAssertNotNil(recoveryMessage)
        do { try await store.save(LocalDraft(ownerScope: "o", accountId: "a")); XCTFail("Expected recovery protection") } catch {}
        XCTAssertEqual(try Data(contentsOf: file), original)
    }
    func testPrepareSendReusesStableIdempotencyKey() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString); let store = DraftStore(directory: directory); let draft = LocalDraft(ownerScope: "o", accountId: "a")
        try await store.save(draft); let first = try await store.prepareSend(draft.id); let second = try await store.prepareSend(draft.id)
        XCTAssertNotNil(first.idempotencyKey); XCTAssertEqual(first.idempotencyKey, second.idempotencyKey)
    }
    func testConfirmedPreReservationTransitionRestoresEditableDraftAtRemoteRevision() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString); let store = DraftStore(directory: directory); var draft = LocalDraft(ownerScope: "o", accountId: "a"); draft.serverID = "server-draft"; draft.serverRevision = 2
        try await store.save(draft); let sending = try await store.prepareSend(draft.id); let key = try XCTUnwrap(sending.idempotencyKey)
        let stale = APIClient.ClientError.http(409, APIErrorBody(code: "stale_draft", message: "changed", retryable: true, currentRevision: 3))
        XCTAssertEqual(APIClient.sendFailurePhase(for: stale), .confirmedPreReservation)
        let transitioned = try await store.transition(draft.id, .confirmedPreReservation(serverRevision: 3)); let recovered = try XCTUnwrap(transitioned)
        XCTAssertNil(recovered.idempotencyKey); XCTAssertEqual(recovered.deliveryState, "local"); XCTAssertEqual(recovered.serverRevision, 3); XCTAssertFalse(key.isEmpty)
    }
    func testPatchThenConcurrentEditThenSend409ReconcilesRemoteRevision() async throws {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: configuration)) { "token" }
        let content = DraftContent(to: [Recipient(name: nil, email: "maya@example.com")], subject: "Concurrent edit", body: DraftBody(text: "Local body", html: nil))
        func serverDraft(revision: Int) -> MessageDraft { MessageDraft(id: "server-draft", accountId: "account", to: content.to, cc: [], bcc: [], subject: content.subject, body: content.body, context: nil, attachments: [], revision: revision, deliveryStatus: "draft", providerSyncStatus: "not_applicable", providerSyncError: nil, providerDraftId: nil, providerMessageId: nil, providerThreadId: nil, createdAt: "2026-09-22T12:00:00Z", updatedAt: "2026-09-22T12:00:00Z") }
        var requests = [String]()
        StubURLProtocol.handler = { request in
            requests.append(request.httpMethod ?? "")
            switch request.httpMethod {
            case "PATCH" where requests.filter({ $0 == "PATCH" }).count == 1: return (200, try JSONEncoder().encode(serverDraft(revision: 2)))
            case "PATCH": return (409, #"{"error":{"code":"stale_draft","message":"changed","retryable":true,"currentRevision":3}}"#.data(using: .utf8)!)
            case "POST": return (409, #"{"error":{"code":"stale_draft","message":"changed","retryable":true,"currentRevision":3}}"#.data(using: .utf8)!)
            case "GET": return (200, try JSONEncoder().encode(serverDraft(revision: 3)))
            default: throw URLError(.unsupportedURL)
            }
        }
        defer { StubURLProtocol.handler = nil }

        let patched = try await client.updateDraft("server-draft", accountId: "account", revision: 1, content: content)
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString); let store = DraftStore(directory: directory); var local = LocalDraft(ownerScope: "o", accountId: "account", content: content); local.serverID = patched.id; local.serverRevision = patched.revision
        try await store.save(local); let sending = try await store.prepareSend(local.id)
        do {
            _ = try await client.sendDraft(patched.id, accountId: "account", revision: patched.revision, idempotencyKey: try XCTUnwrap(sending.idempotencyKey))
            XCTFail("Expected stale_draft")
        } catch {
            XCTAssertEqual(APIClient.sendFailurePhase(for: error), .confirmedPreReservation)
        }
        let remote = try await client.draft(patched.id, accountId: "account")
        let transitioned = try await store.transition(local.id, .confirmedPreReservation(serverRevision: nil)); let recovered = try XCTUnwrap(transitioned)
        XCTAssertEqual(requests, ["PATCH", "POST", "GET"]); XCTAssertEqual(remote.revision, 3); XCTAssertEqual(recovered.serverRevision, 2); XCTAssertNil(recovered.idempotencyKey); XCTAssertEqual(recovered.deliveryState, "local")
        do {
            _ = try await client.updateDraft(patched.id, accountId: "account", revision: try XCTUnwrap(recovered.serverRevision), content: content)
            XCTFail("A reopened local draft must retain the stale revision")
        } catch let APIClient.ClientError.http(status, body) {
            XCTAssertEqual(status, 409); XCTAssertEqual(body?.code, "stale_draft")
        }
        XCTAssertEqual(requests, ["PATCH", "POST", "GET", "PATCH"])
    }
    func testFailedStaleReconciliationKeepsOriginalDeliveryKeyFrozen() async throws {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: configuration)) { "token" }
        StubURLProtocol.handler = { _ in throw URLError(.timedOut) }; defer { StubURLProtocol.handler = nil }
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString); let store = DraftStore(directory: directory); var draft = LocalDraft(ownerScope: "o", accountId: "a"); draft.serverID = "server-draft"; draft.serverRevision = 2
        try await store.save(draft); let sending = try await store.prepareSend(draft.id); let originalKey = try XCTUnwrap(sending.idempotencyKey)
        do { _ = try await client.draft("server-draft", accountId: "a"); XCTFail("Expected reconciliation GET failure") }
        catch { XCTAssertEqual((error as? URLError)?.code, .timedOut) }
        let reconciled = try await store.transition(draft.id, .uncertain); let frozen = try XCTUnwrap(reconciled)
        XCTAssertEqual(frozen.idempotencyKey, originalKey); XCTAssertEqual(frozen.serverRevision, 2); XCTAssertEqual(frozen.deliveryState, "ambiguous")
    }
    func testDefinitiveAndUncertainSendFailuresPreserveDifferentRetrySafety() async throws {
        XCTAssertEqual(APIClient.sendFailurePhase(for: APIClient.ClientError.http(501, APIErrorBody(code: "missing_capability", message: "read only", retryable: false))), .confirmedPreReservation)
        XCTAssertEqual(APIClient.sendFailurePhase(for: APIClient.ClientError.http(409, APIErrorBody(code: "provider_rejected", message: "attachment pending", retryable: false))), .confirmedPreReservation)
        XCTAssertEqual(APIClient.sendFailurePhase(for: URLError(.timedOut)), .uncertain)
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString); let store = DraftStore(directory: directory); let draft = LocalDraft(ownerScope: "o", accountId: "a")
        try await store.save(draft); let sending = try await store.prepareSend(draft.id); let transitioned = try await store.transition(draft.id, .uncertain); let uncertain = try XCTUnwrap(transitioned)
        XCTAssertEqual(uncertain.deliveryState, "ambiguous"); XCTAssertEqual(uncertain.idempotencyKey, sending.idempotencyKey)
    }
    func testOutgoingLastMessageFallsBackToExternalRecipients() {
        let message = threadMessage(from: "me@example.com", to: ["maya@example.com", "ME@example.com"], cc: ["anika@example.com"], labels: [])
        let reply = ComposeView.replyRecipients(accountEmail: "me@example.com", message: message, kind: "reply")
        XCTAssertEqual(reply.to.map(\.email), ["maya@example.com", "anika@example.com"]); XCTAssertTrue(reply.cc.isEmpty)
        let replyAll = ComposeView.replyRecipients(accountEmail: "me@example.com", message: message, kind: "reply_all")
        XCTAssertEqual(replyAll.to.map(\.email), ["maya@example.com"]); XCTAssertEqual(replyAll.cc.map(\.email), ["anika@example.com"])
    }
    func testSentAliasIsOwnedAndRecipientDedupeIsCaseInsensitive() {
        let message = threadMessage(from: "me+work@example.com", to: ["maya@example.com", "MAYA@example.com", "me@example.com"], cc: ["ME+WORK@example.com", "anika@example.com"], labels: ["SENT"])
        let reply = ComposeView.replyRecipients(accountEmail: "me@example.com", message: message, kind: "reply")
        XCTAssertEqual(reply.to.map(\.email), ["maya@example.com", "anika@example.com"])
        let replyAll = ComposeView.replyRecipients(accountEmail: "me@example.com", message: message, kind: "reply_all")
        XCTAssertEqual(replyAll.to.map(\.email), ["maya@example.com"]); XCTAssertEqual(replyAll.cc.map(\.email), ["anika@example.com"])
    }
    private func threadMessage(from: String, to: [String], cc: [String], labels: [String]) -> ThreadMessage {
        ThreadMessage(id: "m", accountId: "a", provider: "gmail", providerMessageId: "pm", from: MailContact(name: nil, email: from), to: to.map { MailContact(name: nil, email: $0) }, cc: cc.map { MailContact(name: nil, email: $0) }, bcc: [], subject: "Subject", snippet: "Body", receivedAt: "2026-09-22T12:00:00Z", unread: false, labels: labels, bodyText: "Body", bodyHtml: nil, internetMessageId: "<m@example.com>", references: [], humanSignal: nil, humanClassification: nil, attachments: [])
    }
    func testAttachmentLimitIsAggregate() {
        let mib = 1024 * 1024
        XCTAssertTrue(ComposeView.acceptsAttachment(existingSize: 20 * mib, candidateSize: 5 * mib))
        XCTAssertFalse(ComposeView.acceptsAttachment(existingSize: 20 * mib, candidateSize: 5 * mib + 1))
        XCTAssertFalse(ComposeView.acceptsAttachment(existingSize: 0, candidateSize: 0))
    }
}
