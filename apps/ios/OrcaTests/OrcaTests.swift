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
        let first = DraftStore(directory: directory); draft = try await first.save(draft); let sending = try await first.prepareSend(draft.id); let second = DraftStore(directory: directory); let restored = await second.all(ownerScope: "https://one.example", accountId: "account-a")
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
        for state in ["sending", "ambiguous", "rejected", "sent"] { XCTAssertFalse(ComposeView.sendPermissionGate(account: account, deliveryState: state).blocksNormalSend) }
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
            local = try await store.save(local)
            let remote = MessageDraft(id: "contested-server-draft", accountId: "account", to: [], cc: [], bcc: [], subject: "Remote copy", body: .init(text: "Remote words", html: nil), context: nil, attachments: [], revision: 2, deliveryStatus: "draft", providerSyncStatus: "synced", providerSyncError: nil, providerDraftId: nil, providerMessageId: nil, providerThreadId: nil, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z")
            var reservation = ComposeOperationReservation()
            let started = expectation(description: "First mutation reserved before delayed work")
            var resume: CheckedContinuation<Void, Never>?
            let pending = Task { @MainActor in
                XCTAssertTrue(reservation.reserve(first))
                defer { reservation.release(first) }
                var snapshot = local
                await withCheckedContinuation { continuation in resume = continuation; started.fulfill() }
                if first == .attachments {
                    snapshot.content.attachments.removeAll()
                    local = try await store.save(snapshot)
                } else { local = try await store.makeEditableCopy(snapshot, verifiedRemote: remote) }
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
            if second == .attachments {
                latest.content.attachments.removeAll()
                local = try await store.save(latest)
            } else { local = try await store.makeEditableCopy(latest, verifiedRemote: remote) }
            reservation.release(second)
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
        draft.content.body.text = "Previously saved words"; draft = try await store.save(draft)
        draft.content.body.text = "Latest visible words typed before the debounce"
        draft.content.subject = "Latest subject"
        draft.recipientText = .init(to: "maya@example.com", cc: "unfinished", bcc: "")
        let current = draft
        var checkpointed = draft
        let remoteStarted = expectation(description: "Remote check starts after durable checkpoint")
        var finishRemote: CheckedContinuation<MessageDraft, Error>?
        let pending = Task { @MainActor in
            try await ComposeReconciliationCheckpoint.loadRemote(afterCheckpointing: current, store: store, didCheckpoint: { checkpointed = $0 }) {
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
        XCTAssertNotEqual(checkpointed.storageRevision, current.storageRevision)
        XCTAssertEqual(checkpointed.storageRevision, afterFailure.first?.storageRevision)
        checkpointed.content.body.text = "More writing after the remote check failed"
        let continued = try await store.save(checkpointed)
        XCTAssertEqual(continued.content.body.text, checkpointed.content.body.text)
        XCTAssertEqual(continued.serverID, "contested-server-draft")
        let continuedAfterRestart = await DraftStore(directory: folder).all(ownerScope: "origin|user", accountId: "account")
        XCTAssertEqual(continuedAfterRestart, [continued])
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
    static func page(_ id: String = "page", cursor: String? = nil) throws -> Data {
        var message = DemoData.messages[0]; message.id = id
        return try JSONEncoder().encode(InboxPage(accounts: DemoData.accounts, messages: [message], nextCursor: cursor,
            counts: InboxCounts(focus: 1, normal: 0, quiet: 0, hidden: 0, all: 1)))
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
            UserDefaults.standard.set(previousAccountID, forKey: "selectedAccountID")
            try? FileManager.default.removeItem(at: folder)
        }
    }
    actor FirstRequestGate {
        let started: XCTestExpectation
        private var first = true
        private var continuation: CheckedContinuation<Void, Never>?
        init(started: XCTestExpectation) { self.started = started }
        func wait() async {
            guard first else { return }; first = false
            await withCheckedContinuation { continuation in
                self.continuation = continuation; started.fulfill()
            }
        }
        func release() { continuation?.resume(); continuation = nil }
    }
}

final class InboxLoadingTests: XCTestCase {
    @MainActor func testRequestPathsAndQueryPreserveAllDestinationAndLegacyViews() async throws {
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
            let model = InboxViewModel(); model.view = view; model.search = "two words & more"
            await model.load(state: fixture.state)
            XCTAssertEqual(requests.compactMap { $0.url?.path }, InboxLoadingTestSupport.paths(for: view), view)
            let request = try XCTUnwrap(requests.last)
            var expected = ["accountId": "demo-account", "view": view.hasPrefix("destination:") ? "all" : view,
                            "limit": "30", "query": "two words & more"]
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

    @MainActor func testRefreshAndPaginationKeepCursorSearchAndFreshLegacyMappings() async throws {
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
            let model = InboxViewModel(); model.view = view; model.search = "subject"
            await model.load(state: fixture.state)
            await model.load(state: fixture.state, reset: false)
            XCTAssertEqual(model.messages.map(\.id), ["first", "second"]); XCTAssertNil(model.nextCursor)
            await model.load(state: fixture.state)
            XCTAssertEqual(model.messages.map(\.id), ["refreshed"])
            XCTAssertEqual(requests.compactMap { $0.url?.path }, Array(repeating: InboxLoadingTestSupport.paths(for: view), count: 3).flatMap { $0 })
            let queries = requests.filter { $0.url?.path == "/v1/inbox" }.map(InboxLoadingTestSupport.query)
            XCTAssertEqual(queries.map { $0["cursor"] }, [nil, "opaque + / cursor", nil])
            XCTAssertEqual(queries.map { $0["query"] }, ["subject", "subject", "subject"])
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
        StubURLProtocol.handler = { request in
            requests.append(request)
            if request.url?.path == "/v1/destinations" { return (200, InboxLoadingTestSupport.catalog) }
            return (200, try InboxLoadingTestSupport.page(InboxLoadingTestSupport.query(request)["query"] ?? "old"))
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


/// Regression checks call the production ComposeView serialization path. All
/// messages are synthetic; these tests never create or deliver real email.
@MainActor
final class DraftLifecycleTests: XCTestCase {
    func testVerifiedCopyOnlyAllowsMatchingTerminalDeliveryStates() {
        for local in ["local", "draft", "sending", "ambiguous", "rejected", "sent"] {
            for remote in ["draft", "sending", "ambiguous", "rejected", "sent"] {
                XCTAssertEqual(ComposeView.canEditVerifiedCopy(remoteDeliveryStatus: remote, localDeliveryState: local),
                               ["rejected", "sent"].contains(local) && remote == local,
                               "local=\(local), remote=\(remote)")
            }
        }
        var sent = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account")
        sent.deliveryState = "sent"
        let composer = ComposeView(localDraft: sent)
        XCTAssertTrue(composer.copyableDelivery); XCTAssertTrue(composer.deliveryRecoveryAction)
        XCTAssertEqual(composer.primaryActionTitle, "Edit a new copy")
    }

    func testSharedOperationCompletionReloadsOnlyTheBlockedObserver() {
        let draft = UUID(), owner = UUID(), other = UUID()
        let active = [draft: owner]
        // Invalid recipients or a failed checkpoint may leave the owner with
        // unsaved visible words. Releasing its own lease must not replace them.
        XCTAssertFalse(ComposeView.shouldReloadAfterSharedOperation(draftID: draft, previous: active, current: [:], lastOwnedOperation: owner))
        XCTAssertTrue(ComposeView.shouldReloadAfterSharedOperation(draftID: draft, previous: active, current: [:], lastOwnedOperation: nil))
        XCTAssertTrue(ComposeView.shouldReloadAfterSharedOperation(draftID: draft, previous: active, current: [:], lastOwnedOperation: other))
        XCTAssertFalse(ComposeView.shouldReloadAfterSharedOperation(draftID: draft, previous: active, current: [draft: other], lastOwnedOperation: nil))
        XCTAssertFalse(ComposeView.shouldReloadAfterSharedOperation(draftID: UUID(), previous: active, current: [:], lastOwnedOperation: nil))
    }

    func testDraftLifecycleStaleSaveCannotEraseAnEstablishedServerIdentity() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let reopened = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account", content: DraftContent(subject: "One operation")))
        var created = reopened
        created.serverID = "fixture-server-draft"; created.serverRevision = 1
        created = try await store.save(created)
        do {
            try await store.save(reopened)
            XCTFail("A stale composer must not erase the first create's server identity")
        } catch { /* A stale local snapshot must fail closed. */ }
        let persisted = await store.all(ownerScope: reopened.ownerScope, accountId: reopened.accountId)
        XCTAssertEqual(persisted.first?.serverID, created.serverID)
        XCTAssertEqual(persisted.first?.serverRevision, created.serverRevision)
    }

    func testDraftLifecycleUnapprovedBodyEditCannotDiscardHTMLDuringAutosave() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = DraftBody(text: "Keep this link", html: "<p>Keep <a href=\"https://example.com/notes\">this link</a></p>")
        let store = DraftStore(directory: directory)
        var draft = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account", content: DraftContent(body: original)))
        // An input/autosave path without conversion approval must fail closed,
        // even if the text editor accidentally supplies a changed value.
        draft.content.body = ComposeView.bodyForSaving(text: "Accidental edit", original: draft.content.body)
        _ = try await store.save(draft)
        let reopened = await DraftStore(directory: directory).all(ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(reopened.first?.content.body.html, original.html, "An unapproved autosave must retain the exact HTML and links")
        XCTAssertEqual(reopened.first?.content.body.text, original.text, "A locked rich body cannot diverge from its original text")
    }

    func testExplicitConversionPersistsBeforeAnyTextEditAndKeepsDraftIdentity() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        var initial = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account", content: DraftContent(
            to: [.init(name: nil, email: "maya@example.com")], subject: "Keep metadata",
            body: .init(text: "Keep this link", html: "<p>Keep <a href=\"https://example.com\">this link</a></p>"),
            attachments: [.init(id: "a", filename: "note.txt", mimeType: "text/plain", size: 1, contentBase64: "eA==")]))
        initial.serverID = "server-draft"; initial.serverRevision = 4
        initial.recipientText = .init(to: "maya@example.com, unfinished", cc: "", bcc: "")
        let draft = try await store.save(initial)
        let request = ComposePlainTextConversion.Request(draftID: draft.id, body: draft.content.body)
        let reservation = try await store.reserve(draft)
        let converted = try await ComposePlainTextConversion.save(draft, request: request, store: store, reservation: reservation)
        await store.release(reservation)
        var expected = draft.content; expected.body.html = nil
        XCTAssertEqual(converted.content, expected)
        XCTAssertEqual(converted.recipientText, draft.recipientText)
        XCTAssertEqual(converted.id, draft.id); XCTAssertEqual(converted.serverID, draft.serverID)
        XCTAssertEqual(converted.serverRevision, draft.serverRevision)
        XCTAssertEqual(converted.idempotencyKey, draft.idempotencyKey)
        XCTAssertNotEqual(converted.storageRevision, draft.storageRevision)
        let reopened = await DraftStore(directory: directory).all(ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(reopened, [converted], "Conversion alone must be durable even if snapshot text never changes")
        let edited = ComposeView.bodyForSaving(text: "New plain text", original: converted.content.body)
        XCTAssertEqual(edited.text, "New plain text"); XCTAssertNil(edited.html)
    }

    func testConversionRejectsChangedBodyStaleSnapshotAndForeignLease() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let initial = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account",
            content: DraftContent(body: .init(text: "Rich writing", html: "<p>Rich writing</p>"))))
        let approved = ComposePlainTextConversion.Request(draftID: initial.id, body: initial.content.body)
        var changed = initial; changed.content.subject = "Newer subject"
        changed = try await store.save(changed)
        let reservation = try await store.reserve(changed)
        do {
            _ = try await ComposePlainTextConversion.save(initial, request: approved, store: store, reservation: reservation)
            XCTFail("A stale snapshot must not convert or overwrite newer writing")
        } catch { XCTAssertEqual(error as? DraftStore.StoreError, .staleDraft) }
        await store.release(reservation)
        changed.content.body.html = "<p><strong>New formatting</strong></p>"
        changed = try await store.save(changed)
        let currentReservation = try await store.reserve(changed)
        do {
            _ = try await ComposePlainTextConversion.save(changed, request: approved, store: store, reservation: currentReservation)
            XCTFail("Approval for an earlier body must not destroy newly adopted HTML")
        } catch { XCTAssertTrue(error is ComposePlainTextConversion.Failure) }
        let other = try await store.save(LocalDraft(ownerScope: initial.ownerScope, accountId: initial.accountId))
        let foreignReservation = try await store.reserve(other)
        let currentApproval = ComposePlainTextConversion.Request(draftID: changed.id, body: changed.content.body)
        do {
            _ = try await ComposePlainTextConversion.save(changed, request: currentApproval, store: store, reservation: foreignReservation)
            XCTFail("A conversion cannot bypass another operation's lease")
        } catch { XCTAssertEqual(error as? DraftStore.StoreError, .invalidReservation) }
        await store.release(currentReservation); await store.release(foreignReservation)
        let unchanged = await store.current(changed.id, ownerScope: changed.ownerScope, accountId: changed.accountId)
        XCTAssertEqual(unchanged, changed)
    }

    func testConversionRefusesFrozenDeliveryStates() async throws {
        for delivery in ["sending", "ambiguous", "rejected", "sent"] {
            let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = DraftStore(directory: directory)
            var initial = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account",
                content: DraftContent(body: .init(text: "Frozen writing", html: "<p>Frozen writing</p>")))
            initial.deliveryState = delivery
            let draft = try await store.save(initial), reservation = try await store.reserve(draft)
            let request = ComposePlainTextConversion.Request(draftID: draft.id, body: draft.content.body)
            do {
                _ = try await ComposePlainTextConversion.save(draft, request: request, store: store, reservation: reservation)
                XCTFail("Recovery must use an explicit new copy before body conversion")
            } catch { XCTAssertTrue(error is ComposePlainTextConversion.Failure) }
            await store.release(reservation)
            let unchanged = await store.current(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId)
            XCTAssertEqual(unchanged, draft)
        }
    }

    func testFailedConversionKeepsRichBodyOnDiskAndInMemoryUntilSuccessfulRetry() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let backup = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory); try? FileManager.default.removeItem(at: backup) }
        let store = DraftStore(directory: directory)
        let draft = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account",
            content: DraftContent(body: .init(text: "Kept writing", html: "<p>Kept <strong>writing</strong></p>"))))
        let request = ComposePlainTextConversion.Request(draftID: draft.id, body: draft.content.body)
        let reservation = try await store.reserve(draft)
        let bytes = try Data(contentsOf: directory.appending(path: "drafts.json"))
        try FileManager.default.moveItem(at: directory, to: backup)
        try Data("blocked-directory".utf8).write(to: directory)
        do {
            _ = try await ComposePlainTextConversion.save(draft, request: request, store: store, reservation: reservation)
            XCTFail("Expected a durable save failure")
        } catch {}
        let unchanged = await store.current(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(unchanged, draft)
        XCTAssertEqual(try Data(contentsOf: backup.appending(path: "drafts.json")), bytes)
        try FileManager.default.removeItem(at: directory)
        try FileManager.default.moveItem(at: backup, to: directory)
        let retried = try await ComposePlainTextConversion.save(draft, request: request, store: store, reservation: reservation)
        await store.release(reservation)
        XCTAssertNil(retried.content.body.html)
        XCTAssertEqual(retried.content.body.text, draft.content.body.text)
    }

    func testCommittedConversionCanBeAdoptedAfterInterruptionButCannotReplaceAnotherIdentityOrRevision() {
        var previous = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account",
            content: DraftContent(body: .init(text: "Writing", html: "<p>Writing</p>")))
        previous.storageRevision = UUID()
        var committed = previous; committed.content.body.html = nil; committed.storageRevision = UUID()
        // Visibility, activity, and editor appearance are not post-commit gates:
        // Back/background cancellation cannot roll back a successful disk write.
        XCTAssertTrue(ComposePlainTextConversion.shouldAdoptCommitted(committed, replacing: previous, current: previous, ownerScope: previous.ownerScope, accountID: previous.accountId))
        XCTAssertTrue(ComposePlainTextConversion.shouldAdoptCommitted(committed, replacing: previous, current: committed, ownerScope: previous.ownerScope, accountID: previous.accountId))
        var newer = previous; newer.storageRevision = UUID()
        var other = previous; other.id = UUID()
        for current in [newer, other] {
            XCTAssertFalse(ComposePlainTextConversion.shouldAdoptCommitted(committed, replacing: previous, current: current, ownerScope: previous.ownerScope, accountID: previous.accountId))
        }
        XCTAssertFalse(ComposePlainTextConversion.shouldAdoptCommitted(committed, replacing: previous, current: previous, ownerScope: "another-owner", accountID: previous.accountId))
        XCTAssertFalse(ComposePlainTextConversion.shouldAdoptCommitted(committed, replacing: previous, current: previous, ownerScope: previous.ownerScope, accountID: "another-account"))
        XCTAssertFalse(ComposePlainTextConversion.shouldAdoptCommitted(committed, replacing: previous, current: nil, ownerScope: previous.ownerScope, accountID: previous.accountId))
    }

    func testConversionReservationExcludesEveryOtherMutationAndRepeatTap() {
        let operations: [ComposeOperationReservation.Operation] = [.attachments, .delivery, .reconciliation, .conversion]
        for first in operations {
            var reservation = ComposeOperationReservation()
            XCTAssertTrue(reservation.reserve(first))
            for second in operations { XCTAssertFalse(reservation.reserve(second)) }
            reservation.release(first)
            XCTAssertTrue(reservation.reserve(.conversion))
            reservation.release(.conversion)
            XCTAssertFalse(reservation.isBusy)
        }
    }

    func testDraftLifecycleConvertedBodyEditsRemainPlainText() {
        let original = DraftBody(text: "Original", html: nil)
        let edited = ComposeView.bodyForSaving(text: "Changed", original: original)
        XCTAssertEqual(edited.text, "Changed")
        XCTAssertNil(edited.html, "Sending edited plain text must not send the old rich body instead")
        XCTAssertNil(ComposeView.bodyForSaving(text: "New message", original: nil).html)
    }

    func testDraftLifecycleOpeningLocalRichDraftPreservesHTML() {
        let body = DraftBody(text: "Keep this link", html: "<p>Keep <a href=\"https://example.com/notes\">this link</a></p>")
        let draft = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account",
                               content: DraftContent(subject: "Rich draft", body: body))
        let serialized = ComposeView(localDraft: draft).content()
        XCTAssertEqual(serialized.body.text, body.text)
        XCTAssertEqual(serialized.body.html, body.html, "Opening an unchanged draft must not destroy its rich body")
    }

    func testDraftLifecycleOpeningServerRichDraftPreservesHTML() {
        let body = DraftBody(text: "Keep formatting", html: "<p>Keep <strong>formatting</strong></p>")
        let draft = MessageDraft(id: "fixture-server-draft", accountId: "fixture-account", to: [], cc: [], bcc: [],
                                 subject: "Rich server draft", body: body, context: nil, attachments: [], revision: 1,
                                 deliveryStatus: "draft", providerSyncStatus: "synced", providerSyncError: nil,
                                 providerDraftId: nil, providerMessageId: nil, providerThreadId: nil,
                                 createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z")
        let serialized = ComposeView(serverDraft: draft).content()
        XCTAssertEqual(serialized.body.text, body.text)
        XCTAssertEqual(serialized.body.html, body.html, "The first local autosave must preserve the server rich body")
    }

    func testDraftLifecycleUnchangedRichBodySurvivesSaveAndReopen() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let body = DraftBody(text: "Keep formatting", html: "<p>Keep <em>formatting</em></p>")
        var draft = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account", content: DraftContent(body: body))
        // This is the content() -> DraftStore.save sequence used by saveLocal().
        draft.content = ComposeView(localDraft: draft).content()
        try await DraftStore(directory: directory).save(draft)
        let reopened = await DraftStore(directory: directory).all(ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(reopened.count, 1)
        XCTAssertEqual(reopened.first?.content.body.html, body.html)
    }
}

