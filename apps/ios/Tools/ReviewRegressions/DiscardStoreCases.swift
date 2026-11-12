import Foundation

/// Deliberately unsafe integration control for a NEW discard feature. There is
/// no exposed Discard button at baseline: those failures were not existing UI
/// bugs. After c426 red, the candidate adapter below binds the SAME boundary
/// invariants to the dedicated discard role, not altered generic reserve/remove.
@MainActor func runDiscardStoreBoundaryCases(cacheRoot: URL, check: @MainActor (String, Bool, String) -> Void) async throws {
    func original(_ store: DraftStore) async throws -> LocalDraft {
        var draft = LocalDraft(ownerScope: "discard-owner", accountId: "discard-account")
        draft.recipientText = .init(to: "Unfinished <person@", cc: "Still typing,", bcc: "Private incomplete <")
        draft.content.subject = "Visible discard approval"
        draft.content.body = .init(text: "Visible latest writing", html: "<p><b>Visible latest writing</b></p>")
        draft.content.attachments = [.init(id: "owned-file", filename: "notes.txt", mimeType: "text/plain", size: 1, contentBase64: "eA==")]
        return try await store.save(draft)
    }
    do {
        let store = DraftStore(directory: cacheRoot.appending(path: "other-editor")), a = UUID(), b = UUID()
        let draft = try await original(store)
        _ = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: a)
        _ = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: b)
        var refused = false
        do { _ = try await store.reserveForDiscard(draft, editorID: a) } catch { refused = true }
        let retained = await store.current(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId)
        check("DISCARD-unsafe-integration-other-editor-must-survive", retained != nil && refused, "candidate adapter uses atomic discard-specific API; historical generic unsafe control remains c426 red")
    }
    do {
        let store = DraftStore(directory: cacheRoot.appending(path: "new-editor")), a = UUID(), b = UUID()
        let draft = try await original(store)
        _ = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: a)
        let reservation = try await store.reserveForDiscard(draft, editorID: a)
        let other = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: b)
        check("DISCARD-unsafe-integration-lease-blocks-new-editor", other == nil, "negative control: discard needs an atomic special lease that blocks new editor registration across awaits")
        await store.release(reservation.reservation)
    }
    do {
        let store = DraftStore(directory: cacheRoot.appending(path: "exact-snapshot")), a = UUID()
        let approved = try await original(store)
        _ = await store.beginEditing(approved.id, ownerScope: approved.ownerScope, accountId: approved.accountId, editorID: a)
        let reservation = try await store.reserveForDiscard(approved, editorID: a)
        var newer = approved; newer.content.body.text = "Newer than the approved writing"
        newer = try await store.save(newer, reservation: reservation.reservation)
        var refused = false
        do { try await store.removeForDiscard(approved, token: reservation) } catch { refused = true }
        let retained = await store.current(approved.id, ownerScope: approved.ownerScope, accountId: approved.accountId)
        check("DISCARD-unsafe-integration-ack-cannot-remove-newer-snapshot", refused && retained?.storageRevision == newer.storageRevision, "negative control: remove(id) has no exact approved-snapshot predicate; future discard must refuse a newer leased snapshot")
        await store.release(reservation.reservation)
    }
}

