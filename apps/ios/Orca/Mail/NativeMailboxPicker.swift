import SwiftUI

/// One native disclosure, with typed option identifiers. A permanent All Mail
/// shortcut and this picker may share a label without sharing AX identity.
struct NativeMailboxPicker: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var mailboxes: MailboxViews
    @Environment(\.dismiss) private var dismiss
    let onLocalUtility: (String) -> Void
    var body: some View {
        NavigationStack {
            List {
                ForEach(mailboxes.groups) { group in
                    if !group.options.isEmpty {
                        Section(group.title) {
                            ForEach(group.options) { option in
                                Button { select(option.id) } label: {
                                    HStack(alignment: .top, spacing: 12) {
                                        if let symbol = option.symbol { Image(systemName: symbol).foregroundStyle(OrcaTheme.muted).accessibilityHidden(true) }
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(option.name).foregroundStyle(OrcaTheme.ink).fixedSize(horizontal: false, vertical: true)
                                            if let detail = option.detail { Text(detail).font(.caption).foregroundStyle(OrcaTheme.muted).fixedSize(horizontal: false, vertical: true) }
                                        }
                                        Spacer(minLength: 0)
                                        if mailboxes.selectedID == option.id { Image(systemName: "checkmark").accessibilityHidden(true) }
                                    }.frame(minHeight: 44, alignment: .leading).contentShape(Rectangle())
                                }.accessibilityIdentifier("mailbox.option." + option.id)
                                    .accessibilityAddTraits(mailboxes.selectedID == option.id ? [.isSelected] : [])
                                    .contextMenu {
                                        if !["important", "all", "normal"].contains(option.id) {
                                            Button("Hide on this device") {
                                                if option.id == "focus" { mailboxes.setEnabled("focus", false) } else { mailboxes.setHidden(option.id, true) }
                                            }
                                        }
                                    }
                            }
                        }
                    }
                }
                if !mailboxes.hiddenOptions.isEmpty {
                    Section("Hidden on this device") {
                        ForEach(mailboxes.hiddenOptions) { option in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(option.name).fixedSize(horizontal: false, vertical: true)
                                HStack {
                                    Button { mailboxes.restore(option.id) } label: { Text("Restore").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }
                                        .accessibilityIdentifier("mailbox.restore." + option.id)
                                    Button { mailboxes.restore(option.id); select(option.id) } label: { Text("Restore and open").fixedSize(horizontal: false, vertical: true).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }
                                        .accessibilityIdentifier("mailbox.restore-open." + option.id)
                                }.buttonStyle(.bordered).frame(minHeight: 44)
                            }
                        }
                    }
                }
                Section {
                    if let account = state.selectedAccount { Text(account.email).font(.subheadline) }
                    Text("Spaces keep workspace names and order. Collections and pins belong to the selected account. Visibility is saved on this device and does not change notifications.")
                        .font(.caption).foregroundStyle(OrcaTheme.muted)
                    if let error = mailboxes.error { Text(error) }
                    if let error = mailboxes.browser.spaceError { Text(error) }
                    if let error = mailboxes.browser.catalogError { Text(error) }
                    Button { Task { await mailboxes.load(state: state) } } label: { Text("Refresh choices").frame(minHeight: 44).contentShape(Rectangle()) }
                        .disabled(mailboxes.loading).accessibilityIdentifier("mailbox.catalog.reload")
                }
            }.accessibilityIdentifier("mailbox.choices")
                .navigationTitle("Mailboxes").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button { dismiss() } label: { Text("Done").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) } } }
        }
    }
    private func select(_ id: String) {
        guard let identity = mailboxes.identity(for: id) else { return }
        guard let context = state.nativeMailContext() else {
            // Existing fixed Mail lenses still support their owned offline cache.
            // This does not authorize a new Organization request or saved target.
            if identity.kind == .utility { onLocalUtility(id); dismiss() }
            return
        }
        state.routeMailbox(.init(identity: identity, context: context)); dismiss()
    }
}
