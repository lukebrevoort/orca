import Foundation

struct MailboxOption: Identifiable, Equatable { var id: String; var name: String; var detail: String? = nil; var symbol: String? = nil }

/// Browsing choices belong to this signed-in identity on this device, independently of push.
struct MailboxPreferenceStore {
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    func load(scope: String) -> Set<String> {
        Set(defaults.stringArray(forKey: "mailboxViews|\(scope)") ?? ["focus", "all"])
    }
    func loadHidden(scope: String) -> Set<String> {
        Set(defaults.stringArray(forKey: "mailboxHiddenV1|\(scope)") ?? [])
    }
    func saveHidden(_ ids: Set<String>, scope: String) {
        defaults.set(ids.sorted(), forKey: "mailboxHiddenV1|\(scope)")
    }
    func save(_ ids: Set<String>, scope: String) {
        defaults.set(ids.sorted(), forKey: "mailboxViews|\(scope)")
    }
}

/// Workspace names and order are server-owned; built-in IDs are real Spaces.
/// The Inbox focus utility remains a separate local lens.
enum NativeMailboxProjection {
    static func options(destinations: [MailboxOption], views: [SavedMailboxView], enabledIDs: Set<String>) -> [MailboxOption] {
        [MailboxOption(id: "important", name: "Important"), MailboxOption(id: "all", name: "All Mail"), MailboxOption(id: "normal", name: "Inbox")]
            + [MailboxOption(id: "focus", name: "Inbox focus")].filter { enabledIDs.contains($0.id) }
            + destinations
            + views.filter { enabledIDs.contains($0.selectionID) }.map { MailboxOption(id: $0.selectionID, name: $0.name) }
    }

    /// nil means the existing load path leaves its prior destinations unchanged.
    static func destinations(routing: MailActionJSON) -> [MailboxOption]? {
        guard case .array(let items) = routing["destinations"] else { return nil }
        return items.compactMap { item in
            guard let id = item["id"].text, let name = item["name"].text, item["retiredAt"].text == nil else { return nil }
            return MailboxOption(id: "destination:" + id, name: name)
        }
    }

    /// Preserve the legacy Saved View fallback without changing new catalog routes.
    static func selectionAfterCatalogRefresh(_ selectedID: String, options: [MailboxOption]) -> String {
        if selectedID.hasPrefix("view:") && !options.contains(where: { $0.id == selectedID }) {
            return "important"
        }
        return selectedID
    }

    static func unavailableIDs(enabledIDs: Set<String>, views: [SavedMailboxView]) -> [String] {
        enabledIDs.filter { id in id.hasPrefix("view:") && !views.contains(where: { $0.selectionID == id }) }.sorted()
    }
}

/// The current inbox endpoint mapping, kept separate from display labels.
/// The separate Inbox focus utility uses the Inbox destination plus view=focus;
/// an actual named Focus Space is destination:<opaqueID> with view=all.
enum NativeMailboxRequestScope {
    static func requiresDestinationCatalog(view: String) -> Bool {
        view != "all" && view != "important" && !view.hasPrefix("destination:")
    }
    static func destinationID(view: String, routing: MailActionJSON? = nil) -> String? {
        if view == "all" || view == "important" { return nil }
        if view.hasPrefix("destination:") { return String(view.dropFirst(12)) }
        return routing?["legacyDestinationIds"][view == "focus" ? "normal" : view].text
    }
    static func apiView(view: String, destinationID: String?) -> String {
        view.hasPrefix("destination:") || (view == "normal" && destinationID != nil) ? "all" : view
    }
}

struct NativeMailboxGroup: Identifiable {
    var id: String; var title: String; var options: [MailboxOption]
}