@MainActor private final class DiscardHarness {
    let directory: URL
    let store: DraftStore
    let controller = ComposeDiscardController()
    var context: ComposeDiscardContext?
    var deleteCalls = 0
    var onLease: ((DraftStore.Reservation) -> Void)?
    var lease: DraftStore.Reservation?
    init(directory: URL) { self.directory = directory; store = DraftStore(directory: directory) }
    static func make(_ directory: URL, linked: Bool = false, accountId: String = "discard-account", serverID: String = "original-server-id", deliveryState: String? = nil, keyed: Bool = false) async throws -> DiscardHarness {
        let h = DiscardHarness(directory: directory)
        var draft = LocalDraft(ownerScope: "discard-owner", accountId: accountId)
        if linked { draft.serverID = serverID; draft.serverRevision = 3; draft.deliveryState = "draft" }
        if let deliveryState { draft.deliveryState = deliveryState }
        if keyed { draft.idempotencyKey = "original-send-key" }
        draft.content.subject = "Approved writing"
        draft.content.body = .init(text: "Plain preserved", html: "<p><b>Rich preserved</b></p>")
        draft.content.attachments = [.init(id: "file", filename: "notes.txt", mimeType: "text/plain", size: 1, contentBase64: "eA==")]
        draft.recipientText = .init(to: "Unfinished <person@", cc: "Still typing,", bcc: "Private incomplete <")
        draft = try await h.store.save(draft)
        let editor = UUID()
        _ = await h.store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: editor)
        h.context = .init(draft: draft, content: draft.content, recipientText: draft.recipientText!, editorID: editor,
                          generation: UUID(), clientID: nil, origin: "https://example.invalid")
        return h
    }
    func run(_ approval: ComposeDiscardContext? = nil, predecessor: Task<Void, Never>? = nil,
             delete: (@MainActor (LocalDraft) async throws -> Void)? = nil) async -> ComposeDiscardController.Outcome {
        let approval = approval ?? context!
        return await controller.discard(approval, store: store, predecessor: predecessor, current: { self.context },
            checkpointed: { self.context?.draft = $0 }, leased: { token in
                self.lease = token; if let token { self.onLease?(token) }
            }, delete: { draft in self.deleteCalls += 1; try await delete?(draft) })
    }
    func retained(_ draft: LocalDraft) async -> LocalDraft? {
        await store.current(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId)
    }
    func breakDisk() throws {
        try FileManager.default.moveItem(at: directory, to: directory.appendingPathExtension("backup"))
        try Data("not a directory".utf8).write(to: directory)
    }
}

