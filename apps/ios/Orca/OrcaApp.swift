import SwiftUI
import UniformTypeIdentifiers
import AVKit
import PhotosUI
import CoreTransferable
import ImageIO

@main struct OrcaApp: App {
    @UIApplicationDelegateAdaptor(NotificationManager.self) var notifications
    @StateObject private var state = AppState()
    @Environment(\.scenePhase) private var scenePhase
    init() { OrcaTheme.configureNavigation(); FeedbackTicketModel.removeAbandonedPreviews(); FeedbackVideoWriter.removeAbandonedFiles() }
    var body: some Scene { WindowGroup { RootView().environmentObject(state).environmentObject(notifications).tint(OrcaTheme.accent).font(OrcaTheme.ui(15)).foregroundStyle(OrcaTheme.ink).task { notifications.state = state; await notifications.refreshPermission(); await state.start(); if state.phase == .ready { notifications.openPendingNotification(); notifications.reconcile() } }.onChange(of: state.phase) { if state.phase == .ready { notifications.openPendingNotification(); notifications.reconcile() } }.onChange(of: scenePhase) { if scenePhase == .active && state.phase == .ready { notifications.reconcile() } }.alert("Orca", isPresented: Binding(get: { state.errorMessage != nil }, set: { if !$0 { state.errorMessage = nil } })) { Button("OK") { state.errorMessage = nil } } message: { Text(state.errorMessage ?? "") } } }
}

struct RootView: View {
    @AppStorage("orca.appearance") private var appearance = "system"
    @EnvironmentObject var state: AppState
    var body: some View { Group { switch state.phase {
    case .configuring:
#if DEBUG
        ServerSetupView()
#else
        ContentUnavailableView("Orca needs an update", systemImage: "exclamationmark.triangle", description: Text("The app’s connection settings are missing. Please install the latest build."))
#endif
    case .signedOut: SignInView()
    case .loading: ProgressView("Opening Orca")
    case .ready: MainView()
    } }.background(OrcaTheme.paper).preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil) }
}

