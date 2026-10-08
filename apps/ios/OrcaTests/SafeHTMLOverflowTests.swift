import XCTest
import SwiftUI
import WebKit
@testable import Orca

/// Real WebKit layout, using the production reader shell and bundled font.
/// The web view has the same disabled outer scrolling as SafeHTMLView; text
/// cannot rely on a horizontal gesture to recover content outside its bounds.
@MainActor
final class SafeHTMLOverflowTests: XCTestCase {
    private final class NavigationObserver: NSObject, WKNavigationDelegate {
        let loaded: XCTestExpectation
        init(_ loaded: XCTestExpectation) { self.loaded = loaded }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded.fulfill() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            XCTFail("Reader navigation failed: \(error)")
            loaded.fulfill()
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            XCTFail("Reader navigation failed: \(error)")
            loaded.fulfill()
        }
    }

    private var layouts: [(CGFloat, CGFloat, ColorScheme)] {
        [CGFloat(272), 342].flatMap { width in
            [CGFloat(22), 44].flatMap { size in
                [ColorScheme.light, .dark].map { (width, size, $0) }
            }
        }
    }

    func testLongPreformattedCodeRemainsReadableWithoutHorizontalScrolling() async throws {
        let code = "const artifact = \"" + String(repeating: "release_candidate_", count: 16) + "\";\n  return artifact;"
        for (width, size, theme) in layouts {
            let metrics = try await render("<p>Build output</p><pre><code>\(code)</code></pre><p>End of message.</p>", width: width, size: size, theme: theme)
            XCTAssertEqual(metrics["preText"] as? String, code, "Wrapping must preserve every character and indentation")
            assertFits(metrics, width: width, size: size)
            XCTAssertTrue(["pre", "pre-wrap", "break-spaces"].contains(metrics["preWhiteSpace"] as? String ?? ""), "Preserve indentation and explicit line breaks visually")
            XCTAssertGreaterThan(number(metrics, "preHeight"), size * 5, "Long code must reflow into visible lines")
        }
    }

    func testFixedWidthTableKeepsHeadersAndEveryCellWithinReader() async throws {
        let html = """
        <p>Build results</p><table width="1200"><caption>Required checks</caption>
        <thead><tr><th>Job</th><th>Status</th><th>Commit</th></tr></thead>
        <tbody><tr><td>Native reader</td><td>Passed</td><td>f0a9180a8a185cd2bdb293d87a617e81414ebbaf</td></tr></tbody></table><p>End of message.</p>
        """
        for (width, size, theme) in layouts {
            let metrics = try await render(html, width: width, size: size, theme: theme)
            assertFits(metrics, width: width, size: size)
            XCTAssertEqual(metrics["headers"] as? [String], ["Job", "Status", "Commit"])
            XCTAssertEqual(metrics["cells"] as? [String], ["Native reader", "Passed", "f0a9180a8a185cd2bdb293d87a617e81414ebbaf"])
            XCTAssertEqual(metrics["tableDisplay"] as? String, "table", "Keep native table semantics for assistive technology")
            XCTAssertLessThanOrEqual(number(metrics, "tableRight"), Double(width) + 1)
        }
    }

    func testSenderInlineWidthsAndNoWrapCannotHideTableText() async throws {
        let html = """
        <table style="width:1200px;min-width:1200px;table-layout:auto">
        <colgroup width="1200"><col width="800"><col style="width:400px"></colgroup>
        <thead><tr><th width="800">Job</th><th style="width:400px">Status</th></tr></thead>
        <tbody><tr><td width="800" style="white-space:nowrap">Native reader checks</td><td style="min-width:400px">Passed</td></tr></tbody></table>
        <pre style="white-space:pre"><code style="white-space:pre">    release_candidate_release_candidate_release_candidate_release_candidate</code></pre>
        """
        for (width, size, theme) in layouts {
            let metrics = try await render(html, width: width, size: size, theme: theme)
            assertFits(metrics, width: width, size: size)
            XCTAssertEqual(metrics["headers"] as? [String], ["Job", "Status"])
            XCTAssertEqual(metrics["cells"] as? [String], ["Native reader checks", "Passed"])
            XCTAssertEqual(metrics["tableDisplay"] as? String, "table")
            XCTAssertEqual(metrics["preText"] as? String, "    release_candidate_release_candidate_release_candidate_release_candidate")
            XCTAssertEqual(number(metrics, "tableFontSize"), Double(size), accuracy: 0.1, "Table text must respect the requested reading size")
        }
    }

    private func assertFits(_ metrics: [String: Any], width: CGFloat, size: CGFloat, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(number(metrics, "bodyFontSize"), Double(size), accuracy: 0.1, "Keep the requested reading size", file: file, line: line)
        XCTAssertLessThanOrEqual(number(metrics, "documentWidth"), Double(width) + 1, "The disabled outer scroll view must not hide horizontal overflow: \(metrics)", file: file, line: line)
        XCTAssertLessThanOrEqual(number(metrics, "textRight"), Double(width) + 1, "Every rendered text fragment must fit the reader", file: file, line: line)
        XCTAssertGreaterThanOrEqual(number(metrics, "textLeft"), -1, file: file, line: line)
        XCTAssertGreaterThanOrEqual(number(metrics, "scale"), 0.99, "Do not shrink the entire message to fit wide content", file: file, line: line)
    }

    private func number(_ metrics: [String: Any], _ key: String) -> Double {
        (metrics[key] as? NSNumber)?.doubleValue ?? .infinity
    }

    private func render(_ html: String, width: CGFloat, size: CGFloat, theme: ColorScheme) async throws -> [String: Any] {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: width, height: 800), configuration: configuration)
        view.scrollView.isScrollEnabled = false
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = view.bounds
        window.overrideUserInterfaceStyle = theme == .dark ? .dark : .light
        let controller = UIViewController()
        controller.view.backgroundColor = theme == .dark ? .black : .white
        view.isOpaque = false
        view.backgroundColor = .clear
        window.rootViewController = controller
        controller.view.addSubview(view)
        window.makeKeyAndVisible()
        defer {
            view.removeFromSuperview()
            window.isHidden = true
            previousKeyWindow?.makeKeyAndVisible()
        }
        let loaded = expectation(description: "Reader HTML loaded")
        let observer = NavigationObserver(loaded)
        view.navigationDelegate = observer
        let coordinator = SafeHTMLView.Coordinator()
        coordinator.update(view, html: html, colorScheme: theme, size: size)
        await fulfillment(of: [loaded], timeout: 15)
        // App-owned evaluation remains separate from disabled message scripts.
        // Wait for the actual bundled font before measuring any line boxes.
        let result = try await view.callAsyncJavaScript("""
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const rectangles = [];
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(walker.currentNode);
          rectangles.push(...Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0));
        }
        const table = document.querySelector('table'), pre = document.querySelector('pre');
        return {
          documentWidth: document.documentElement.scrollWidth,
          bodyFontSize: parseFloat(getComputedStyle(document.body).fontSize),
          textRight: Math.max(...rectangles.map(r => r.right)),
          textLeft: Math.min(...rectangles.map(r => r.left)),
          scale: window.visualViewport.scale,
          preHeight: pre ? pre.getBoundingClientRect().height : 0,
          preWhiteSpace: pre ? getComputedStyle(pre).whiteSpace : '',
          preText: pre ? pre.textContent : '',
          headers: Array.from(document.querySelectorAll('th')).map(n => n.textContent),
          cells: Array.from(document.querySelectorAll('td')).map(n => n.textContent),
          tableRight: table ? table.getBoundingClientRect().right : 0,
          tableFontSize: table ? parseFloat(getComputedStyle(table).fontSize) : 0,
          tableDisplay: table ? getComputedStyle(table).display : ''
        };
        """, arguments: [:], in: nil, contentWorld: .defaultClient)
        let metrics = try XCTUnwrap(result as? [String: Any])
        let captured = expectation(description: "Synthetic reader snapshot")
        let snapshotConfiguration = WKSnapshotConfiguration()
        snapshotConfiguration.afterScreenUpdates = true
        view.takeSnapshot(with: snapshotConfiguration) { snapshot, error in
            XCTAssertNil(error)
            XCTAssertNotNil(snapshot)
            if let snapshot {
                let attachment = XCTAttachment(image: snapshot)
                attachment.name = "reader-overflow-\(theme)-\(Int(width))-\(Int(size))"
                attachment.lifetime = .keepAlways
                self.add(attachment)
            }
            captured.fulfill()
        }
        await fulfillment(of: [captured], timeout: 10)
        print("NATIVE_READER_OVERFLOW width=\(width) size=\(size) theme=\(theme) metrics=\(metrics)")
        return metrics
    }
}
