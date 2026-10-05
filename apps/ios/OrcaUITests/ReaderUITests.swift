import XCTest

final class ReaderUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testLongHTMLScrollBackAndRepeatedOpen() throws {
        let app = try launchReader()
        for pass in 1...2 {
            openHTML(in: app)
            let first = app.staticTexts["Explicit dark foreground stays readable."]
            XCTAssertTrue(first.waitForExistence(timeout: 10))
            XCTAssertTrue(first.isHittable, "Every open should begin at the top of this HTML message")
            screenshot("reader-open-\(pass)")
            let end = app.staticTexts["End of the long reading fixture."]
            for _ in 0..<20 {
                if end.exists && end.isHittable { break }
                app.swipeUp(velocity: .fast)
            }
            XCTAssertTrue(end.isHittable, "The complete HTML body must remain reachable")
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
            if first.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(first.isHittable)
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
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        for _ in 0..<5 {
            if row.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(row.isHittable)
        row.tap()
        XCTAssertTrue(app.navigationBars["Conversation"].waitForExistence(timeout: 10))
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