/// Production discard controller and role-specific actor methods on real local
/// files. Injected transport cases are explicitly not Apple UI or provider proof.
@MainActor func runDiscardControllerCases(cacheRoot: URL, check: @MainActor (String, Bool, String) -> Void) async throws {
    do {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "local"))
        let approval = h.context!
        let result = await h.run()
        let reopened = DraftStore(directory: h.directory)
        let remaining = await reopened.all(ownerScope: approval.draft.ownerScope, accountId: approval.draft.accountId)
        check("DISCARD-local-durable-exact-removal", result == .discarded && remaining.isEmpty && h.deleteCalls == 0, "local acknowledgement is real durable removal, no network or recipient validation")
        var staleRejected = false
        do { _ = try await h.store.save(approval.draft) } catch { staleRejected = true }
        check("DISCARD-retired-snapshot-cannot-recreate", staleRejected, "no replacement UUID or retired-row resurrection")
    }
    do {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "linked"), linked: true)
        let original = h.context!.draft
        var sibling = LocalDraft(ownerScope: original.ownerScope, accountId: original.accountId)
        sibling.serverID = original.serverID; sibling.content.body.text = "Other local writing"
        sibling = try await h.store.save(sibling)
        h.context?.content.subject = "Latest visible not autosaved"
        let approved = h.context!
        var checkpoint: LocalDraft?
        let result = await h.run(delete: { draft in checkpoint = await h.retained(draft) })
        let retainedSibling = await h.retained(sibling)
        check("DISCARD-linked-checkpoints-raw-rich-attachments-before-delete", checkpoint?.content == approved.content && checkpoint?.recipientText == approved.recipientText, "actual disk checkpoint preserves incomplete recipients, HTML/text and attachment data before injected 204")
        check("DISCARD-linked-exact-id-only", result == .discarded && h.deleteCalls == 1 && retainedSibling == sibling, "one local identity removed; sibling with same server ID remains")
        check("DISCARD-role-released-after-success", await h.store.isReserved(original.id) == false && h.lease == nil, "the dedicated lease ends after completion")
    }
    for axis in ["raw-to", "raw-cc", "raw-bcc", "html", "attachments"] {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "approval-" + axis), linked: true)
        let approval = h.context!
        switch axis {
        case "raw-to": h.context?.recipientText.to += "new typing"
        case "raw-cc": h.context?.recipientText.cc += "new typing"
        case "raw-bcc": h.context?.recipientText.bcc += "new typing"
        case "html": h.context?.content.body.html = "<p>New rich writing</p>"
        default: h.context?.content.attachments = []
        }
        let result = await h.run(approval)
        check("DISCARD-confirmation-\(axis)-changed-zero-delete", result != .discarded && h.deleteCalls == 0, "old confirmation is bound to the full raw/rich/attachment visible fingerprint")
    }
    for state in ["sending", "ambiguous", "rejected", "sent", "keyed"] {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "delivery-" + state), linked: true,
            deliveryState: state == "keyed" ? "draft" : state, keyed: state == "keyed")
        let original = h.context!.draft
        var storeRefused = false
        do { _ = try await h.store.reserveForDiscard(original, editorID: h.context!.editorID) } catch { storeRefused = true }
        let result = await h.run()
        let retained = await h.store.current(original.id, ownerScope: original.ownerScope, accountId: original.accountId)
        check("DISCARD-refuses-\(state)-zero-delete", storeRefused && result != .discarded && h.deleteCalls == 0 && retained != nil, "no send-key reset, new identity, detach or ambiguous-send replay")
    }
    do {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "other-editor"), linked: true)
        let original = h.context!.draft
        _ = await h.store.beginEditing(original.id, ownerScope: original.ownerScope, accountId: original.accountId, editorID: UUID())
        let result = await h.run()
        check("DISCARD-controller-other-editor-zero-delete", result != .discarded && h.deleteCalls == 0, "atomic reservation refuses another registered editor before network")
    }
    do {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "held-save"), linked: true)
        let hold = SearchRequestHold(), approval = h.context!
        var predecessorDrained = false
        let previous = Task { @MainActor in
            _ = await hold.token()
            var saved = h.context!.draft; saved.content = approval.content; saved.recipientText = approval.recipientText
            if let committed = try? await h.store.save(saved) { h.context?.draft = committed }
            predecessorDrained = true
        }
        await hold.waitUntilHeld()
        var cancelledQueueWrites = 0
        let middle = ComposeSaveSequencing.enqueue(after: previous, debounce: false, canSave: { true }, save: { cancelledQueueWrites += 1 })
        let last = ComposeSaveSequencing.enqueue(after: middle, debounce: false, canSave: { true }, save: { cancelledQueueWrites += 1 })
        let operation = Task { await h.run(approval, predecessor: last) }
        await Task.yield()
        check("DISCARD-awaits-entire-predecessor-save", !predecessorDrained && h.deleteCalls == 0, "a cancelled but running predecessor cannot be overtaken by DELETE")
        await hold.release(); let result = await operation.value
        check("DISCARD-held-own-save-drained-before-delete", predecessorDrained && cancelledQueueWrites == 0 && result == .discarded && h.deleteCalls == 1, "production ComposeSaveSequencing drains the whole cancelled predecessor chain before the exact role lease is acquired")
    }
    do {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "newer-save"), linked: true)
        let approval = h.context!
        var newer = approval.draft; newer.content.body.text = "Other newer snapshot"
        _ = try await h.store.save(newer)
        let result = await h.run(approval)
        let retained = await h.retained(approval.draft)
        check("DISCARD-newer-local-snapshot-zero-delete", result != .discarded && retained?.content.body.text == newer.content.body.text && h.deleteCalls == 0, "an unrelated newer snapshot is not adopted as the old confirmation")
    }
    do {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "repeat"), linked: true)
        let approval = h.context!, hold = SearchRequestHold()
        let operation = Task { await h.run(delete: { _ in _ = await hold.token() }) }
        await hold.waitUntilHeld()
        let newEditor = await h.store.beginEditing(approval.draft.id, ownerScope: approval.draft.ownerScope, accountId: approval.draft.accountId, editorID: UUID())
        let repeated = await h.run()
        check("DISCARD-held-delete-blocks-new-editor-and-repeat", newEditor == nil && repeated != .discarded && h.deleteCalls == 1, "same controller and actor role exclude repeated operation/new editors throughout the await")
        await hold.release(); let result = await operation.value
        check("DISCARD-held-delete-success-once", result == .discarded && h.deleteCalls == 1, "one acknowledgement and one exact local removal")
    }
    for axis in ["owner", "account", "client", "generation", "editor", "origin", "writing", "server", "closed", "lease", "snapshot", "registration"] {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "changed-" + axis), linked: true)
        let original = h.context!.draft, hold = SearchRequestHold()
        let operation = Task { await h.run(delete: { _ in _ = await hold.token() }) }
        await hold.waitUntilHeld()
        switch axis {
        case "owner": h.context?.draft.ownerScope = "other-owner"
        case "account": h.context?.draft.accountId = "other-account"
        case "client": h.context?.clientID = ObjectIdentifier(APIClient(baseURL: URL(string: "https://example.invalid")!) { nil })
        case "generation": h.context?.generation = UUID()
        case "editor": h.context?.editorID = UUID()
        case "origin": h.context?.origin = "https://other.invalid"
        case "writing": h.context?.content.subject = "New visible writing"
        case "server": h.context?.draft.serverID = "other-server-id"
        case "closed": h.context = nil
        case "snapshot":
            if let lease = h.lease {
                var newer = original; newer.content.subject = "Newer leased snapshot"
                _ = try await h.store.save(newer, reservation: lease)
            }
        case "registration": await h.store.endEditing(h.context!.editorID)
        default: if let lease = h.lease { await h.store.release(lease) }
        }
        await hold.release(); let result = await operation.value
        let retained = await h.retained(original)
        check("DISCARD-held-204-\(axis)-keeps-local", result != .discarded && retained != nil && h.deleteCalls == 1, "stale acknowledgement cannot retire original writing or dismiss a changed composer")
    }
    for phase in ["checkpoint", "after204"] {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "disk-" + phase), linked: true)
        let original = h.context!.draft
        h.context?.content.subject = "Visible latest checkpoint requires disk write"
        if phase == "checkpoint" { h.onLease = { _ in try! h.breakDisk() } }
        let result = await h.run(delete: { _ in if phase == "after204" { try h.breakDisk() } })
        let retained = await h.retained(original)
        let backup = DraftStore(directory: h.directory.appendingPathExtension("backup"))
        let onDisk = await backup.current(original.id, ownerScope: original.ownerScope, accountId: original.accountId)
        check("DISCARD-disk-\(phase)-keeps-local", retained != nil && onDisk != nil && h.deleteCalls == (phase == "checkpoint" ? 0 : 1) && (phase != "after204" || result == .serverDeletedLocalKept), "disk failure before DELETE stops network; after 204 is explicitly partial and the last successfully persisted writing survives independently")
    }
    for status in [200, 202, 400, 401, 403, 404, 409, 502] {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "http-\(status)"), linked: true)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReviewURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://example.invalid")!, session: URLSession(configuration: config)) { "synthetic-discard" }
        var requests = 0
        ReviewURLProtocol.handler = { request in
            guard request.httpMethod == "DELETE", request.url?.path == "/v1/drafts/original-server-id" else { throw URLError(.badURL) }
            requests += 1; return (status, Data())
        }
        let original = h.context!.draft
        let result = await h.run(delete: { draft in
            try await client.deleteDraftForDiscard(draft.serverID!, accountId: draft.accountId, expectedOrigin: "https://example.invalid") { true }
        })
        let retained = await h.retained(original)
        check("DISCARD-client-\(status)-not-a204-receipt", result != .discarded && retained != nil && requests == 1, "actual production APIClient refuses every non204; 404 is never implicit success")
    }
    for failure in [URLError.Code.timedOut, .notConnectedToInternet, .cancelled] {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "network-\(failure.rawValue)"), linked: true)
        let original = h.context!.draft
        let result = await h.run(delete: { _ in throw URLError(failure) })
        let retained = await h.retained(original)
        check("DISCARD-network-\(failure.rawValue)-keeps-writing", result != .discarded && retained != nil, "uncertain transport never unlocks a fabricated successful deletion")
    }
    do {
        let h = try await DiscardHarness.make(cacheRoot.appending(path: "held-credential"), linked: true)
        let hold = SearchRequestHold(), config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReviewURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://example.invalid")!, session: URLSession(configuration: config)) { await hold.token() }
        var requests = 0
        ReviewURLProtocol.handler = { _ in requests += 1; return (204, Data()) }
        var authorized = true
        let operation = Task { await h.run(delete: { draft in
            try await client.deleteDraftForDiscard(draft.serverID!, accountId: draft.accountId, expectedOrigin: "https://example.invalid") { await MainActor.run { authorized } }
        }) }
        await hold.waitUntilHeld(); authorized = false; await hold.release()
        let result = await operation.value
        check("DISCARD-owner-change-during-token-zero-request", result != .discarded && requests == 0, "original approval is rechecked after credential lookup, before any DELETE request")
    }
}

