import XCTest
@testable import Orca

private final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (status: Int, data: Data))?
    nonisolated(unsafe) static var responseHeaders: ((URLRequest) -> [String: String])?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler, let url = request.url else { throw URLError(.badServerResponse) }
            let result = try handler(request)
            var headers = ["Content-Type": "application/json"]
            if let custom = Self.responseHeaders { headers.merge(custom(request)) { _, value in value } }
            else {
                headers["X-Orca-Search-Mode"] = request.value(forHTTPHeaderField: "X-Orca-Expected-Search-Mode")
                headers["X-Orca-Search-Epoch"] = request.value(forHTTPHeaderField: "X-Orca-Expected-Search-Epoch")
            }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: result.status, httpVersion: nil, headerFields: headers)!, cacheStoragePolicy: .notAllowed)
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
    func testViewDefinitionRoundTripPreservesServerOwnedFields() throws {
        let raw = ##"{"mode":"update","skipInbox":true,"viewId":"v","viewRevision":2,"source":{"kind":"sender_selection","label":"iOS"},"identity":{"name":"People","color":"#aabbcc","position":3},"definition":{"revision":1,"accountIds":["a"],"sender":{"addresses":["maya@example.com"]},"thread":{"readState":"unread"},"humanSignal":{"minimumScore":7}},"unsupportedClauses":[],"definitionDigest":"sha256:example"}"##.data(using: .utf8)!
        let reviewed = try JSONDecoder().decode(MailActionJSON.self, from: raw)
        let input = reviewed.keeping(["mode", "skipInbox", "viewId", "viewRevision", "source", "identity", "definition", "unsupportedClauses"])
        let encoded = try JSONEncoder().encode(input)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertNil(object["definitionDigest"])
        XCTAssertEqual(object["skipInbox"] as? Bool, true)
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual(object["definition"] as? NSDictionary, original["definition"] as? NSDictionary)
        XCTAssertEqual(object["identity"] as? NSDictionary, original["identity"] as? NSDictionary)
    }
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
        XCTAssertTrue(normal.blocksNormalSend); XCTAssertEqual(normal.guidance, "This Gmail connection is read-only. In Orca on the web, open Settings → Gmail → Enable drafts and sending, then return here and refresh sending access. Your draft remains editable.")
        for state in ["sending", "ambiguous", "rejected"] { XCTAssertFalse(ComposeView.sendPermissionGate(account: account, deliveryState: state).blocksNormalSend) }
        var unsupported = account; unsupported.provider = "outlook"
        XCTAssertEqual(ComposeView.sendPermissionGate(account: unsupported, deliveryState: "local").guidance, "Sending is not supported for this provider yet. Your draft remains editable in Orca.")
    }
    @MainActor func testCapabilityRefreshUnlocksSendingWithoutReplacingTheSelectedAccount() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: config)) { "fixture-token" }
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let state = AppState(client: client, cache: CacheStore(directory: folder))
        state.baseURLText = "https://orca.example"; state.phase = .ready
        var account = DemoData.accounts[0]; account.capabilities.send = false; account.capabilities.draft = false
        state.accounts = [account]; state.selectedAccountID = account.id
        let originalScope = state.ownerScope
        var upgraded = account; upgraded.capabilities.send = true; upgraded.capabilities.draft = true
        struct Accounts: Encodable { var items: [MailAccount] }
        let response = try JSONEncoder().encode(Accounts(items: [upgraded]))
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET"); XCTAssertEqual(request.url?.path, "/v1/accounts")
            return (200, response)
        }
        defer { StubURLProtocol.handler = nil }
        let refreshed = try await state.refreshAccountCapabilities()
        XCTAssertTrue(refreshed); XCTAssertEqual(state.selectedAccountID, account.id)
        XCTAssertEqual(state.ownerScope, originalScope); XCTAssertTrue(state.phase == .ready)
        XCTAssertEqual(state.selectedAccount?.capabilities.send, true)
        XCTAssertFalse(ComposeView.sendPermissionGate(account: state.selectedAccount, deliveryState: "local").blocksNormalSend)
    }
    @MainActor func testFailedCapabilityRefreshPreservesAccountScopeAndCachedGrants() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: config)) { nil }
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let state = AppState(client: client, cache: CacheStore(directory: folder))
        state.baseURLText = "https://orca.example"; state.phase = .ready; state.accounts = DemoData.accounts
        state.selectedAccountID = DemoData.accounts[0].id
        let scope = state.ownerScope
        defer { StubURLProtocol.handler = nil }
        for code in [401, 503] {
            StubURLProtocol.handler = { _ in (code, #"{"error":{"code":"unavailable","message":"Try again"}}"#.data(using: .utf8)!) }
            do { _ = try await state.refreshAccountCapabilities(); XCTFail("Expected refresh failure") }
            catch { /* The composer remains available for local writing. */ }
            XCTAssertEqual(state.accounts, DemoData.accounts)
            XCTAssertEqual(state.selectedAccountID, DemoData.accounts[0].id)
            XCTAssertEqual(state.ownerScope, scope); XCTAssertTrue(state.phase == .ready)
        }
    }
    func testServerOriginDeliveryRecoveryUsesOnlyGETWithoutInventingAKey() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: config)) { nil }
        var local = LocalDraft(ownerScope: "origin|user", accountId: "mail-account")
        local.serverID = "server-draft"; local.serverRevision = 4; local.deliveryState = "ambiguous"
        let server = MessageDraft(id: "server-draft", accountId: "mail-account", to: [], cc: [], bcc: [], subject: "Safe status check", body: .init(text: "Words", html: nil), context: nil, attachments: [], revision: 4, deliveryStatus: "sent", providerSyncStatus: "synced", providerSyncError: nil, providerDraftId: nil, providerMessageId: "sent-message", providerThreadId: "sent-thread", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z")
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/drafts/server-draft")
            XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "mail-account")
            return (200, try JSONEncoder().encode(server))
        }
        defer { StubURLProtocol.handler = nil }
        let result = try await DraftDeliveryRecovery.check(local, client: client)
        XCTAssertEqual(result.status, "sent"); XCTAssertEqual(result.providerMessageId, "sent-message")
        XCTAssertNil(local.idempotencyKey)
    }
    func testLocalDeliveryRecoveryReplaysOnlyItsPersistedCommand() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: config)) { nil }
        var local = LocalDraft(ownerScope: "origin|user", accountId: "mail-account")
        local.serverID = "server-draft"; local.serverRevision = 4; local.deliveryState = "ambiguous"; local.idempotencyKey = "persisted-delivery-key"
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(request.url?.path, "/v1/drafts/server-draft/send")
            let body = try JSONSerialization.jsonObject(with: requestBodyData(request)) as! [String: Any]
            XCTAssertEqual(body["idempotencyKey"] as? String, "persisted-delivery-key"); XCTAssertEqual(body["revision"] as? Int, 4)
            return (200, #"{"draftId":"server-draft","status":"ambiguous","providerMessageId":null,"providerThreadId":null,"error":null}"#.data(using: .utf8)!)
        }
        defer { StubURLProtocol.handler = nil }
        let result = try await DraftDeliveryRecovery.check(local, client: client)
        XCTAssertEqual(result.status, "ambiguous"); XCTAssertEqual(local.idempotencyKey, "persisted-delivery-key")
    }
    func testAttachmentCountMatchesServerLimitBeforeReadingFiles() {
        XCTAssertTrue(ComposeView.acceptsAttachment(existingSize: 24, candidateSize: 1, existingCount: 24))
        XCTAssertFalse(ComposeView.acceptsAttachment(existingSize: 25, candidateSize: 1, existingCount: 25))
        XCTAssertFalse(ComposeView.acceptsAttachment(existingSize: 0, candidateSize: 1, existingCount: -1))
    }
    @MainActor func testDelayedReconciliationAndAttachmentEditsCannotRestoreEachOthersSnapshots() async throws {
        // Exercise the production reservation used by Keep both, Edit a new
        // copy, attachment edits and Send with a deliberately suspended write.
        for first in [ComposeOperationReservation.Operation.reconciliation, .attachments] {
            let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: folder) }
            let store = DraftStore(directory: folder)
            var local = LocalDraft(ownerScope: "origin|user", accountId: "account")
            local.serverID = "contested-server-draft"; local.serverRevision = 1
            local.content.attachments = [.init(id: "x", filename: "x.txt", mimeType: "text/plain", size: 1, contentBase64: "eA==")]
            try await store.save(local)
            var reservation = ComposeOperationReservation()
            let started = expectation(description: "First mutation reserved before delayed work")
            var resume: CheckedContinuation<Void, Never>?
            let pending = Task { @MainActor in
                XCTAssertTrue(reservation.reserve(first))
                defer { reservation.release(first) }
                var snapshot = local
                await withCheckedContinuation { continuation in resume = continuation; started.fulfill() }
                if first == .attachments { snapshot.content.attachments.removeAll() }
                else { snapshot.serverID = nil; snapshot.serverRevision = nil }
                try await store.save(snapshot); local = snapshot
            }
            await fulfillment(of: [started], timeout: 3)
            let second: ComposeOperationReservation.Operation = first == .attachments ? .reconciliation : .attachments
            XCTAssertTrue(reservation.isBusy)
            XCTAssertFalse(reservation.reserve(second), "The overlapping action must not capture or save a stale draft")
            XCTAssertFalse(reservation.reserve(.delivery), "Send cannot start while either mutation is pending")
            XCTAssertFalse(reservation.reserve(first), "Rapid repeat taps cannot start a second mutation")
            resume?.resume(); try await pending.value
            XCTAssertFalse(reservation.isBusy)

            // A retry after completion reads the current draft, so both removal
            // and detachment survive regardless of which action was first.
            XCTAssertTrue(reservation.reserve(second))
            var latest = local
            if second == .attachments { latest.content.attachments.removeAll() }
            else { latest.serverID = nil; latest.serverRevision = nil }
            try await store.save(latest); local = latest; reservation.release(second)
            let saved = await store.all(ownerScope: "origin|user", accountId: "account")
            XCTAssertTrue(try XCTUnwrap(saved.first).content.attachments.isEmpty)
            XCTAssertNil(saved.first?.serverID); XCTAssertNil(saved.first?.serverRevision)
            XCTAssertTrue(reservation.reserve(.delivery)); reservation.release(.delivery)
        }
    }
    @MainActor func testCancelledAutosavesStillDrainInitializationBeforeDelivery() async {
        var events = [String]()
        let started = expectation(description: "Initial local write started")
        var finishInitialWrite: CheckedContinuation<Void, Never>?
        let initial = ComposeSaveSequencing.enqueue(after: nil, debounce: false, canSave: { true }) {
            events.append("initial-start")
            await withCheckedContinuation { continuation in finishInitialWrite = continuation; started.fulfill() }
            events.append("initial-finish")
        }
        await fulfillment(of: [started], timeout: 3)
        let debounce = ComposeSaveSequencing.enqueue(after: initial, debounce: true, canSave: { true }) { events.append("cancelled-debounce-write") }
        let latest = ComposeSaveSequencing.enqueue(after: debounce, debounce: true, canSave: { true }) { events.append("cancelled-latest-write") }
        latest.cancel()
        var checkingForEarlyDelivery = true
        let earlyDelivery = expectation(description: "Delivery must wait for the oldest in-flight write")
        earlyDelivery.isInverted = true
        let delivery = Task { @MainActor in
            await latest.value
            if checkingForEarlyDelivery { earlyDelivery.fulfill() }
            events.append("delivery-can-start")
        }
        await fulfillment(of: [earlyDelivery], timeout: 0.1)
        checkingForEarlyDelivery = false
        XCTAssertEqual(events, ["initial-start"])
        finishInitialWrite?.resume(); await delivery.value
        XCTAssertEqual(events, ["initial-start", "initial-finish", "delivery-can-start"])
    }
    @MainActor func testKeepBothCheckpointsLatestWordsBeforeStalledOrFailedRemoteCheck() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = DraftStore(directory: folder)
        var draft = LocalDraft(ownerScope: "origin|user", accountId: "account")
        draft.serverID = "contested-server-draft"; draft.serverRevision = 1
        draft.content.body.text = "Previously saved words"; try await store.save(draft)
        draft.content.body.text = "Latest visible words typed before the debounce"
        draft.content.subject = "Latest subject"
        draft.recipientText = .init(to: "maya@example.com", cc: "unfinished", bcc: "")
        let current = draft
        let remoteStarted = expectation(description: "Remote check starts after durable checkpoint")
        var finishRemote: CheckedContinuation<MessageDraft, Error>?
        let pending = Task { @MainActor in
            try await ComposeReconciliationCheckpoint.loadRemote(afterCheckpointing: current, store: store) {
                try await withCheckedThrowingContinuation { continuation in finishRemote = continuation; remoteStarted.fulfill() }
            }
        }
        await fulfillment(of: [remoteStarted], timeout: 3)
        // Reopen the actual persisted file while the remote request is still
        // stalled, modelling the data available after background termination.
        let reopened = await DraftStore(directory: folder).all(ownerScope: "origin|user", accountId: "account")
        XCTAssertEqual(reopened.first?.content.body.text, current.content.body.text)
        XCTAssertEqual(reopened.first?.content.subject, current.content.subject)
        XCTAssertEqual(reopened.first?.recipientText, current.recipientText)
        XCTAssertEqual(reopened.first?.serverID, "contested-server-draft")
        XCTAssertEqual(reopened.first?.serverRevision, 1, "Checkpointing must not detach the contested draft")
        finishRemote?.resume(throwing: URLError(.timedOut))
        do { _ = try await pending.value; XCTFail("Expected the delayed remote check to fail") }
        catch { XCTAssertEqual((error as? URLError)?.code, .timedOut) }
        let afterFailure = await DraftStore(directory: folder).all(ownerScope: "origin|user", accountId: "account")
        XCTAssertEqual(afterFailure.first?.content.body.text, current.content.body.text)
        XCTAssertEqual(afterFailure.first?.serverID, "contested-server-draft")
        XCTAssertNil(afterFailure.first?.idempotencyKey)
    }
    @MainActor func testFailedKeepBothCheckpointNeverStartsRemoteVerification() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let original = Data("preserve-corrupt-file".utf8), file = folder.appending(path: "drafts.json")
        try original.write(to: file)
        let store = DraftStore(directory: folder)
        var remoteWasCalled = false
        do {
            _ = try await ComposeReconciliationCheckpoint.loadRemote(afterCheckpointing: LocalDraft(ownerScope: "origin|user", accountId: "account"), store: store) {
                remoteWasCalled = true; throw URLError(.timedOut)
            }
            XCTFail("Expected local checkpoint failure")
        } catch is ComposeReconciliationCheckpoint.Failure { /* Fail closed before remote work. */ }
        catch { XCTFail("Expected a classified local checkpoint failure, got \(error)") }
        XCTAssertFalse(remoteWasCalled)
        XCTAssertEqual(try Data(contentsOf: file), original)
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

