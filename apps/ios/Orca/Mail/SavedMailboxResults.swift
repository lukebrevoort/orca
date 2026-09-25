import SwiftUI

struct SavedMailboxResults: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var mailboxes: MailboxViews
    @StateObject private var reader = SavedViewReader()
    let view: SavedMailboxView
    let onOpen: (SavedViewThread) -> Void

    var body: some View {
        Group {
            if reader.loading && reader.page == nil {
                ProgressView("Loading view…")
            } else if let error = reader.error, reader.page == nil {
                VStack(spacing: 16) {
                    ContentUnavailableView("View unavailable", systemImage: "rectangle.stack", description: Text(error))
                    Button("Try again") { Task { await reload() } }.buttonStyle(.bordered)
                }
            } else {
                List {
                    Section {
                        if let page = reader.page, page.items.isEmpty {
                            ContentUnavailableView("No matching mail", systemImage: "tray", description: Text("New mail that matches this saved view will appear here."))
                                .listRowBackground(OrcaTheme.paper)
                        }
                        ForEach(reader.page?.items ?? []) { item in
                            Button { onOpen(item) } label: { SavedMailboxRow(item: item) }
                                .buttonStyle(.plain)
                                .listRowBackground(item.readState == "read" ? OrcaTheme.surface : OrcaTheme.unread)
                                .listRowSeparatorTint(OrcaTheme.border)
                                .listRowInsets(EdgeInsets(top: 15, leading: 20, bottom: 15, trailing: 16))
                                .accessibilityIdentifier("view.thread.\(item.threadId)")
                        }
                        if reader.page?.nextCursor != nil {
                            Button { Task { await reader.load(view: view, state: state, reset: false) } } label: {
                                if reader.loading { ProgressView("Loading more…") } else { Text("Load more") }
                            }.disabled(reader.loading).accessibilityIdentifier("view.load-more")
                        }
                        if let error = reader.error {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(error).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
                                Button("Reload view") { Task { await reload() } }
                            }.listRowBackground(OrcaTheme.paper)
                        }
                    } header: {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(view.name).font(OrcaTheme.reader(28)).foregroundStyle(OrcaTheme.ink)
                            if !view.description.isEmpty { Text(view.description).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted) }
                            Text("Matching mail across this view’s accounts").font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                        }.textCase(nil).fixedSize(horizontal: false, vertical: true).padding(.vertical, 12)
                    }
                }.listStyle(.plain).scrollContentBackground(.hidden)
                    .refreshable { await reload() }
                    .accessibilityIdentifier("view.results")
            }
        }
        .task(id: "\(state.ownerScope)|\(view.id)|\(view.revision)") { await reader.load(view: view, state: state) }
    }
    private func reload() async {
        await mailboxes.load(state: state)
        guard let current = mailboxes.selectedView, current.id == view.id else { return }
        await reader.load(view: current, state: state)
    }
}

private struct SavedMailboxRow: View {
    var item: SavedViewThread
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ContactGlyph(contact: item.sender)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(item.sender.name ?? item.sender.email).font(OrcaTheme.ui(12, weight: .semibold)).foregroundStyle(OrcaTheme.ink)
                    Spacer(minLength: 8)
                    Text(MailDate.compact(item.latestReceivedAt)).font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.muted)
                }
                Text(item.subject.isEmpty ? "(No subject)" : item.subject).font(OrcaTheme.ui(15, weight: item.readState == "read" ? .regular : .semibold)).foregroundStyle(OrcaTheme.ink)
                Text("\(item.accountEmail) · \(item.messageCount) \(item.messageCount == 1 ? "message" : "messages")")
                    .font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
            }
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(OrcaTheme.muted).accessibilityHidden(true)
        }.accessibilityElement(children: .combine)
        .accessibilityHint(item.readState == "read" ? "Open conversation" : "Unread conversation")
    }
}
