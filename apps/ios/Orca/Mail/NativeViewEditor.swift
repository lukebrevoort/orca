import SwiftUI

/// Native simple edits retain the complete server draft/definition, including advanced clauses.
struct NativeViewEditor: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var mailboxes: MailboxViews
    @Environment(\.dismiss) private var dismiss
    let selection: NativeViewSelection
    @StateObject private var model = NativeViewEditorController()
    @State private var leave = false
    var body: some View {
        NavigationStack {
            Form {
                Section("Scope") {
                    Text(state.accounts.first { $0.id == selection.accountId }?.email ?? "Account unavailable")
                    Text("A saved view groups mail. Preview creates nothing. Saving does not grant notifications or move mail.").font(.subheadline)
                    if model.draft?["skipInbox"].flag == true {
                        Text("This existing advanced view skips Inbox. Its saved routing behavior is preserved; this editor does not change that policy.").font(.subheadline)
                    }
                }
                if let original = model.pendingTarget {
                    Section(model.appliedTarget == nil ? "Save outcome unknown" : "Original View saved") {
                        Text(original).textSelection(.enabled)
                        Text(model.appliedTarget == nil ? "Retry sends the identical original command. Newer edits stay separate until its outcome is known. Closing this editor keeps that command." : "The original View was saved. Its current object must be loaded before editing; no replacement will be created.")
                        Button("Check Save outcome") { Task { await save(checkOnly: true) } }.accessibilityIdentifier("view-editor.check-outcome")
                        if model.appliedTarget == nil { Button("Retry original Save") { Task { await save() } }.accessibilityIdentifier("view-editor.reconcile") }
                    }
                }
                if let status = model.status { Section { Text(status).accessibilityIdentifier("view-editor.status") } }
                if model.draft != nil {
                    Section("View") {
                        TextField("View name", text: $model.name).accessibilityIdentifier("view-editor.name")
                        TextField("Description", text: $model.description, axis: .vertical)
                        if let query = selection.query, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text("Search “\(query)” matches sender, subject and snippet. A saved view cannot preserve general text search.")
                            Toggle("Replace search with subject contains", isOn: $model.replaceSearch)
                            if model.replaceSearch { TextField("Subject contains", text: $model.subject).accessibilityIdentifier("view-editor.subject") }
                            Text("Only this explicit replacement enables Save. Cancel returns to your unchanged search.").font(.caption)
                        }
                        DisclosureGroup("Retained filters") {
                            Text(model.draft?["summary"]["text"].text ?? "The complete prepared definition is retained.")
                            Text("Advanced filters, account scope, ordering and policy are preserved. Use web Organization for other filter or policy changes.").font(.caption)
                        }
                        Button("Preview matching mail") { Task { await model.review() } }.disabled(model.pendingTarget != nil || model.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("view-editor.preview")
                    }
                } else if !model.busy { Button("Load view") { Task { await model.load() } } }
                if let preview = model.preview {
                    Section("Actual preview") {
                        Text(preview["draft"]["summary"]["text"].text ?? "")
                        Text("\(preview["results"]["count"]["value"].integer ?? 0) matching conversations \(preview["results"]["count"]["kind"].text == "exact" ? "in this preview" : "shown; more may match")")
                        if case .array(let items) = preview["results"]["items"] {
                            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                                VStack(alignment: .leading) { Text(item["subject"].text ?? "(No subject)"); Text(item["accountEmail"].text ?? "").font(.caption) }
                            }
                        }
                        if !preview["draft"]["saveEligibility"]["allowed"].flag { Text(preview["draft"]["saveEligibility"]["detail"].text ?? "Resolve unsupported criteria before saving.") }
                        Button(preview["results"]["state"].text == "zero" ? "Save empty View" : "Save View") { Task { await save() } }
                            .disabled(!preview["draft"]["saveEligibility"]["allowed"].flag).accessibilityIdentifier("view-editor.save")
                    }
                }
                if model.busy { ProgressView("Working…") }
                if let error = model.error { Text(error).foregroundStyle(OrcaTheme.danger) }
            }.disabled(model.busy)
                .navigationTitle(selection.viewId == nil ? "Save search as View" : "Edit View").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { if model.changed { leave = true } else { dismiss() } }.disabled(model.busy) } }
                .interactiveDismissDisabled(model.changed || model.busy)
                .confirmationDialog("Discard view edits?", isPresented: $leave, titleVisibility: .visible) {
                    Button("Keep editing", role: .cancel) { }
                    Button(model.pendingTarget == nil ? "Discard edits" : (model.appliedTarget == nil ? "Close and keep pending Save" : "Close and keep recovered View"), role: .destructive) { model.discardEdits(); dismiss() }
                }
                .task { await model.open(selection: selection, state: state) }
                .onChange(of: model.name) { model.edited() }.onChange(of: model.description) { model.edited() }
                .onChange(of: model.subject) { model.edited() }.onChange(of: model.replaceSearch) { model.edited() }
                .onDisappear { model.close() }
                .onChange(of: state.ownerScope) { model.close(); dismiss() }
                .onChange(of: state.selectedAccountID) { model.close(); dismiss() }
        }
    }
    private func save(checkOnly: Bool = false) async {
        let owner = state.ownerScope
        let result = checkOnly ? await model.checkSaveOutcome() : await model.save()
        if let id = result {
            await mailboxes.load(state: state)
            guard model.canFinishPresentation, owner == state.ownerScope, state.selectedAccount?.id == selection.accountId, state.phase == .ready, state.accounts.contains(where: { $0.id == selection.accountId }) else { return }
            mailboxes.setEnabled("view:" + id, true); mailboxes.selectedID = "view:" + id
            dismiss()
        }
    }
}