struct ServerSetupView: View {
    @EnvironmentObject var state: AppState
    var body: some View { NavigationStack { VStack(alignment: .leading, spacing: 22) { Spacer(); Image(systemName: "water.waves").font(.system(size: 50)).foregroundStyle(OrcaTheme.accent); Text("A calmer current").font(.largeTitle.bold()); Text("Connect Orca to your team’s secure server. Production servers must use HTTPS.").foregroundStyle(.secondary); TextField("https://mail.example.com", text: $state.baseURLText).textInputAutocapitalization(.never).keyboardType(.URL).textFieldStyle(.roundedBorder).accessibilityLabel("Orca API server"); Button("Continue") { Task { await state.saveServer() } }.buttonStyle(OrcaPrimaryButtonStyle()).controlSize(.large); Spacer() }.padding(28) } }
}
struct SignInView: View {
    @EnvironmentObject var state: AppState
    var body: some View { VStack(spacing: 20) { Spacer(); Image(systemName: "water.waves").font(.system(size: 54)).foregroundStyle(OrcaTheme.accent); Text("Orca").font(.largeTitle.bold()); Text("Read and write with less noise.").foregroundStyle(.secondary); Button("Continue with Google") { Task { await state.signIn() } }.buttonStyle(OrcaPrimaryButtonStyle()).controlSize(.large)
#if DEBUG
        Button("Change server") { state.phase = .configuring }
#endif
        Spacer() }.padding() }
}
struct MainView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var mailboxes = MailboxViews()
    @StateObject private var importance = ImportanceController()
    @StateObject private var preferences = AccountPreferencesController()
    @State private var pendingTab: String?
    @State private var confirmSettingsLeave = false
    @StateObject private var feedback = FeedbackTicketModel()
    @StateObject private var capture = FeedbackCaptureController()
    @StateObject private var captureWindow = FeedbackWindowReference()
    @State private var captureRequest: FeedbackCaptureAction?
    @State private var captureRequestScope = ""
    @State private var captureGeneration = UUID()
    private var captureScope: String { state.ownerScope + "|" + (state.selectedAccount?.id ?? "") }
    @State private var feedbackPresented = false
    var body: some View {
        // NavigationStack destinations own their reading/writing insets. An
        // inset outside those stacks can be reset by destination/tab-bar layout,
        // painting Feedback over the destination's actions above the keyboard.
        // A sibling takes real height out of the navigation proposal instead.
        // Keyboard avoidance and Dynamic Type resize this one shared row;
        // there is no per-screen visibility bookkeeping or guessed padding.
        VStack(spacing: 0) {
            TabView(selection: Binding(get: { state.selectedTab }, set: { tab in
                if state.selectedTab == "settings", tab != "settings", preferences.dirty || preferences.saving { pendingTab = tab; confirmSettingsLeave = true }
                else { state.selectedTab = tab }
            })) {
                InboxView().tabItem { Label("Mail", systemImage: "tray") }.tag("inbox")
                DraftsView().tabItem { Label("Drafts", systemImage: "doc.text") }.tag("drafts")
                SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }.tag("settings")
            }
            feedbackCorner
                .frame(maxWidth: .infinity, alignment: .trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
        .background(OrcaTheme.paper)
        .environmentObject(mailboxes)
        .environmentObject(importance)
        .environmentObject(preferences)
        .onChange(of: state.ownerScope) { preferences.invalidate() }
        .confirmationDialog("Leave unsaved account choices?", isPresented: $confirmSettingsLeave, titleVisibility: .visible) {
            Button("Stay", role: .cancel) { pendingTab = nil }
            Button("Discard edits and leave", role: .destructive) { if !preferences.saving { preferences.discard(); state.selectedTab = pendingTab ?? "settings"; pendingTab = nil } }.disabled(preferences.saving)
        } message: { Text("Stay to save or continue editing. Section changes keep your edits.") }
        .onChange(of: captureScope) { importance.invalidate() }
        .background(FeedbackWindowProbe(reference: captureWindow).frame(width: 0, height: 0))
        .sheet(isPresented: $feedbackPresented, onDismiss: performCaptureAfterDismissal) {
            FeedbackTicketComposer(model: feedback, capture: capture) { action in
                captureGeneration = UUID()
                captureRequest = action; captureRequestScope = captureScope
                feedbackPresented = false
            }.environmentObject(state)
        }
        .task(id: captureScope) {
            capture.configure(scope: captureScope)
            capture.onReturnToComposer = { receiveCapture() }
        }
        .onChange(of: captureScope) { _, scope in
            captureGeneration = UUID(); captureRequest = nil; capture.configure(scope: scope)
        }
        .onDisappear { captureGeneration = UUID(); captureRequest = nil; capture.onReturnToComposer = nil; capture.cancel() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
            captureGeneration = UUID(); captureRequest = nil; capture.cancel()
        }
        .task(id: state.ownerScope) {
            feedback.configure(scope: state.ownerScope)
            if let client = state.client, !state.demoMode {
                await feedback.checkAvailability(client: client, scope: state.ownerScope)
            }
        }
        .onChange(of: state.ownerScope) { _, scope in
            feedbackPresented = false
            feedback.configure(scope: scope)
        }
        .task(id: state.ownerScope) { await mailboxes.load(state: state) }
        .task(id: state.ownerScope) { await preferences.load(state: state) }
        .onChange(of: scenePhase) {
            if scenePhase == .active {
                Task {
                    try? await state.refreshAccountCapabilities()
                    await mailboxes.load(state: state)
                    if let client = state.client, !state.demoMode {
                        await feedback.checkAvailability(client: client, scope: state.ownerScope)
                    }
                }
            }
        }
        .modifier(FeedbackShortLayoutFixture())
    }
    private func performCaptureAfterDismissal() {
        guard let action = captureRequest else { return }
        captureRequest = nil
        guard captureRequestScope == captureScope, feedback.canAddMedia,
              UIApplication.shared.applicationState == .active else { return }
        let window = captureWindow.window
        let requestedScope = captureRequestScope
        let requestedGeneration = captureGeneration
        if action == .screenshot {
            feedbackCaptureTrace("sheet_dismissed")
            // SwiftUI is still completing its dismissal/layout transaction here.
            // Capture after this callback returns, without a timed delay or a
            // forced recursive window layout. Fence navigation/account changes.
            DispatchQueue.main.async { [weak window] in
                guard let window, window === captureWindow.window,
                      requestedGeneration == captureGeneration,
                      requestedScope == captureScope, capture.scope == requestedScope,
                      feedback.canAddMedia, !feedbackPresented, !capture.active,
                      UIApplication.shared.applicationState == .active,
                      window.windowScene?.activationState == .foregroundActive else { return }
                capture.screenshot(window: window, scope: requestedScope)
                receiveCapture()
            }
        } else {
            Task { await capture.start(scope: requestedScope, windowScene: window?.windowScene) }
        }
    }
    private func receiveCapture() {
        guard capture.scope == captureScope else { return }
        if let result = capture.result, result.scope == captureScope {
            feedbackCaptureTrace("attachment_begin")
            feedback.attachCapture(result, scope: state.ownerScope)
            feedbackCaptureTrace("attachment_end")
            capture.clearResult()
        }
        if UIApplication.shared.applicationState == .active {
            feedbackCaptureTrace("composer_reopen")
            feedbackPresented = true
        }
    }
    @ViewBuilder private var feedbackCorner: some View {
        if feedback.available && !capture.active {
            Button { feedbackPresented = true } label: {
                Label("Feedback", systemImage: "bubble.left")
                    .font(OrcaTheme.ui(11, weight: .semibold))
                    .padding(.horizontal, 12).frame(minHeight: 44)
                    .foregroundStyle(OrcaTheme.ink)
                    .background(OrcaTheme.surface, in: Capsule())
                    .overlay(Capsule().stroke(OrcaTheme.border))
            }.buttonStyle(.plain)
                .accessibilityIdentifier("feedback.open")
                .accessibilityHint("Send a note to your Linear")
                .padding(.trailing, 16).padding(.vertical, 4)
        }
    }
}

