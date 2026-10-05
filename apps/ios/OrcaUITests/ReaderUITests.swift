import XCTest

final class ReaderUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testLongHTMLScrollBackAndRepeatedOpen() throws {
        let app = try launchReader()
        for pass in 1...2 {
            openHTML(in: app)
            let first = app.staticTexts["Explicit dark foreground stays readable."]
            XCTAssertTrue(first.waitForExistence(timeout: 10))
            XCTAssertTrue(isVisible(first, in: app), "Every open should begin at the top of this HTML message")
            screenshot("reader-open-\(pass)")
            let end = app.staticTexts["End of the long reading fixture."]
            XCTAssertFalse(isVisible(end, in: app), "The long fixture must start with its end outside the viewport")
            var scrolls = 0
            for _ in 0..<20 {
                if isVisible(end, in: app) { break }
                app.swipeUp(velocity: .fast)
                scrolls += 1
            }
            XCTAssertGreaterThan(scrolls, 0, "The long fixture must exercise actual scrolling")
            screenshot("reader-end-check-\(pass)")
            XCTAssertTrue(isVisible(end, in: app), "The complete HTML body must remain visible in the reader viewport")
            XCTAssertTrue(app.buttons["Reply"].isHittable)
            screenshot("reader-bottom-\(pass)")
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        }
    }

    func testHTMLAtAccessibilityTypeSize() throws {
        let app = try launchReader(contentSize: "UICTContentSizeCategoryAccessibilityXXXL")
        openHTML(in: app)
        let first = app.staticTexts["Explicit dark foreground stays readable."]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        for _ in 0..<6 {
            if isVisible(first, in: app) { break }
            app.swipeUp()
        }
        screenshot("reader-accessibility-visibility-check")
        XCTAssertTrue(isVisible(first, in: app))
        XCTAssertTrue(app.buttons["Reply"].isHittable)
        screenshot("reader-accessibility-type")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
    }

    private func launchReader(contentSize: String = "UICTContentSizeCategoryL") throws -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        let url = try XCTUnwrap(environment["ORCA_FIXTURE_API_URL"])
        let token = try XCTUnwrap(environment["ORCA_FIXTURE_ACCESS_TOKEN"])
        XCTAssertFalse(url.isEmpty)
        XCTAssertFalse(token.isEmpty)
        let app = XCUIApplication()
        app.launchArguments = ["--fixture-api-url", url, "--fixture-access-token", token,
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-UIPreferredContentSizeCategoryName", contentSize]
        app.launch()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 20))
        return app
    }

    private func openHTML(in app: XCUIApplication) {
        let row = app.descendants(matching: .any)["inbox.message.ios-fixture-message-3"]
        let list = app.descendants(matching: .any)["inbox.list"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        // At large text sizes SwiftUI virtualizes this row until it scrolls
        // into the list. Waiting for its existence first can never reveal it.
        for _ in 0..<12 {
            if row.exists && row.isHittable { break }
            list.swipeUp()
        }
        screenshot("reader-inbox-before-open")
        XCTAssertTrue(row.exists && row.isHittable)
        row.tap()
        XCTAssertTrue(app.navigationBars["Conversation"].waitForExistence(timeout: 10))
    }

    private func isVisible(_ text: XCUIElement, in app: XCUIApplication) -> Bool {
        guard text.exists else { return false }
        // WebKit can mark offscreen accessibility text as hittable. Require
        // its actual frame to be within the unobscured scroll viewport too.
        let top = app.navigationBars["Conversation"].frame.maxY
        let bottom = app.buttons["Reply"].frame.minY - 12
        let frame = text.frame
        let visible = frame.width > 0 && frame.height > 0 && frame.minY >= top && frame.maxY <= bottom
        print("READER_VISIBILITY frame=\(frame) top=\(top) bottom=\(bottom) visible=\(visible)")
        return visible && text.isHittable
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
