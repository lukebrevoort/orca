import SwiftUI
import WebKit

struct SafeHTMLView: UIViewRepresentable {
    let html: String
    var findRequest: UUID? = nil
    var wideContent = false
    func makeUIView(context: Context) -> WKWebView { let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent(); config.defaultWebpagePreferences.allowsContentJavaScript = false; let view = ContentSizedWebView(frame: .zero, configuration: config); view.navigationDelegate = context.coordinator; view.isFindInteractionEnabled = true; view.isOpaque = false; view.scrollView.isScrollEnabled = false; return view }
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.sizeCategory) private var sizeCategory
    private static let readerFont = Bundle.main.url(forResource: "Newsreader", withExtension: "ttf").flatMap { try? Data(contentsOf: $0).base64EncodedString() } ?? ""
    func updateUIView(_ view: WKWebView, context: Context) {
        let size = UIFontMetrics(forTextStyle: .body).scaledValue(for: 22)
        context.coordinator.update(view, html: html, colorScheme: colorScheme, size: size, wideContent: wideContent)
        context.coordinator.find(view, request: findRequest)
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, WKNavigationDelegate {
        private struct RenderInputs: Equatable {
            let html: String
            let colorScheme: ColorScheme
            let size: CGFloat
            let wideContent: Bool
        }
        // Retain only this reader's current inputs, not another copy of the
        // complete document (which also embeds the ~600 KB base64 font).
        private var renderedInputs: RenderInputs?
        private var lastFindRequest: UUID?
        func find(_ view: WKWebView, request: UUID?) {
            guard let request, request != lastFindRequest else { return }
            lastFindRequest = request
            view.findInteraction?.presentFindNavigator(showingReplace: false)
        }

        // Keep preparation in the coordinator so repeated update work can be
        // measured independently of asynchronous WebKit navigation/layout.
        func update(_ view: WKWebView, html: String, colorScheme: ColorScheme, size: CGFloat, wideContent: Bool = false) {
            let inputs = RenderInputs(html: html, colorScheme: colorScheme, size: size, wideContent: wideContent)
            // SwiftUI may update the representable without changing its body.
            // Check before interpolation so a no-op does not rebuild the font
            // payload or disturb the existing WebKit document/selection.
            guard renderedInputs != inputs else { return }
            renderedInputs = inputs
            let ink = colorScheme == .dark ? "#f4f3ef" : "#102522"
            let shell = """
            <meta name='viewport' content='width=device-width'>
            <meta http-equiv='Content-Security-Policy' content="default-src 'none'; img-src data: cid:; font-src data:; style-src 'unsafe-inline'">
            <style>
            @font-face{font-family:OrcaReader;src:url(data:font/ttf;base64,\(SafeHTMLView.readerFont)) format('truetype')}
            :root{color-scheme:\(colorScheme == .dark ? "dark" : "light")}
            body{font-family:OrcaReader,Georgia,serif;font-size:\(size)px;line-height:1.6;color:\(ink);background:transparent;overflow-wrap:anywhere;margin:0}
            p{margin:0 0 1.2em}img{max-width:100%;height:auto}a{color:inherit;text-underline-offset:3px}
            blockquote{border-left:2px solid #65746d;margin:1em 0;padding-left:1em}
            /* Outer WebKit scrolling is disabled: reflow wide content instead of clipping it or shrinking the message. */
            pre{max-width:100%!important;min-width:0!important;box-sizing:border-box}
            pre,pre *{white-space:break-spaces!important;overflow-wrap:anywhere!important}
            table{width:100%!important;max-width:100%!important;min-width:0!important;table-layout:fixed!important;font:inherit}
            /* API-validated single-content rows let blank gutters yield width.
               Keep data/statistics tables fixed and semantic; do not flatten. */
            table.orca-mail-spacer-table{table-layout:auto!important}
            /* A preferred width only: retain intrinsic minimums and descendants. */
            td.orca-mail-spacer-cell{width:0!important}
            /* Only structurally blank gutters may shed nested 100% widths. */
            td.orca-mail-spacer-cell table{width:auto!important}
            col,colgroup,th,td{width:auto!important;min-width:0!important;max-width:100%!important}
            th,td{white-space:normal!important;overflow-wrap:anywhere!important;word-break:normal!important}
            /* Only API-validated presentation tables receive these classes.
               Direct-child selectors leave nested data tables semantic. The
               relative size follows the same Dynamic Type scale as body. */
            .orca-mail-formatted{font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;font-size:0.8181818182em;line-height:1.55}
            .orca-mail-formatted p{margin:0 0 0.85em}
            .orca-mail-formatted h1,.orca-mail-formatted h2,.orca-mail-formatted h3{font-size:1.2em;line-height:1.3;margin:0.8em 0 0.5em}
            table.orca-mail-layout,table.orca-mail-layout>tbody,table.orca-mail-layout>thead,table.orca-mail-layout>tfoot,table.orca-mail-layout>tr,table.orca-mail-layout>tbody>tr,table.orca-mail-layout>thead>tr,table.orca-mail-layout>tfoot>tr,table.orca-mail-layout>tr>td,table.orca-mail-layout>tbody>tr>td,table.orca-mail-layout>thead>tr>td,table.orca-mail-layout>tfoot>tr>td{display:block!important;box-sizing:border-box!important;width:100%!important;max-width:100%!important;min-width:0!important;height:auto!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important}
            table.orca-mail-layout>tr>td,table.orca-mail-layout>tbody>tr>td,table.orca-mail-layout>thead>tr>td,table.orca-mail-layout>tfoot>tr>td{padding:0 0 0.5em!important}
            .orca-mail-image-note{display:block;font-size:0.9em;line-height:1.4;margin:0.3em 0 0.65em;overflow-wrap:anywhere}
            .orca-wide-content{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain}
            .orca-wide-content pre,.orca-wide-content pre *{white-space:pre!important;overflow-wrap:normal!important;max-width:none!important}
            .orca-wide-content table:not(.orca-mail-layout):not(.orca-mail-spacer-table){width:max-content!important;min-width:100%!important;max-width:none!important;table-layout:auto!important}
            .orca-wide-content table:not(.orca-mail-layout):not(.orca-mail-spacer-table) th,.orca-wide-content table:not(.orca-mail-layout):not(.orca-mail-spacer-table) td{white-space:nowrap!important;overflow-wrap:normal!important}
            </style>
            """ + (wideContent ? "<div class=\"orca-wide-content\" tabindex=\"0\" role=\"region\" aria-label=\"Wide message content, scroll horizontally\">" + html + "</div>" : html)
#if DEBUG
            (view as? ContentSizedWebView)?.recordFixtureEvent(.requested)
#endif
            view.loadHTMLString(shell, baseURL: nil)
        }

#if DEBUG
        // Scalars only; never inspect or export the document, URL or error text.
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            (webView as? ContentSizedWebView)?.recordFixtureEvent(.started)
        }
        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            (webView as? ContentSizedWebView)?.recordFixtureEvent(.committed)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            (webView as? ContentSizedWebView)?.recordFixtureEvent(.finished)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            (webView as? ContentSizedWebView)?.recordFixtureEvent(.failed, errorCode: (error as NSError).code)
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            (webView as? ContentSizedWebView)?.recordFixtureEvent(.provisionalfailed, errorCode: (error as NSError).code)
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            (webView as? ContentSizedWebView)?.recordFixtureEvent(.processterminated)
        }