@MainActor func runDiscardAPICases(connection: ReviewRegressions.Connection, cacheRoot: URL,
    check: @MainActor (String, Bool, String) -> Void) async throws {
    struct Probe: Decodable {
        struct Draft: Decodable { var id: String }
        var drafts: [Draft]; var draftDeletes: [Draft]; var providerCalls: Int
    }
    let client = APIClient(baseURL: URL(string: connection.baseURL)!) { connection.token }
    let origin = await client.serverOrigin()
    for scenario in ["success", "missing", "foreign", "held204"] {
        let content = DraftContent(to: [.init(name: nil, email: "person@example.com")], subject: "Owned synthetic discard " + scenario,
            body: .init(text: "Original API writing", html: "<p><b>Original API writing</b></p>"))
        let remote = try await client.createDraft(accountId: "account", content: content)
        let id = scenario == "missing" ? UUID().uuidString : remote.id
        let h = try await DiscardHarness.make(cacheRoot.appending(path: scenario), linked: true, accountId: "account", serverID: id)
        let approval = h.context!
        let deletingClient = scenario == "foreign" ? APIClient(baseURL: URL(string: connection.baseURL)!) { connection.otherToken } : client
        let hold = SearchRequestHold()
        let operation = Task { await h.run(delete: { draft in
            try await deletingClient.deleteDraftForDiscard(draft.serverID!, accountId: draft.accountId, expectedOrigin: origin) { true }
            if scenario == "held204" { _ = await hold.token() }
        }) }
        if scenario == "held204" {
            await hold.waitUntilHeld()
            let probe: Probe = try await client.request("__bre457/state")
            let local = await h.retained(approval.draft)
            check("DISCARD-API-held204-independent-server-removed-local-retained", !probe.drafts.contains(where: { $0.id == remote.id }) && probe.draftDeletes.filter({ $0.id == remote.id }).count == 1 && local != nil, "real API204 and independent SQLite deletion precede released native acknowledgement; local writing remains under lease")
            h.context?.generation = UUID()
            await hold.release()
        }
        let result = await operation.value
        let probe: Probe = try await client.request("__bre457/state")
        let local = await h.retained(approval.draft)
        if scenario == "success" {
            let reopened = DraftStore(directory: h.directory)
            let reopenedLocal = await reopened.current(approval.draft.id, ownerScope: approval.draft.ownerScope, accountId: approval.draft.accountId)
            check("DISCARD-API204-exact-local-server-durable-removal", result == .discarded && local == nil && reopenedLocal == nil && !probe.drafts.contains(where: { $0.id == remote.id }) && probe.draftDeletes.filter({ $0.id == remote.id }).count == 1, "production APIClient/controller/store and actual API/SQLite agree on one owned deletion")
        } else if scenario == "held204" {
            check("DISCARD-API-held204-new-generation-keeps-device-writing", result != .discarded && local != nil, "a real server receipt never authorizes local removal/dismissal in a changed generation")
        } else {
            check("DISCARD-API-\(scenario)-retains-local-and-real-original", result != .discarded && local != nil && probe.drafts.contains(where: { $0.id == remote.id }) && !probe.draftDeletes.contains(where: { $0.id == remote.id }), "actual authorized missing or foreign request is not a deletion receipt; original server draft and local writing survive")
        }
        check("DISCARD-API-\(scenario)-zero-provider", probe.providerCalls == 0, "synthetic unmirrored drafts only; no external provider calls")
    }
}
