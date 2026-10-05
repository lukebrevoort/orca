import XCTest
import SwiftUI
import WebKit
@testable import Orca

@MainActor
final class SafeHTMLViewTests: XCTestCase {
    private final class LoadingSpy: WKWebView {
        var documents = [String]()
        var baseURLs = [URL?]()

        override func loadHTMLString(_ string: String, baseURL: URL?) -> WKNavigation? {
            documents.append(string)
            baseURLs.append(baseURL)
            return nil
        }
    }

    func testRepeatedUpdatesDoNotReloadWebContent() {
        let view = LoadingSpy()
        let coordinator = SafeHTMLView.Coordinator()
        for _ in 0..<100 {
            coordinator.update(view, html: "<p>A calm conversation</p>", colorScheme: .light, size: 22)
        }
        XCTAssertEqual(view.documents.count, 1)
        XCTAssertNil(view.baseURLs.first!)
    }

    func testMessageThemeAndTypeSizeChangesReloadWithoutStaleContent() throws {
        let view = LoadingSpy()
        let coordinator = SafeHTMLView.Coordinator()
        coordinator.update(view, html: "<p>First account message</p>", colorScheme: .light, size: 22)
        coordinator.update(view, html: "<p>Second account message</p>", colorScheme: .light, size: 22)
        coordinator.update(view, html: "<p>Second account message</p>", colorScheme: .dark, size: 22)
        coordinator.update(view, html: "<p>Second account message</p>", colorScheme: .dark, size: 36)
        XCTAssertEqual(view.documents.count, 4)
        let last = try XCTUnwrap(view.documents.last)
        XCTAssertFalse(last.contains("First account message"))
        XCTAssertTrue(last.contains("Second account message"))
        XCTAssertTrue(last.contains("color-scheme:dark"))
        XCTAssertTrue(last.contains("font-size:36.0px"))
        coordinator.update(view, html: "", colorScheme: .light, size: 22)
        XCTAssertEqual(view.documents.count, 5)
        XCTAssertFalse(try XCTUnwrap(view.documents.last).contains("Second account message"))
    }

    func testEquivalentFreshStringsAndIndependentReaders() {
        let first = LoadingSpy()
        let firstCoordinator = SafeHTMLView.Coordinator()
        let html = String(repeating: "<p>Conversation</p>", count: 500)
        firstCoordinator.update(first, html: html, colorScheme: .light, size: 22)
        for _ in 0..<10 {
            let fresh = String(decoding: Array(html.utf8), as: UTF8.self)
            firstCoordinator.update(first, html: fresh, colorScheme: .light, size: 22)
        }
        XCTAssertEqual(first.documents.count, 1)
        let second = LoadingSpy()
        let secondCoordinator = SafeHTMLView.Coordinator()
        secondCoordinator.update(second, html: html, colorScheme: .light, size: 22)
        XCTAssertEqual(second.documents.count, 1, "Identical content in a new reader must still load")
        firstCoordinator.update(first, html: html + "<p>Newest reply</p>", colorScheme: .light, size: 22)
        XCTAssertEqual(first.documents.count, 2)
        XCTAssertEqual(second.documents.count, 1)
        XCTAssertFalse(second.documents[0].contains("Newest reply"))
    }

    func testReaderShellKeepsSecurityAndTypographyContract() throws {
        let view = LoadingSpy()
        SafeHTMLView.Coordinator().update(view, html: "<p>Message</p>", colorScheme: .light, size: 22)
        let document = try XCTUnwrap(view.documents.first)
        XCTAssertTrue(document.contains("default-src 'none'; img-src data: cid:; font-src data:; style-src 'unsafe-inline'"))
        XCTAssertTrue(document.contains("data:font/ttf;base64,"))
        XCTAssertTrue(document.contains("font-family:OrcaReader,Georgia,serif"))
        XCTAssertTrue(document.contains("color:#102522"))
        XCTAssertTrue(document.hasSuffix("<p>Message</p>"))
        XCTAssertGreaterThan(document.utf8.count, 600_000, "The production Newsreader font must be in the test host")
        XCTAssertNil(view.baseURLs.first!)
    }

    /// Measures the actual preparation path called by updateUIView. WebKit load
    /// and layout are intentionally excluded; this is not tap-to-paint latency.
    func testProfileRepeatedReaderPreparation() throws {
        let paragraph = "<p>A thoughtful reply keeps enough context to read the conversation comfortably.</p>"
        for paragraphs in [1, 100, 1_000] {
            let html = String(repeating: paragraph, count: paragraphs)
            let view = LoadingSpy()
            let coordinator = SafeHTMLView.Coordinator()
            coordinator.update(view, html: html, colorScheme: .light, size: 22)
            var samples = [Double]()
            let updates = 1_000
            for _ in 0..<9 {
                let start = ProcessInfo.processInfo.systemUptime
                for _ in 0..<updates {
                    coordinator.update(view, html: html, colorScheme: .light, size: 22)
                }
                samples.append((ProcessInfo.processInfo.systemUptime - start) * 1_000)
            }
            XCTAssertEqual(view.documents.count, 1)
            samples.sort()
            let result: [String: Any] = [
                "kind": "unchanged-reader-preparation", "paragraphs": paragraphs,
                "htmlBytes": html.utf8.count, "documentBytes": try XCTUnwrap(view.documents.first).utf8.count,
                "updatesPerSample": updates, "samplesMS": samples,
                "medianMS": samples[samples.count / 2], "maxMS": samples.last!,
                "webKitLoads": view.documents.count,
            ]
            let encoded = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            print("NATIVE_READER_PROFILE " + String(decoding: encoded, as: UTF8.self))
        }
    }
}