extension OrcaTests {
    @MainActor func testVisibleViewsPersistIndependentlyOfNotificationsAndIdentity() throws {
        let suite = "OrcaTests.mailboxes.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)); defer { defaults.removePersistentDomain(forName: suite) }
        let notifications = NotificationPreferenceStore(defaults: defaults)
        notifications.save(.off, scope: "origin|user")
        let store = MailboxPreferenceStore(defaults: defaults)
        let model = MailboxViews(preferences: store)
        model.activate(scope: "origin|user")
        XCTAssertEqual(model.options.map(\.id), ["normal", "focus", "all"])
        model.selectedID = "focus"
        model.setEnabled("focus", false)
        XCTAssertEqual(model.selectedID, "normal")
        model.setEnabled("all", false)
        model.setEnabled("view:hub", true)
        XCTAssertEqual(model.options.map(\.id), ["normal"], "Inbox remains a reachable fallback before the catalog loads")
        XCTAssertEqual(notifications.load(scope: "origin|user"), .off)
        let reopened = MailboxViews(preferences: store)
        reopened.activate(scope: "origin|user")
        XCTAssertEqual(reopened.enabledIDs, ["view:hub"])
        reopened.activate(scope: "origin|other-user")
        XCTAssertEqual(reopened.enabledIDs, ["focus", "all"])
        reopened.activate(scope: "other-origin|user")
        XCTAssertEqual(reopened.enabledIDs, ["focus", "all"])
    }

