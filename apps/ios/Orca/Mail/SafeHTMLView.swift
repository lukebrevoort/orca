import SwiftUI
import WebKit

struct SafeHTMLView: UIViewRepresentable {
    let html: String
    func makeUIView(context: Context) -> WKWebView { let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent(); config.defaultWebpagePreferences.allowsContentJavaScript = false; let view = WKWebView(frame: .zero, configuration: config); view.navigationDelegate = context.coordinator; view.isOpaque = false; view.scrollView.isScrollEnabled = false; return view }
    func updateUIView(_ view: WKWebView, context: Context) { let shell = "<meta name='viewport' content='width=device-width'><style>body{font: -apple-system-body;color:#202724;background:transparent;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>" + html; view.loadHTMLString(shell, baseURL: nil) }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, WKNavigationDelegate { func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) { if action.navigationType == .linkActivated, let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme) { UIApplication.shared.open(url); decisionHandler(.cancel) } else { decisionHandler(action.request.url?.scheme == "about" ? .allow : .cancel) } } }
}

