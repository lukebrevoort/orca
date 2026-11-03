import SwiftUI
import ReplayKit
import AVFoundation

@MainActor final class FeedbackWindowReference: ObservableObject { weak var window: UIWindow? }
struct FeedbackWindowProbe: UIViewRepresentable {
    let reference: FeedbackWindowReference
    func makeUIView(context: Context) -> Probe {
        let view = Probe(); view.reference = reference; view.isUserInteractionEnabled = false; return view
    }
    func updateUIView(_ view: Probe, context: Context) { view.reference = reference }
    final class Probe: UIView {
        weak var reference: FeedbackWindowReference?
        override func didMoveToWindow() { super.didMoveToWindow(); reference?.window = window }
    }
}

struct FeedbackCapturedMedia: Identifiable {
    let id = UUID()
    let scope: String
    let data: Data
    let name: String
    let mime: String
}

@MainActor protocol FeedbackRecordingSession: AnyObject {
    var available: Bool { get }
    func start(onLimit: @escaping @MainActor () -> Void) async throws
    func finish() async throws -> Data
    func cancel() async
}

enum FeedbackCaptureError: LocalizedError {
    case unavailable, failed, empty, tooLarge
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Screen recording is unavailable on this device right now. Try again on a supported device."
        case .failed: return "Capture could not finish. Nothing was attached. Please try again."
        case .empty: return "No screen frames were captured. Nothing was attached."
        case .tooLarge: return "The recording exceeded 10 MiB. Try a shorter recording."
        }
    }
}

/// Owns a single explicit capture. It never starts from app launch or foreground.
@MainActor final class FeedbackCaptureController: ObservableObject {
    enum Phase: Equatable { case idle, starting, recording, finishing }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var elapsed = 0
    @Published private(set) var result: FeedbackCapturedMedia?
    @Published private(set) var error: String?
    private(set) var scope = ""
    private var generation = UUID()
    private var session: FeedbackRecordingSession?
    private var timer: Task<Void, Never>?
    private var hud: UIWindow?
    private let makeSession: () -> FeedbackRecordingSession
    private let requiresVisibleScene: Bool
    var onReturnToComposer: (() -> Void)?
    var active: Bool { phase != .idle }
    init() { makeSession = { ReplayKitFeedbackSession() }; requiresVisibleScene = true }
#if DEBUG
    /// Unit-only dependency injection. The app always uses the foreground HUD initializer.
    init(testSessionFactory: @escaping () -> FeedbackRecordingSession) {
        makeSession = testSessionFactory; requiresVisibleScene = false
    }
#endif

    func configure(scope: String) {
        guard self.scope != scope else { return }
        self.scope = scope; result = nil; error = nil
        cancel()
    }
    func clearResult() { result = nil }
    func screenshot(window: UIWindow?, scope: String) {
        guard !active, scope == self.scope else { return }
        error = nil
        guard let window, window.windowScene?.activationState == .foregroundActive,
              window.bounds.width > 0, window.bounds.height > 0 else {
            error = "The current Orca screen could not be captured."; return
        }
        // The caller uses sheet onDismiss, so the feedback composer is gone.
        window.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        format.scale = min(window.screen.scale, 2)
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds, format: format)
        var complete = false
        let image = renderer.image { _ in complete = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        guard complete, let data = image.pngData() else { error = FeedbackCaptureError.failed.localizedDescription; return }
        result = FeedbackCapturedMedia(scope: scope, data: data, name: "Orca screenshot.png", mime: "image/png")
    }
    func start(scope: String, windowScene: UIWindowScene? = nil) async {
        guard !active, scope == self.scope else { return }
        if requiresVisibleScene {
            guard let windowScene, windowScene.activationState == .foregroundActive,
                  windowScene.coordinateSpace.bounds.width > 0, windowScene.coordinateSpace.bounds.height >= 72 else {
                error = "Keep Orca open in the foreground to record this screen."; onReturnToComposer?(); return
            }
        }
        let recording = makeSession()
        guard recording.available else { error = FeedbackCaptureError.unavailable.localizedDescription; onReturnToComposer?(); return }
        let token = UUID(); generation = token
        session = recording; phase = .starting; elapsed = 0; error = nil; result = nil
        if let windowScene { showHUD(in: windowScene) }
        do {
            var limitReachedWhileStarting = false
            try await recording.start { [weak self] in
                guard let self, self.generation == token else { return }
                if self.phase == .starting { limitReachedWhileStarting = true; return }
                guard self.phase == .recording else { return }
                Task { await self.stop() }
            }
            guard generation == token else { return }
            phase = .recording
            if limitReachedWhileStarting { await stop(); return }
            timer = Task { [weak self] in
                let started = ContinuousClock.now
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                    guard let self, self.generation == token, self.phase == .recording else { return }
                    await self.elapsedTimeDidChange(Int(started.duration(to: .now).components.seconds))
                }
            }
        } catch {
            guard generation == token else { return }
            await recording.cancel()
            guard generation == token else { return }
            self.error = error.localizedDescription
            finishState(); onReturnToComposer?()
        }
    }
    func elapsedTimeDidChange(_ seconds: Int) async {
        guard phase == .recording else { return }
        elapsed = min(max(seconds, 0), 60); updateHUDFrame()
        if seconds >= 60 { await stop() }
    }
    func stop() async {
        guard phase == .recording, let recording = session else { return }
        let token = generation, owner = scope
        phase = .finishing; timer?.cancel(); timer = nil
        do {
            let data = try await recording.finish()
            guard generation == token, scope == owner else { return }
            guard !data.isEmpty else { throw FeedbackCaptureError.empty }
            guard data.count <= 10 * 1_024 * 1_024 else { throw FeedbackCaptureError.tooLarge }
            result = FeedbackCapturedMedia(scope: owner, data: data, name: "Orca screen recording.mp4", mime: "video/mp4")
        } catch {
            guard generation == token else { return }
            self.error = error.localizedDescription
        }
        guard generation == token else { return }
        await recording.cancel()
        guard generation == token else { return }
        finishState(); onReturnToComposer?()
    }
    func cancel() {
        generation = UUID(); timer?.cancel(); timer = nil; result = nil
        let recording = session
        if recording == nil { finishState(); return }
        let token = generation
        phase = .finishing
        Task {
            await recording?.cancel()
            guard generation == token else { return }
            finishState()
        }
    }
    private func finishState() {
        phase = .idle; session = nil; timer?.cancel(); timer = nil
        hud?.isHidden = true; hud?.rootViewController = nil; hud = nil
    }
    private func showHUD(in scene: UIWindowScene) {
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .statusBar + 1
        window.backgroundColor = .clear
        window.rootViewController = UIHostingController(rootView: FeedbackRecordingHUD(controller: self))
        window.rootViewController?.view.backgroundColor = .clear
        hud = window; updateHUDFrame(); window.isHidden = false
    }
    private func updateHUDFrame() {
        guard let hud, let scene = hud.windowScene else { return }
        let top = scene.windows.first(where: { $0.isKeyWindow })?.safeAreaInsets.top ?? 0
        hud.frame = CGRect(x: 0, y: top, width: scene.coordinateSpace.bounds.width, height: 72)
    }
}