    func testSavedViewClientUsesCanonicalResultsAndOpaqueCursorWithoutPushWrites() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: config)) { "token" }
        let cursor = "opaque+/=?&cursor"
        var paths = [String]()
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            let url = try XCTUnwrap(request.url); paths.append(url.path)
            if url.path == "/v1/organization/views" {
                return (200, #"{"items":[{"id":"hub","name":"Hub notifications","description":"Browse without alerts","revision":7}]}"#.data(using: .utf8)!)
            }
            XCTAssertEqual(url.path, "/v1/organization/views/hub/results")
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(query?.first { $0.name == "cursor" }?.value, cursor)
            XCTAssertNil(query?.first { $0.name == "accountId" }, "A saved View owns its account scope")
            return (200, #"{"viewId":"hub","viewRevision":7,"accountIds":["work"],"items":[{"accountId":"work","accountEmail":"work@example.com","provider":"gmail","threadId":"t","subject":"Hub update","latestReceivedAt":"2026-09-25T10:00:00Z","messageCount":2,"readState":"unread","sender":{"name":"Jordan","email":"jordan@example.com"}}],"nextCursor":null}"#.data(using: .utf8)!)
        }
        defer { StubURLProtocol.handler = nil }
        let catalog = try await client.mailboxViews()
        let page = try await client.mailboxViewResults(try XCTUnwrap(catalog.items.first).id, cursor: cursor)
        XCTAssertEqual(page.items.first?.accountId, "work")
        XCTAssertEqual(page.items.first?.threadId, "t")
        XCTAssertEqual(paths, ["/v1/organization/views", "/v1/organization/views/hub/results"])
    }

    func testSavedViewIDIsEncodedAsOnePathComponent() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: config)) { nil }
        StubURLProtocol.handler = { request in
            let parts = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            XCTAssertEqual(parts.percentEncodedPath, "/v1/organization/views/hub%2Fweekly%3F%23%25/results")
            return (200, #"{"viewId":"hub/weekly?#%","viewRevision":1,"accountIds":[],"items":[],"nextCursor":null}"#.data(using: .utf8)!)
        }
        defer { StubURLProtocol.handler = nil }
        _ = try await client.mailboxViewResults("hub/weekly?#%")
    }

    @MainActor func testSavedViewThreadHandoffSelectsOwnedAccountAndRejectsUnknownAccount() {
        let state = AppState(); state.accounts = DemoData.accounts; state.phase = .ready
        var second = DemoData.accounts[0]; second.id = "work"; second.email = "work@example.com"
        state.accounts.append(second); state.selectedAccountID = DemoData.accounts[0].id
        var row = savedViewThread(accountId: "work")
        XCTAssertTrue(state.selectSavedViewThread(row)); XCTAssertEqual(state.selectedAccountID, "work")
        let reader = ThreadView(accountId: row.accountId, threadId: row.threadId)
        XCTAssertEqual(reader.accountId, "work"); XCTAssertEqual(reader.threadId, "thread")
        row.accountId = "someone-else"
        XCTAssertFalse(state.selectSavedViewThread(row)); XCTAssertEqual(state.selectedAccountID, "work")
        state.phase = .signedOut; row.accountId = "work"
        XCTAssertFalse(state.selectSavedViewThread(row))
    }

    @MainActor func testSavedViewResultsValidateViewRevisionAndAccountOwnership() {
        let view = SavedMailboxView(id: "hub", name: "Hub", description: "", revision: 2)
        var page = SavedViewPage(viewId: "hub", viewRevision: 2, accountIds: ["demo-account"], items: [savedViewThread(accountId: "demo-account")], nextCursor: nil)
        XCTAssertTrue(SavedViewReader.isValid(page, view: view, accounts: DemoData.accounts))
        page.viewRevision = 3
        XCTAssertFalse(SavedViewReader.isValid(page, view: view, accounts: DemoData.accounts))
        page.viewRevision = 2; page.viewId = "different"
        XCTAssertFalse(SavedViewReader.isValid(page, view: view, accounts: DemoData.accounts))
        page.viewId = "hub"; page.items[0].accountId = "someone-else"
        XCTAssertFalse(SavedViewReader.isValid(page, view: view, accounts: DemoData.accounts))
        page.accountIds.append("someone-else")
        XCTAssertFalse(SavedViewReader.isValid(page, view: view, accounts: DemoData.accounts))
    }

    @MainActor func testViewCatalogRemovalFallsBackWithoutErasingSavedVisibility() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: config)) { nil }
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let state = AppState(client: client, cache: CacheStore(directory: folder)); state.phase = .ready
        let suite = "OrcaTests.catalog.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)); defer { defaults.removePersistentDomain(forName: suite) }
        let model = MailboxViews(preferences: .init(defaults: defaults))
        var available = true
        StubURLProtocol.handler = { _ in
            (200, (available ? #"{"items":[{"id":"hub","name":"Hub notifications","description":"","revision":1}]}"# : #"{"items":[]}"#).data(using: .utf8)!)
        }
        defer { StubURLProtocol.handler = nil }
        await model.load(state: state); model.setEnabled("view:hub", true); model.selectedID = "view:hub"
        XCTAssertEqual(model.title, "Hub notifications")
        available = false; await model.load(state: state)
        XCTAssertEqual(model.selectedID, "normal")
        XCTAssertTrue(model.enabledIDs.contains("view:hub"))
        XCTAssertEqual(model.unavailableIDs, ["view:hub"])
    }

    @MainActor func testSavedViewPaginationAndOfflineCacheAreScoped() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: config)) { nil }
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let state = AppState(client: client, cache: CacheStore(directory: folder)); state.phase = .ready; state.accounts = DemoData.accounts
        let view = SavedMailboxView(id: "hub", name: "Hub", description: "", revision: 1)
        var response = SavedViewPage(viewId: "hub", viewRevision: 1, accountIds: ["demo-account"], items: [savedViewThread(accountId: "demo-account")], nextCursor: "next")
        var offline = false
        StubURLProtocol.handler = { _ in
            if offline { throw URLError(.notConnectedToInternet) }
            return (200, try JSONEncoder().encode(response))
        }
        defer { StubURLProtocol.handler = nil }
        let reader = SavedViewReader(); await reader.load(view: view, state: state)
        response.items.append(SavedViewThread(accountId: "demo-account", accountEmail: "hello@example.com", provider: "gmail", threadId: "second", subject: "Second", latestReceivedAt: "2026-09-25T10:00:00Z", messageCount: 1, readState: "read", sender: .init(name: nil, email: "jordan@example.com")))
        response.nextCursor = nil
        await reader.load(view: view, state: state, reset: false)
        XCTAssertEqual(reader.page?.items.map(\.threadId), ["thread", "second"], "Overlapping pages must not duplicate threads")
        offline = true
        let cached = SavedViewReader(); await cached.load(view: view, state: state)
        XCTAssertEqual(cached.page?.items.count, 1); XCTAssertNil(cached.page?.nextCursor)
        XCTAssertEqual(cached.error, "Offline — showing saved results")
        state.baseURLText = "https://other.example"
        await cached.load(view: view, state: state)
        XCTAssertNil(cached.page, "Cached results cannot cross server/identity scopes")
    }

    @MainActor func testLateSavedViewCacheMissCannotOverwriteNewerResults() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: config)) { nil }
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let state = AppState(client: client, cache: CacheStore(directory: folder)); state.phase = .ready; state.accounts = DemoData.accounts
        let oldView = SavedMailboxView(id: "old", name: "Old", description: "", revision: 1)
        let newView = SavedMailboxView(id: "new", name: "New", description: "", revision: 1)
        let response = SavedViewPage(viewId: "new", viewRevision: 1, accountIds: ["demo-account"], items: [savedViewThread(accountId: "demo-account")], nextCursor: "next")
        StubURLProtocol.handler = { request in
            if request.url!.path.contains("/old/") { throw URLError(.notConnectedToInternet) }
            return (200, try JSONEncoder().encode(response))
        }
        defer { StubURLProtocol.handler = nil }
        let cacheStarted = expectation(description: "Old request waiting for cache")
        var cacheMiss: CheckedContinuation<SavedViewPage?, Never>?
        let reader = SavedViewReader(loadCachedPage: { _, _ in
            await withCheckedContinuation { continuation in
                cacheMiss = continuation
                cacheStarted.fulfill()
            }
        })
        let oldLoad = Task { await reader.load(view: oldView, state: state) }
        await fulfillment(of: [cacheStarted], timeout: 3)
        await reader.load(view: newView, state: state)
        XCTAssertEqual(reader.page?.viewId, "new")
        cacheMiss?.resume(returning: nil)
        await oldLoad.value
        XCTAssertEqual(reader.page?.viewId, "new")
        XCTAssertEqual(reader.page?.items.map(\.threadId), ["thread"])
        XCTAssertEqual(reader.page?.nextCursor, "next")
        XCTAssertNil(reader.error)
        XCTAssertFalse(reader.loading)
    }

    @MainActor func testLateViewCatalogResponseCannotCrossIdentityScope() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: config)) { nil }
        let state = AppState(client: client); state.phase = .ready
        let started = expectation(description: "Catalog request started")
        StubURLProtocol.handler = { _ in
            started.fulfill()
            Thread.sleep(forTimeInterval: 0.15)
            return (200, #"{"items":[{"id":"private","name":"Previous identity","description":"","revision":1}]}"#.data(using: .utf8)!)
        }
        defer { StubURLProtocol.handler = nil }
        let model = MailboxViews()
        let pending = Task { await model.load(state: state) }
        await fulfillment(of: [started], timeout: 3)
        state.baseURLText = "https://another-identity.example"
        model.activate(scope: state.ownerScope)
        await pending.value
        XCTAssertTrue(model.views.isEmpty)
        XCTAssertEqual(model.selectedID, "normal")
    }

    @MainActor func testViewCacheIsNeverUsedForAuthorizationOrDeletedViewErrors() {
        for status in [401, 403, 404, 409] {
            XCTAssertFalse(MailboxViews.permitsOfflineCache(APIClient.ClientError.http(status, nil)))
        }
        XCTAssertTrue(MailboxViews.permitsOfflineCache(URLError(.notConnectedToInternet)))
    }

    private func savedViewThread(accountId: String) -> SavedViewThread {
        SavedViewThread(accountId: accountId, accountEmail: "work@example.com", provider: "gmail", threadId: "thread", subject: "Hub update", latestReceivedAt: "2026-09-25T10:00:00Z", messageCount: 2, readState: "unread", sender: .init(name: "Jordan", email: "jordan@example.com"))
    }
}

// The baseline is intentionally the pre-optimization implementation, including
// its fractional-first fallback and option mutation. Keep it independent of the
// production parser so these tests detect future parsing-contract changes.
private enum MailDateTestSupport {
    static func baselineParse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static let edgeCases = [
        "1970-01-01T00:00:00Z", "1969-12-31T23:59:59Z",
        "2024-02-29T23:59:59.123Z", "2026-10-05T01:26:17.1Z",
        "2026-10-05T01:26:17.123456789Z", "2026-10-05T01:26:17+05:30",
        "2026-10-05T01:26:17.123-07:00", "2026-10-05T01:26:17+00:00",
        "2026-03-08T01:59:59-08:00", "2026-03-08T03:00:00-07:00",
        "2026-11-01T01:30:00-07:00", "2026-11-01T01:30:00-08:00",
        "2000-02-29T12:00:00Z", "1900-02-29T12:00:00Z",
        "2026-02-30T12:00:00Z", "2026-13-01T12:00:00Z",
        "2026-00-01T12:00:00Z", "2026-01-00T12:00:00Z",
        "2016-12-31T23:59:60Z", "2026-01-01T24:00:00Z",
        "2026-10-05", "2026-10-05T01:26:17", "20261005T012617Z",
        "2026-10-05t01:26:17z", "2026-10-05 01:26:17Z",
        "2026-10-05T01:26:17.Z", "2026-10-05T01:26:17,123Z",
        "2026-10-05T01:26:17+0530", "2026-10-05T01:26:17+25:00",
        " 2026-10-05T01:26:17Z", "2026-10-05T01:26:17Z ",
        "2026-10-05T01:26:17Zsuffix", "2026-10-05T01:26:17Z\n",
        "", "not-a-date", "0000-00-00", "☃️", String(repeating: "x", count: 1_024),
    ]

    // Generate all strings before measuring. Distinct dates avoid benchmarking
    // repeated-input memoization, and fixed arithmetic makes runs reproducible.
    static func timestamps(count: Int, fractional: Bool) -> [String] {
        (0..<count).map { index in
            let date = String(format: "%04d-%02d-%02dT%02d:%02d:%02d",
                              2020 + index / 336, 1 + (index / 28) % 12,
                              1 + index % 28, index % 24, (index * 7) % 60, (index * 13) % 60)
            let fraction = fractional ? String(format: ".%03d", (index * 37) % 1_000) : ""
            let zone = ["Z", "+05:30", "-07:00"][index % 3]
            return date + fraction + zone
        }
    }

    struct Totals: Equatable, Sendable {
        var valid = 0
        var checksum: TimeInterval = 0
    }

