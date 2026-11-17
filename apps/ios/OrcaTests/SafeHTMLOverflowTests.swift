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

    func testOptionalWideFormattingKeepsSemanticTableAndLocalScrollReachable() async throws {
        let html = "<p>Ordinary prose stays at the reader width.</p><table><caption>Wide checks</caption><tr><th>First column</th><th>Second column</th><th>Final column</th></tr><tr><td>" + String(repeating: "wide-", count: 40) + "</td><td>Middle</td><td>Last cell retained</td></tr></table><pre>    indentation and code</pre><p>End retained.</p>"
        for (width, size, theme) in layouts {
            let metrics = try await render(html, width: width, size: size, theme: theme, evidenceName: "bre457-wide", wideContent: true)
            XCTAssertLessThanOrEqual(number(metrics, "documentWidth"), Double(width) + 1)
            XCTAssertGreaterThan(number(metrics, "wideScrollWidth"), number(metrics, "wideClientWidth"))
            XCTAssertGreaterThan(number(metrics, "wideScrolled"), 0, "Wide content must be reachable within the message")
            XCTAssertEqual(metrics["tableDisplay"] as? String, "table")
            XCTAssertEqual(metrics["headers"] as? [String], ["First column", "Second column", "Final column"])
            XCTAssertTrue((metrics["bodyText"] as? String ?? "").contains("Last cell retained"))
            XCTAssertTrue((metrics["bodyText"] as? String ?? "").contains("End retained."))
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

    // Synthetic output of the API's presentation-table normalization, with a
    // real data table deliberately nested inside a layout cell. These fixtures
    // contain no production message content or externally loaded resources.
    func testFormattedNewsletterStacksColumnsAndPreservesContentAndDataTable() async throws {
        let html = """
        <div class="orca-mail-formatted"><table class="orca-mail-layout" role="presentation"><tbody><tr>
        <td><span class="orca-mail-image-note">[Image blocked: Weekly digest]</span>
        <h1>News for your team</h1><p>Read the weekly update in a comfortable single column.</p></td>
        <td><h2>Project update</h2><p>Every word stays available at larger reading sizes.</p>
        <a href="https://example.test/update">Read the complete update</a>
        <table><caption>Project checks</caption><thead><tr><th>Check</th><th>Status</th></tr></thead>
        <tbody><tr><td>Build</td><td>Passed</td></tr></tbody></table></td>
        </tr></tbody></table><p>End of newsletter.</p></div>
        """
        for (width, size, theme) in layouts {
            let metrics = try await render(html, width: width, size: size, theme: theme, evidenceName: "newsletter")
            assertFits(metrics, width: width, size: size)
            XCTAssertEqual(metrics["tableDisplay"] as? String, "block")
            XCTAssertEqual(metrics["dataTableDisplay"] as? String, "table", "Newsletter layout must preserve nested data-table semantics")
            XCTAssertEqual(metrics["headers"] as? [String], ["Check", "Status"])
            XCTAssertEqual(number(metrics, "formattedFontSize"), Double(size) * 18 / 22, accuracy: 0.1)
            XCTAssertEqual(number(metrics, "layoutCellCount"), 2)
            XCTAssertEqual(metrics["layoutCellsStacked"] as? Bool, true, "Presentation columns must stack in reading order")
            XCTAssertGreaterThanOrEqual(number(metrics, "minimumLayoutCellWidth"), Double(width) - 1)
            XCTAssertEqual(metrics["links"] as? [String], ["https://example.test/update"])
            XCTAssertEqual(number(metrics, "imageCount"), 0, "Blocked image placeholders must not retain blank image rectangles")
            XCTAssertTrue((metrics["bodyText"] as? String ?? "").contains("End of newsletter."))
        }
    }

    func testActualAPINewsletterOutputRemainsReadable() async throws {
        // Exact sanitizeInboundHtml output for diagnostics/mobile-email/fixtures/newsletter.html.
        // The API contract test checks this literal against the real sanitizer.
        // BEGIN API NEWSLETTER FIXTURE
        let html = """
        <div class="orca-mail-formatted">


        <table class="orca-mail-layout" role="presentation"><tr><td>
        <h1>Your community update</h1>
        <table class="orca-mail-layout" role="presentation"><tr><td><span class="orca-mail-image-note">[Image blocked: Community workshop banner]</span></td></tr></table>
        <table class="orca-mail-layout" role="presentation"><tr>
        <td><h2>News from the workshop</h2><p>Our community is building a small garden together. Join us this Saturday for stories, ideas, and a practical workshop.</p><p><a href="https://example.invalid/workshop" target="_blank" rel="noopener noreferrer">Read the workshop details</a></p></td>

        <td><h2>Next event</h2><p>Saturday, 10 AM. Everyone is welcome.</p></td>
        </tr></table>
        <table class="orca-mail-layout" role="presentation"></table>
        <p>End of community update.</p>

        </td></tr></table>
        </div>
        """
        // END API NEWSLETTER FIXTURE
        for (width, size, theme) in layouts {
            let metrics = try await render(html, width: width, size: size, theme: theme, evidenceName: "actual-newsletter")
            assertFits(metrics, width: width, size: size)
            XCTAssertEqual(number(metrics, "formattedFontSize"), Double(size) * 18 / 22, accuracy: 0.1)
            XCTAssertEqual(metrics["layoutRowsStacked"] as? Bool, true, "Every newsletter row must stack its columns in reading order")
            XCTAssertGreaterThanOrEqual(number(metrics, "minimumLayoutCellWidth"), Double(width) - 1)
            XCTAssertEqual(number(metrics, "imageCount"), 0)
            XCTAssertEqual(metrics["links"] as? [String], ["https://example.invalid/workshop"])
            let text = metrics["bodyText"] as? String ?? ""
            for expected in ["Your community update", "Community workshop banner", "News from the workshop", "Join us this Saturday", "Next event", "Saturday, 10 AM.", "End of community update."] {
                XCTAssertTrue(text.contains(expected), "Missing newsletter content: \(expected)")
            }
        }
    }

    // BRE-444: the unchanged baseline failed these readable-width assertions.
    // Keep the same fixture and thresholds while checking the scoped sizing hint.
    // This literal is checked against the real API sanitizer by its contract test.
    func testUnmarkedDigestUsesAvailableWidthInsteadOfEqualSpacerColumns() async throws {
        // BEGIN API UNMARKED DIGEST FIXTURE
        let html = """

        <table border="0" cellspacing="0" width="100%" class="orca-mail-spacer-table"><tr><td>
          <table width="100%" class="orca-mail-spacer-table"><tr><td class="orca-mail-spacer-cell"></td><td width="650" align="center" style="text-align:center;padding:20px 0;font-family:Arial,sans-serif"><a href="https://example.invalid/community" style="font-size:22px;text-decoration:none" target="_blank" rel="noopener noreferrer"><strong>Example Developer Community</strong></a></td><td class="orca-mail-spacer-cell"></td></tr></table>
          <table width="100%" style="padding:0;border-spacing:0;font-family:Arial,sans-serif;font-size:14px;line-height:1.3" class="orca-mail-spacer-table"><tr>
            <td style="padding:0" class="orca-mail-spacer-cell"><table style="border-spacing:0;padding:0;width:100%"><tr><td height="400" style="height:400px;padding:0">&#xa0;</td></tr></table></td>
            <td width="650" style="padding:0;font-family:Arial,sans-serif">
              <p>Since your last visit</p>
              <table style="table-layout:fixed;width:100%;min-width:100%"><tr>
                <td style="text-align:center;font-size:36px"><a href="https://example.invalid/new" target="_blank" rel="noopener noreferrer"><strong>123</strong></a></td>
                <td style="text-align:center;font-size:36px"><a href="https://example.invalid/users" target="_blank" rel="noopener noreferrer"><strong>459</strong></a></td>
              </tr><tr><td style="text-align:center;font-size:14px">New topics</td><td style="text-align:center;font-size:14px">New users</td></tr></table>
              <p>Every word in this synthetic digest should remain easy to read.</p>
            </td>
            <td style="padding:0" class="orca-mail-spacer-cell"><table style="border-spacing:0;padding:0;width:100%"><tr><td height="400" style="height:400px;padding:0">&#xa0;</td></tr></table></td>
          </tr></table>
          <table><caption>Synthetic checks</caption><tr><th>Check</th><th>Status</th></tr><tr><td>Build</td><td>Passed</td></tr></table>
          <p><span class="orca-mail-image-note">[Image blocked: Synthetic digest banner]</span></p>
          <p>End of synthetic digest.</p>
        </td><td class="orca-mail-spacer-cell"></td></tr></table>

        """
        // END API UNMARKED DIGEST FIXTURE
        for width in [CGFloat(272), 342, 700] {
            for size in [CGFloat(22), 44] {
                for theme in [ColorScheme.light, .dark] {
                    let metrics = try await render(html, width: width, size: size, theme: theme, evidenceName: "unmarked-digest")
                    assertFits(metrics, width: width, size: size)
                    XCTAssertGreaterThanOrEqual(number(metrics, "digestTitleContentWidth"), Double(width) * 0.8,
                        "Empty spacer columns must yield available width to digest content: \(metrics)")
                    XCTAssertGreaterThanOrEqual(number(metrics, "digestBodyContentWidth"), Double(width) * 0.8,
                        "Nested blank gutters must yield available width to body content: \(metrics)")
                    XCTAssertLessThanOrEqual(number(metrics, "digestTitleLineCount"), 3,
                        "The short digest title must wrap as words, not narrow character stacks")
                    XCTAssertEqual(metrics["digestStatLineCounts"] as? [Int], [1, 1],
                        "Short numeric statistics must stay on one line")
                    XCTAssertEqual(metrics["digestStatsTableDisplay"] as? String, "table")
                    XCTAssertEqual(metrics["digestStatsColumnCount"] as? [Int], [2, 2])
                    XCTAssertEqual(metrics["digestStatsStayInColumns"] as? Bool, true,
                        "Headerless statistics must keep two aligned columns and their labels")
                    XCTAssertEqual(metrics["captionedTableDisplay"] as? String, "table")
                    XCTAssertEqual(metrics["headers"] as? [String], ["Check", "Status"])
                    XCTAssertEqual(number(metrics, "imageCount"), 0, "Remote image remains a blocked placeholder")
                    XCTAssertEqual(metrics["links"] as? [String], ["https://example.invalid/community", "https://example.invalid/new", "https://example.invalid/users"])
                    let text = metrics["bodyText"] as? String ?? ""
                    for expected in ["Example Developer Community", "123", "459", "New topics", "New users", "Synthetic checks", "Build", "Passed", "Synthetic digest banner", "End of synthetic digest."] {
                        XCTAssertTrue(text.contains(expected), "Missing synthetic digest content: \(expected)")
                    }
                }
            }
        }
    }

    func testOrdinaryEmailAndLongThreadKeepReaderTypographyAndContent() async throws {
        let replies = (1...30).map { "<blockquote><p>Reply \($0): A longer conversation remains readable.</p></blockquote>" }.joined()
        for (width, size, theme) in layouts {
            let metrics = try await render("<p>Hello team,</p><p>The meeting is tomorrow.</p>" + replies + "<p>Last reply.</p>", width: width, size: size, theme: theme, evidenceName: "ordinary-long-thread")
            assertFits(metrics, width: width, size: size)
            XCTAssertTrue((metrics["bodyText"] as? String ?? "").contains("Reply 30:"))
            XCTAssertTrue((metrics["bodyText"] as? String ?? "").contains("Last reply."))
            XCTAssertTrue((metrics["bodyFontFamily"] as? String ?? "").contains("OrcaReader"))
        }
    }

    private func assertFits(_ metrics: [String: Any], width: CGFloat, size: CGFloat, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(metrics["cellsContainText"] as? Bool, true, "Table text must fit its own cell without overlapping adjacent columns", file: file, line: line)
        XCTAssertEqual(number(metrics, "bodyFontSize"), Double(size), accuracy: 0.1, "Keep the requested reading size", file: file, line: line)
        XCTAssertLessThanOrEqual(number(metrics, "documentWidth"), Double(width) + 1, "The disabled outer scroll view must not hide horizontal overflow: \(metrics)", file: file, line: line)
        XCTAssertLessThanOrEqual(number(metrics, "textRight"), Double(width) + 1, "Every rendered text fragment must fit the reader", file: file, line: line)
        XCTAssertGreaterThanOrEqual(number(metrics, "textLeft"), -1, file: file, line: line)
        XCTAssertGreaterThanOrEqual(number(metrics, "scale"), 0.99, "Do not shrink the entire message to fit wide content", file: file, line: line)
    }

    private func number(_ metrics: [String: Any], _ key: String, file: StaticString = #filePath, line: UInt = #line) -> Double {
        guard let value = (metrics[key] as? NSNumber)?.doubleValue, value.isFinite else {
            XCTFail("Missing or nonfinite reader metric: \(key)", file: file, line: line)
            return .nan
        }
        return value
    }

    private func render(_ html: String, width: CGFloat, size: CGFloat, theme: ColorScheme, evidenceName: String = "overflow", wideContent: Bool = false) async throws -> [String: Any] {
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
        view.backgroundColor = controller.view.backgroundColor
        view.underPageBackgroundColor = controller.view.backgroundColor!
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
        coordinator.update(view, html: html, colorScheme: theme, size: size, wideContent: wideContent)
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
        const formatted = document.querySelector('.orca-mail-formatted');
        const dataTable = document.querySelector('table:not(.orca-mail-layout)');
        const layoutCells = Array.from(document.querySelectorAll('table.orca-mail-layout > tbody > tr > td'));
        const layoutBounds = layoutCells.map(cell => cell.getBoundingClientRect());
        // Measure rendered text fragments, not the anchor's inline bounding box.
        // Deduplicate line positions because nested strong elements share a line.
        const lineCount = element => {
          if (!element) return -1;
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const tops = new Set();
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(walker.currentNode);
            for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) tops.add(Math.round(rect.top));
          }
          return tops.size;
        };
        const digestTitle = document.querySelector('a[href="https://example.invalid/community"]');
        const digestCell = digestTitle?.closest('td');
        const digestCellStyle = digestCell ? getComputedStyle(digestCell) : null;
        const captionedTable = document.querySelector('caption')?.parentElement;
        const statsTable = document.querySelector('a[href="https://example.invalid/new"]')?.closest('table');
        const digestBodyCell = statsTable?.closest('td');
        const digestBodyTable = digestBodyCell?.closest('table');
        const digestBodyStyle = digestBodyCell ? getComputedStyle(digestBodyCell) : null;
        const digestGutters = digestBodyCell ? Array.from(digestBodyCell.parentElement.cells).filter(cell => cell !== digestBodyCell) : [];
        const statRows = statsTable ? Array.from(statsTable.rows) : [];
        const statBounds = statRows.map(row => Array.from(row.cells).map(cell => cell.getBoundingClientRect()));
        const wide = document.querySelector('.orca-wide-content');
        let wideScrolled = 0;
        if (wide) { wide.scrollLeft = wide.scrollWidth; wideScrolled = wide.scrollLeft; }
        return {
          wideClientWidth: wide?.clientWidth ?? 0, wideScrollWidth: wide?.scrollWidth ?? 0, wideScrolled,
          digestBodyContentWidth: digestBodyCell ? digestBodyCell.clientWidth - parseFloat(digestBodyStyle.paddingLeft) - parseFloat(digestBodyStyle.paddingRight) : 0,
          digestBodyTableLayout: digestBodyTable ? getComputedStyle(digestBodyTable).tableLayout : '',
          digestGutterWidths: digestGutters.map(cell => cell.getBoundingClientRect().width),
          digestGutterComputedWidths: digestGutters.map(cell => getComputedStyle(cell).width),
          digestGutterNestedTableWidths: digestGutters.flatMap(cell => Array.from(cell.querySelectorAll('table')).map(table => table.getBoundingClientRect().width)),
          digestGutterNestedTableLayouts: digestGutters.flatMap(cell => Array.from(cell.querySelectorAll('table')).map(table => getComputedStyle(table).tableLayout)),
          digestStatsTableDisplay: statsTable ? getComputedStyle(statsTable).display : '',
          digestStatsColumnCount: statRows.map(row => row.cells.length),
          digestStatsStayInColumns: statBounds.length === 2 && statBounds.every(row => row.length === 2
            && Math.abs(row[0].top - row[1].top) <= 1 && row[0].right <= row[1].left + 1)
            && statBounds[1].every((cell, index) => Math.abs(cell.left - statBounds[0][index].left) <= 1),
          digestTitleContentWidth: digestCell ? digestCell.clientWidth - parseFloat(digestCellStyle.paddingLeft) - parseFloat(digestCellStyle.paddingRight) : 0,
          digestTitleLineCount: lineCount(digestTitle),
          digestStatLineCounts: ['new', 'users'].map(path => lineCount(document.querySelector('a[href="https://example.invalid/' + path + '"]'))),
          captionedTableDisplay: captionedTable ? getComputedStyle(captionedTable).display : '',
          documentWidth: document.documentElement.scrollWidth,
          bodyFontSize: parseFloat(getComputedStyle(document.body).fontSize),
          bodyFontFamily: getComputedStyle(document.body).fontFamily,
          bodyText: document.body.textContent,
          formattedFontSize: formatted ? parseFloat(getComputedStyle(formatted).fontSize) : 0,
          dataTableDisplay: dataTable ? getComputedStyle(dataTable).display : '',
          layoutCellCount: layoutCells.length,
          layoutRowsStacked: Array.from(document.querySelectorAll('table.orca-mail-layout > tbody > tr')).every(row => {
            const cells = Array.from(row.children).filter(node => node.tagName === 'TD').map(node => node.getBoundingClientRect());
            return cells.every((r, index) => index === 0 || r.top >= cells[index - 1].bottom - 1);
          }),
          minimumLayoutCellWidth: layoutBounds.length ? Math.min(...layoutBounds.map(r => r.width)) : 0,
          layoutCellsStacked: layoutBounds.every((r, index) => index === 0 || r.top >= layoutBounds[index - 1].bottom - 1),
          links: Array.from(document.querySelectorAll('a')).map(a => a.getAttribute('href')),
          imageCount: document.querySelectorAll('img').length,
          textRight: Math.max(...rectangles.map(r => r.right)),
          textLeft: Math.min(...rectangles.map(r => r.left)),
          scale: window.visualViewport.scale,
          preHeight: pre ? pre.getBoundingClientRect().height : 0,
          preWhiteSpace: pre ? getComputedStyle(pre).whiteSpace : '',
          preText: pre ? pre.textContent : '',
          headers: Array.from(document.querySelectorAll('th')).map(n => n.textContent),
          cells: Array.from(document.querySelectorAll('td')).map(n => n.textContent),
          cellsContainText: Array.from(document.querySelectorAll('th,td')).every(cell => {
            const bounds = cell.getBoundingClientRect(), range = document.createRange();
            range.selectNodeContents(cell);
            return Array.from(range.getClientRects()).every(r => r.left >= bounds.left - 1 && r.right <= bounds.right + 1);
          }),
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
                // The reader HTML is transparent over a native theme surface.
                // WebKit's captured pixels omit that surface; include the same
                // host backdrop so light-mode screenshots are readable too.
                let image = UIGraphicsImageRenderer(size: snapshot.size).image { context in
                    controller.view.backgroundColor!.setFill()
                    context.fill(CGRect(origin: .zero, size: snapshot.size))
                    snapshot.draw(at: .zero)
                }
                let attachment = XCTAttachment(image: image)
                attachment.name = "reader-\(evidenceName)-\(theme)-\(Int(width))-\(Int(size))"
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
