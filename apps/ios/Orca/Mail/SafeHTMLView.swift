import SwiftUI
import WebKit

struct SafeHTMLView: UIViewRepresentable {
    let html: String
    func makeUIView(context: Context) -> WKWebView { let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent(); config.defaultWebpagePreferences.allowsContentJavaScript = false; let view = ContentSizedWebView(frame: .zero, configuration: config); view.navigationDelegate = context.coordinator; view.isOpaque = false; view.scrollView.isScrollEnabled = false; return view }
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.sizeCategory) private var sizeCategory
    private static let readerFont = Bundle.main.url(forResource: "Newsreader", withExtension: "ttf").flatMap { try? Data(contentsOf: $0).base64EncodedString() } ?? ""
    func updateUIView(_ view: WKWebView, context: Context) {
        let size = UIFontMetrics(forTextStyle: .body).scaledValue(for: 22)
        let ink = colorScheme == .dark ? "#f4f3ef" : "#102522"
        let shell = """
        <meta name='viewport' content='width=device-width'>
        <meta http-equiv='Content-Security-Policy' content="default-src 'none'; img-src data: cid:; font-src data:; style-src 'unsafe-inline'">
        <style>
        @font-face{font-family:OrcaReader;src:url(data:font/ttf;base64,\(Self.readerFont)) format('truetype')}
        :root{color-scheme:\(colorScheme == .dark ? "dark" : "light")}
        body{font-family:OrcaReader,Georgia,serif;font-size:\(size)px;line-height:1.6;color:\(ink);background:transparent;overflow-wrap:anywhere;margin:0}
        p{margin:0 0 1.2em}img{max-width:100%;height:auto}a{color:inherit;text-underline-offset:3px}
        blockquote{border-left:2px solid #65746d;margin:1em 0;padding-left:1em}
        </style>
        """ + html
        if context.coordinator.renderedHTML != shell { context.coordinator.renderedHTML = shell; view.loadHTMLString(shell, baseURL: nil) }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, WKNavigationDelegate { var renderedHTML: String?; func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) { if action.navigationType == .linkActivated, let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme) { UIApplication.shared.open(url); decisionHandler(.cancel) } else { decisionHandler(action.request.url?.scheme == "about" ? .allow : .cancel) } } }
}
private final class ContentSizedWebView: WKWebView {
    private var observation: NSKeyValueObservation?
    override init(frame: CGRect, configuration: WKWebViewConfiguration) { super.init(frame: frame, configuration: configuration); observation = scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in self?.invalidateIntrinsicContentSize() } }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: max(44, scrollView.contentSize.height)) }
}