/// Only the authenticated loopback UI harness can request a shorter proposal.
/// This drives the real navigation/footer/keyboard hierarchy on the hosted
/// phone; it does not substitute a screenshot or change production sizing.
private struct FeedbackShortLayoutFixture: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
#if DEBUG
        if Self.enabled {
            GeometryReader { geometry in
                content
                    .frame(height: max(1, geometry.size.height - 120))
                    .frame(maxHeight: .infinity, alignment: .bottom)
            }
        } else { content }
#else
        content
#endif
    }
#if DEBUG
    private static var enabled: Bool {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("--fixture-short-layout"),
              let index = args.firstIndex(of: "--fixture-api-url"), args.indices.contains(index + 1),
              let url = URL(string: args[index + 1]), url.scheme == "http",
              ["127.0.0.1", "localhost"].contains(url.host),
              let tokenIndex = args.firstIndex(of: "--fixture-access-token"), args.indices.contains(tokenIndex + 1),
              !args[tokenIndex + 1].isEmpty else { return false }
        return true
    }
#endif
}

private struct FeedbackPickedMedia: Transferable {
    let data: Data
    let name: String
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .data) { received in
            let handle = try FileHandle(forReadingFrom: received.file)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: 10 * 1_024 * 1_024 + 1) ?? Data()
            guard !data.isEmpty, data.count <= 10 * 1_024 * 1_024 else { throw FeedbackTicketModel.MediaError.size }
            return Self(data: data, name: received.file.lastPathComponent)
        }
    }
}

