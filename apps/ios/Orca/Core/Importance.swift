import Foundation
import SwiftUI

/// One account mutation at a time, retained across sheet dismissal/termination.
/// The server operation record is the authority after an ambiguous response.
@MainActor final class ImportanceController: ObservableObject {
    struct Pending: Codable { var command: ImportanceCommand; var undoReceipt: ImportanceReceipt?; var contextThreadId: String?; var contextSubject: String? }
    @Published private(set) var snapshot: ImportanceResolution?
    @Published private(set) var preview: ImportancePreview?
    @Published private(set) var receipt: ImportanceReceipt?
    @Published private(set) var busy = false
    @Published private(set) var uncertain = false
    @Published private(set) var status: String?
    @Published private(set) var error: String?
    private var scope = "", accountId = "", threadId = ""
    private var receiptThreadId: String?
    private var subject = ""
    private var generation = UUID()
    private let defaults: UserDefaults
    private var pending: Pending?
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    private var pendingKey: String { "importance.pending.v1|\(scope)|\(accountId)" }
    var canUndo: Bool { !busy && !uncertain && receiptThreadId == threadId && receiptMatchesKnownRevision && receipt.flatMap { MailDate.parse($0.undoUntil) }.map { $0 > Date() } == true }
    private var receiptMatchesKnownRevision: Bool {
        guard let receipt, let snapshot else { return false }
        if receipt.target.kind == "conversation" { return receipt.target.threadId == threadId && receipt.revision == snapshot.conversation.revision }
        if let preference = snapshot.preferences.first(where: { $0.address == receipt.target.address }) { return preference.revision == receipt.revision }
        // Resets and truncated preference lists carry no newer target revision.
        // The server still enforces exact owned revision when Undo is submitted.
        return true
    }
    private func discardKnownSupersededReceipt() {
        if receipt != nil && !receiptMatchesKnownRevision {
            receipt = nil; receiptThreadId = nil; status = "Choice changed elsewhere. Showing the current conversation."
        }
    }
    var originalTarget: String? {
        guard let pending else { return nil }
        let context = pending.contextSubject.flatMap { $0.isEmpty ? nil : $0 } ?? pending.contextThreadId ?? pending.command.target.threadId ?? "Earlier conversation"
        if let address = pending.command.target.address { return "Original sender preference: \(address), opened from \(context)." }
        return "Original conversation: \(context) (\(pending.contextThreadId ?? pending.command.target.threadId ?? "unknown"))."
    }
    func invalidate() { generation = UUID(); scope = ""; accountId = ""; threadId = ""; snapshot = nil; preview = nil; receipt = nil; receiptThreadId = nil; pending = nil; uncertain = false; busy = false; status = nil; error = nil }
    private func current(_ state: AppState, _ request: UUID) -> Bool {
        !Task.isCancelled && generation == request && scope == state.ownerScope && state.phase == .ready
        && state.selectedAccount?.id == accountId && state.accounts.contains { $0.id == accountId }
    }
    func open(state: AppState, accountId: String, threadId: String, subject: String = "") async {
        guard state.phase == .ready, state.selectedAccount?.id == accountId else { invalidate(); return }
        if scope != state.ownerScope || self.accountId != accountId || self.threadId != threadId {
            invalidate(); scope = state.ownerScope; self.accountId = accountId; self.threadId = threadId
            pending = defaults.data(forKey: pendingKey).flatMap { try? JSONDecoder().decode(Pending.self, from: $0) }
            uncertain = pending != nil
        }
        self.subject = subject
        if pending != nil { await reconcile(state: state); return }
        await refresh(state: state)
    }
    func refresh(state: AppState) async {
        guard !busy, let client = state.client else { return }
        busy = true; error = nil; let request = generation
        defer { if request == generation { busy = false } }
        do {
            let result = try await client.importance(accountId: accountId, threadId: threadId)
            guard current(state, request) else { return }; snapshot = result; discardKnownSupersededReceipt()
        } catch { if current(state, request) { self.error = error.localizedDescription } }
    }
    private func persist(_ next: Pending?) {
        pending = next; uncertain = next != nil
        if let next, let data = try? JSONEncoder().encode(next) { defaults.set(data, forKey: pendingKey) }
        else { defaults.removeObject(forKey: pendingKey) }
    }
    func choose(_ choice: ImportanceChoice?, state: AppState) async {
        guard !busy, !uncertain, let snapshot else { return }
        await submit(.init(command: .init(accountId: accountId, target: .conversation(threadId), choice: choice, expectedRevision: snapshot.conversation.revision)), state: state)
    }
    func prepareSender(_ address: String, choice: ImportanceChoice?, state: AppState) async {
        guard !busy, !uncertain, let client = state.client else { return }
        busy = true; preview = nil; error = nil; let request = generation
        defer { if request == generation { busy = false } }
        do {
            let result = try await client.previewImportance(accountId: accountId, address: address, choice: choice)
            guard current(state, request), result.accountId == accountId,
                  result.address == address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), result.choice == choice,
                  result.future.accountId == accountId, result.future.address == result.address,
                  result.future.exactAddressOnly, result.future.preservesConversationOverrides,
                  result.future.otherImportantParticipantsMayKeepImportant else { return }
            preview = result
        } catch { if current(state, request) { self.error = error.localizedDescription } }
    }
    func cancelPreview() { preview = nil }
    func confirmSender(state: AppState) async {
        guard !busy, !uncertain, let preview, let expiry = MailDate.parse(preview.expiresAt), expiry > Date() else { self.preview = nil; error = "Preview expired. Review current effects again."; return }
        await submit(.init(command: .init(accountId: accountId, target: .sender(preview.address), choice: preview.choice, expectedRevision: preview.current.revision, confirmation: preview.confirmation)), state: state)
    }
    func undo(state: AppState) async {
        guard canUndo, let receipt else { return }
        let command = ImportanceCommand(accountId: accountId, target: receipt.target, choice: receipt.previousChoice, expectedRevision: receipt.revision)
        await submit(.init(command: command, undoReceipt: receipt), state: state)
    }
    private func submit(_ pending: Pending, state: AppState) async {
        guard let client = state.client, !busy, current(state, generation) else { return }
        var pending = pending
        if pending.contextThreadId == nil { pending.contextThreadId = threadId; pending.contextSubject = subject }
        persist(pending); busy = true; preview = nil; receipt = nil; status = nil; error = nil; let request = generation
        do {
            let result: ImportanceOperation
            if let undo = pending.undoReceipt { result = try await client.undoImportance(undo, operationId: pending.command.operationId) }
            else { result = try await client.chooseImportance(pending.command) }
            guard current(state, request) else { return }; await accept(result, state: state, request: request)
        } catch {
            guard current(state, request) else { return }
            busy = false
            // Every failure is reconciled, including HTTP errors. No receipt is inferred.
            await reconcile(state: state)
        }
        if request == generation { busy = false }
    }
    func reconcile(state: AppState) async {
        guard !busy, let pending, let client = state.client, current(state, generation) else { return }
        busy = true; error = nil; let request = generation
        defer { if request == generation { busy = false } }
        do {
            let result = try await client.importanceOperation(accountId: accountId, operationId: pending.command.operationId)
            guard current(state, request) else { return }; await accept(result, state: state, request: request)
        } catch APIClient.ClientError.http(404, _) {
            guard current(state, request) else { return }
            // Fresh authorized absence permits the SAME guarded UUID command, never a new write.
            error = "This operation is not recorded. Retry the original choice or review current state."
            status = nil
        } catch { if current(state, request) { self.error = "Save outcome unknown. Reconnect and check again before another choice. \(error.localizedDescription)" } }
    }
    func retryOriginal(state: AppState) async {
        guard !busy, let pending, let client = state.client else { return }
        // Confirm authorized absence immediately before replay; an offline check never authorizes it.
        let request = generation
        busy = true
        do {
            let found = try await client.importanceOperation(accountId: accountId, operationId: pending.command.operationId)
            guard current(state, request) else { return }; await accept(found, state: state, request: request); busy = false
        } catch APIClient.ClientError.http(404, _) {
            guard current(state, request) else { return }; busy = false; await submit(pending, state: state)
        } catch { if current(state, request) { busy = false; self.error = "Cannot confirm the save outcome. Check again when connected." } }
    }
    func reviewCurrent(state: AppState) async {
        guard !busy, let pending, let client = state.client else { return }
        busy = true; let request = generation
        do {
            let found = try await client.importanceOperation(accountId: accountId, operationId: pending.command.operationId)
            guard current(state, request) else { return }; await accept(found, state: state, request: request); busy = false
        } catch APIClient.ClientError.http(404, _) {
            guard current(state, request) else { return }
            persist(nil); receipt = nil; status = "Original choice was not recorded. Review the current choice."; busy = false
            await refresh(state: state)
        } catch { if current(state, request) { busy = false; self.error = "Cannot confirm the save outcome. Check again when connected." } }
    }
    private func accept(_ result: ImportanceOperation, state: AppState, request: UUID) async {
        guard let pending, result.receipt.accountId == accountId,
              result.receipt.operationId == pending.command.operationId, result.receipt.target == pending.command.target,
              result.receipt.choice == pending.command.choice, result.receipt.revision > pending.command.expectedRevision,
              result.current.revision >= result.receipt.revision,
              ["current", "superseded"].contains(result.status) else { error = "Server acknowledgement did not match this operation."; return }
        // Original receipt is never displayed as current when superseded.
        let originalThread = pending.contextThreadId ?? pending.command.target.threadId
        let sameConversation = originalThread == threadId
        receiptThreadId = sameConversation ? threadId : nil
        receipt = sameConversation && result.status == "current" && result.current.revision == result.receipt.revision ? result.receipt : nil
        if sameConversation { status = result.status == "superseded" ? "Choice changed elsewhere. Showing the current conversation." : "Choice saved." }
        else { status = "Earlier operation resolved for \(originalTarget ?? "a different conversation"). Showing this conversation’s current importance." }
        persist(nil)
        state.importanceDidChange(accountId: accountId)
        do {
            let latest = try await state.client?.importance(accountId: accountId, threadId: threadId)
            guard current(state, request) else { return }; snapshot = latest; discardKnownSupersededReceipt()
        } catch { if current(state, request) { snapshot = nil; self.error = "Choice recorded; current conversation could not be refreshed. Try again." } }
    }
}
