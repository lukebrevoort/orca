import SwiftUI
import WebKit

struct SafeHTMLView: UIViewRepresentable {
    let html: String
    func makeUIView(context: Context) -> WKWebView { let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent(); config.defaultWebpagePreferences.allowsContentJavaScript = false; let view = ContentSizedWebView(frame: .zero, configuration: config); view.navigationDelegate = context.coordinator; view.isOpaque = false; view.scrollView.isScrollEnabled = false; return view }
    func updateUIView(_ view: WKWebView, context: Context) { let shell = "<meta name='viewport' content='width=device-width'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'\"><style>:root{color-scheme:light dark}body{font: -apple-system-body;color:#202724;background:transparent;overflow-wrap:anywhere;margin:0}@media(prefers-color-scheme:dark){body{color:#F4F3EF}}img{max-width:100%;height:auto}</style>" + html; view.loadHTMLString(shell, baseURL: nil) }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, WKNavigationDelegate { func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) { if action.navigationType == .linkActivated, let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme) { UIApplication.shared.open(url); decisionHandler(.cancel) } else { decisionHandler(action.request.url?.scheme == "about" ? .allow : .cancel) } } }
}
private final class ContentSizedWebView: WKWebView {
    private var observation: NSKeyValueObservation?
    override init(frame: CGRect, configuration: WKWebViewConfiguration) { super.init(frame: frame, configuration: configuration); observation = scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in self?.invalidateIntrinsicContentSize() } }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: max(44, scrollView.contentSize.height)) }
}