@MainActor final class FeedbackTicketModel: ObservableObject {
    @Published var message = ""
    @Published private(set) var attachments: [FeedbackAttachment] = []
    @Published private(set) var reviewed: Set<String> = []
    @Published private(set) var importing = false
    private var previewURLs: [String: URL] = [:]
    @Published private(set) var pending: FeedbackTicketInput?
    @Published private(set) var available = false
    @Published private(set) var busy = false
    @Published private(set) var receipt: FeedbackTicketReceipt?
    @Published private(set) var error: String?
    private var scope = ""
    private var generation = UUID()
    private var checking = false
    var canAddMedia: Bool { available && pending == nil && !busy && !importing && attachments.count < 3 }
    func attachCapture(_ capture: FeedbackCapturedMedia, scope: String) {
        guard self.scope == scope, canAddMedia else { return }
        do { try addAttachment(data: capture.data, name: capture.name, mime: capture.mime); error = nil }
        catch { self.error = "Could not attach this capture. Keep each capture under 10 MiB and all attachments under 20 MiB." }
    }
    var canSubmit: Bool {
        available && !importing && (pending != nil || (attachments.allSatisfy { reviewed.contains($0.id) } && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && message.utf16.count <= 10_000))
    }
    func configure(scope: String) {
        guard self.scope != scope else { return }
        self.scope = scope; generation = UUID()
        clearAttachments()
        message = ""; pending = nil; available = false; busy = false
        receipt = nil; error = nil; checking = false
    }
    func checkAvailability(client: APIClient, scope: String) async {
        guard scope == self.scope, !checking else { return }
        let generation = generation
        checking = true
        defer { if generation == self.generation { checking = false } }
        do {
            let response: FeedbackTicketAvailability = try await client.request("v1/feedback/ticket")
            guard generation == self.generation else { return }
            available = response.available
        } catch {
            guard generation == self.generation else { return }
            available = false
        }
    }
    func send(client: APIClient, scope: String) async {
        guard scope == self.scope, !busy, canSubmit else { return }
        let generation = generation
        busy = true; error = nil; receipt = nil
        if pending == nil { pending = FeedbackTicketInput(message: message.trimmingCharacters(in: .whitespacesAndNewlines), attachments: attachments.isEmpty ? nil : attachments) }
        defer { if generation == self.generation { busy = false } }
        do {
            let confirmed: FeedbackTicketReceipt = try await client.request("v1/feedback/ticket", method: "POST", body: pending)
            guard generation == self.generation else { return }
            guard !confirmed.identifier.isEmpty, confirmed.issueURL != nil else { throw APIClient.ClientError.invalidResponse }
            receipt = confirmed; pending = nil; message = ""; clearAttachments()
        } catch {
            guard generation == self.generation else { return }
            if case let APIClient.ClientError.http(status, body) = error,
               (status == 400 && ["invalid_feedback", "invalid_attachment"].contains(body?.code ?? "")) ||
               (status == 413 && body?.code == "payload_too_large") {
                pending = nil
                self.error = "Your feedback was not sent. Check the note and selected files, then try again."
            } else {
                self.error = "We could not confirm a Linear ticket. Your note is still here. Retry to check or finish this same submission."
            }
        }
    }
    nonisolated static let mediaTypes: [String: String] = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime"]
    nonisolated static func removeAbandonedPreviews() {
        // Called once at application startup, before any live draft exists.
        let directory = FileManager.default.temporaryDirectory
        for url in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
            let stem = url.deletingPathExtension().lastPathComponent
            guard stem.hasPrefix("orca-feedback-"), UUID(uuidString: String(stem.dropFirst("orca-feedback-".count))) != nil else { continue }
            try? FileManager.default.removeItem(at: url)
        }
    }
    deinit { for url in previewURLs.values { try? FileManager.default.removeItem(at: url) } }
    func previewURL(for id: String) -> URL? { previewURLs[id] }
    func review(_ id: String) {
        guard pending == nil, !busy, attachments.contains(where: { $0.id == id }) else { return }
        reviewed.insert(id)
    }
    func removeAttachment(_ id: String) {
        guard pending == nil, !busy, !importing else { return }
        attachments.removeAll { $0.id == id }; reviewed.remove(id)
        if let url = previewURLs.removeValue(forKey: id) { try? FileManager.default.removeItem(at: url) }
    }
    private func clearAttachments() {
        for url in previewURLs.values { try? FileManager.default.removeItem(at: url) }
        previewURLs = [:]; attachments = []; reviewed = []; importing = false
    }
    func importFiles(_ urls: [URL], scope: String) async {
        guard self.scope == scope, pending == nil, !busy, !importing else { return }
        guard attachments.count + urls.count <= 3 else { error = "Choose up to 3 files."; return }
        let generation = generation
        importing = true; error = nil
        defer { if generation == self.generation { importing = false } }
        for url in urls {
            do {
                let loaded = try await Task.detached { () throws -> (Data, String) in
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    guard let mime = Self.mediaTypes[url.pathExtension.lowercased()] else { throw MediaError.unsupported }
                    let handle = try FileHandle(forReadingFrom: url)
                    defer { try? handle.close() }
                    let data = try handle.read(upToCount: 10 * 1_024 * 1_024 + 1) ?? Data()
                    guard !data.isEmpty, data.count <= 10 * 1_024 * 1_024 else { throw MediaError.size }
                    return (data, mime)
                }.value
                guard generation == self.generation else { return }
                try addAttachment(data: loaded.0, name: url.lastPathComponent, mime: loaded.1)
            } catch {
                guard generation == self.generation else { return }
                self.error = "Could not add this file. Use PNG, JPEG, WebP, MP4, WebM or MOV; up to 10 MiB each and 20 MiB total. Images must fit within 8192 pixels per side and 32 megapixels."
            }
        }
    }
    func importPhotos(_ items: [PhotosPickerItem], scope: String) async {
        guard self.scope == scope, pending == nil, !busy, !importing else { return }
        guard attachments.count + items.count <= 3 else { error = "Choose up to 3 files."; return }
        let generation = generation
        importing = true; error = nil
        defer { if generation == self.generation { importing = false } }
        for item in items {
            do {
                guard let loaded = try await item.loadTransferable(type: FeedbackPickedMedia.self),
                      let mime = Self.mediaTypes[URL(fileURLWithPath: loaded.name).pathExtension.lowercased()] else { throw MediaError.unsupported }
                guard generation == self.generation else { return }
                try addAttachment(data: loaded.data, name: loaded.name, mime: mime)
            } catch {
                guard generation == self.generation else { return }
                self.error = "Could not add this photo or video. Choose PNG, JPEG, WebP, MP4, WebM or MOV; up to 10 MiB each and 20 MiB total. Images must fit within 8192 pixels per side and 32 megapixels. HEIC photos must be exported as JPEG first."
            }
        }
    }
    enum MediaError: Error { case unsupported, size }
    nonisolated static func validImageDimensions(width: Int, height: Int) -> Bool {
        width > 0 && height > 0 && width <= 8_192 && height <= 8_192 && width * height <= 32_000_000
    }
    nonisolated static func normalizeImage(_ data: Data) throws -> Data {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              validImageDimensions(width: width, height: height) else { throw MediaError.size }
        // Decode only after checking dimensions. Render orientation into pixels;
        // encode a new PNG from the raster, never copy source EXIF/GPS properties.
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                        kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceThumbnailMaxPixelSize: max(width, height)]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw MediaError.unsupported }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else { throw MediaError.unsupported }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination), output.length <= 10 * 1_024 * 1_024 else { throw MediaError.size }
        return output as Data
    }
    func addAttachment(data original: Data, name: String, mime originalMIME: String) throws {
        guard !original.isEmpty, original.count <= 10 * 1_024 * 1_024,
              Self.mediaTypes.values.contains(originalMIME) else { throw MediaError.unsupported }
        let isImage = originalMIME.hasPrefix("image/")
        let data: Data
        if isImage { data = try Self.normalizeImage(original) } else { data = original }
        let mime = isImage ? "image/png" : originalMIME
        let name = isImage ? URL(fileURLWithPath: name).deletingPathExtension().lastPathComponent + ".png" : name
        guard pending == nil, !busy, attachments.count < 3,
              !data.isEmpty, data.count <= 10 * 1_024 * 1_024,
              attachments.reduce(0, { $0 + $1.size }) + data.count <= 20 * 1_024 * 1_024 else { throw MediaError.size }
        guard Self.mediaTypes.values.contains(mime) else { throw MediaError.unsupported }
        var safeName = String(name.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && $0 != "/" && $0 != "\\" }.map(String.init).joined().prefix(180))
        while safeName.utf16.count > 180 { safeName.removeLast() }
        safeName = safeName.trimmingCharacters(in: .whitespacesAndNewlines)
        let item = FeedbackAttachment(name: safeName.isEmpty ? "attachment" : safeName, mimeType: mime,
                                      dataUrl: "data:\(mime);base64,\(data.base64EncodedString())", size: data.count)
        let ext = Self.mediaTypes.first(where: { $0.value == mime })?.key ?? "bin"
        let preview = FileManager.default.temporaryDirectory.appendingPathComponent("orca-feedback-\(item.id).\(ext)")
        try data.write(to: preview, options: [.atomic, .completeFileProtection])
        previewURLs[item.id] = preview; attachments.append(item)
    }
    func writeAnother() { receipt = nil; error = nil }
}

