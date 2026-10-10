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
        context.coordinator.update(view, html: html, colorScheme: colorScheme, size: size)
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, WKNavigationDelegate {
        private struct RenderInputs: Equatable {
            let html: String
            let colorScheme: ColorScheme
            let size: CGFloat
        }
        // Retain only this reader's current inputs, not another copy of the
        // complete document (which also embeds the ~600 KB base64 font).
        private var renderedInputs: RenderInputs?

        // Keep preparation in the coordinator so repeated update work can be
        // measured independently of asynchronous WebKit navigation/layout.
        func update(_ view: WKWebView, html: String, colorScheme: ColorScheme, size: CGFloat) {
            let inputs = RenderInputs(html: html, colorScheme: colorScheme, size: size)
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
            </style>
            """ + html
            view.loadHTMLString(shell, baseURL: nil)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .linkActivated, let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(action.request.url?.scheme == "about" ? .allow : .cancel)
            }
        }
    }
}
private final class ContentSizedWebView: WKWebView {
    private var observation: NSKeyValueObservation?
    override init(frame: CGRect, configuration: WKWebViewConfiguration) { super.init(frame: frame, configuration: configuration); observation = scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in self?.invalidateIntrinsicContentSize() } }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: max(44, scrollView.contentSize.height)) }
}