    // The Sendable assertion is bounded by the lock, including snapshots; neither
    // mutable storage nor formatter objects escape into the concurrent closures.
    final class Results: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [Int: Totals] = [:]
        func put(_ value: Totals, at index: Int) {
            lock.lock(); defer { lock.unlock() }
            values[index] = value
        }
        func snapshot() -> [Int: Totals] {
            lock.lock(); defer { lock.unlock() }
            return values
        }
    }

    static func run(_ inputs: [String], workers: Int,
                    parse: @escaping @Sendable (String) -> Date?) -> [Totals] {
        let parseChunk: @Sendable (Int) -> Totals = { worker in
            autoreleasepool {
                var totals = Totals()
                for index in stride(from: worker, to: inputs.count, by: workers) {
                    if let date = parse(inputs[index]) {
                        totals.valid += 1
                        totals.checksum += date.timeIntervalSinceReferenceDate
                    }
                }
                return totals
            }
        }
        if workers == 1 { return [parseChunk(0)] }
        let results = Results()
        DispatchQueue.concurrentPerform(iterations: workers) { worker in
            results.put(parseChunk(worker), at: worker)
        }
        let values = results.snapshot()
        return (0..<workers).map { values[$0]! }
    }
}

final class MailDateTests: XCTestCase {
    func testParsingMatchesOriginalAcrossDistinctDatesAndEdgeCases() {
        let inputs = MailDateTestSupport.edgeCases
            + MailDateTestSupport.timestamps(count: 1_024, fractional: true)
            + MailDateTestSupport.timestamps(count: 1_024, fractional: false)
        for input in inputs {
            XCTAssertEqual(MailDate.parse(input), MailDateTestSupport.baselineParse(input), input)
        }
    }

    func testParsingPreservesAbsoluteInstantsAndDisplayFallbacks() throws {
        for input in ["1970-01-01T00:00:00Z", "1970-01-01T05:30:00+05:30", "1969-12-31T17:00:00-07:00"] {
            XCTAssertEqual(try XCTUnwrap(MailDate.parse(input)).timeIntervalSince1970, 0)
        }
        XCTAssertEqual(try XCTUnwrap(MailDate.parse("1970-01-01T00:00:00.125Z")).timeIntervalSince1970, 0.125, accuracy: 0.000_001)
        for input in ["", "not-a-date"] {
            XCTAssertNil(MailDate.parse(input))
            XCTAssertEqual(MailDate.compact(input), "")
            XCTAssertEqual(MailDate.full(input), input)
        }
        let input = "2024-02-29T23:59:59.123Z"
        let date = try XCTUnwrap(MailDateTestSupport.baselineParse(input))
        let expectedCompact = Calendar.current.isDateInToday(date)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.month(.abbreviated).day())
        XCTAssertEqual(MailDate.compact(input), expectedCompact)
        XCTAssertEqual(MailDate.full(input), date.formatted(date: .abbreviated, time: .shortened))
    }

    func testConcurrentParsingMatchesOriginalForEveryInput() {
        let inputs = MailDateTestSupport.edgeCases
            + MailDateTestSupport.timestamps(count: 256, fractional: true)
            + MailDateTestSupport.timestamps(count: 256, fractional: false)
        let expected = inputs.map { MailDateTestSupport.baselineParse($0) }
        let mismatches = MailDateTestSupport.Results()
        DispatchQueue.concurrentPerform(iterations: 8) { worker in
            var result = MailDateTestSupport.Totals()
            for offset in 0..<(inputs.count * 4) {
                let index = (offset + worker * 17) % inputs.count
                if MailDate.parse(inputs[index]) != expected[index] { result.valid += 1 }
            }
            mismatches.put(result, at: worker)
        }
        let results = mismatches.snapshot()
        XCTAssertEqual(results.count, 8)
        XCTAssertTrue(results.values.allSatisfy { $0.valid == 0 }, "Concurrent parser results diverged: \(results)")
    }

    func testAlternatingWarmParserBenchmark() throws {
        // Diagnostic, not a wall-clock CI assertion. The hosted harness waits for
        // bootstatus before XCTest runs; warm both implementations again here.
        // Results describe this simulator/Debug workload, not physical devices.
        let fractional = MailDateTestSupport.timestamps(count: 2_048, fractional: true)
        let whole = MailDateTestSupport.timestamps(count: 2_048, fractional: false)
        let mixed = fractional.indices.map { index in
            index % 10 == 0 ? "invalid-\(index)" : (index % 2 == 0 ? fractional[index] : whole[index])
        }
        let workloads: [(String, [String], Int)] = [
            ("fractional", fractional, 1), ("whole", whole, 1),
            ("mixed", mixed, 1), ("mixed-four-workers", mixed, 4),
        ]
        for (name, inputs, workers) in workloads {
            _ = MailDateTestSupport.run(Array(inputs.prefix(128)), workers: workers, parse: { MailDateTestSupport.baselineParse($0) })
            _ = MailDateTestSupport.run(Array(inputs.prefix(128)), workers: workers) { MailDate.parse($0) }
            var baselineSamples = [Double](), cachedSamples = [Double]()
            var expected: [MailDateTestSupport.Totals]?
            for sample in 0..<6 {
                // AB/BA alternation reduces order/thermal/scheduler bias.
                for cached in (sample.isMultiple(of: 2) ? [false, true] : [true, false]) {
                    let start = DispatchTime.now().uptimeNanoseconds
                    let totals = cached
                        ? MailDateTestSupport.run(inputs, workers: workers) { MailDate.parse($0) }
                        : MailDateTestSupport.run(inputs, workers: workers, parse: { MailDateTestSupport.baselineParse($0) })
                    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
                    if let expected { XCTAssertEqual(totals, expected, "\(name): parse results changed") }
                    else { expected = totals }
                    if cached { cachedSamples.append(elapsed) } else { baselineSamples.append(elapsed) }
                }
            }
            let median: ([Double]) -> Double = { samples in
                let sorted = samples.sorted()
                return (sorted[2] + sorted[3]) / 2
            }
            let report: [String: Any] = [
                "workload": name, "inputsPerSample": inputs.count, "workers": workers,
                "baselineMilliseconds": baselineSamples, "cachedMilliseconds": cachedSamples,
                "baselineMedianMilliseconds": median(baselineSamples),
                "cachedMedianMilliseconds": median(cachedSamples),
                "medianSpeedup": median(baselineSamples) / median(cachedSamples),
                "timingIsDiagnosticOnly": true,
            ]
            let json = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
            print("MAIL_DATE_BENCHMARK \(String(decoding: json, as: UTF8.self))")
        }
    }
}

