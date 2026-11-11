import Foundation

@MainActor func runCommitStatusCases(state: AppState, client: APIClient, suite: String, otherToken: String,
                                    createFixtureView: @MainActor (String) async throws -> String,
                                    check: @MainActor (String, Bool, String) -> Void) async throws {
    let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
    func statusState() async throws -> MailActionJSON { try await client.request("__bre457/state") }
    func control(_ path: String, _ body: MailActionJSON = .object([:])) async throws {
        let _: MailActionJSON = try await client.request("__bre457/" + path, method: "POST", body: body)
    }
    func pendingBody(_ defaults: UserDefaults) -> MailActionJSON {
        guard let data = defaults.data(forKey: "native-view.pending.v1|\(state.ownerScope)|account"), let json = try? JSONDecoder().decode(MailActionJSON.self, from: data) else { return .null }
        return json["command"]["body"]
    }
    func sameCommand(_ defaults: UserDefaults, _ original: MailActionJSON) -> Bool {
        guard let lhs = try? encoder.encode(pendingBody(defaults)), let rhs = try? encoder.encode(original) else { return false }; return lhs == rhs
    }
    func beginHeld(_ name: String, defaults: UserDefaults) async throws -> NativeViewEditorController {
        let editor = NativeViewEditorController(defaults: defaults)
        await editor.open(selection: .init(query: "Subject", accountId: "account"), state: state)
        editor.name = name; editor.replaceSearch = true; editor.subject = "Subject"; editor.edited(); await editor.review()
        try await control("hold-next-commit"); _ = await editor.save()
        return editor
    }
    let id = state.userID!
    let binding: MailActionJSON = .object(["operation": .string("view_commit"), "workspaceId": .string(id), "retryKey": .string("strict-test"), "expectedRevisions": .object(["workspace": .number(2), "view": .null])])
    let applied = binding.setting("outcome", to: .string("applied")).setting("viewId", to: .string("original-view")).setting("committedWorkspaceRevision", to: .number(3)).setting("committedViewRevision", to: .number(1))
    let notApplied = binding.setting("outcome", to: .string("not_applied")).setting("reason", to: .string("workspace_advanced")).setting("observedWorkspaceRevision", to: .number(3)).setting("observedViewRevision", to: .null)
    let unknown = binding.setting("outcome", to: .string("unknown")).setting("reason", to: .string("eligible_or_unresolved"))
    for (index, value) in [applied, notApplied, unknown].enumerated() {
        check("478-strict-valid-variant-\(index)", (try? JSONDecoder().decode(ViewCommitStatus.self, from: encoder.encode(value))) != nil, "strict shared discriminated shape accepts valid variant")
    }
    let invalid: [MailActionJSON] = [applied.setting("extra", to: .bool(true)), applied.setting("operation", to: .string("other")), applied.setting("workspaceId", to: .string(" ")), applied.setting("retryKey", to: .string(String(repeating: "x", count: 201))), applied.setting("committedWorkspaceRevision", to: .number(4)), applied.setting("committedViewRevision", to: .number(2)), applied.setting("committedViewRevision", to: .number(1.5)), applied.setting("expectedRevisions", to: .object(["workspace": .number(2), "view": .null, "extra": .bool(true)])), notApplied.setting("observedWorkspaceRevision", to: .number(2)), notApplied.setting("reason", to: .string("unchanged_view")), unknown.setting("reason", to: .string("invented")), unknown.setting("viewId", to: .string("unallowed"))]
    for (index, value) in invalid.enumerated() {
        check("478-strict-invalid-variant-\(index)", (try? JSONDecoder().decode(ViewCommitStatus.self, from: encoder.encode(value))) == nil, "invalid/extra fields, reason or revision fence cannot become proof")
    }

    let unknownSuite = suite + ".status-unknown", defaults = UserDefaults(suiteName: unknownSuite)!
    defer { defaults.removePersistentDomain(forName: unknownSuite) }
    let held = try await beginHeld("Unknown original", defaults: defaults)
    let original = pendingBody(defaults), before = try await statusState()
    held.name = "Newer unknown edits"; held.edited()
    _ = await held.checkSaveOutcome()
    check("478-eligible-unknown-keeps-exact-command", held.pendingTarget != nil && held.name == "Newer unknown edits" && sameCommand(defaults, original), "actual eligible/unresolved status never releases the original command")
    let originalBinding: MailActionJSON = .object(["operation": .string("view_commit"), "workspaceId": .string(id), "retryKey": original["retryKey"], "expectedRevisions": original["expectedRevisions"], "outcome": .string("not_applied"), "reason": .string("workspace_advanced"), "observedWorkspaceRevision": .number(Double(original["expectedRevisions"]["workspace"].integer! + 1)), "observedViewRevision": .null])
    let shiftedRevisions: MailActionJSON = .object(["workspace": .number(Double(original["expectedRevisions"]["workspace"].integer! + 1)), "view": original["expectedRevisions"]["view"]])
    let hostile = [originalBinding.setting("retryKey", to: .string("wrong-key")), originalBinding.setting("workspaceId", to: .string("wrong-owner")), originalBinding.setting("observedWorkspaceRevision", to: original["expectedRevisions"]["workspace"]), originalBinding.setting("extra", to: .bool(true)), originalBinding.setting("expectedRevisions", to: shiftedRevisions).setting("observedWorkspaceRevision", to: .number(Double(original["expectedRevisions"]["workspace"].integer! + 2)))]
    for (index, body) in hostile.enumerated() {
        try await control("status-response", .object(["status": .number(200), "body": body])); _ = await held.checkSaveOutcome()
        check("478-invalid-proof-keeps-command-\(index)", held.pendingTarget != nil && sameCommand(defaults, original), "mismatched or malformed injected transport proof cannot unlock")
    }
    for status in [401, 404, 503] {
        try await control("status-response", .object(["status": .number(Double(status)), "body": .object(["error": .object(["code": .string("synthetic_unavailable"), "message": .string("Unverified")])])]))
        _ = await held.checkSaveOutcome()
        check("478-status-failure-keeps-command-\(status)", held.pendingTarget != nil && sameCommand(defaults, original), "auth/foreign404/unavailable status never becomes a no-write proof")
    }
    for (label, credential) in [("unauthenticated", "invalid-owned-fixture-token"), ("foreign-owner", otherToken)] {
        let authState = AppState(cache: state.cache)
        authState.baseURLText = state.baseURLText; authState.ownerScope = state.ownerScope; authState.userID = state.userID; authState.accounts = state.accounts
        authState.client = APIClient(baseURL: URL(string: state.baseURLText)!) { credential }
        let authEditor = NativeViewEditorController(defaults: defaults)
        await authEditor.open(selection: .init(query: "Subject", accountId: "account"), state: authState); _ = await authEditor.checkSaveOutcome()
        let authObservation = try await statusState()
        if case .array(let requests) = authObservation["requests"] {
            check("478-real-" + label + "-cannot-unlock", authEditor.pendingTarget != nil && requests.last?["path"].text == "/v1/organization/views/commit-status" && requests.last?["status"].integer == (label == "unauthenticated" ? 401 : 403) && sameCommand(defaults, original), "real API auth/ownership rejection retains the exact original command")
        }
    }
    let switched = AppState(cache: state.cache), hold = SearchRequestHold()
    switched.baseURLText = state.baseURLText; switched.ownerScope = state.ownerScope; switched.userID = state.userID; switched.accounts = state.accounts
    // Use the original real client credential after the held preflight, without exposing it.
    let offlineConfig = URLSessionConfiguration.ephemeral; offlineConfig.protocolClasses = [ReviewURLProtocol.self]
    let offline = AppState(cache: state.cache); offline.baseURLText = state.baseURLText; offline.ownerScope = state.ownerScope; offline.userID = state.userID; offline.accounts = state.accounts
    ReviewURLProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
    offline.client = APIClient(baseURL: URL(string: state.baseURLText)!, session: URLSession(configuration: offlineConfig)) { "synthetic-offline" }
    let offlineEditor = NativeViewEditorController(defaults: defaults)
    await offlineEditor.open(selection: .init(query: "Subject", accountId: "account"), state: offline); _ = await offlineEditor.checkSaveOutcome()
    check("478-offline-keeps-command", offlineEditor.pendingTarget != nil && sameCommand(defaults, original), "actual URLSession transport failure retains uncertainty")
    // A held status response is tested below with a URLProtocol boundary: no server proof is invented as acceptance.
    ReviewURLProtocol.handler = { request in
        let reply = originalBinding.setting("observedWorkspaceRevision", to: .number(Double(original["expectedRevisions"]["workspace"].integer! + 1)))
        return (200, try encoder.encode(reply))
    }
    switched.client = APIClient(baseURL: URL(string: state.baseURLText)!, session: URLSession(configuration: offlineConfig)) { await hold.token() }
    let switchedEditor = NativeViewEditorController(defaults: defaults)
    await switchedEditor.open(selection: .init(query: "Subject", accountId: "account"), state: switched)
    let checking = Task { _ = await switchedEditor.checkSaveOutcome() }
    await hold.waitUntilHeld(); switched.selectedAccountID = "other-account"; await hold.release(); await checking.value
    check("478-held-other-account-cannot-accept-proof", switchedEditor.pendingTarget != nil && sameCommand(defaults, original), "account change during held proof rejects publication and retirement")
    _ = await held.save() // Explicit safe original retry; commits exactly the original command once.
    let afterRetry = try await statusState()
    let release: MailActionJSON = try await client.request("__bre457/release-held", method: "POST", body: MailActionJSON.object([:]))
    let afterLate = try await statusState()
    check("478-late-original-replays-only-once", afterRetry["count"].integer == (before["count"].integer ?? 0) + 1 && afterLate["count"].integer == afterRetry["count"].integer && release["status"].integer == 200, "safe retry and delayed original share one real API receipt/creation")
    await held.review(); _ = await held.save()

    let mismatchSuite = suite + ".status-mismatch", mismatchDefaults = UserDefaults(suiteName: mismatchSuite)!
    defer { mismatchDefaults.removePersistentDomain(forName: mismatchSuite) }
    let mismatched = try await beginHeld("Bound command original", defaults: mismatchDefaults)
    let mismatchedOriginal = pendingBody(mismatchDefaults)
    let alternateDraft = mismatchedOriginal["draft"].setting("identity", to: mismatchedOriginal["draft"]["identity"].setting("name", to: .string("Different command same key")))
    let _: MailActionJSON = try await client.request("v1/organization/views/commit", method: "POST", body: mismatchedOriginal.setting("draft", to: alternateDraft))
    let mismatchedBefore = try await statusState()
    _ = await mismatched.checkSaveOutcome(); _ = await mismatched.save()
    let mismatchLate: MailActionJSON = try await client.request("__bre457/release-held", method: "POST", body: MailActionJSON.object([:]))
    let mismatchedAfter = try await statusState()
    check("478-real-command-mismatch-stays-locked", mismatched.pendingTarget != nil && mismatchLate["status"].integer == 409 && mismatchedBefore["count"].integer == mismatchedAfter["count"].integer && sameCommand(mismatchDefaults, mismatchedOriginal), "actual owned key collision is unknown, never a no-write fence for this command")

    let fenceSuite = suite + ".status-fence", fenceDefaults = UserDefaults(suiteName: fenceSuite)!
    defer { fenceDefaults.removePersistentDomain(forName: fenceSuite) }
    let fenced = try await beginHeld("Fenced original", defaults: fenceDefaults)
    _ = try await createFixtureView("Independent fence advance")
    let fenceBefore = try await statusState()
    fenced.name = "Kept after durable fence"; fenced.edited(); _ = await fenced.checkSaveOutcome()
    check("478-fence-prepares-before-retiring", fenced.pendingTarget == nil && fenced.name == "Kept after durable fence", "actual server fence plus fresh authorized prepare permits a replacement preview")
    let lateRejected: MailActionJSON = try await client.request("__bre457/release-held", method: "POST", body: MailActionJSON.object([:]))
    await fenced.review(); let fenceID = await fenced.save(); let fenceAfter = try await statusState()
    check("478-fence-blocks-delayed-original", lateRejected["status"].integer == 409 && fenceID != nil && fenceAfter["count"].integer == (fenceBefore["count"].integer ?? 0) + 1, "delayed original cannot race the replacement into a duplicate")

    let deletedSuite = suite + ".status-deleted", deletedDefaults = UserDefaults(suiteName: deletedSuite)!
    defer { deletedDefaults.removePersistentDomain(forName: deletedSuite) }
    let deleted = NativeViewEditorController(defaults: deletedDefaults)
    await deleted.open(selection: .init(query: "Subject", accountId: "account"), state: state)
    deleted.name = "Applied then removed"; deleted.replaceSearch = true; deleted.subject = "Subject"; deleted.edited(); await deleted.review()
    try await control("drop-next-commit"); _ = await deleted.save()
    let deletedOriginal = pendingBody(deletedDefaults), saved = try await statusState()
    guard case .array(let ledger) = saved["ledger"], let last = ledger.last, let savedID = last["response"]["view"]["id"].text else { throw APIClient.ClientError.invalidResponse }
    let catalog: MailActionJSON = try await client.request("v1/organization/views")
    let _: EmptyResponse = try await client.request("v1/organization/views", pathSuffix: [savedID], method: "DELETE", query: [.init(name: "expectedRevision", value: "1"), .init(name: "expectedWorkspaceRevision", value: String(catalog["workspaceRevision"].integer!)), .init(name: "idempotencyKey", value: UUID().uuidString)])
    let removed = try await statusState(); _ = await deleted.checkSaveOutcome(); _ = await deleted.save(); await deleted.review()
    let stillRemoved = try await statusState()
    check("478-applied-deleted-never-recreates", deleted.pendingTarget != nil && deleted.error?.contains(savedID) == true && removed["count"].integer == stillRemoved["count"].integer && sameCommand(deletedDefaults, deletedOriginal), "applied receipt pins original deleted ID and exact command; no new UUID or replacement View")
    check("478-status-provider-boundary", stillRemoved["providerCalls"].integer == 0, "all status, fence and recovery cases use zero external provider calls")
}