/// Exercises the actual disk-backed store with independent composer snapshots.
/// No API requests or live mail are involved.
final class DraftStoreRevisionTests: XCTestCase {
    func testConcurrentReservationAcquisitionHasExactlyOneOwnerPerDraft() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let draft = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account"))
        let other = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account"))
        let file = directory.appending(path: "drafts.json"), bytes = try Data(contentsOf: file)
        let acquired = await withTaskGroup(of: DraftStore.Reservation?.self, returning: [DraftStore.Reservation].self) { group in
            for _ in 0..<8 {
                group.addTask {
                    do { return try await store.reserve(draft) }
                    catch { XCTAssertEqual(error as? DraftStore.StoreError, .operationInProgress); return nil }
                }
            }
            var results = [DraftStore.Reservation]()
            for await result in group { if let result { results.append(result) } }
            return results
        }
        XCTAssertEqual(acquired.count, 1)
        let owner = try XCTUnwrap(acquired.first)
        XCTAssertEqual(owner.draftID, draft.id)
        let otherOwner = try await store.reserve(other)
        XCTAssertNotEqual(owner.id, otherOwner.id, "Distinct drafts may operate independently")
        XCTAssertEqual(try Data(contentsOf: file), bytes, "Reservations never modify persistence")
        await store.release(owner); await store.release(otherOwner)
        let reserved = await store.isReserved(draft.id)
        XCTAssertFalse(reserved)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testReservationAcquisitionRejectsStaleRemovedUnsavedAndWrongScopeSnapshots() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let original = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account", content: .init(subject: "Original")))
        var edit = original; edit.content.subject = "Changed"
        edit = try await store.save(edit)
        edit.content = original.content
        let latest = try await store.save(edit)
        // Ordinary identical-save adoption is deliberately more permissive
        // than acquisition: an operation must capture the exact current revision.
        await assertReservationFails(original, store: store, expected: .staleDraft)
        var unversioned = latest; unversioned.storageRevision = nil
        await assertReservationFails(unversioned, store: store, expected: .staleDraft)
        var wrongOwner = latest; wrongOwner.ownerScope = "other-owner"
        await assertReservationFails(wrongOwner, store: store, expected: .identityChanged)
        var wrongAccount = latest; wrongAccount.accountId = "other-account"
        await assertReservationFails(wrongAccount, store: store, expected: .identityChanged)
        await assertReservationFails(LocalDraft(ownerScope: latest.ownerScope, accountId: latest.accountId), store: store, expected: .staleDraft)
        let reserved = await store.isReserved(latest.id)
        XCTAssertFalse(reserved, "Failed acquisition must not take ownership")
        let owner = try await store.reserve(latest)
        await store.release(owner)
        try await store.remove(latest.id)
        await assertReservationFails(latest, store: store, expected: .staleDraft)
    }

    func testReservationBlocksEveryForeignMutationIncludingIdenticalAutosave() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        var initial = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account")
        initial.serverID = "server-draft"; initial.serverRevision = 2
        let draft = try await store.save(initial)
        let other = try await store.save(LocalDraft(ownerScope: draft.ownerScope, accountId: draft.accountId))
        let owner = try await store.reserve(draft)
        let otherOwner = try await store.reserve(other)
        let file = directory.appending(path: "drafts.json"), bytes = try Data(contentsOf: file)
        let wrong = DraftStore.Reservation(id: UUID(), draftID: draft.id)
        let cases: [(DraftStore.Reservation?, DraftStore.StoreError)] = [(nil, .operationInProgress), (wrong, .invalidReservation), (otherOwner, .invalidReservation)]
        for (token, expected) in cases {
            await assertMutationFails(expected) { _ = try await store.save(draft, reservation: token) }
            var changed = draft; changed.content.body.text = "Foreign writing"
            await assertMutationFails(expected) { _ = try await store.save(changed, reservation: token) }
            await assertMutationFails(expected) { try await store.remove(draft.id, reservation: token) }
            await assertMutationFails(expected) { _ = try await store.transition(draft.id, .confirmedPreReservation(serverRevision: 3), reservation: token) }
            await assertMutationFails(expected) { _ = try await store.prepareSend(draft.id, reservation: token) }
            await assertMutationFails(expected) { _ = try await store.markAmbiguous(draft.id, reservation: token) }
            await assertMutationFails(expected) { _ = try await store.markRejected(draft.id, reservation: token) }
            let remote = remoteDraft(for: draft)
            await assertMutationFails(expected) { _ = try await store.makeEditableCopy(draft, verifiedRemote: remote, reservation: token) }
        }
        let current = await store.current(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(current, draft)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        await store.release(owner); await store.release(otherOwner)
    }

    func testWrongReleaseCannotUnlockDraftAndExpiredTokenCannotMutateAfterReacquisition() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let draft = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account"))
        let first = try await store.reserve(draft)
        await store.release(.init(id: UUID(), draftID: draft.id))
        await store.release(.init(id: first.id, draftID: UUID()))
        let stillReserved = await store.isReserved(draft.id)
        XCTAssertTrue(stillReserved)
        await assertReservationFails(draft, store: store, expected: .operationInProgress)
        await store.release(first)
        let released = await store.isReserved(draft.id)
        XCTAssertFalse(released)
        await assertMutationFails(.invalidReservation) { _ = try await store.save(draft, reservation: first) }
        await assertMutationFails(.invalidReservation) { try await store.remove(draft.id, reservation: first) }
        await assertMutationFails(.invalidReservation) { _ = try await store.prepareSend(draft.id, reservation: first) }
        await assertMutationFails(.invalidReservation) { _ = try await store.markAmbiguous(draft.id, reservation: first) }
        await assertMutationFails(.invalidReservation) { _ = try await store.markRejected(draft.id, reservation: first) }
        await assertMutationFails(.invalidReservation) { _ = try await store.transition(draft.id, .uncertain, reservation: first) }
        let remote = remoteDraft(for: draft)
        await assertMutationFails(.invalidReservation) { _ = try await store.makeEditableCopy(draft, verifiedRemote: remote, reservation: first) }
        let second = try await store.reserve(draft)
        XCTAssertNotEqual(second.id, first.id)
        await store.release(first)
        let reacquired = await store.isReserved(draft.id)
        XCTAssertTrue(reacquired, "A late release must not unlock a new operation")
        await assertMutationFails(.invalidReservation) { _ = try await store.prepareSend(draft.id, reservation: first) }
        let unchanged = try await store.save(draft, reservation: second)
        XCTAssertEqual(unchanged, draft)
        await store.release(second)
        let ordinarySave = try await store.save(draft)
        XCTAssertEqual(ordinarySave, draft)
    }

    func testReservationOwnerCanPersistServerIdentityAndEveryDeliveryTransition() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        var draft = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account", content: .init(subject: "Local writing")))
        let owner = try await store.reserve(draft)
        draft.serverID = "created-on-server"; draft.serverRevision = 1
        draft = try await store.save(draft, reservation: owner)
        XCTAssertEqual(draft.serverID, "created-on-server")
        draft = try await store.prepareSend(draft.id, reservation: owner)
        let key = try XCTUnwrap(draft.idempotencyKey)
        XCTAssertEqual(draft.deliveryState, "sending")
        let ambiguous = try await store.markAmbiguous(draft.id, reservation: owner)
        draft = try XCTUnwrap(ambiguous)
        XCTAssertEqual(draft.deliveryState, "ambiguous"); XCTAssertEqual(draft.idempotencyKey, key)
        let rejected = try await store.markRejected(draft.id, reservation: owner)
        draft = try XCTUnwrap(rejected)
        XCTAssertEqual(draft.deliveryState, "rejected"); XCTAssertEqual(draft.idempotencyKey, key)
        let recovered = try await store.transition(draft.id, .confirmedPreReservation(serverRevision: 2), reservation: owner)
        draft = try XCTUnwrap(recovered)
        XCTAssertEqual(draft.deliveryState, "local"); XCTAssertNil(draft.idempotencyKey); XCTAssertEqual(draft.serverRevision, 2)
        let reopened = await DraftStore(directory: directory).all(ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(reopened, [draft])
        try await store.remove(draft.id, reservation: owner)
        let removed = await store.all(ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertTrue(removed.isEmpty)
        // Row retirement does not silently release ownership; a pending callback
        // with no token still cannot recreate an unsaved value under the old UUID.
        var recreation = LocalDraft(ownerScope: draft.ownerScope, accountId: draft.accountId); recreation.id = draft.id
        await assertMutationFails(.operationInProgress) { _ = try await store.save(recreation) }
        await store.release(owner)
        await assertMutationFails(.invalidReservation) { _ = try await store.save(recreation, reservation: owner) }
    }

    func testReservationOwnerCanMakeVerifiedEditableCopyWithoutTransferringLease() async throws {
        for rejected in [false, true] {
            let directory = temporaryDirectory()
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = DraftStore(directory: directory)
            var initial = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account", content: .init(subject: "Keep my words"))
            initial.serverID = "server-draft"; initial.serverRevision = 2
            var draft = try await store.save(initial)
            let owner = try await store.reserve(draft)
            if rejected {
                _ = try await store.prepareSend(draft.id, reservation: owner)
                let terminal = try await store.markRejected(draft.id, reservation: owner)
                draft = try XCTUnwrap(terminal)
            }
            let copied = try await store.makeEditableCopy(draft, verifiedRemote: remoteDraft(for: draft, status: rejected ? "rejected" : "draft"), reservation: owner)
            XCTAssertNotEqual(copied.id, draft.id); XCTAssertEqual(copied.content, draft.content)
            XCTAssertNil(copied.serverID); XCTAssertNil(copied.idempotencyKey)
            let originalReserved = await store.isReserved(draft.id), copyReserved = await store.isReserved(copied.id)
            XCTAssertTrue(originalReserved); XCTAssertFalse(copyReserved)
            await assertMutationFails(.invalidReservation) { _ = try await store.save(copied, reservation: owner) }
            let copyOwner = try await store.reserve(copied)
            await store.release(owner)
            let stillReserved = await store.isReserved(copied.id)
            XCTAssertTrue(stillReserved)
            var changed = copied; changed.content.body.text = "Continued writing"
            let saved = try await store.save(changed, reservation: copyOwner)
            XCTAssertEqual(saved.content.body.text, "Continued writing")
            await store.release(copyOwner)
            await assertSaveFails(draft, store: store, expected: .staleDraft)
        }
    }

    func testReservationsAreEphemeralAndNeverSerialized() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let draft = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account"))
        let file = directory.appending(path: "drafts.json"), bytes = try Data(contentsOf: file)
        let owner = try await store.reserve(draft)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        let restored = DraftStore(directory: directory)
        let restoredReserved = await restored.isReserved(draft.id)
        XCTAssertFalse(restoredReserved, "Runtime leases must not survive process restart")
        await assertMutationFails(.invalidReservation) { _ = try await restored.save(draft, reservation: owner) }
        let newOwner = try await restored.reserve(draft)
        XCTAssertNotEqual(newOwner, owner)
        await restored.release(newOwner); await store.release(owner)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testNoOpSavePreservesRevisionTimestampAndDiskBytes() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let initial = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account", content: .init(subject: "Same writing"))
        let current = try await store.save(initial)
        let file = directory.appending(path: "drafts.json"), bytes = try Data(contentsOf: file)
        var flush = current; flush.modifiedAt = current.modifiedAt.addingTimeInterval(60)
        let unchanged = try await store.save(flush)
        XCTAssertEqual(unchanged, current)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        await assertSaveFails(initial, store: store, expected: .staleDraft)
        var wrongOwner = current; wrongOwner.ownerScope = "other-owner"
        await assertSaveFails(wrongOwner, store: store, expected: .identityChanged)
        var wrongAccount = current; wrongAccount.accountId = "other-account"
        await assertSaveFails(wrongAccount, store: store, expected: .identityChanged)
        let reopened = await DraftStore(directory: directory).all(ownerScope: current.ownerScope, accountId: current.accountId)
        XCTAssertEqual(reopened, [current])
    }

    func testStaleButIdenticalSaveAdoptsCurrentRevisionWithoutAnotherWrite() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let original = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account", content: .init(subject: "Original writing")))
        var edit = original; edit.content.subject = "Temporary change"
        edit = try await store.save(edit)
        edit.content = original.content
        let latest = try await store.save(edit)
        XCTAssertNotEqual(latest.storageRevision, original.storageRevision)
        let file = directory.appending(path: "drafts.json"), bytes = try Data(contentsOf: file)
        let adopted = try await store.save(original)
        XCTAssertEqual(adopted, latest)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        var different = original; different.recipientText = .init(to: "unfinished", cc: "", bcc: "")
        await assertSaveFails(different, store: store, expected: .staleDraft)
        let reopened = await DraftStore(directory: directory).all(ownerScope: original.ownerScope, accountId: original.accountId)
        XCTAssertEqual(reopened, [latest])
    }

    func testStaleBodyAndAttachmentSnapshotCannotOverwriteNewerWriting() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        var initial = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account")
        initial.content.body = .init(text: "Old words", html: "<p>Old words</p>")
        initial.content.attachments = [.init(id: "old", filename: "old.txt", mimeType: "text/plain", size: 1, contentBase64: "eA==")]
        let stale = try await store.save(initial)
        var edit = stale
        edit.content.body = .init(text: "Latest words", html: nil)
        edit.content.subject = "Latest subject"
        edit.content.attachments.removeAll()
        edit.recipientText = .init(to: "maya@example.com", cc: "unfinished", bcc: "")
        let latest = try await store.save(edit)
        XCTAssertNotEqual(stale.storageRevision, latest.storageRevision)
        let bytes = try Data(contentsOf: directory.appending(path: "drafts.json"))
        await assertSaveFails(stale, store: store, expected: .staleDraft)
        let inMemory = await store.all(ownerScope: initial.ownerScope, accountId: initial.accountId)
        let reopened = await DraftStore(directory: directory).all(ownerScope: initial.ownerScope, accountId: initial.accountId)
        XCTAssertEqual(inMemory, [latest]); XCTAssertEqual(reopened, [latest])
        XCTAssertEqual(try Data(contentsOf: directory.appending(path: "drafts.json")), bytes)
    }

    func testCurrentRevisionCannotRegressEstablishedIdentityOrDeliveryMetadata() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        var initial = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account")
        initial.serverID = "server-draft"; initial.serverRevision = 4
        let current = try await store.save(initial)
        let changes: [(inout LocalDraft) -> Void] = [
            { $0.serverID = nil }, { $0.serverID = "different-server-draft" },
            { $0.serverRevision = nil }, { $0.serverRevision = 3 },
            { $0.ownerScope = "other-owner" }, { $0.accountId = "other-account" },
            { $0.idempotencyKey = "invented-command" }, { $0.deliveryState = "sending" }
        ]
        for change in changes {
            var proposed = current; change(&proposed)
            await assertSaveFails(proposed, store: store, expected: .identityChanged)
        }
        let unchanged = await store.all(ownerScope: current.ownerScope, accountId: current.accountId)
        XCTAssertEqual(unchanged, [current])
        var nextRevision = current; nextRevision.serverRevision = 5
        let advanced = try await store.save(nextRevision)
        XCTAssertEqual(advanced.serverRevision, 5)
        let sending = try await store.prepareSend(current.id)
        var clearedKey = sending; clearedKey.idempotencyKey = nil
        await assertSaveFails(clearedKey, store: store, expected: .identityChanged)
        var editable = sending; editable.deliveryState = "local"
        await assertSaveFails(editable, store: store, expected: .identityChanged)
        let reopened = await DraftStore(directory: directory).all(ownerScope: current.ownerScope, accountId: current.accountId)
        XCTAssertEqual(reopened, [sending])
    }

    func testDeletedPersistedDraftCannotBeResurrectedEvenAfterStoreRecreation() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let draft = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account"))
        try await store.remove(draft.id)
        await assertSaveFails(draft, store: store, expected: .staleDraft)
        let reopenedStore = DraftStore(directory: directory)
        await assertSaveFails(draft, store: reopenedStore, expected: .staleDraft)
        let reopened = await reopenedStore.all(ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertTrue(reopened.isEmpty)
    }

    func testLegacyRowsReceiveDurableRevisionsBeforeTheyCanBeOpened() async throws {
        let directory = temporaryDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var legacy = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account")
        legacy.serverID = "server-draft"; legacy.serverRevision = 2
        legacy.content.body.text = "Legacy writing"
        legacy.recipientText = .init(to: "maya@example.com", cc: "unfinished", bcc: "")
        let file = directory.appending(path: "drafts.json")
        let original = try JSONEncoder().encode([legacy])
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: original) as? [[String: Any]])
        XCTAssertNil(json.first?["storageRevision"], "This fixture must predate storage revisions")
        try original.write(to: file)
        let store = DraftStore(directory: directory)
        let rows = await store.all(ownerScope: legacy.ownerScope, accountId: legacy.accountId)
        let migrated = try XCTUnwrap(rows.first)
        XCTAssertNotNil(migrated.storageRevision)
        var expected = legacy; expected.storageRevision = migrated.storageRevision
        XCTAssertEqual(migrated, expected, "Migration changes only storage metadata")
        let onDisk = try JSONDecoder().decode([LocalDraft].self, from: Data(contentsOf: file))
        let reopened = await DraftStore(directory: directory).all(ownerScope: legacy.ownerScope, accountId: legacy.accountId)
        XCTAssertEqual(onDisk, [migrated]); XCTAssertEqual(reopened, [migrated])
        await assertSaveFails(legacy, store: store, expected: .staleDraft)
        var changed = migrated; changed.content.body.text = "After migration"
        let saved = try await store.save(changed)
        XCTAssertNotEqual(saved.storageRevision, migrated.storageRevision)
    }

    func testFailedLegacyMigrationPreservesFileAndDoesNotExposeUnversionedRows() async throws {
        let directory = temporaryDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            try? FileManager.default.removeItem(at: directory)
        }
        let legacy = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account")
        let file = directory.appending(path: "drafts.json")
        let original = try JSONEncoder().encode([legacy]); try original.write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
        let blocked = DraftStore(directory: directory)
        let rows = await blocked.all(ownerScope: legacy.ownerScope, accountId: legacy.accountId)
        let recoveryMessage = await blocked.recoveryMessage()
        XCTAssertTrue(rows.isEmpty); XCTAssertNotNil(recoveryMessage)
        await assertSaveFails(legacy, store: blocked, expected: .recoveryRequired)
        XCTAssertEqual(try Data(contentsOf: file), original)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let recovered = await DraftStore(directory: directory).all(ownerScope: legacy.ownerScope, accountId: legacy.accountId)
        XCTAssertNotNil(recovered.first?.storageRevision)
    }

    func testEveryDeliveryTransitionReturnsAFreshDurableRevision() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        var draft = try await store.save(LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account"))
        var revisions = Set([try XCTUnwrap(draft.storageRevision)])
        for transition in [DraftDeliveryTransition.prepare, .uncertain, .rejected, .confirmedPreReservation(serverRevision: nil)] {
            let previous = draft
            let changed = try await store.transition(draft.id, transition)
            draft = try XCTUnwrap(changed)
            XCTAssertTrue(revisions.insert(try XCTUnwrap(draft.storageRevision)).inserted)
            await assertSaveFails(previous, store: store, expected: .staleDraft)
            let reopened = await DraftStore(directory: directory).all(ownerScope: draft.ownerScope, accountId: draft.accountId)
            XCTAssertEqual(reopened, [draft])
        }
    }

    func testExplicitEditableCopiesPreserveWritingAndRetireOldIdentity() async throws {
        for rejected in [false, true] {
            let directory = temporaryDirectory()
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = DraftStore(directory: directory)
            var initial = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account")
            initial.serverID = "server-draft"; initial.serverRevision = 2
            initial.content = .init(to: [.init(name: "Maya", email: "maya@example.com")], subject: "Keep my words", body: .init(text: "Rich writing", html: "<p>Rich writing</p>"), context: .init(kind: "reply", threadId: "thread", messageId: "message", providerMessageId: "provider-message", providerThreadId: "provider-thread", inReplyTo: "<original@example.com>", references: ["<original@example.com>"]), attachments: [.init(id: "attachment", filename: "note.txt", mimeType: "text/plain", size: 1, contentBase64: "eA==")])
            initial.recipientText = .init(to: "maya@example.com", cc: "unfinished", bcc: "")
            var original = try await store.save(initial)
            if rejected {
                _ = try await store.prepareSend(original.id)
                let terminal = try await store.markRejected(original.id)
                original = try XCTUnwrap(terminal)
                XCTAssertNotNil(original.idempotencyKey)
            }
            let copied = try await store.makeEditableCopy(original, verifiedRemote: remoteDraft(for: original, status: rejected ? "rejected" : "draft"))
            XCTAssertNotEqual(copied.id, original.id)
            XCTAssertNotNil(copied.storageRevision); XCTAssertNotEqual(copied.storageRevision, original.storageRevision)
            XCTAssertEqual(copied.ownerScope, original.ownerScope); XCTAssertEqual(copied.accountId, original.accountId)
            XCTAssertEqual(copied.content, original.content); XCTAssertEqual(copied.recipientText, original.recipientText)
            XCTAssertNil(copied.serverID); XCTAssertNil(copied.serverRevision); XCTAssertNil(copied.idempotencyKey)
            XCTAssertEqual(copied.deliveryState, "local")
            let reopened = await DraftStore(directory: directory).all(ownerScope: original.ownerScope, accountId: original.accountId)
            XCTAssertEqual(reopened, [copied])
            await assertSaveFails(original, store: store, expected: .staleDraft)
            var editedCopy = copied; editedCopy.content.body.text = "Continued writing"
            let updatedCopy = try await store.save(editedCopy)
            XCTAssertEqual(updatedCopy.id, copied.id); XCTAssertEqual(updatedCopy.content.body.text, "Continued writing")
        }
    }

    func testEditableCopyRejectsUnverifiedStatusesIdentityAndStaleSnapshots() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        var initial = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account")
        initial.serverID = "server-draft"; initial.serverRevision = 2
        let current = try await store.save(initial)
        var invalidRemotes = ["sending", "ambiguous", "sent", "rejected"].map { remoteDraft(for: current, status: $0) }
        var wrongID = remoteDraft(for: current); wrongID.id = "other-server-draft"; invalidRemotes.append(wrongID)
        var wrongAccount = remoteDraft(for: current); wrongAccount.accountId = "other-account"; invalidRemotes.append(wrongAccount)
        var staleRemote = remoteDraft(for: current); staleRemote.revision = 1; invalidRemotes.append(staleRemote)
        for remote in invalidRemotes {
            do { _ = try await store.makeEditableCopy(current, verifiedRemote: remote); XCTFail("Unsafe copy must fail") }
            catch { XCTAssertEqual(error as? DraftStore.StoreError, .copyNotAllowed) }
        }
        var edit = current; edit.content.subject = "A genuinely newer edit"
        let latest = try await store.save(edit)
        do { _ = try await store.makeEditableCopy(current, verifiedRemote: remoteDraft(for: current)); XCTFail("Stale copy must fail") }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, .staleDraft) }
        let sending = try await store.prepareSend(latest.id)
        do { _ = try await store.makeEditableCopy(sending, verifiedRemote: remoteDraft(for: sending)); XCTFail("An active delivery command must not be detached") }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, .copyNotAllowed) }
        let reopened = await DraftStore(directory: directory).all(ownerScope: sending.ownerScope, accountId: sending.accountId)
        XCTAssertEqual(reopened, [sending])
    }

    func testDiskFailuresNeverCommitSaveTransitionCopyOrRemovalInMemory() async throws {
        let directory = temporaryDirectory(), backup = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory); try? FileManager.default.removeItem(at: backup) }
        let store = DraftStore(directory: directory)
        var initial = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account")
        initial.serverID = "server-draft"; initial.serverRevision = 2
        initial.content.body.text = "Durable original"
        let current = try await store.save(initial)
        let original = try Data(contentsOf: directory.appending(path: "drafts.json"))
        // Replacing the parent directory with a file causes a real, deterministic
        // filesystem failure without relying on permission bits or disk space.
        try FileManager.default.moveItem(at: directory, to: backup)
        try Data("blocked-directory".utf8).write(to: directory)
        var edited = current; edited.content.body.text = "Uncommitted edit"
        do { _ = try await store.save(edited); XCTFail("Expected disk failure") } catch {}
        do { _ = try await store.prepareSend(current.id); XCTFail("Expected disk failure") } catch {}
        do { _ = try await store.makeEditableCopy(current, verifiedRemote: remoteDraft(for: current)); XCTFail("Expected disk failure") } catch {}
        do { try await store.remove(current.id); XCTFail("Expected disk failure") } catch {}
        let inMemory = await store.all(ownerScope: current.ownerScope, accountId: current.accountId)
        XCTAssertEqual(inMemory, [current], "Failed writes must not advance revisions or retire identity")
        XCTAssertEqual(try Data(contentsOf: backup.appending(path: "drafts.json")), original)
        try FileManager.default.removeItem(at: directory)
        try FileManager.default.moveItem(at: backup, to: directory)
        let retried = try await store.save(edited)
        XCTAssertEqual(retried.content.body.text, "Uncommitted edit")
        XCTAssertNotEqual(retried.storageRevision, current.storageRevision)
        let reopened = await DraftStore(directory: directory).all(ownerScope: current.ownerScope, accountId: current.accountId)
        XCTAssertEqual(reopened, [retried])
    }

    private func temporaryDirectory() -> URL { FileManager.default.temporaryDirectory.appending(path: UUID().uuidString) }
    private func remoteDraft(for draft: LocalDraft, status: String = "draft") -> MessageDraft {
        MessageDraft(id: draft.serverID ?? "missing-server-draft", accountId: draft.accountId, to: draft.content.to, cc: draft.content.cc, bcc: draft.content.bcc, subject: draft.content.subject, body: draft.content.body, context: draft.content.context, attachments: draft.content.attachments, revision: draft.serverRevision ?? 1, deliveryStatus: status, providerSyncStatus: "synced", providerSyncError: nil, providerDraftId: nil, providerMessageId: nil, providerThreadId: nil, createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z")
    }
    private func assertSaveFails(_ draft: LocalDraft, store: DraftStore, expected: DraftStore.StoreError, file: StaticString = #filePath, line: UInt = #line) async {
        do { _ = try await store.save(draft); XCTFail("Expected rejected snapshot", file: file, line: line) }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, expected, file: file, line: line) }
    }
    private func assertReservationFails(_ draft: LocalDraft, store: DraftStore, expected: DraftStore.StoreError, file: StaticString = #filePath, line: UInt = #line) async {
        await assertMutationFails(expected, file: file, line: line) { _ = try await store.reserve(draft) }
    }
    private func assertMutationFails(_ expected: DraftStore.StoreError, file: StaticString = #filePath, line: UInt = #line, operation: () async throws -> Void) async {
        do { try await operation(); XCTFail("Expected rejected operation", file: file, line: line) }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, expected, file: file, line: line) }
    }
}