// Request sequencing is measured at the URLSession boundary using synthetic
// responses. The fixed delay below models a network dependency, not device speed.
private enum InboxLoadingTestSupport {
    static let catalog = Data(#"{"legacyDestinationIds":{"normal":"inbox-lane","focus":"focus-lane","quiet":"quiet-lane","hidden":"hidden-lane"}}"#.utf8)
    static func capabilities(mode: MailSearchMode = .indexed, epoch: String = "epoch-one", owner: String = "fixture-owner") throws -> Data {
        try JSONEncoder().encode(MailSearchCapabilities(version: 1, mode: mode, epoch: epoch, ownerId: owner,
            coverage: mode == .indexed ? "stored-plaintext" : "stored-metadata", semantics: mode == .indexed ? "literal-index-v3" : "legacy-substring-v1"))
    }
    static func indexed(_ handler: @escaping (URLRequest) throws -> (status: Int, data: Data)) -> (URLRequest) throws -> (status: Int, data: Data) {
        { request in
            if request.url?.path == "/v1/mail/search/capabilities" { return (200, try capabilities()) }
            return try handler(request)
        }
    }
    static func page(_ id: String = "page", cursor: String? = nil) throws -> Data {
        var message = DemoData.messages[0]; message.id = id
        return try JSONEncoder().encode(InboxPage(accounts: DemoData.accounts, messages: [message], nextCursor: cursor,
            counts: InboxCounts(focus: 1, normal: 0, quiet: 0, hidden: 0, all: 1)))
    }
    static func searchPage(_ ids: [String] = [], cursor: String? = nil, continuation: MailSearchContinuation = .none, snapshot: String = "snapshot-one") throws -> Data {
        let messages = ids.map { id in var message = DemoData.messages[0]; message.id = id; return message }
        return try JSONEncoder().encode(MailSearchPage(accounts: DemoData.accounts, messages: messages, nextCursor: cursor,
            continuation: continuation, snapshot: snapshot, order: .fieldRelevance, semantics: .literalIndex, coverage: .storedPlaintext))
    }
    static func query(_ request: URLRequest) -> [String: String] {
        Dictionary(uniqueKeysWithValues: (URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    }
    static func paths(for view: String) -> [String] {
        view == "all" || view.hasPrefix("destination:") ? ["/v1/inbox"] : ["/v1/destinations", "/v1/inbox"]
    }

    @MainActor struct Fixture {
        let state: AppState
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        private let previousAccountID = UserDefaults.standard.string(forKey: "selectedAccountID")
        init(token: @escaping @Sendable () async -> String? = { "fixture-token" }) {
            let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubURLProtocol.self]
            let client = APIClient(baseURL: URL(string: "https://orca.example")!, session: URLSession(configuration: config), token: token)
            state = AppState(client: client, cache: CacheStore(directory: folder))
            state.baseURLText = "https://orca.example"; state.phase = .ready
            state.accounts = DemoData.accounts; state.selectedAccountID = DemoData.accounts[0].id
        }
        func cleanup() {
            StubURLProtocol.handler = nil
            StubURLProtocol.responseHeaders = nil
            UserDefaults.standard.set(previousAccountID, forKey: "selectedAccountID")
            try? FileManager.default.removeItem(at: folder)
        }
    }
    actor FirstRequestGate {
        let started: XCTestExpectation
        private var first = true
        private var requestsToSkip: Int
        private var continuation: CheckedContinuation<Void, Never>?
        init(started: XCTestExpectation, skipping requestsToSkip: Int = 0) { self.started = started; self.requestsToSkip = requestsToSkip }
        func wait() async {
            if requestsToSkip > 0 { requestsToSkip -= 1; return }
            guard first else { return }; first = false
            await withCheckedContinuation { continuation in
                self.continuation = continuation; started.fulfill()
            }
        }
        func release() { continuation?.resume(); continuation = nil }
    }
}

final class InboxLoadingTests: XCTestCase {
    @MainActor func testEmptyQueryPreservesInboxDestinationAndLegacyViews() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        let response = try InboxLoadingTestSupport.page()
        var requests = [URLRequest]()
        StubURLProtocol.handler = { request in
            requests.append(request)
            return (200, request.url?.path == "/v1/destinations" ? InboxLoadingTestSupport.catalog : response)
        }
        for (view, destination) in [("all", nil), ("destination:custom /&?", "custom /&?"),
                                    ("normal", "inbox-lane"), ("focus", "focus-lane"),
                                    ("quiet", "quiet-lane"), ("hidden", "hidden-lane"), ("unknown", nil)] as [(String, String?)] {
            requests = []
            let model = InboxViewModel(); model.view = view
            await model.load(state: fixture.state)
            XCTAssertEqual(requests.compactMap { $0.url?.path }, InboxLoadingTestSupport.paths(for: view), view)
            let request = try XCTUnwrap(requests.last)
            var expected = ["accountId": "demo-account", "view": view.hasPrefix("destination:") ? "all" : view,
                            "limit": "30"]
            expected["destinationId"] = destination
            XCTAssertEqual(InboxLoadingTestSupport.query(request), expected, view)
            XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "GET" && $0.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token" })
            XCTAssertEqual(model.messages, try JSONDecoder().decode(InboxPage.self, from: response).messages)
            XCTAssertNil(model.error); XCTAssertFalse(model.isLoading)
        }
    }

    @MainActor func testDirectInboxLoadsDoNotDependOnCatalogAvailability() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        let response = try InboxLoadingTestSupport.page()
        var paths = [String]()
        StubURLProtocol.handler = { request in
            paths.append(request.url!.path)
            if request.url?.path == "/v1/destinations" {
                return (503, Data(#"{"error":{"code":"unavailable","message":"Catalog unavailable"}}"#.utf8))
            }
            return (200, response)
        }
        for view in ["all", "destination:projects"] {
            paths = []
            let model = InboxViewModel(); model.view = view
            await model.load(state: fixture.state)
            XCTAssertEqual(paths, ["/v1/inbox"])
            XCTAssertEqual(model.messages, try JSONDecoder().decode(InboxPage.self, from: response).messages)
            XCTAssertNil(model.error); XCTAssertFalse(model.isLoading)
        }
    }

    @MainActor func testInboxRefreshAndPaginationKeepCursorAndFreshLegacyMappings() async throws {
        for view in ["all", "destination:projects", "normal", "focus"] {
            let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
            let first = try InboxLoadingTestSupport.page("first", cursor: "opaque + / cursor")
            let next = try InboxLoadingTestSupport.page("second")
            let refreshed = try InboxLoadingTestSupport.page("refreshed")
            var requests = [URLRequest](), pageCount = 0, catalogCount = 0
            StubURLProtocol.handler = { request in
                requests.append(request)
                if request.url?.path == "/v1/destinations" {
                    catalogCount += 1
                    return (200, Data("{\"legacyDestinationIds\":{\"normal\":\"inbox-\(catalogCount)\",\"focus\":\"focus-\(catalogCount)\"}}".utf8))
                }
                pageCount += 1
                return (200, pageCount == 1 ? first : pageCount == 2 ? next : refreshed)
            }
            let model = InboxViewModel(); model.view = view
            await model.load(state: fixture.state)
            await model.load(state: fixture.state, reset: false)
            XCTAssertEqual(model.messages.map(\.id), ["first", "second"]); XCTAssertNil(model.nextCursor)
            await model.load(state: fixture.state)
            XCTAssertEqual(model.messages.map(\.id), ["refreshed"])
            XCTAssertEqual(requests.compactMap { $0.url?.path }, Array(repeating: InboxLoadingTestSupport.paths(for: view), count: 3).flatMap { $0 })
            let queries = requests.filter { $0.url?.path == "/v1/inbox" }.map(InboxLoadingTestSupport.query)
            XCTAssertEqual(queries.map { $0["cursor"] }, [nil, "opaque + / cursor", nil])
            XCTAssertTrue(queries.allSatisfy { $0["query"] == nil })
            if view == "normal" || view == "focus" {
                let prefix = view == "normal" ? "inbox" : "focus"
                XCTAssertEqual(queries.map { $0["destinationId"] }, ["\(prefix)-1", "\(prefix)-2", "\(prefix)-3"])
            }
        }
    }

    @MainActor func testLegacyCatalogFailureStillStopsInboxAndMissingMappingKeepsFallback() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        var paths = [String]()
        StubURLProtocol.handler = { request in
            paths.append(request.url!.path)
            return (503, Data(#"{"error":{"code":"unavailable","message":"Catalog unavailable"}}"#.utf8))
        }
        let model = InboxViewModel(); model.view = "focus"
        await model.load(state: fixture.state)
        XCTAssertEqual(paths, ["/v1/destinations"]); XCTAssertTrue(model.messages.isEmpty)
        XCTAssertEqual(model.error, "Catalog unavailable"); XCTAssertFalse(model.isLoading)
        let response = try InboxLoadingTestSupport.page()
        StubURLProtocol.handler = { request in
            if request.url?.path == "/v1/destinations" { return (200, Data("{}".utf8)) }
            XCTAssertNil(InboxLoadingTestSupport.query(request)["destinationId"])
            XCTAssertEqual(InboxLoadingTestSupport.query(request)["view"], "focus")
            return (200, response)
        }
        await model.load(state: fixture.state)
        XCTAssertEqual(model.messages.map(\.id), ["page"]); XCTAssertNil(model.error)
    }

    @MainActor func testInboxErrorAndOfflineCacheRemainScoped() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        let response = try InboxLoadingTestSupport.page(cursor: "must-not-reuse-offline")
        StubURLProtocol.handler = { request in (200, request.url?.path == "/v1/destinations" ? InboxLoadingTestSupport.catalog : response) }
        let model = InboxViewModel(); model.view = "all"
        await model.load(state: fixture.state)
        StubURLProtocol.handler = { request in
            if request.url?.path == "/v1/destinations" { return (200, InboxLoadingTestSupport.catalog) }
            throw URLError(.notConnectedToInternet)
        }
        await model.load(state: fixture.state)
        XCTAssertEqual(model.messages.map(\.id), ["page"]); XCTAssertNil(model.nextCursor)
        XCTAssertEqual(model.error, "Offline — showing saved mail")
        fixture.state.baseURLText = "https://other.example"
        StubURLProtocol.handler = { request in
            if request.url?.path == "/v1/destinations" { return (200, InboxLoadingTestSupport.catalog) }
            return (404, Data(#"{"error":{"code":"not_found","message":"Destination not found"}}"#.utf8))
        }
        await model.load(state: fixture.state)
        XCTAssertTrue(model.messages.isEmpty); XCTAssertNil(model.nextCursor)
        XCTAssertEqual(model.error, "Destination not found"); XCTAssertFalse(model.isLoading)
    }

    @MainActor func testCancelledOrChangedIdentityResponseCannotPublishOrCache() async throws {
        for interruption in ["cancel", "account", "scope"] {
            let gate = InboxLoadingTestSupport.FirstRequestGate(started: expectation(description: "request suspended"))
            let fixture = InboxLoadingTestSupport.Fixture(token: { await gate.wait(); return "fixture-token" })
            defer { fixture.cleanup() }
            let response = try InboxLoadingTestSupport.page()
            StubURLProtocol.handler = { request in (200, request.url?.path == "/v1/destinations" ? InboxLoadingTestSupport.catalog : response) }
            let model = InboxViewModel(); model.view = "all"
            let oldKey = "\(fixture.state.ownerScope)|demo-account|inbox|all|"
            let task = Task { await model.load(state: fixture.state) }
            await fulfillment(of: [gate.started], timeout: 3)
            switch interruption {
            case "cancel": task.cancel()
            case "account":
                var other = DemoData.accounts[0]; other.id = "other-account"
                fixture.state.accounts.append(other); fixture.state.selectedAccountID = other.id
            default: fixture.state.baseURLText = "https://other.example"
            }
            await gate.release(); await task.value
            XCTAssertTrue(model.messages.isEmpty, interruption); XCTAssertNil(model.error); XCTAssertFalse(model.isLoading)
            let cached = await fixture.state.cache.load(InboxPage.self, key: oldKey)
            XCTAssertNil(cached, interruption)
        }
    }

    @MainActor func testNewerSearchWinsAndDuplicatePaginationDoesNotStart() async throws {
        let gate = InboxLoadingTestSupport.FirstRequestGate(started: expectation(description: "old request suspended"))
        let fixture = InboxLoadingTestSupport.Fixture(token: { await gate.wait(); return "fixture-token" })
        defer { fixture.cleanup() }
        var requests = [URLRequest]()
        StubURLProtocol.handler = InboxLoadingTestSupport.indexed { request in
            requests.append(request)
            if request.url?.path == "/v1/destinations" { return (200, InboxLoadingTestSupport.catalog) }
            if request.url?.path == "/v1/mail/search" { return (200, try InboxLoadingTestSupport.searchPage(["new"])) }
            return (200, try InboxLoadingTestSupport.page("old"))
        }
        let model = InboxViewModel(); model.view = "all"
        let old = Task { await model.load(state: fixture.state) }
        await fulfillment(of: [gate.started], timeout: 3)
        await model.load(state: fixture.state, reset: false)
        XCTAssertTrue(requests.isEmpty, "Pagination must not overlap an in-flight load")
        model.search = "new"
        await model.load(state: fixture.state)
        XCTAssertEqual(model.messages.map(\.id), ["new"])
        await gate.release(); await old.value
        XCTAssertEqual(model.messages.map(\.id), ["new"]); XCTAssertNil(model.error); XCTAssertFalse(model.isLoading)
    }

    @MainActor func testDelayedSyntheticRequestSequencingMeasurement() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        let response = try InboxLoadingTestSupport.page()
        let delay = 0.08
        var requests = [URLRequest]()
        StubURLProtocol.handler = { request in
            requests.append(request); Thread.sleep(forTimeInterval: delay)
            return (200, request.url?.path == "/v1/destinations" ? InboxLoadingTestSupport.catalog : response)
        }
        var samples = [String: [Double]]()
        for sample in 0..<6 {
            for view in (sample.isMultiple(of: 2) ? ["all", "destination:projects", "focus"] : ["focus", "destination:projects", "all"]) {
                requests = []
                let model = InboxViewModel(); model.view = view
                let start = DispatchTime.now().uptimeNanoseconds
                await model.load(state: fixture.state)
                let milliseconds = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
                XCTAssertEqual(requests.compactMap { $0.url?.path }, InboxLoadingTestSupport.paths(for: view))
                XCTAssertEqual(model.messages.map(\.id), ["page"]); XCTAssertNil(model.error)
                samples[view, default: []].append(milliseconds)
            }
        }
        for view in samples.keys.sorted() {
            let values = samples[view]!.sorted()
            let report: [String: Any] = ["view": view, "requestCount": InboxLoadingTestSupport.paths(for: view).count,
                "delayPerRequestMilliseconds": delay * 1_000, "samplesMilliseconds": samples[view]!,
                "medianMilliseconds": (values[2] + values[3]) / 2, "timingIsDiagnosticOnly": true]
            let json = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
            print("INBOX_LOADING_BENCHMARK \(String(decoding: json, as: UTF8.self))")
        }
    }
}

final class IndexedMailSearchTests: XCTestCase {
    func testSearchDecodesMatchesScanAndTerminalWithoutCounts() throws {
        for (continuation, cursor) in [(MailSearchContinuation.matches, "matches-cursor"), (.scan, "scan-cursor"), (.none, nil)] as [(MailSearchContinuation, String?)] {
            let data = try InboxLoadingTestSupport.searchPage(cursor: cursor, continuation: continuation)
            let page = try JSONDecoder().decode(MailSearchPage.self, from: data)
            XCTAssertEqual(page.continuation, continuation); XCTAssertEqual(page.nextCursor, cursor)
            XCTAssertEqual(page.snapshot, "snapshot-one"); XCTAssertEqual(page.order, .fieldRelevance)
            XCTAssertEqual(page.semantics, .literalIndex); XCTAssertEqual(page.coverage, .storedPlaintext)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertNil(object["counts"]); XCTAssertNil(object["total"])
        }
    }

    func testSearchRejectsMetadataFallbackAndInconsistentWireContract() throws {
        let valid = try InboxLoadingTestSupport.searchPage()
        for (key, value) in [("coverage", "stored-metadata"), ("order", "newest-first"), ("semantics", "literal-index-v2"),
                             ("snapshot", ""), ("continuation", "scan"), ("nextCursor", "unexpected-cursor")] {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: valid) as? [String: Any])
            object[key] = value
            XCTAssertThrowsError(try JSONDecoder().decode(MailSearchPage.self, from: JSONSerialization.data(withJSONObject: object)), key)
        }
        var missingCursor = try XCTUnwrap(JSONSerialization.jsonObject(with: valid) as? [String: Any])
        missingCursor.removeValue(forKey: "nextCursor")
        XCTAssertThrowsError(try JSONDecoder().decode(MailSearchPage.self, from: JSONSerialization.data(withJSONObject: missingCursor)))
    }

    @MainActor func testSearchUsesIndexedEndpointAndExactSelectedScope() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        let response = try InboxLoadingTestSupport.searchPage(["match"])
        var requests = [URLRequest]()
        StubURLProtocol.handler = InboxLoadingTestSupport.indexed { request in
            requests.append(request)
            return (200, request.url?.path == "/v1/destinations" ? InboxLoadingTestSupport.catalog : response)
        }
        for (view, destination) in [("all", nil), ("destination:custom /&?", "custom /&?"),
                                    ("normal", "inbox-lane"), ("focus", "focus-lane"),
                                    ("quiet", "quiet-lane"), ("hidden", "hidden-lane")] as [(String, String?)] {
            requests = []
            let model = InboxViewModel(); model.view = view; model.search = "  AI update & \"project plans\"  "
            await model.load(state: fixture.state)
            let request = try XCTUnwrap(requests.last)
            XCTAssertEqual(request.url?.path, "/v1/mail/search")
            var expected = ["query": "AI update & \"project plans\"", "limit": "10", "accountId": "demo-account", "view": "all"]
            expected["destinationId"] = destination
            XCTAssertEqual(InboxLoadingTestSupport.query(request), expected, view)
            XCTAssertFalse(requests.contains { $0.url?.path == "/v1/inbox" })
            XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "GET" && $0.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token" })
            XCTAssertEqual(model.messages.map(\.id), ["match"]); XCTAssertEqual(model.searchStatus, .ready)
            XCTAssertEqual(model.view, view); XCTAssertNil(model.error)
        }
    }