private struct FeedbackRecordingHUD: View {
    @ObservedObject var controller: FeedbackCaptureController
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "record.circle.fill").foregroundStyle(OrcaTheme.danger)
            Text(controller.phase == .starting ? "Starting recording…" : controller.phase == .finishing ? "Finishing…" : "Recording Orca · \(controller.elapsed)s / 60s")
                .font(OrcaTheme.ui(12, weight: .semibold))
            Spacer(minLength: 0)
            Button("Stop") { Task { await controller.stop() } }.disabled(controller.phase != .recording)
                .frame(minHeight: 44).accessibilityIdentifier("feedback.capture-stop")
            Button("Cancel") { controller.cancel() }.frame(minHeight: 44).accessibilityIdentifier("feedback.capture-cancel")
        }.padding(12).foregroundStyle(OrcaTheme.ink)
            .background(OrcaTheme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(OrcaTheme.border))
            .padding(.horizontal, 8).accessibilityIdentifier("feedback.recording-indicator")
    }
}

/// ReplayKit supplies app/microphone audio too; the writer accepts video ONLY.
/// No audio input is created, and camera and microphone are explicitly disabled.
@MainActor final class ReplayKitFeedbackSession: NSObject, FeedbackRecordingSession, RPScreenRecorderDelegate {
    private let recorder = RPScreenRecorder.shared()
    private var writer: FeedbackVideoWriter?
    private var startTask: Task<Void, Error>?
    private var stopTask: Task<Void, Never>?
    private var cancelled = false
    private var ownsRecording = false
    var available: Bool { recorder.isAvailable && !recorder.isRecording }
    func start(onLimit: @escaping @MainActor () -> Void) async throws {
        guard available else { throw FeedbackCaptureError.unavailable }
        recorder.isMicrophoneEnabled = false; recorder.isCameraEnabled = false
        let sink = FeedbackVideoWriter { Task { @MainActor in onLimit() } }
        writer = sink
        let task = Task { @MainActor in
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                recorder.startCapture(handler: { buffer, type, error in
                    if let error { sink.fail(error); return }
                    guard type == .video else { return }
                    sink.append(buffer)
                }, completionHandler: { error in
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                })
            }
            ownsRecording = true
            recorder.delegate = self
        }
        startTask = task
        try await task.value
        if cancelled { throw CancellationError() }
    }
    private func stopCapture() async {
        if let stopTask { await stopTask.value; return }
        let task = Task { @MainActor in
            _ = try? await startTask?.value
            guard ownsRecording else { return }
            ownsRecording = false
            if recorder.delegate === self { recorder.delegate = nil }
            if recorder.isRecording {
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in recorder.stopCapture { _ in continuation.resume() } }
            }
        }
        stopTask = task; await task.value
    }
    nonisolated func screenRecorder(_ screenRecorder: RPScreenRecorder, didStopRecordingWith previewViewController: RPPreviewViewController?, error: Error?) {
        Task { @MainActor [weak self] in
            guard let self, self.ownsRecording else { return }
            self.ownsRecording = false
            if self.recorder.delegate === self { self.recorder.delegate = nil }
            self.writer?.fail(error ?? FeedbackCaptureError.failed)
        }
    }
    func finish() async throws -> Data {
        await stopCapture()
        guard !cancelled, let writer else { throw CancellationError() }
        return try await writer.finish()
    }
    func cancel() async {
        cancelled = true
        writer?.discard()
        await stopCapture()
        writer?.discard(); writer = nil
    }
}