final class DraftStoreSentReconciliationTests: XCTestCase {
    func testVerifiedSentRemovesUnchangedShadowAfterRestartAndNormalizesRecipientNames() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = DraftStore(directory: directory)
        var initial = localDraft()
        initial.content.to = [.init(name: "Local name", email: "  MAYA@EXAMPLE.COM  ")]
        initial.content.cc = [.init(name: "Local cc", email: " CC@example.com ")]
        initial.content.bcc = [.init(name: "Local bcc", email: "BCC@example.com")]
        initial.recipientText = .init(to: "maya@example.com", cc: " cc@EXAMPLE.COM ", bcc: "bcc@example.com")
        let draft = try await first.save(initial)
        var remote = remoteDraft(for: draft)
        remote.to = [.init(name: "Server name", email: "maya@example.com")]
        remote.cc = [.init(name: nil, email: "cc@example.com")]
        remote.bcc = [.init(name: "Server bcc", email: "bcc@example.com")]
        remote.revision += 1
        let restarted = DraftStore(directory: directory)
        let rows = try await restarted.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertTrue(rows.isEmpty, "A fresh server detail must retire the durable sent shadow")
        let persisted = await DraftStore(directory: directory).all(ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertTrue(persisted.isEmpty)
        do { _ = try await restarted.save(draft); XCTFail("A stale composer cannot restore a sent shadow") }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, .staleDraft) }
    }

    func testSentReconciliationPreservesEveryWritingDifferenceAndRawUnfinishedRecipient() async throws {
        let changes: [(String, (inout LocalDraft) -> Void)] = [
            ("subject", { $0.content.subject = "Unsent subject" }),
            ("plain text", { $0.content.body.text = "Unsent words" }),
            ("rich text", { $0.content.body.html = "<p><strong>Unsent formatting</strong></p>" }),
            ("context", { $0.content.context?.references.append("<new@example.com>") }),
            ("attachment bytes", { $0.content.attachments[0].contentBase64 = "eQ==" }),
            ("attachment metadata", { $0.content.attachments[0].filename = "renamed.txt" }),
            ("removed attachment", { $0.content.attachments = [] }),
            ("recipient", { $0.content.to[0].email = "different@example.com" }),
            ("raw to", { $0.recipientText?.to += ", unfinished" }),
            ("raw cc", { $0.recipientText?.cc = "unfinished" }),
            ("raw bcc", { $0.recipientText?.bcc = "unfinished" }),
            ("trailing separator", { $0.recipientText?.to += "," }),
            ("empty tokens", { $0.recipientText?.cc = ",," })
        ]
        for (label, change) in changes {
            let directory = temporaryDirectory()
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = DraftStore(directory: directory)
            var initial = localDraft()
            let remote = remoteDraft(for: initial)
            change(&initial)
            initial.idempotencyKey = "original-command"; initial.deliveryState = "ambiguous"
            let draft = try await store.save(initial)
            let rows = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId)
            let preserved = try XCTUnwrap(rows.first, label)
            var expected = draft; expected.deliveryState = "sent"; expected.storageRevision = preserved.storageRevision
            XCTAssertEqual(preserved, expected, "Must preserve \(label), writing, identity, and delivery command")
            XCTAssertNotEqual(preserved.storageRevision, draft.storageRevision, label)
            let reopened = await DraftStore(directory: directory).all(ownerScope: draft.ownerScope, accountId: draft.accountId)
            XCTAssertEqual(reopened, [preserved], label)
            let bytes = try Data(contentsOf: directory.appending(path: "drafts.json"))
            let repeated = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId)
            XCTAssertEqual(repeated, [preserved], label)
            XCTAssertEqual(try Data(contentsOf: directory.appending(path: "drafts.json")), bytes, "Repeated refresh must not churn revisions")
        }
    }

    func testSentReconciliationIgnoresWrongStatusAccountScopeIdentityAndOldRevision() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let draft = try await store.save(localDraft())
        let file = directory.appending(path: "drafts.json"), bytes = try Data(contentsOf: file)
        var invalid = ["draft", "sending", "ambiguous", "rejected"].map { status -> MessageDraft in
            var remote = remoteDraft(for: draft); remote.deliveryStatus = status; return remote
        }
        var wrongAccount = remoteDraft(for: draft); wrongAccount.accountId = "other-account"; invalid.append(wrongAccount)
        var wrongID = remoteDraft(for: draft); wrongID.id = "other-server-draft"; invalid.append(wrongID)
        var oldRevision = remoteDraft(for: draft); oldRevision.revision -= 1; invalid.append(oldRevision)
        for remote in invalid {
            let rows = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId)
            XCTAssertEqual(rows, [draft])
        }
        _ = try await store.reconcileSent(remoteDraft(for: draft), ownerScope: "other-owner", accountId: draft.accountId)
        _ = try await store.reconcileSent(remoteDraft(for: draft), ownerScope: draft.ownerScope, accountId: "other-account")
        let current = await store.all(ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(current, [draft]); XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testSentReconciliationIgnoresLocalRowsWithoutVerifiedServerRevision() async throws {
        for divergent in [false, true] {
            let directory = temporaryDirectory()
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = DraftStore(directory: directory)
            var initial = localDraft()
            let remote = remoteDraft(for: initial)
            initial.serverRevision = nil
            if divergent { initial.content.body.text = "Unsent writing" }
            let draft = try await store.save(initial)
            let file = directory.appending(path: "drafts.json"), bytes = try Data(contentsOf: file)
            let rows = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId)
            XCTAssertEqual(rows, [draft], "Unknown local revision must remain untouched")
            XCTAssertEqual(try Data(contentsOf: file), bytes)
        }
    }

    func testSentReconciliationRemembersNewestVerifiedRevisionBeforeIgnoringOlderMatchingResponse() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        var initial = localDraft()
        var newest = remoteDraft(for: initial); newest.revision = 4
        initial.content.body.text = "Local edits after the last save"
        initial.idempotencyKey = "original-command"
        let draft = try await store.save(initial)
        let first = try await store.reconcileSent(newest, ownerScope: draft.ownerScope, accountId: draft.accountId)
        let preserved = try XCTUnwrap(first.first)
        XCTAssertEqual(preserved.serverRevision, 4)
        XCTAssertEqual(preserved.content, draft.content); XCTAssertEqual(preserved.idempotencyKey, draft.idempotencyKey)
        XCTAssertEqual(preserved.modifiedAt, draft.modifiedAt)
        newest.revision = 5
        let second = try await store.reconcileSent(newest, ownerScope: draft.ownerScope, accountId: draft.accountId)
        let advanced = try XCTUnwrap(second.first)
        XCTAssertEqual(advanced.serverRevision, 5); XCTAssertNotEqual(advanced.storageRevision, preserved.storageRevision)
        XCTAssertEqual(advanced.content, draft.content); XCTAssertEqual(advanced.modifiedAt, draft.modifiedAt)
        var staleMatching = remoteDraft(for: advanced); staleMatching.revision = 4
        let restarted = DraftStore(directory: directory)
        let afterStale = try await restarted.reconcileSent(staleMatching, ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(afterStale, [advanced], "Older sent writing must never retire the preserved current revision")
    }

    func testSentReconciliationOnlyChangesMatchingRowsAndReturnsCurrentScopedList() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let draft = try await store.save(localDraft())
        var otherOwner = localDraft(); otherOwner.ownerScope = "other-owner"
        otherOwner = try await store.save(otherOwner)
        var otherAccount = localDraft(); otherAccount.accountId = "other-account"
        otherAccount = try await store.save(otherAccount)
        var otherServer = localDraft(); otherServer.serverID = "other-server-draft"
        otherServer = try await store.save(otherServer)
        let rows = try await store.reconcileSent(remoteDraft(for: draft), ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(rows, [otherServer])
        let ownerRows = await store.all(ownerScope: otherOwner.ownerScope, accountId: otherOwner.accountId)
        let accountRows = await store.all(ownerScope: otherAccount.ownerScope, accountId: otherAccount.accountId)
        XCTAssertEqual(ownerRows, [otherOwner]); XCTAssertEqual(accountRows, [otherAccount])
    }

    func testSentReconciliationUsesLatestActorWritingRatherThanPreFetchSnapshotOrTimestamps() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let preFetch = try await store.save(localDraft())
        let fetchedRemote = remoteDraft(for: preFetch)
        var edit = preFetch
        edit.content.body.text = "Typed while remote detail was loading"
        edit.modifiedAt = .distantPast
        let latest = try await store.save(edit)
        let rows = try await store.reconcileSent(fetchedRemote, ownerScope: preFetch.ownerScope, accountId: preFetch.accountId)
        let preserved = try XCTUnwrap(rows.first)
        XCTAssertEqual(preserved.content, latest.content)
        XCTAssertEqual(preserved.modifiedAt, latest.modifiedAt)
        XCTAssertEqual(preserved.id, latest.id); XCTAssertEqual(preserved.deliveryState, "sent")
        XCTAssertNotEqual(preserved.storageRevision, latest.storageRevision)
    }

    func testSentReconciliationSkipsActiveReservationUntilRelease() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let draft = try await store.save(localDraft())
        let reservation = try await store.reserve(draft)
        let bytes = try Data(contentsOf: directory.appending(path: "drafts.json"))
        let skipped = try await store.reconcileSent(remoteDraft(for: draft), ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(skipped, [draft])
        XCTAssertEqual(try Data(contentsOf: directory.appending(path: "drafts.json")), bytes)
        await store.release(reservation)
        let removed = try await store.reconcileSent(remoteDraft(for: draft), ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertTrue(removed.isEmpty)
    }

    func testOwnedSentReconciliationPreservesDivergentWritingWhileSkippingOtherLeasesAndEditors() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        var initial = localDraft()
        let remote = remoteDraft(for: initial)
        initial.content.body.text = "Unsent edits checkpointed before recovery"
        initial.recipientText?.cc = "unfinished"
        initial.idempotencyKey = "original-command"; initial.deliveryState = "ambiguous"
        let draft = try await store.save(initial)
        let reservedOther = try await store.save(localDraft())
        let openOther = try await store.save(localDraft())
        let ownerID = UUID(), observerID = UUID(), otherID = UUID()
        _ = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: ownerID)
        _ = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: observerID)
        _ = await store.beginEditing(openOther.id, ownerScope: openOther.ownerScope, accountId: openOther.accountId, editorID: otherID)
        let owner = try await store.reserve(draft)
        let otherOwner = try await store.reserve(reservedOther)
        let withoutEditor = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId, reservation: owner)
        XCTAssertEqual(withoutEditor.first { $0.id == draft.id }, draft, "A lease alone must not bypass live editors")
        let observerProtected = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId, reservation: owner, editorID: ownerID)
        XCTAssertEqual(observerProtected.first { $0.id == draft.id }, draft, "Another same-row editor may still hold unsaved visible writing")
        await store.endEditing(observerID)
        let rows = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId, reservation: owner, editorID: ownerID)
        let preserved = try XCTUnwrap(rows.first { $0.id == draft.id })
        XCTAssertEqual(preserved.deliveryState, "sent")
        XCTAssertNotEqual(preserved.storageRevision, draft.storageRevision)
        XCTAssertEqual(preserved.content, draft.content); XCTAssertEqual(preserved.recipientText, draft.recipientText)
        XCTAssertEqual(preserved.serverID, draft.serverID); XCTAssertEqual(preserved.idempotencyKey, draft.idempotencyKey)
        XCTAssertEqual(rows.first { $0.id == reservedOther.id }, reservedOther)
        XCTAssertEqual(rows.first { $0.id == openOther.id }, openOther)
        let persisted = await DraftStore(directory: directory).all(ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(persisted, rows)
        await store.release(owner); await store.release(otherOwner)
        await store.endEditing(ownerID); await store.endEditing(observerID); await store.endEditing(otherID)
    }

    func testOwnedSentReconciliationRemovesExactShadowAndRejectsObserverResurrection() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let draft = try await store.save(localDraft())
        let ownerID = UUID(), observerID = UUID()
        _ = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: ownerID)
        let opened = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: observerID)
        let observer = try XCTUnwrap(opened)
        let reservation = try await store.reserve(draft)
        let protected = try await store.reconcileSent(remoteDraft(for: draft), ownerScope: draft.ownerScope, accountId: draft.accountId, reservation: reservation, editorID: ownerID)
        XCTAssertEqual(protected, [draft], "The observer must finish checkpointing and close before exact-shadow removal")
        await store.endEditing(observerID)
        let rows = try await store.reconcileSent(remoteDraft(for: draft), ownerScope: draft.ownerScope, accountId: draft.accountId, reservation: reservation, editorID: ownerID)
        XCTAssertTrue(rows.isEmpty)
        await store.release(reservation)
        do { _ = try await store.save(observer); XCTFail("An observer must not resurrect the retired sent identity") }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, .staleDraft) }
        let persisted = await DraftStore(directory: directory).all(ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertTrue(persisted.isEmpty)
        var replacement = localDraft(); replacement.id = draft.id
        replacement = try await store.save(replacement)
        let removed = try await store.reconcileSent(remoteDraft(for: replacement), ownerScope: replacement.ownerScope, accountId: replacement.accountId)
        XCTAssertTrue(removed.isEmpty, "Successful removal must retire the owner and observer registrations")
    }

    func testOwnedSentReconciliationRejectsWrongExpiredCrossDraftAndCrossScopeReservations() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let draft = try await store.save(localDraft())
        var other = localDraft(); other.serverID = "other-server-draft"
        other = try await store.save(other)
        let owner = try await store.reserve(draft)
        let otherOwner = try await store.reserve(other)
        let remote = remoteDraft(for: draft)
        let file = directory.appending(path: "drafts.json"), bytes = try Data(contentsOf: file)
        for token in [DraftStore.Reservation(id: UUID(), draftID: draft.id), otherOwner] {
            do { _ = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId, reservation: token); XCTFail("Wrong owner must not bypass reconciliation protection") }
            catch { XCTAssertEqual(error as? DraftStore.StoreError, .invalidReservation) }
        }
        do { _ = try await store.reconcileSent(remote, ownerScope: "other-owner", accountId: draft.accountId, reservation: owner); XCTFail("Cross-scope lease must fail") }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, .invalidReservation) }
        do { _ = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: "other-account", reservation: owner); XCTFail("Cross-account lease must fail") }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, .invalidReservation) }
        do { _ = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId, reservation: owner, editorID: UUID()); XCTFail("Unregistered editor must not bypass protection") }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, .invalidReservation) }
        let editorID = UUID()
        _ = await store.beginEditing(other.id, ownerScope: other.ownerScope, accountId: other.accountId, editorID: editorID)
        do { _ = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId, reservation: owner, editorID: editorID); XCTFail("Another row's editor token must fail") }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, .invalidReservation) }
        do { _ = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: editorID); XCTFail("An editor token without a lease cannot bypass protection") }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, .invalidReservation) }
        await store.release(owner)
        do { _ = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId, reservation: owner); XCTFail("Expired lease must not become background reconciliation") }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, .invalidReservation) }
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        let current = await store.current(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(current, draft)
        await store.release(otherOwner)
    }

    func testOpenEditorsProtectUnsavedWritingUntilEveryEditorEnds() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let draft = try await store.save(localDraft())
        let firstID = UUID(), secondID = UUID()
        let first = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: firstID)
        let second = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: secondID)
        XCTAssertEqual(first, draft); XCTAssertEqual(second, draft)
        let remote = remoteDraft(for: draft)
        let skipped = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(skipped, [draft])
        await store.endEditing(firstID)
        await store.endEditing(UUID())
        let stillOpen = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(stillOpen, [draft])
        var pendingTyping = try XCTUnwrap(second); pendingTyping.content.body.text = "Visible unsaved writing"
        let saved = try await store.save(pendingTyping)
        await store.endEditing(secondID)
        let reconciled = try await store.reconcileSent(remote, ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertEqual(reconciled.first?.content, saved.content)
        XCTAssertEqual(reconciled.first?.deliveryState, "sent")
    }

    func testBeginEditingReturnsLatestRowAndRejectsWrongScopeOrRemovedIdentity() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let stale = try await store.save(localDraft())
        var edit = stale; edit.content.body.text = "Latest saved writing"
        let latest = try await store.save(edit)
        let wrongOwner = await store.beginEditing(latest.id, ownerScope: "other-owner", accountId: latest.accountId, editorID: UUID())
        let wrongAccount = await store.beginEditing(latest.id, ownerScope: latest.ownerScope, accountId: "other-account", editorID: UUID())
        let missing = await store.beginEditing(UUID(), ownerScope: latest.ownerScope, accountId: latest.accountId, editorID: UUID())
        XCTAssertNil(wrongOwner); XCTAssertNil(wrongAccount); XCTAssertNil(missing)
        let editorID = UUID()
        let opened = await store.beginEditing(stale.id, ownerScope: stale.ownerScope, accountId: stale.accountId, editorID: editorID)
        XCTAssertEqual(opened, latest)
        await store.endEditing(editorID)
        let removed = try await store.reconcileSent(remoteDraft(for: latest), ownerScope: latest.ownerScope, accountId: latest.accountId)
        XCTAssertTrue(removed.isEmpty, "Failed registrations must not pin the row")
        let retired = await store.beginEditing(stale.id, ownerScope: stale.ownerScope, accountId: stale.accountId, editorID: editorID)
        XCTAssertNil(retired)
    }

    func testEditorRegistrationsAreEphemeralAcrossStoreRestart() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let draft = try await store.save(localDraft())
        let file = directory.appending(path: "drafts.json"), bytes = try Data(contentsOf: file)
        _ = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: UUID())
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        let restored = DraftStore(directory: directory)
        let removed = try await restored.reconcileSent(remoteDraft(for: draft), ownerScope: draft.ownerScope, accountId: draft.accountId)
        XCTAssertTrue(removed.isEmpty, "An editor from a terminated process must not pin sent mail")
    }

    func testEditableCopyTransfersAllEditorRegistrationsToFreshIdentity() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let original = try await store.save(localDraft())
        let firstID = UUID(), secondID = UUID()
        _ = await store.beginEditing(original.id, ownerScope: original.ownerScope, accountId: original.accountId, editorID: firstID)
        _ = await store.beginEditing(original.id, ownerScope: original.ownerScope, accountId: original.accountId, editorID: secondID)
        var verified = remoteDraft(for: original); verified.deliveryStatus = "draft"
        var copy = try await store.makeEditableCopy(original, verifiedRemote: verified)
        copy.serverID = "new-server-draft"; copy.serverRevision = 1
        copy = try await store.save(copy)
        let remote = remoteDraft(for: copy)
        let skipped = try await store.reconcileSent(remote, ownerScope: copy.ownerScope, accountId: copy.accountId)
        XCTAssertEqual(skipped, [copy])
        await store.endEditing(firstID)
        let stillOpen = try await store.reconcileSent(remote, ownerScope: copy.ownerScope, accountId: copy.accountId)
        XCTAssertEqual(stillOpen, [copy])
        await store.endEditing(secondID)
        let removed = try await store.reconcileSent(remote, ownerScope: copy.ownerScope, accountId: copy.accountId)
        XCTAssertTrue(removed.isEmpty)
    }

    func testRemovalRetiresOnlyMatchingEditorRegistrations() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        let first = try await store.save(localDraft())
        var other = localDraft(); other.serverID = "other-server-draft"
        other = try await store.save(other)
        let otherID = UUID()
        _ = await store.beginEditing(first.id, ownerScope: first.ownerScope, accountId: first.accountId, editorID: UUID())
        _ = await store.beginEditing(other.id, ownerScope: other.ownerScope, accountId: other.accountId, editorID: otherID)
        try await store.remove(first.id)
        // Reuse the ID in a genuinely new, unversioned row to observe whether
        // the old registration was retired. Saved stale snapshots still fail.
        var replacement = localDraft(); replacement.id = first.id
        replacement = try await store.save(replacement)
        _ = try await store.reconcileSent(remoteDraft(for: replacement), ownerScope: replacement.ownerScope, accountId: replacement.accountId)
        let otherSkipped = try await store.reconcileSent(remoteDraft(for: other), ownerScope: other.ownerScope, accountId: other.accountId)
        XCTAssertEqual(otherSkipped, [other], "Removing one row must not release another editor")
        await store.endEditing(otherID)
        let removed = try await store.reconcileSent(remoteDraft(for: other), ownerScope: other.ownerScope, accountId: other.accountId)
        XCTAssertTrue(removed.isEmpty)
    }

    func testPreservedSentWritingIsFrozenUntilVerifiedExplicitCopy() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory)
        var initial = localDraft()
        let sentRemote = remoteDraft(for: initial)
        initial.content.body.text = "My unsent edits"; initial.idempotencyKey = "same-command"; initial.deliveryState = "ambiguous"
        let original = try await store.save(initial)
        let rows = try await store.reconcileSent(sentRemote, ownerScope: original.ownerScope, accountId: original.accountId)
        let preserved = try XCTUnwrap(rows.first)
        let identical = try await store.save(preserved)
        XCTAssertEqual(identical, preserved)
        var edit = preserved; edit.content.subject = "Must copy before editing"
        do { _ = try await store.save(edit); XCTFail("Sent writing must remain frozen") }
        catch { XCTAssertEqual(error as? DraftStore.StoreError, .identityChanged) }
        for transition in [DraftDeliveryTransition.prepare, .uncertain, .rejected, .confirmedPreReservation(serverRevision: nil)] {
            do { _ = try await store.transition(preserved.id, transition); XCTFail("Sent identity must never restart delivery") }
            catch { XCTAssertEqual(error as? DraftStore.StoreError, .identityChanged) }
        }
        var invalid = ["draft", "sending", "ambiguous", "rejected"].map { status -> MessageDraft in
            var remote = sentRemote; remote.deliveryStatus = status; return remote
        }
        var wrongID = sentRemote; wrongID.id = "other-server-draft"; invalid.append(wrongID)
        var wrongAccount = sentRemote; wrongAccount.accountId = "other-account"; invalid.append(wrongAccount)
        var oldRevision = sentRemote; oldRevision.revision -= 1; invalid.append(oldRevision)
        for remote in invalid {
            do { _ = try await store.makeEditableCopy(preserved, verifiedRemote: remote); XCTFail("Copy needs matching freshly verified sent status") }
            catch { XCTAssertEqual(error as? DraftStore.StoreError, .copyNotAllowed) }
        }
        let copied = try await store.makeEditableCopy(preserved, verifiedRemote: sentRemote)
        XCTAssertNotEqual(copied.id, preserved.id); XCTAssertNotEqual(copied.storageRevision, preserved.storageRevision)
        XCTAssertEqual(copied.content, preserved.content); XCTAssertEqual(copied.recipientText, preserved.recipientText)
        XCTAssertEqual(copied.deliveryState, "local")
        XCTAssertNil(copied.serverID); XCTAssertNil(copied.serverRevision); XCTAssertNil(copied.idempotencyKey)
        let persisted = await DraftStore(directory: directory).all(ownerScope: original.ownerScope, accountId: original.accountId)
        XCTAssertEqual(persisted, [copied])
    }

    func testSentReconciliationDiskFailureDoesNotRemoveOrFreezeInMemory() async throws {
        for divergent in [false, true] {
            let directory = temporaryDirectory(), backup = temporaryDirectory()
            defer { try? FileManager.default.removeItem(at: directory); try? FileManager.default.removeItem(at: backup) }
            let store = DraftStore(directory: directory)
            var initial = localDraft()
            let remote = remoteDraft(for: initial)
            if divergent { initial.content.body.text = "Unsent writing" }
            let current = try await store.save(initial)
            let bytes = try Data(contentsOf: directory.appending(path: "drafts.json"))
            try FileManager.default.moveItem(at: directory, to: backup)
            try Data("blocked-directory".utf8).write(to: directory)
            do { _ = try await store.reconcileSent(remote, ownerScope: current.ownerScope, accountId: current.accountId); XCTFail("Expected disk failure") } catch {}
            let unchanged = await store.all(ownerScope: current.ownerScope, accountId: current.accountId)
            XCTAssertEqual(unchanged, [current]); XCTAssertEqual(try Data(contentsOf: backup.appending(path: "drafts.json")), bytes)
            try FileManager.default.removeItem(at: directory)
            try FileManager.default.moveItem(at: backup, to: directory)
            let retried = try await store.reconcileSent(remote, ownerScope: current.ownerScope, accountId: current.accountId)
            if divergent { XCTAssertEqual(retried.first?.deliveryState, "sent"); XCTAssertEqual(retried.first?.content, current.content) }
            else { XCTAssertTrue(retried.isEmpty) }
        }
    }

    func testFailedCopyOrRemovalKeepsOriginalEditorRegistration() async throws {
        let directory = temporaryDirectory(), backup = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory); try? FileManager.default.removeItem(at: backup) }
        let store = DraftStore(directory: directory)
        let original = try await store.save(localDraft())
        let editorID = UUID()
        _ = await store.beginEditing(original.id, ownerScope: original.ownerScope, accountId: original.accountId, editorID: editorID)
        try FileManager.default.moveItem(at: directory, to: backup)
        try Data("blocked-directory".utf8).write(to: directory)
        var editableRemote = remoteDraft(for: original); editableRemote.deliveryStatus = "draft"
        do { _ = try await store.makeEditableCopy(original, verifiedRemote: editableRemote); XCTFail("Expected disk failure") } catch {}
        do { try await store.remove(original.id); XCTFail("Expected disk failure") } catch {}
        try FileManager.default.removeItem(at: directory)
        try FileManager.default.moveItem(at: backup, to: directory)
        let skipped = try await store.reconcileSent(remoteDraft(for: original), ownerScope: original.ownerScope, accountId: original.accountId)
        XCTAssertEqual(skipped, [original])
        await store.endEditing(editorID)
        let removed = try await store.reconcileSent(remoteDraft(for: original), ownerScope: original.ownerScope, accountId: original.accountId)
        XCTAssertTrue(removed.isEmpty)
    }

    private func temporaryDirectory() -> URL { FileManager.default.temporaryDirectory.appending(path: UUID().uuidString) }
    private func localDraft() -> LocalDraft {
        var draft = LocalDraft(ownerScope: "fixture|owner", accountId: "fixture-account")
        draft.serverID = "server-draft"; draft.serverRevision = 2
        draft.content = .init(to: [.init(name: "Maya", email: "maya@example.com")], subject: "Sent subject", body: .init(text: "Sent words", html: "<p>Sent words</p>"), context: .init(kind: "reply", threadId: "thread", messageId: "message", providerMessageId: "provider-message", providerThreadId: "provider-thread", inReplyTo: "<original@example.com>", references: ["<original@example.com>"]), attachments: [.init(id: "attachment", filename: "note.txt", mimeType: "text/plain", size: 1, contentBase64: "eA==")])
        draft.recipientText = .init(to: "maya@example.com", cc: "", bcc: "")
        return draft
    }
    private func remoteDraft(for draft: LocalDraft) -> MessageDraft {
        MessageDraft(id: draft.serverID ?? "missing-server-draft", accountId: draft.accountId, to: draft.content.to, cc: draft.content.cc, bcc: draft.content.bcc, subject: draft.content.subject, body: draft.content.body, context: draft.content.context, attachments: draft.content.attachments, revision: draft.serverRevision ?? 1, deliveryStatus: "sent", providerSyncStatus: "synced", providerSyncError: nil, providerDraftId: nil, providerMessageId: "sent-message", providerThreadId: "sent-thread", createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z")
    }
}


