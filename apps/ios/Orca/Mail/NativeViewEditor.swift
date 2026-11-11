import SwiftUI

struct NativeViewSelection: Identifiable {
    var viewId: String?; var query: String?; var accountId: String
    var id: String { viewId ?? "search|" + (query ?? "") }
}
extension MailActionJSON {
    func setting(_ key: String, to value: Self) -> Self {
        guard case .object(var values) = self else { return .object([key: value]) }
        values[key] = value; return .object(values)
    }
}
/// Native simple edits retain the complete server draft/definition, including advanced clauses.
struct NativeViewEditor: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var mailboxes: MailboxViews
    @Environment(\.dismiss) private var dismiss
    let selection: NativeViewSelection
    @State private var draft: MailActionJSON?
    @State private var preview: MailActionJSON?
    @State private var name = ""
    @State private var description = ""
    @State private var subject = ""
    @State private var replaceSearch = false
    @State private var busy = false
    @State private var error: String?
    @State private var scope = ""
    @State private var presented = true
    @State private var changed = false
    @State private var baseline = [String]()
    @State private var leave = false
    @State private var retryKey = UUID().uuidString
    private var current: Bool { presented && !Task.isCancelled && scope == state.ownerScope && state.phase == .ready && state.accounts.contains { $0.id == selection.accountId } }
    var body: some View {
        NavigationStack {
            Form {
                Section("Scope") {
                    Text(state.accounts.first { $0.id == selection.accountId }?.email ?? "Account unavailable")
                    Text("A saved view groups mail. Preview creates nothing. Saving does not grant notifications or move mail.").font(.subheadline)
                    if draft?["skipInbox"].flag == true {
                        Text("This existing advanced view skips Inbox. Its saved routing behavior is preserved; this editor does not change that policy.").font(.subheadline)
                    }
                }
                if draft != nil {
                    Section("View") {
                        TextField("View name", text: $name).accessibilityIdentifier("view-editor.name")
                        TextField("Description", text: $description, axis: .vertical)
                        if let query = selection.query, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text("Search “\(query)” matches sender, subject and snippet. A saved view cannot preserve general text search.")
                            Toggle("Replace search with subject contains", isOn: $replaceSearch)
                            if replaceSearch { TextField("Subject contains", text: $subject).accessibilityIdentifier("view-editor.subject") }
                            Text("Only this explicit replacement enables Save. Cancel returns to your unchanged search.").font(.caption)
                        }
                        DisclosureGroup("Retained filters") {
                            Text(draft?["summary"]["text"].text ?? "The complete prepared definition is retained.")
                            Text("Advanced filters, account scope, ordering and policy are preserved. Use web Organization for other filter or policy changes.").font(.caption)
                        }
                        Button("Preview matching mail") { Task { await review() } }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("view-editor.preview")
                    }
                } else if !busy { Button("Load view") { Task { await load() } } }
                if let preview {
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
                if busy { ProgressView("Working…") }
                if let error { Text(error).foregroundStyle(OrcaTheme.danger) }
            }.disabled(busy)
                .navigationTitle(selection.viewId == nil ? "Save search as View" : "Edit View").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { if changed { leave = true } else { dismiss() } }.disabled(busy) } }
                .interactiveDismissDisabled(changed || busy)
                .confirmationDialog("Discard view edits?", isPresented: $leave, titleVisibility: .visible) {
                    Button("Keep editing", role: .cancel) { }
                    Button("Discard edits", role: .destructive) { dismiss() }
                }
                .task { await load() }
                .onChange(of: name) { edited() }.onChange(of: description) { edited() }
                .onChange(of: subject) { edited() }.onChange(of: replaceSearch) { edited() }
                .onDisappear { presented = false }
                .onChange(of: state.ownerScope) { presented = false; dismiss() }
                .onChange(of: state.selectedAccountID) { presented = false; dismiss() }
        }
    }
    private func edited() { guard draft != nil else { return }; changed = [name, description, subject, String(replaceSearch)] != baseline; preview = nil; retryKey = UUID().uuidString }
    private func load() async {
        scope = state.ownerScope; presented = true; busy = true; error = nil; defer { busy = false }
        guard let client = state.client else { return }
        let body: MailActionJSON
        if let id = selection.viewId { body = .object(["kind": .string("saved_view"), "viewId": .string(id)]) }
        else {
            let query = selection.query?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            body = .object([
                "kind": .string("typed_definition"), "skipInbox": .bool(false),
                "source": .object(["kind": .string("search"), "label": .string("Native All Mail search")]),
                "identity": .object(["name": .string(String(("Search · " + query).prefix(120)))]),
                "definition": .object(["revision": .number(1), "accountIds": .array([.string(selection.accountId)])]),
                "unsupportedClauses": query.isEmpty ? .array([]) : .array([.object(["id": .string("search.query"), "label": .string("General text search"), "reason": .string("General sender, subject and snippet search cannot be represented as a saved-view predicate.")])])
            ])
        }
        do {
            let result: MailActionJSON = try await client.request("v1/organization/views/prepare", method: "POST", body: body)
            guard current else { return }
            name = result["draft"]["identity"]["name"].text ?? ""; description = result["draft"]["identity"]["description"].text ?? ""
            subject = selection.query ?? ""; baseline = [name, description, subject, "false"]; draft = result["draft"]; changed = false
        } catch { if current { self.error = error.localizedDescription } }
    }
    private func review() async {
        guard current, !busy, let client = state.client, let draft else { return }
        busy = true; error = nil; defer { busy = false }
        var input = draft.keeping(["mode", "skipInbox", "viewId", "viewRevision", "source", "identity", "definition", "unsupportedClauses"])
        input = input.setting("identity", to: draft["identity"].setting("name", to: .string(name.trimmingCharacters(in: .whitespacesAndNewlines))).setting("description", to: .string(description)))
        if selection.query != nil && replaceSearch && !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            input = input.setting("definition", to: draft["definition"].setting("thread", to: draft["definition"]["thread"].setting("subjectContains", to: .string(subject.trimmingCharacters(in: .whitespacesAndNewlines)))))
                .setting("unsupportedClauses", to: .array([]))
        }
        do {
            let result: MailActionJSON = try await client.request("v1/organization/views/preview", method: "POST", body: MailActionJSON.object(["draft": input, "page": .object(["limit": .number(25)])]))
            guard current else { return }; preview = result
        } catch { if current { self.error = error.localizedDescription } }
    }
    private func save() async {
        guard current, !busy, let client = state.client, let preview, preview["draft"]["saveEligibility"]["allowed"].flag else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let result: MailActionJSON = try await client.request("v1/organization/views/commit", method: "POST", body: MailActionJSON.object([
                "draft": preview["draft"], "expectedRevisions": .object(["workspace": preview["workspaceRevision"], "view": preview["draft"]["viewRevision"]]),
                "retryKey": .string(retryKey), "confirmedZeroMatchDigest": preview["results"]["state"].text == "zero" ? preview["draft"]["definitionDigest"] : .null
            ]))
            guard current else { return }; await mailboxes.load(state: state)
            guard current else { return }
            if let id = result["view"]["id"].text { mailboxes.setEnabled("view:" + id, true); mailboxes.selectedID = "view:" + id }
            changed = false; dismiss()
        } catch { if current { self.error = error.localizedDescription } }
    }
}