/// Serial bounded video sink. Drops frames under encoder backpressure rather
/// than retaining unbounded buffers. Final bytes are checked before attachment.
final class FeedbackVideoWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "orca.feedback.screen-video")
    private let url = FileManager.default.temporaryDirectory.appendingPathComponent("orca-capture-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).mp4")
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var firstTime: CMTime?
    private var failure: Error?
    private var closed = false
    private var limitNotified = false
    private let onLimit: @Sendable () -> Void
    init(onLimit: @escaping @Sendable () -> Void) { self.onLimit = onLimit }
    func fail(_ error: Error) { queue.async { self.failure = error; self.notifyLimit() } }
    private func notifyLimit() { if !limitNotified { limitNotified = true; onLimit() } }
    func append(_ sample: CMSampleBuffer) {
        // ReplayKit sample buffers are retained only for this synchronous append.
        queue.sync {
            guard !closed, failure == nil, !limitNotified, CMSampleBufferDataIsReady(sample),
                  let format = CMSampleBufferGetFormatDescription(sample) else { return }
            do {
                let time = CMSampleBufferGetPresentationTimeStamp(sample)
                if let firstTime, CMTimeGetSeconds(CMTimeSubtract(time, firstTime)) >= 60 { notifyLimit(); return }
                if writer == nil {
                    let size = CMVideoFormatDescriptionGetDimensions(format)
                    guard size.width > 0, size.height > 0, size.width <= 8_192, size.height <= 8_192 else { throw FeedbackCaptureError.failed }
                    let output = try AVAssetWriter(outputURL: url, fileType: .mp4)
                    output.movieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
                    let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
                        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: Int(size.width), AVVideoHeightKey: Int(size.height),
                        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_000_000, AVVideoMaxKeyFrameIntervalKey: 30],
                    ])
                    video.expectsMediaDataInRealTime = true
                    guard output.canAdd(video) else { throw FeedbackCaptureError.failed }
                    output.add(video)
                    guard output.startWriting() else { throw output.error ?? FeedbackCaptureError.failed }
                    output.startSession(atSourceTime: time)
                    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
                    writer = output; input = video; firstTime = time
                }
                if let input, input.isReadyForMoreMediaData, !input.append(sample) { throw writer?.error ?? FeedbackCaptureError.failed }
                let bytes = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                if bytes >= 9 * 1_024 * 1_024 { notifyLimit() }
            } catch { failure = error; notifyLimit() }
        }
    }
    func finish() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                guard !self.closed, let writer = self.writer, let input = self.input else {
                    continuation.resume(throwing: self.failure ?? FeedbackCaptureError.empty); return
                }
                self.closed = true
                if let failure = self.failure { writer.cancelWriting(); try? FileManager.default.removeItem(at: self.url); continuation.resume(throwing: failure); return }
                input.markAsFinished()
                writer.finishWriting {
                    self.queue.async {
                        defer { try? FileManager.default.removeItem(at: self.url) }
                        do {
                            guard writer.status == .completed else { throw writer.error ?? FeedbackCaptureError.failed }
                            let file = try FileHandle(forReadingFrom: self.url); defer { try? file.close() }
                            let data = try file.read(upToCount: 10 * 1_024 * 1_024 + 1) ?? Data()
                            guard data.count <= 10 * 1_024 * 1_024 else { throw FeedbackCaptureError.tooLarge }
                            continuation.resume(returning: data)
                        } catch { continuation.resume(throwing: error) }
                    }
                }
            }
        }
    }
    func discard() {
        queue.sync {
            closed = true
            if writer?.status == .writing { writer?.cancelWriting() }
            try? FileManager.default.removeItem(at: url)
        }
    }
    static func removeAbandonedFiles() {
        let directory = FileManager.default.temporaryDirectory
        for file in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
            let stem = file.deletingPathExtension().lastPathComponent
            guard stem.hasPrefix("orca-capture-"), file.pathExtension == "mp4" else { continue }
            let components = stem.dropFirst("orca-capture-".count).split(separator: "-", maxSplits: 1)
            guard components.count == 2, let process = Int32(components[0]),
                  process != ProcessInfo.processInfo.processIdentifier,
                  UUID(uuidString: String(components[1])) != nil else { continue }
            try? FileManager.default.removeItem(at: file)
        }
    }
    deinit { try? FileManager.default.removeItem(at: url) }
}
