import Foundation

/// Public Check/Reload action used by NativeViewEditor; no private controller call.
@MainActor func runAppliedReloadCases(state: AppState, client: APIClient, suite: String, token: String, otherToken: String,
                                     check: @MainActor (String, Bool, String) -> Void) async throws {
    let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
    func snapshot() async throws -> MailActionJSON { try await client.request("__bre457/state") }
    func control(_ path: String, _ body: MailActionJSON = .object([:])) async throws {
        let _: MailActionJSON = try await client.request("__bre457/" + path, method: "POST", body: body)
    }
    func journal(_ defaults: UserDefaults) -> MailActionJSON {
        guard let data = defaults.data(forKey: "native-view.pending.v1|\(state.ownerScope)|account"), let value = try? JSONDecoder().decode(MailActionJSON.self, from: data) else { return .null }; return value
    }
    func unchanged(_ defaults: UserDefaults, original: MailActionJSON) -> Bool {
        guard let before = try? encoder.encode(original), let after = try? encoder.encode(journal(defaults)["command"]["body"]) else { return false }; return before == after
    }
    func fixtureState(_ credential: @escaping @Sendable () async -> String?) -> AppState {
        let copy = AppState(cache: state.cache)
        copy.baseURLText = state.baseURLText; copy.ownerScope = state.ownerScope; copy.userID = state.userID; copy.accounts = state.accounts
        copy.client = APIClient(baseURL: URL(string: state.baseURLText)!, token: credential)
        return copy
    }
    func advance(_ id: String) async throws -> MailActionJSON {
        let prepared: MailActionJSON = try await client.request("v1/organization/views/prepare", method: "POST", body: MailActionJSON.object(["kind": .string("saved_view"), "viewId": .string(id)]))
        var draft = prepared["draft"].keeping(["mode", "skipInbox", "viewId", "viewRevision", "source", "identity", "definition", "unsupportedClauses"])
        draft = draft.setting("identity", to: draft["identity"].setting("name", to: .string("Newer server object"))).setting("definition", to: draft["definition"].setting("date", to: .object(["receivedAfter": .string("1970-01-01T00:00:00.000Z")])))
        let preview: MailActionJSON = try await client.request("v1/organization/views/preview", method: "POST", body: MailActionJSON.object(["draft": draft, "page": .object(["limit": .number(25)])]))
        return try await client.request("v1/organization/views/commit", method: "POST", body: MailActionJSON.object(["draft": preview["draft"], "expectedRevisions": .object(["workspace": preview["workspaceRevision"], "view": preview["draft"]["viewRevision"]]), "retryKey": .string(UUID().uuidString), "confirmedZeroMatchDigest": preview["draft"]["definitionDigest"]]))
    }
    for kind in ["commit-ack", "typed-proof"] {
        let domain = suite + ".applied-read." + kind, defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        let selection = NativeViewSelection(query: "Subject", accountId: "account")
        let editor = NativeViewEditorController(defaults: defaults)
        await editor.open(selection: selection, state: state)
        editor.name = "Submitted before read failure " + kind; editor.subject = "Subject"; editor.replaceSearch = true; editor.edited(); await editor.review()
        try await control("drop-next-commit"); _ = await editor.save()
        let original = journal(defaults)["command"]["body"], saved = try await snapshot()
        guard case .array(let ledger) = saved["ledger"], let id = ledger.last?["response"]["view"]["id"].text else { throw APIClient.ClientError.invalidResponse }
        let advanced = try await advance(id)
        let desired = "Newer retained local edits " + kind
        editor.name = desired; editor.edited()
        if kind == "commit-ack" { try await control("add-account", .object(["id": .string("reload-added-" + kind)])); state.accounts = try await client.accounts() }
        try await control("saved-prepare-failures", .object(["count": .number(1)]))
        if kind == "commit-ack" { _ = await editor.save() } else { _ = await editor.checkSaveOutcome() }
        let failedRead = try await snapshot()
        if case .array(let requests) = failedRead["requests"] {
            check("478-applied-" + kind + "-read-failure-established", editor.appliedTarget == id && editor.pendingTarget != nil && editor.name == desired && unchanged(defaults, original: original) && requests.last?["path"].text == "/v1/organization/views/prepare" && requests.last?["deliveredStatus"].integer == 503, "validated applied ID persists before actual saved prepare200 acknowledgement is replaced503")
        }
        if kind == "typed-proof" { try await control("add-account", .object(["id": .string("reload-added-" + kind)])); state.accounts = try await client.accounts() }
        editor.close()
        let reopened = NativeViewEditorController(defaults: defaults)
        await reopened.open(selection: selection, state: state)
        let proof: ViewCommitStatus = try await client.request("v1/organization/views/commit-status", method: "POST", body: original)
        if case .unknown = proof.outcome { check("478-applied-" + kind + "-status-conservative", true, "real status stays unknown after account addition; existing original ID remains authoritative") }
        else { check("478-applied-" + kind + "-status-conservative", false, "fixture requires conservative account-scope status") }
        try await control("saved-prepare-failures", .object(["count": .number(2)]))
        let beforeRepeat = try await snapshot()
        _ = await reopened.checkSaveOutcome(); _ = await reopened.checkSaveOutcome()
        let afterRepeat = try await snapshot()
        if case .array(let beforeRequests) = beforeRepeat["requests"], case .array(let afterRequests) = afterRepeat["requests"] {
            let failedReads = afterRequests.dropFirst(beforeRequests.count).filter { $0["path"].text == "/v1/organization/views/prepare" && $0["viewId"].text == id && $0["deliveredStatus"].integer == 503 }
            check("478-applied-" + kind + "-public-reload-retries-read", failedReads.count == 2 && reopened.appliedTarget == id && reopened.pendingTarget != nil && reopened.name == desired && unchanged(defaults, original: original), "user-reachable Check/Reload must retry original-ID prepare; repeated failures retain immutable command and newer edits")
        }
        try await control("saved-prepare-failures", .object(["count": .number(0)]))
        if kind == "commit-ack" {
            for (label, credential) in [("unauthenticated", "invalid-fixture-token"), ("foreign", otherToken)] {
                let guarded = fixtureState { credential }, guardedEditor = NativeViewEditorController(defaults: defaults)
                await guardedEditor.open(selection: selection, state: guarded); _ = await guardedEditor.checkSaveOutcome()
                let observed = try await snapshot()
                if case .array(let requests) = observed["requests"] {
                    check("478-applied-reload-" + label + "-protected", guardedEditor.appliedTarget == id && guardedEditor.pendingTarget != nil && unchanged(defaults, original: original) && requests.last?["path"].text == "/v1/organization/views/prepare" && requests.last?["status"].integer == (label == "unauthenticated" ? 401 : 404), "real original-ID read remains auth/owner guarded, never interpreted as absence")
                }
            }
            for changed in ["account", "owner", "origin"] {
                let hold = SearchRequestHold(credential: token)
                let guarded = fixtureState { await hold.token() }, guardedEditor = NativeViewEditorController(defaults: defaults)
                await guardedEditor.open(selection: selection, state: guarded)
                let reading = Task { _ = await guardedEditor.checkSaveOutcome() }
                await hold.waitUntilHeld()
                if changed == "account" { guarded.selectedAccountID = "other-account" }
                else if changed == "owner" { guarded.userID = "other-owner"; guarded.ownerScope = "other-origin|other-owner" }
                else { guarded.baseURLText = "https://other.invalid" }
                await hold.release(); await reading.value
                check("478-applied-reload-held-" + changed + "-protected", guardedEditor.pendingTarget != nil && guardedEditor.name == desired && unchanged(defaults, original: original), "late owned read cannot retire the journal or replace edits after identity/generation changes")
            }
        }
        _ = await reopened.checkSaveOutcome()
        let recovered = try await snapshot()
        check("478-applied-" + kind + "-public-reload-recovers", reopened.pendingTarget == nil && reopened.appliedTarget == id && reopened.draft?["viewId"].text == id && reopened.draft?["viewRevision"].integer == advanced["view"]["revision"].integer && reopened.name == desired && recovered["count"].integer == saved["count"].integer, "network recovery uses persisted validated ID even while status remains unknown; no new creation or stale-edit overwrite")
        await reopened.review(); let updatedID = await reopened.save()
        let catalog: MailActionJSON = try await client.request("v1/organization/views")
        if case .array(let views) = catalog["items"], let result = views.first(where: { $0["id"].text == id }) {
            check("478-applied-" + kind + "-same-id-update", updatedID == id && result["name"].text == desired && result["definition"]["date"]["receivedAfter"].text == "1970-01-01T00:00:00.000Z", "fresh preview/Save updates the original ID once and preserves current advanced predicates")
        }
    }
    check("478-applied-reload-provider-boundary", try await snapshot()["providerCalls"].integer == 0, "all known-applied recovery cases use zero external provider calls")
}