final class InboxRecoveryTests: XCTestCase {
    @MainActor func testInvalidMailboxCursorRestartsOnceAndReplacesStalePage() async throws {
        for view in ["all", "destination:projects", "normal"] {
            let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
            let first = try InboxLoadingTestSupport.page("stale", cursor: "expired-cursor")
            let fresh = try InboxLoadingTestSupport.page("fresh", cursor: "fresh-cursor")
            var queries = [[String: String]]()
            StubURLProtocol.handler = { request in
                if request.url?.path == "/v1/destinations" { return (200, InboxLoadingTestSupport.catalog) }
                let query = InboxLoadingTestSupport.query(request); queries.append(query)
                if queries.count == 1 { return (200, first) }
                if query["cursor"] == "expired-cursor" {
                    return (400, Data(#"{"error":{"code":"invalid_cursor","message":"Mailbox changed"}}"#.utf8))
                }
                return (200, fresh)
            }
            let model = InboxViewModel(); model.view = view; model.search = "same search"
            await model.load(state: fixture.state)
            await model.load(state: fixture.state, reset: false)
            XCTAssertEqual(queries.map { $0["cursor"] }, [nil, "expired-cursor", nil], view)
            XCTAssertEqual(queries.map { $0["query"] }, Array(repeating: "same search", count: 3), view)
            XCTAssertEqual(model.messages.map(\.id), ["fresh"], "Recovery replaces rather than appends a new snapshot")
            XCTAssertEqual(model.nextCursor, "fresh-cursor"); XCTAssertNil(model.error); XCTAssertFalse(model.isLoading)
        }
    }

    @MainActor func testInvalidCursorRecoveryStopsIfFreshRequestAlsoFails() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        let first = try InboxLoadingTestSupport.page("saved", cursor: "expired-cursor")
        var requests = 0
        StubURLProtocol.handler = { _ in
            requests += 1
            if requests == 1 { return (200, first) }
            return (400, Data(#"{"error":{"code":"invalid_cursor","message":"Mailbox changed"}}"#.utf8))
        }
        let model = InboxViewModel(); model.view = "all"
        await model.load(state: fixture.state)
        await model.load(state: fixture.state, reset: false)
        XCTAssertEqual(requests, 3, "A failed restart must not recurse indefinitely")
        XCTAssertEqual(model.messages.map(\.id), ["saved"]); XCTAssertNil(model.nextCursor)
        XCTAssertNotNil(model.error); XCTAssertFalse(model.isLoading)
    }

    @MainActor func testUnrelatedPaginationFailuresKeepCursorForManualRetry() async throws {
        for (status, code) in [(400, "invalid_request"), (401, "unauthorized"), (503, "unavailable")] {
            let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
            let first = try InboxLoadingTestSupport.page("saved", cursor: "valid-cursor")
            var requests = 0
            StubURLProtocol.handler = { _ in
                requests += 1
                return requests == 1 ? (200, first) : (status, Data("{\"error\":{\"code\":\"\(code)\",\"message\":\"Try again\"}}".utf8))
            }
            let model = InboxViewModel(); model.view = "all"
            await model.load(state: fixture.state)
            await model.load(state: fixture.state, reset: false)
            XCTAssertEqual(requests, 2); XCTAssertEqual(model.nextCursor, "valid-cursor")
            XCTAssertEqual(model.messages.map(\.id), ["saved"]); XCTAssertEqual(model.error, "Try again")
        }
    }

    @MainActor func testPaginationWithoutCursorDoesNotDuplicateFirstPage() async throws {
        let fixture = InboxLoadingTestSupport.Fixture(); defer { fixture.cleanup() }
        let first = try InboxLoadingTestSupport.page("only-page")
        var requests = 0
        StubURLProtocol.handler = { _ in requests += 1; return (200, first) }
        let model = InboxViewModel(); model.view = "all"
        await model.load(state: fixture.state)
        await model.load(state: fixture.state, reset: false)
        XCTAssertEqual(requests, 1); XCTAssertEqual(model.messages.map(\.id), ["only-page"])
    }
}
