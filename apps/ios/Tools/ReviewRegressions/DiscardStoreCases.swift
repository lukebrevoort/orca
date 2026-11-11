import Foundation

/// Deliberately unsafe integration control for a NEW discard feature. There is
/// no exposed Discard button at baseline: these failures are not existing UI
/// bugs. They show why blindly wiring reserve/remove cannot implement OptionA.
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
        let reservation = try await store.reserve(draft)
        try await store.remove(draft.id, reservation: reservation)
        let retained = await store.current(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId)
        check("DISCARD-unsafe-integration-other-editor-must-survive", retained != nil, "negative control: generic lease/remove must not be mistaken for discard while another registered editor may hold unsaved writing")
        await store.release(reservation)
    }
    do {
        let store = DraftStore(directory: cacheRoot.appending(path: "new-editor")), a = UUID(), b = UUID()
        let draft = try await original(store)
        _ = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: a)
        let reservation = try await store.reserve(draft)
        let other = await store.beginEditing(draft.id, ownerScope: draft.ownerScope, accountId: draft.accountId, editorID: b)
        check("DISCARD-unsafe-integration-lease-blocks-new-editor", other == nil, "negative control: discard needs an atomic special lease that blocks new editor registration across awaits")
        await store.release(reservation)
    }
    do {
        let store = DraftStore(directory: cacheRoot.appending(path: "exact-snapshot")), a = UUID()
        let approved = try await original(store)
        _ = await store.beginEditing(approved.id, ownerScope: approved.ownerScope, accountId: approved.accountId, editorID: a)
        let reservation = try await store.reserve(approved)
        var newer = approved; newer.content.body.text = "Newer than the approved writing"
        newer = try await store.save(newer, reservation: reservation)
        try await store.remove(approved.id, reservation: reservation)
        let retained = await store.current(approved.id, ownerScope: approved.ownerScope, accountId: approved.accountId)
        check("DISCARD-unsafe-integration-ack-cannot-remove-newer-snapshot", retained?.storageRevision == newer.storageRevision, "negative control: remove(id) has no exact approved-snapshot predicate; future discard must refuse a newer leased snapshot")
        await store.release(reservation)
    }
}