#endif

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .linkActivated, let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme) {
                UIApplication.shared.open(url)
#if DEBUG
                (webView as? ContentSizedWebView)?.recordFixtureEvent(.policyCancel)
#endif
                decisionHandler(.cancel)
            } else {
                let policy: WKNavigationActionPolicy = action.request.url?.scheme == "about" ? .allow : .cancel
#if DEBUG
                (webView as? ContentSizedWebView)?.recordFixtureEvent(policy == .allow ? .policyAllow : .policyCancel)
#endif
                decisionHandler(policy)
            }
        }
    }
}
private final class ContentSizedWebView: WKWebView {
#if DEBUG
    private let fixtureDiagnosticsEnabled: Bool = {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("--fixture-html-diagnostics"),
              let index = args.firstIndex(of: "--fixture-api-url"), args.indices.contains(index + 1),
              let url = URL(string: args[index + 1]), url.scheme == "http",
              ["127.0.0.1", "localhost"].contains(url.host ?? ""),
              let token = args.firstIndex(of: "--fixture-access-token"), args.indices.contains(token + 1),
              !args[token + 1].isEmpty else { return false }
        return true
    }()
    // Fixed event names and numeric scalars only. A generation identifies the
    // latest request at callback time, not proof that a callback belongs to it.
    enum FixtureEvent: String {
        case requested, started, committed, finished, failed
        case provisionalfailed = "provisional-failed"
        case processterminated = "process-terminated"
        case policyAllow = "policy-allow", policyCancel = "policy-cancel"
    }
    private var fixtureDiagnosticPhase = "created"
    private var fixtureGeneration = 0
    private var fixtureRequestedMS: Int64 = 0
    private var fixtureCallbackMS: Int64 = 0
    private var fixtureHistory: [String] = []
    func recordFixtureEvent(_ event: FixtureEvent, errorCode: Int = 0) {
        guard fixtureDiagnosticsEnabled else { return }
        let now = Int64(ProcessInfo.processInfo.systemUptime * 1_000)
        if event == .requested {
            fixtureGeneration += 1
            fixtureRequestedMS = now
        } else {
            fixtureCallbackMS = now
        }
        if event != .policyAllow && event != .policyCancel {
            fixtureDiagnosticPhase = event.rawValue
        }
        fixtureHistory.append("\(event.rawValue):\(fixtureGeneration):\(now):\(errorCode)")
        fixtureHistory = Array(fixtureHistory.suffix(8))
        updateFixtureDiagnostics()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        updateFixtureDiagnostics()
    }
    private func updateFixtureDiagnostics() {
        guard fixtureDiagnosticsEnabled else { return }
        // Identifier carries bounded metadata without changing labels, values,
        // navigation, sizing or the WebView's accessibility children.
        accessibilityIdentifier = "fixture-html-state phase=\(fixtureDiagnosticPhase) loading=\(isLoading) bounds=\(bounds.size) content=\(scrollView.contentSize) generation=\(fixtureGeneration) requested_ms=\(fixtureRequestedMS) callback_ms=\(fixtureCallbackMS) history=\(fixtureHistory.joined(separator: ","))"
    }
#endif
    private var observation: NSKeyValueObservation?
    override init(frame: CGRect, configuration: WKWebViewConfiguration) { super.init(frame: frame, configuration: configuration); observation = scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in self?.invalidateIntrinsicContentSize() } }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: max(44, scrollView.contentSize.height)) }
}