enum FeedbackCaptureAction { case screenshot, recording }

private struct FeedbackTicketComposer: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: FeedbackTicketModel
    @ObservedObject var capture: FeedbackCaptureController
    let requestCapture: (FeedbackCaptureAction) -> Void
    @FocusState private var writing: Bool
    @State private var choosingMedia = false
    @State private var choosingPhotos = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var importScope = ""
    @State private var previewing: FeedbackAttachment?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let receipt = model.receipt, let url = receipt.issueURL {
                        Label("Sent to Linear", systemImage: "checkmark.circle")
                            .font(OrcaTheme.ui(16, weight: .semibold))
                            .accessibilityIdentifier("feedback.confirmation")
                        Link("Open \(receipt.identifier)", destination: url)
                            .font(OrcaTheme.ui(14, weight: .semibold)).frame(minHeight: 44)
                            .accessibilityIdentifier("feedback.ticket-link")
                        Button("Send another note") { model.writeAnother(); writing = true }.frame(minHeight: 44)
                    } else {
                        Text("What would you like to change?").font(OrcaTheme.reader(24))
                        ZStack(alignment: .topLeading) {
                            TextEditor(text: $model.message)
                                .focused($writing).frame(minHeight: 180).scrollContentBackground(.hidden)
                                .accessibilityLabel("Feedback note").accessibilityIdentifier("feedback.message")
                            if model.message.isEmpty {
                                Text("An idea, a problem, or a small improvement…")
                                    .foregroundStyle(OrcaTheme.muted).padding(.top, 8).padding(.leading, 5)
                                    .allowsHitTesting(false).accessibilityHidden(true)
                            }
                        }.padding(8).background(OrcaTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(OrcaTheme.border))
                            .disabled(model.pending != nil || model.busy)
                        Text("Creates a ticket in your Linear. Only your note and reviewed files are sent.")
                            .font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                        HStack {
                            Button { writing = false; requestCapture(.screenshot) } label: {
                                Label("Screenshot this screen", systemImage: "camera.viewfinder")
                            }.frame(minHeight: 44).accessibilityIdentifier("feedback.capture-screenshot")
                            Button { writing = false; requestCapture(.recording) } label: {
                                Label("Record this screen", systemImage: "record.circle")
                            }.frame(minHeight: 44).accessibilityIdentifier("feedback.capture-recording")
                        }.disabled(!model.canAddMedia || capture.active)
                        Text("Captures the current Orca screen with this composer hidden. Recordings are silent and stop after 60 seconds. Review captures before sending.")
                            .font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                        if let error = capture.error {
                            Text(error).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.danger).accessibilityIdentifier("feedback.capture-error")
                        }
                        Text("Or attach an existing file").font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                        Button("Choose photos or videos") { writing = false; importScope = state.ownerScope; choosingPhotos = true }
                            .frame(minHeight: 44).accessibilityIdentifier("feedback.photos")
                            .disabled(model.pending != nil || model.busy || model.importing || model.attachments.count >= 3)
                        Button("Choose from Files") { writing = false; importScope = state.ownerScope; choosingMedia = true }
                            .frame(minHeight: 44).accessibilityIdentifier("feedback.attach")
                            .disabled(model.pending != nil || model.busy || model.importing || model.attachments.count >= 3)
                        Text("Up to 3 files, 10 MiB each, 20 MiB total. Images omit location and camera metadata. Imported videos may retain audio and metadata.")
                            .font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                        ForEach(model.attachments) { attachment in
                            HStack {
                                Button { previewing = attachment } label: {
                                    Label(attachment.name, systemImage: attachment.mimeType.hasPrefix("video/") ? "play.rectangle" : "photo")
                                }.frame(minHeight: 44).accessibilityIdentifier("feedback.preview.\(attachment.id)")
                                Spacer()
                                Text(model.reviewed.contains(attachment.id) ? "Reviewed" : "Review required").font(OrcaTheme.ui(11))
                                Button("Remove") { model.removeAttachment(attachment.id) }.frame(minHeight: 44)
                                    .disabled(model.pending != nil || model.busy || model.importing)
                            }
                        }
                        if model.importing { ProgressView("Adding selected files…") }
                        if model.busy { ProgressView("Sending feedback and selected files…") }
                        if model.message.utf16.count > 10_000 {
                            Text("Keep your note under 10,000 characters.").font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.danger)
                        }
                        if let error = model.error {
                            Text(error).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.danger).accessibilityIdentifier("feedback.error")
                        }
                        Button(model.busy ? "Sending…" : model.pending == nil ? "Send to Linear" : "Retry submission") {
                            guard let client = state.client else { return }
                            writing = false
                            Task { await model.send(client: client, scope: state.ownerScope) }
                        }.buttonStyle(OrcaPrimaryButtonStyle())
                            .disabled(!model.canSubmit || model.busy || state.client == nil)
                            .accessibilityIdentifier("feedback.submit")
                    }
                }.padding(20).foregroundStyle(OrcaTheme.ink)
            }.background(OrcaTheme.paper.ignoresSafeArea())
                .scrollDismissesKeyboard(.interactively)
                .navigationTitle("Feedback").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Close") { dismiss() }.accessibilityIdentifier("feedback.close")
                    }
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") { writing = false }.accessibilityIdentifier("feedback.keyboard-done")
                    }
                }.accessibilityIdentifier("feedback.composer")
        }.tint(OrcaTheme.accent)
            .photosPicker(isPresented: $choosingPhotos, selection: $selectedPhotos,
                          maxSelectionCount: max(1, 3 - model.attachments.count), matching: .any(of: [.images, .videos]), preferredItemEncoding: .current)
            .onChange(of: selectedPhotos) { _, items in
                guard !items.isEmpty else { return }
                let scope = importScope
                selectedPhotos = []
                Task { await model.importPhotos(items, scope: scope) }
            }
            .fileImporter(isPresented: $choosingMedia,
                          allowedContentTypes: FeedbackTicketModel.mediaTypes.keys.compactMap { UTType(filenameExtension: $0) },
                          allowsMultipleSelection: true) { result in
                if case let .success(urls) = result {
                    let scope = importScope
                    Task { await model.importFiles(urls, scope: scope) }
                }
            }
            .sheet(item: $previewing) { attachment in
                FeedbackMediaPreview(attachment: attachment, url: model.previewURL(for: attachment.id)) {
                    model.review(attachment.id); previewing = nil
                }
            }
    }
}