    @MainActor func testUnmappedNativeInboxUsesInboxPolicyAndDirectSearchSkipsCatalog() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        let response = try InboxLoadingTestSupport.searchPage()
        var requests = [URLRequest]()
        StubURLProtocol.handler = InboxLoadingTestSupport.indexed { request in
            requests.append(request)
            return (200, request.url?.path == "/v1/destinations" ? Data("{}".utf8) : response)
        }
        let model = InboxViewModel(); model.search = "update"
        await model.load(state: fixture.state)
        XCTAssertEqual(InboxLoadingTestSupport.query(try XCTUnwrap(requests.last))["view"], "inbox")
        for view in ["all", "destination:projects"] {
            requests = []; model.view = view
            await model.load(state: fixture.state)
            XCTAssertEqual(requests.compactMap { $0.url?.path }, ["/v1/mail/search"])
        }
    }

    @MainActor func testEmptyScanPageContinuesWithStableSnapshotAndDestinationUntilRefresh() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        var requests = [URLRequest](), pages = 0, catalogs = 0
        StubURLProtocol.handler = InboxLoadingTestSupport.indexed { request in
            requests.append(request)
            if request.url?.path == "/v1/destinations" {
                catalogs += 1
                return (200, Data("{\"legacyDestinationIds\":{\"normal\":\"inbox-\(catalogs)\"}}".utf8))
            }
            pages += 1
            if pages == 1 { return (200, try InboxLoadingTestSupport.searchPage(cursor: "scan + / cursor", continuation: .scan)) }
            if pages == 2 { return (200, try InboxLoadingTestSupport.searchPage(["first"], cursor: "match + / cursor", continuation: .matches)) }
            if pages == 3 { return (200, try InboxLoadingTestSupport.searchPage(["first", "second"])) }
            return (200, try InboxLoadingTestSupport.searchPage(["refreshed"], snapshot: "snapshot-two"))
        }
        let model = InboxViewModel(); model.search = "update"
        await model.load(state: fixture.state)
        XCTAssertTrue(model.messages.isEmpty); XCTAssertEqual(model.continuation, .scan)
        XCTAssertEqual(model.nextCursor, "scan + / cursor"); XCTAssertEqual(model.searchStatus, .ready)
        await model.load(state: fixture.state, reset: false)
        await model.load(state: fixture.state, reset: false)
        XCTAssertEqual(model.messages.map(\.id), ["first", "second"])
        XCTAssertEqual(model.snapshot, "snapshot-one"); XCTAssertNil(model.nextCursor)
        await model.load(state: fixture.state, reset: false)
        XCTAssertEqual(pages, 3, "A terminal search must not request another page")
        await model.load(state: fixture.state)
        XCTAssertEqual(model.messages.map(\.id), ["refreshed"]); XCTAssertEqual(model.snapshot, "snapshot-two")
        let queries = requests.filter { $0.url?.path == "/v1/mail/search" }.map(InboxLoadingTestSupport.query)
        XCTAssertEqual(queries.map { $0["cursor"] }, [nil, "scan + / cursor", "match + / cursor", nil])
        XCTAssertEqual(queries.map { $0["destinationId"] }, ["inbox-1", "inbox-1", "inbox-1", "inbox-2"])
        XCTAssertTrue(queries.allSatisfy { $0["query"] == "update" && $0["limit"] == "10" })
    }

    @MainActor func testSearchFailuresRemainExplicitAndNeverUseLegacyCachedMatches() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        let cached = try JSONDecoder().decode(InboxPage.self, from: InboxLoadingTestSupport.page("cached-wrong-result"))
        try await fixture.state.cache.save(cached, key: "\(fixture.state.ownerScope)|demo-account|inbox|all|AI")
        let model = InboxViewModel(); model.view = "all"; model.search = "AI"
        let failures: [(String, InboxViewModel.SearchStatus)] = [
            ("search_anchor_required", .invalidQuery), ("search_invalid_query", .invalidQuery),
            ("search_index_updating", .updating), ("search_index_blocked", .blocked),
            ("search_index_unavailable", .unavailable), ("search_busy", .unavailable),
            ("search_cursor_stale", .stale), ("search_invalid_cursor", .stale)
        ]
        for (code, expectedStatus) in failures {
            StubURLProtocol.handler = InboxLoadingTestSupport.indexed { request in
                XCTAssertEqual(request.url?.path, "/v1/mail/search")
                let message = code == "search_anchor_required" ? "Add a word or phrase with at least 3 characters. Short terms can accompany it, such as AI update." : "Search needs retry: \(code)"
                return (409, try JSONEncoder().encode(ErrorEnvelope(error: APIErrorBody(code: code, message: message, retryable: true))))
            }
            await model.load(state: fixture.state)
            XCTAssertEqual(model.searchStatus, expectedStatus, code)
            XCTAssertTrue(model.messages.isEmpty, code); XCTAssertNil(model.nextCursor); XCTAssertNil(model.snapshot)
            XCTAssertEqual(model.search, "AI"); XCTAssertEqual(model.view, "all"); XCTAssertFalse(model.isLoading)
            XCTAssertNotNil(model.error)
            if code == "search_anchor_required" { XCTAssertTrue(model.error?.contains("AI update") == true) }
            if expectedStatus == .stale { XCTAssertEqual(model.retryTitle, "Restart search") }
        }
    }

    @MainActor func testOfflineSearchCannotFallBackAndClearingQueryRestoresOfflineInbox() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        StubURLProtocol.handler = InboxLoadingTestSupport.indexed { request in
            if request.url?.path == "/v1/inbox" { return (200, try InboxLoadingTestSupport.page("inbox")) }
            return (200, try InboxLoadingTestSupport.searchPage(["result"], cursor: "next", continuation: .matches))
        }
        let model = InboxViewModel(); model.view = "all"
        await model.load(state: fixture.state)
        model.search = "update"
        XCTAssertTrue(model.messages.isEmpty, "Typing must immediately hide cached or unrelated Inbox rows")
        XCTAssertEqual(model.searchStatus, .idle)
        await model.load(state: fixture.state)
        XCTAssertEqual(model.messages.map(\.id), ["result"])
        StubURLProtocol.handler = InboxLoadingTestSupport.indexed { _ in throw URLError(.notConnectedToInternet) }
        await model.load(state: fixture.state, reset: false)
        XCTAssertEqual(model.searchStatus, .offline); XCTAssertTrue(model.messages.isEmpty)
        XCTAssertNil(model.nextCursor); XCTAssertNil(model.snapshot); XCTAssertEqual(model.search, "update")
        model.search = ""
        await model.load(state: fixture.state)
        XCTAssertEqual(model.messages.map(\.id), ["inbox"])
        XCTAssertEqual(model.error, "Offline — showing saved mail"); XCTAssertFalse(model.isSearching)
    }

    @MainActor func testSnapshotMismatchAndStaleCursorRequireExplicitRestart() async throws {
        for failure in ["snapshot", "server", "repeated-cursor"] {
            let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
            var requests = [URLRequest]()
            StubURLProtocol.handler = InboxLoadingTestSupport.indexed { request in
                requests.append(request)
                if requests.count == 1 { return (200, try InboxLoadingTestSupport.searchPage(["old"], cursor: "cursor-one", continuation: .matches)) }
                if requests.count == 2 {
                    if failure == "server" { return (409, Data(#"{"error":{"code":"search_cursor_stale","message":"Stored mail changed. Restart this search."}}"#.utf8)) }
                    return (200, try InboxLoadingTestSupport.searchPage(["wrong"], cursor: failure == "repeated-cursor" ? "cursor-one" : nil,
                        continuation: failure == "repeated-cursor" ? .matches : .none, snapshot: failure == "snapshot" ? "snapshot-two" : "snapshot-one"))
                }
                return (200, try InboxLoadingTestSupport.searchPage(["fresh"], snapshot: "snapshot-fresh"))
            }
            let model = InboxViewModel(); model.view = "all"; model.search = "update"
            await model.load(state: fixture.state)
            await model.load(state: fixture.state, reset: false)
            XCTAssertEqual(model.searchStatus, .stale, failure); XCTAssertTrue(model.messages.isEmpty)
            XCTAssertNil(model.nextCursor); XCTAssertNil(model.snapshot); XCTAssertEqual(model.search, "update")
            await model.load(state: fixture.state, reset: false)
            XCTAssertEqual(requests.count, 2, "A failed continuation cannot be appended or retried implicitly")
            await model.load(state: fixture.state)
            XCTAssertNil(InboxLoadingTestSupport.query(try XCTUnwrap(requests.last))["cursor"])
            XCTAssertEqual(model.messages.map(\.id), ["fresh"]); XCTAssertEqual(model.searchStatus, .ready)
        }
    }

    @MainActor func testEditingOrInterruptingSearchRejectsLateResponses() async throws {
        for interruption in ["query", "view", "account", "scope", "cancel"] {
            let gate = InboxLoadingTestSupport.FirstRequestGate(started: expectation(description: "search suspended"))
            let fixture = InboxLoadingTestSupport.Fixture(token: { await gate.wait(); return "fixture-token" })
            defer { fixture.cleanup() }
            StubURLProtocol.handler = InboxLoadingTestSupport.indexed { _ in (200, try InboxLoadingTestSupport.searchPage(["late-result"])) }
            let model = InboxViewModel(); model.view = "all"; model.search = "update"
            let pending = Task { await model.load(state: fixture.state) }
            await fulfillment(of: [gate.started], timeout: 3)
            switch interruption {
            case "query": model.search = "changed"
            case "view": model.view = "destination:other"
            case "account":
                var other = DemoData.accounts[0]; other.id = "other-account"
                fixture.state.accounts.append(other); fixture.state.selectedAccountID = other.id
            case "scope": fixture.state.baseURLText = "https://other.example"
            default: pending.cancel()
            }
            await gate.release(); await pending.value
            XCTAssertTrue(model.messages.isEmpty, interruption); XCTAssertNil(model.snapshot)
            XCTAssertNil(model.error); XCTAssertFalse(model.isLoading)
        }
    }

    @MainActor func testSearchRejectsMessagesOutsideSelectedAccount() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        var page = try JSONDecoder().decode(MailSearchPage.self, from: InboxLoadingTestSupport.searchPage(["wrong-account"]))
        page.messages[0].accountId = "another-account"
        let data = try JSONEncoder().encode(page)
        StubURLProtocol.handler = InboxLoadingTestSupport.indexed { _ in (200, data) }
        let model = InboxViewModel(); model.view = "all"; model.search = "update"
        await model.load(state: fixture.state)
        XCTAssertTrue(model.messages.isEmpty); XCTAssertEqual(model.searchStatus, .unavailable)
        XCTAssertNotNil(model.error); XCTAssertNil(model.nextCursor)
    }
}

final class StagedMailSearchTests: XCTestCase {
    func testCapabilitiesRejectMalformedOrContradictoryModes() throws {
        let data = try InboxLoadingTestSupport.capabilities()
        for (key, value) in [("version", 2), ("mode", "unknown"), ("epoch", ""), ("ownerId", ""),
                             ("coverage", "stored-metadata"), ("semantics", "legacy-substring-v1")] as [(String, Any)] {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]); object[key] = value
            XCTAssertThrowsError(try JSONDecoder().decode(MailSearchCapabilities.self, from: JSONSerialization.data(withJSONObject: object)), key)
        }
    }

    @MainActor func testLegacyShortQueryUsesOriginalInboxContractAndBoundManualPagination() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        var requests = [URLRequest](), pages = 0
        StubURLProtocol.handler = { request in
            requests.append(request)
            if request.url?.path == "/v1/mail/search/capabilities" { return (200, try InboxLoadingTestSupport.capabilities(mode: .legacyMetadata)) }
            if request.url?.path == "/v1/destinations" { return (200, InboxLoadingTestSupport.catalog) }
            pages += 1
            return (200, try InboxLoadingTestSupport.page(pages == 1 ? "legacy-first" : "legacy-next", cursor: pages == 1 ? "legacy-cursor" : nil))
        }
        let model = InboxViewModel(); model.search = "AI"
        await model.load(state: fixture.state)
        await model.load(state: fixture.state, reset: false)
        XCTAssertEqual(model.messages.map(\.id), ["legacy-first", "legacy-next"])
        XCTAssertEqual(model.searchCapabilities?.mode, .legacyMetadata)
        XCTAssertEqual(model.searchCountLabel, "2 shown · Mailbox order")
        XCTAssertTrue(model.searchCoverageLabel.contains("Message bodies are not searched"))
        XCTAssertNil(model.snapshot); XCTAssertEqual(model.continuation, .none); XCTAssertNil(model.nextCursor)
        XCTAssertFalse(requests.contains { $0.url?.path == "/v1/mail/search" })
        XCTAssertEqual(requests.filter { $0.url?.path == "/v1/mail/search/capabilities" }.count, 1)
        let searches = requests.filter { $0.url?.path == "/v1/inbox" }
        XCTAssertEqual(searches.map { InboxLoadingTestSupport.query($0)["cursor"] }, [nil, "legacy-cursor"])
        for request in searches {
            XCTAssertEqual(InboxLoadingTestSupport.query(request)["query"], "AI")
            XCTAssertEqual(InboxLoadingTestSupport.query(request)["limit"], "10")
            XCTAssertEqual(InboxLoadingTestSupport.query(request)["view"], "normal")
            XCTAssertEqual(InboxLoadingTestSupport.query(request)["destinationId"], "inbox-lane")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Orca-Expected-Search-Mode"), "legacy-metadata")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Orca-Expected-Search-Epoch"), "epoch-one")
        }
        model.search = ""
        await model.load(state: fixture.state)
        let browse = try XCTUnwrap(requests.last)
        XCTAssertEqual(InboxLoadingTestSupport.query(browse)["limit"], "30")
        XCTAssertNil(browse.value(forHTTPHeaderField: "X-Orca-Expected-Search-Mode"))
    }

    @MainActor func testModeOrEpochChangeRestartsFromFirstPageWithoutMixing() async throws {
        for newMode in [MailSearchMode.indexed, .legacyMetadata] {
            let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
            var capabilities = 0, reads = [URLRequest]()
            StubURLProtocol.handler = { request in
                if request.url?.path == "/v1/mail/search/capabilities" {
                    capabilities += 1
                    return (200, try InboxLoadingTestSupport.capabilities(mode: capabilities == 1 ? .legacyMetadata : newMode,
                        epoch: capabilities == 1 ? "epoch-one" : "epoch-two"))
                }
                reads.append(request)
                if reads.count == 1 { return (200, try InboxLoadingTestSupport.page("old-mode", cursor: "old-cursor")) }
                if reads.count == 2 { return (409, Data(#"{"error":{"code":"search_mode_changed","message":"Search coverage changed."}}"#.utf8)) }
                if newMode == .indexed { return (200, try InboxLoadingTestSupport.searchPage(["new-mode"])) }
                return (200, try InboxLoadingTestSupport.page("new-mode"))
            }
            let model = InboxViewModel(); model.view = "all"; model.search = "update"
            await model.load(state: fixture.state)
            await model.load(state: fixture.state, reset: false)
            XCTAssertEqual(capabilities, 2); XCTAssertEqual(reads.count, 3)
            XCTAssertEqual(model.messages.map(\.id), ["new-mode"]); XCTAssertNil(model.error)
            XCTAssertEqual(model.searchCapabilities?.mode, newMode); XCTAssertEqual(model.searchCapabilities?.epoch, "epoch-two")
            XCTAssertEqual(reads.last?.url?.path, newMode == .indexed ? "/v1/mail/search" : "/v1/inbox")
            XCTAssertNil(InboxLoadingTestSupport.query(try XCTUnwrap(reads.last))["cursor"])
            XCTAssertEqual(reads.last?.value(forHTTPHeaderField: "X-Orca-Expected-Search-Epoch"), "epoch-two")
            XCTAssertEqual(model.search, "update"); XCTAssertEqual(model.view, "all")
        }
    }

    @MainActor func testIndexedLagDoesNotDowngradeButAuthenticatedRollbackDoes() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        var mode = MailSearchMode.indexed, code = "search_index_updating", legacyReads = 0
        StubURLProtocol.handler = { request in
            if request.url?.path == "/v1/mail/search/capabilities" { return (200, try InboxLoadingTestSupport.capabilities(mode: mode, epoch: mode == .indexed ? "enabled" : "disabled")) }
            if request.url?.path == "/v1/inbox" { legacyReads += 1; return (200, try InboxLoadingTestSupport.page("explicit-rollback")) }
            return (503, try JSONEncoder().encode(ErrorEnvelope(error: APIErrorBody(code: code, message: "Index needs attention", retryable: true))))
        }
        let model = InboxViewModel(); model.view = "all"; model.search = "update"
        for errorCode in ["search_index_updating", "search_index_blocked", "search_failed"] {
            code = errorCode; await model.load(state: fixture.state)
            XCTAssertEqual(model.searchCapabilities?.mode, .indexed)
            XCTAssertEqual(legacyReads, 0); XCTAssertTrue(model.messages.isEmpty); XCTAssertNotNil(model.error)
        }
        mode = .legacyMetadata
        await model.load(state: fixture.state)
        XCTAssertEqual(legacyReads, 1); XCTAssertEqual(model.messages.map(\.id), ["explicit-rollback"])
        XCTAssertEqual(model.searchCapabilities?.mode, .legacyMetadata)
        XCTAssertEqual(model.searchCountLabel, "1 shown · Mailbox order")
        XCTAssertNil(model.snapshot); XCTAssertNil(model.error)
    }

    @MainActor func testLateResponseFromPreviousEpochCannotReplaceNewModeResults() async throws {
        let gate = InboxLoadingTestSupport.FirstRequestGate(started: expectation(description: "indexed read suspended"), skipping: 1)
        let fixture = InboxLoadingTestSupport.Fixture(token: { await gate.wait(); return "fixture-token" })
        defer { fixture.cleanup() }
        var mode = MailSearchMode.indexed
        StubURLProtocol.handler = { request in
            if request.url?.path == "/v1/mail/search/capabilities" { return (200, try InboxLoadingTestSupport.capabilities(mode: mode, epoch: mode == .indexed ? "old" : "new")) }
            if request.url?.path == "/v1/mail/search" { return (200, try InboxLoadingTestSupport.searchPage(["stale-indexed"])) }
            return (200, try InboxLoadingTestSupport.page("current-legacy"))
        }
        let model = InboxViewModel(); model.view = "all"; model.search = "update"
        let old = Task { await model.load(state: fixture.state) }
        await fulfillment(of: [gate.started], timeout: 3)
        mode = .legacyMetadata
        await model.load(state: fixture.state)
        XCTAssertEqual(model.messages.map(\.id), ["current-legacy"])
        await gate.release(); await old.value
        XCTAssertEqual(model.messages.map(\.id), ["current-legacy"])
        XCTAssertEqual(model.searchCapabilities?.epoch, "new"); XCTAssertNil(model.snapshot); XCTAssertNil(model.error)
    }

    @MainActor func testNotActivatedResponseRechecksCapabilitiesBeforeLegacyRead() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        var capabilities = 0
        StubURLProtocol.handler = { request in
            if request.url?.path == "/v1/mail/search/capabilities" {
                capabilities += 1
                return (200, try InboxLoadingTestSupport.capabilities(mode: capabilities == 1 ? .indexed : .legacyMetadata,
                    epoch: capabilities == 1 ? "enabled" : "disabled"))
            }
            if request.url?.path == "/v1/mail/search" {
                return (503, Data(#"{"error":{"code":"search_not_activated","message":"Indexed search is not activated."}}"#.utf8))
            }
            XCTAssertEqual(capabilities, 2, "The read error alone never authorizes legacy mode")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Orca-Expected-Search-Epoch"), "disabled")
            return (200, try InboxLoadingTestSupport.page("verified-legacy"))
        }
        let model = InboxViewModel(); model.view = "all"; model.search = "update"
        await model.load(state: fixture.state)
        XCTAssertEqual(model.messages.map(\.id), ["verified-legacy"])
        XCTAssertEqual(model.searchCapabilities?.mode, .legacyMetadata); XCTAssertNil(model.error)
    }

    @MainActor func testOnlyInitialAuthenticatedOldServer404AllowsLegacyAcrossViewModels() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        var oldServer = true, legacyReads = 0, sessionReads = 0
        StubURLProtocol.responseHeaders = { _ in [:] }
        StubURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v1/mail/search/capabilities":
                return oldServer ? (404, Data()) : (200, try InboxLoadingTestSupport.capabilities())
            case "/v1/auth/session":
                sessionReads += 1
                return (200, Data(#"{"isAuthenticated":true,"user":{"id":"fixture-owner","email":"owner@example.com"}}"#.utf8))
            case "/v1/inbox":
                legacyReads += 1
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Orca-Expected-Search-Epoch"), "legacy-server")
                return (200, try InboxLoadingTestSupport.page("old-server-result"))
            default: return (200, try InboxLoadingTestSupport.searchPage(["indexed-result"]))
            }
        }
        let first = InboxViewModel(); first.view = "all"; first.search = "AI"
        await first.load(state: fixture.state)
        XCTAssertEqual(first.messages.map(\.id), ["old-server-result"])
        XCTAssertEqual(first.searchCapabilities?.mode, .legacyMetadata); XCTAssertEqual(sessionReads, 1)
        oldServer = false; StubURLProtocol.responseHeaders = nil
        first.search = "update"; await first.load(state: fixture.state)
        XCTAssertEqual(first.messages.map(\.id), ["indexed-result"])
        oldServer = true
        let reopened = InboxViewModel(); reopened.view = "all"; reopened.search = "AI"
        await reopened.load(state: fixture.state)
        XCTAssertTrue(reopened.messages.isEmpty); XCTAssertNotNil(reopened.error)
        XCTAssertEqual(legacyReads, 1, "A new view model cannot forget that this owner and origin used indexed search")
        XCTAssertEqual(sessionReads, 2)
    }

    @MainActor func testCapabilityErrorsAndUnverifiedOldServerNeverUseLegacyReader() async throws {
        for failure in ["401", "503", "network", "malformed", "old-server-signed-out", "old-server-session-error"] {
            let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
            var readRequests = 0
            StubURLProtocol.handler = { request in
                if request.url?.path == "/v1/mail/search/capabilities" {
                    switch failure {
                    case "401": return (401, Data())
                    case "503": return (503, Data())
                    case "network": throw URLError(.notConnectedToInternet)
                    case "malformed": return (200, Data(#"{"version":1,"mode":"legacy-metadata","epoch":"wrong","ownerId":"fixture-owner","coverage":"stored-plaintext","semantics":"literal-index-v3"}"#.utf8))
                    default: return (404, Data())
                    }
                }
                if request.url?.path == "/v1/auth/session" {
                    if failure == "old-server-session-error" { return (503, Data()) }
                    return (200, Data(#"{"isAuthenticated":false}"#.utf8))
                }
                readRequests += 1
                return (200, try InboxLoadingTestSupport.page("must-not-publish"))
            }
            let model = InboxViewModel(); model.view = "all"; model.search = "AI"
            await model.load(state: fixture.state)
            XCTAssertTrue(model.messages.isEmpty, failure); XCTAssertNotNil(model.error, failure)
            XCTAssertEqual(readRequests, 0, failure); XCTAssertEqual(model.search, "AI")
        }
    }

    @MainActor func testCapabilitiesMustBelongToTheCurrentAuthenticatedOwner() async throws {
        for oldServer in [false, true] {
            let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
            StubURLProtocol.handler = { request in
                if request.url?.path == "/v1/mail/search/capabilities" {
                    return oldServer ? (404, Data()) : (200, try InboxLoadingTestSupport.capabilities(owner: "other-owner"))
                }
                return (200, Data(#"{"isAuthenticated":true,"user":{"id":"other-owner","email":"other@example.com"}}"#.utf8))
            }
            let client = try XCTUnwrap(fixture.state.client)
            do {
                _ = try await client.searchCapabilities(expectedOwnerID: "current-owner")
                XCTFail("A capability from another owner must not authorize a search")
            } catch APIClient.ClientError.invalidResponse { }
        }
    }

    @MainActor func testIndexedResponseRequiresMatchingModeAndEpochHeaders() async throws {
        for headers in [[:], ["X-Orca-Search-Mode": "legacy-metadata", "X-Orca-Search-Epoch": "epoch-one"],
                        ["X-Orca-Search-Mode": "indexed", "X-Orca-Search-Epoch": "different"]] {
            let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
            var capabilities = 0, reads = 0
            StubURLProtocol.responseHeaders = { _ in headers }
            StubURLProtocol.handler = { request in
                if request.url?.path == "/v1/mail/search/capabilities" { capabilities += 1; return (200, try InboxLoadingTestSupport.capabilities()) }
                reads += 1
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Orca-Expected-Search-Mode"), "indexed")
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Orca-Expected-Search-Epoch"), "epoch-one")
                return (200, try InboxLoadingTestSupport.searchPage(["unbound-result"]))
            }
            let model = InboxViewModel(); model.view = "all"; model.search = "update"
            await model.load(state: fixture.state)
            XCTAssertTrue(model.messages.isEmpty); XCTAssertEqual(model.searchStatus, .stale)
            XCTAssertEqual(capabilities, 2); XCTAssertEqual(reads, 2, "Re-resolving a changing server must be bounded")
            XCTAssertNil(model.nextCursor); XCTAssertNil(model.snapshot)
        }
    }
}
