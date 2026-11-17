import Foundation

/// Production controller AND the exact surface-policy method used by InboxView.
/// This is not an actual SwiftUI rendering or an accepted-A/failed-B scenario.
@MainActor func runSavedFirstSearchSurfaceCases(cacheRoot: URL, check: @MainActor (String, Bool, String) -> Void) async throws {
    for failure in ["503", "offline", "401"] {
        let state = AppState(cache: CacheStore(directory: cacheRoot.appending(path: failure))), model = InboxViewModel()
        let hold = SearchRequestHold(), config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReviewURLProtocol.self]
        state.client = APIClient(baseURL: URL(string: "https://example.invalid")!, session: URLSession(configuration: config)) { await hold.token() }
        ReviewURLProtocol.handler = { _ in
            if failure == "offline" { throw URLError(.notConnectedToInternet) }
            return (Int(failure)!, try ReviewRegressions.json(["error": ["code": failure == "401" ? "unauthorized" : "unavailable", "message": "Controlled first saved-View search failure"]]))
        }
        await model.loadPrimaryMail(state: state, mailboxView: "view:owned", event: .refresh)
        model.search = "First submitted query"
        let searching = Task { await model.loadPrimaryMail(state: state, mailboxView: "view:owned", event: .submit) }
        await hold.waitUntilHeld()
        check("P2-saved-first-\(failure)-pending-established", model.isLoading && model.resultSearch.isEmpty && model.messages.isEmpty, "a real first submitted request is held before acknowledgement; no accepted search result is fabricated")
        check("P2-saved-first-\(failure)-pending-surface-visible", !model.showsSavedMailboxResults(hasSavedView: true), "InboxView's actual policy must show the pending search surface, not keep old SavedMailboxResults mounted")
        await hold.release(); await searching.value
        check("P2-saved-first-\(failure)-error-established", !model.isLoading && model.error != nil && model.resultSearch.isEmpty && model.messages.isEmpty && model.search == "First submitted query", "actual request failure retains typed query and truthful error with no accepted or unauthorized rows")
        check("P2-saved-first-\(failure)-error-recovery-visible", !model.showsSavedMailboxResults(hasSavedView: true), "the same production branch decision must expose the failed first search and retry/recovery controls")
    }
}