private struct FeedbackMediaPreview: View {
    let attachment: FeedbackAttachment
    let url: URL?
    let confirm: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?
    @State private var previewReady = false
    @State private var previewChecked = false
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if let url, attachment.mimeType.hasPrefix("video/") {
                    if previewReady {
                        VideoPlayer(player: player).frame(minHeight: 240)
                            .onDisappear { player?.pause(); player = nil }
                    } else if previewChecked {
                        Text("This video cannot be previewed on this device. Cancel and remove it, or choose an MP4 or MOV recording.")
                    } else { ProgressView("Loading preview…") }
                } else if let url, let image = UIImage(contentsOfFile: url.path) {
                    Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("Selected screenshot preview")
                } else {
                    ContentUnavailableView("Preview unavailable", systemImage: "doc", description: Text("Remove this file if you cannot verify its contents."))
                }
                Text("Review for private information before including this file in your Linear ticket.").font(OrcaTheme.ui(13))
                Button("Reviewed — include this file", action: confirm).buttonStyle(OrcaPrimaryButtonStyle()).disabled(!previewReady)
                    .accessibilityIdentifier("feedback.media-reviewed")
            }.padding().navigationTitle(attachment.name).navigationBarTitleDisplayMode(.inline)
                .task(id: attachment.id) {
                    guard let url else { previewChecked = true; return }
                    if attachment.mimeType.hasPrefix("video/") {
                        previewReady = (try? await AVURLAsset(url: url).load(.isPlayable)) == true
                        if previewReady { player = AVPlayer(url: url) }
                    } else { previewReady = UIImage(contentsOfFile: url.path) != nil }
                    previewChecked = true
                }
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Cancel") { dismiss() } } }
        }
    }
}
