import Foundation

struct MailboxOption: Identifiable, Equatable { var id: String; var name: String }

/// Browsing choices belong to this signed-in identity on this device, independently of push.
struct MailboxPreferenceStore {
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    func load(scope: String) -> Set<String> {
        Set(defaults.stringArray(forKey: "mailboxViews|\(scope)") ?? ["focus", "all"])
    }
    func save(_ ids: Set<String>, scope: String) {
        defaults.set(ids.sorted(), forKey: "mailboxViews|\(scope)")
    }
}

/// Phase A extraction of the existing native disclosure, including its current
/// legacy destination exclusions. This is not the expanded navigation catalog.
enum NativeMailboxProjection {
    static func options(destinations: [MailboxOption], views: [SavedMailboxView], enabledIDs: Set<String>) -> [MailboxOption] {
        [MailboxOption(id: "important", name: "Important"), MailboxOption(id: "all", name: "All Mail"), MailboxOption(id: "normal", name: "Inbox")]
            + [MailboxOption(id: "focus", name: "Focus")].filter { enabledIDs.contains($0.id) }
            + destinations
            + views.filter { enabledIDs.contains($0.selectionID) }.map { MailboxOption(id: $0.selectionID, name: $0.name) }
    }

    /// nil means the existing load path leaves its prior destinations unchanged.
    static func destinations(routing: MailActionJSON) -> [MailboxOption]? {
        guard case .array(let items) = routing["destinations"] else { return nil }
        let builtIns = [routing["legacyDestinationIds"]["normal"].text, routing["legacyDestinationIds"]["focus"].text]
        return items.compactMap { item in
            guard let id = item["id"].text, let name = item["name"].text, !builtIns.contains(id), item["retiredAt"].text == nil else { return nil }
            return MailboxOption(id: "destination:" + id, name: name)
        }
    }

    static func unavailableIDs(enabledIDs: Set<String>, views: [SavedMailboxView]) -> [String] {
        enabledIDs.filter { id in id.hasPrefix("view:") && !views.contains(where: { $0.selectionID == id }) }.sorted()
    }
}

/// The current inbox endpoint mapping, kept separate from display labels.
/// In particular native Focus still uses the normal destination plus view=focus.
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
