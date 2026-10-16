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
            let reply = app.buttons["Reply"]
            let replyTitle = reply.staticTexts["Reply"]
            XCTAssertTrue(replyTitle.exists)
            XCTAssertLessThan(replyTitle.frame.height, reply.frame.height * 0.6,
                "The Reply text itself must remain on one line at ordinary size")
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
            let returnedToInbox = app.navigationBars["Inbox"].waitForExistence(timeout: 10)
            if !returnedToInbox {
                screenshot("reader-back-navigation-failure")
                var hierarchy = app.debugDescription
                if let token = ProcessInfo.processInfo.environment["ORCA_FIXTURE_ACCESS_TOKEN"], !token.isEmpty {
                    hierarchy = hierarchy.replacingOccurrences(of: token, with: "[REDACTED]")
                }
                print("READER_BACK_FAILURE_HIERARCHY_BEGIN\n\(hierarchy)\nREADER_BACK_FAILURE_HIERARCHY_END")
            }
            XCTAssertTrue(returnedToInbox, "One Back tap must return from the reader to Inbox")
        }
    }

    func testHTMLAtAccessibilityTypeSize() throws {
        let app = try launchReader(contentSize: "UICTContentSizeCategoryAccessibilityXXXL")
        openHTML(in: app)
        let first = app.staticTexts["Explicit dark foreground stays readable."]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        reveal(first, in: app)
        screenshot("reader-accessibility-visibility-check")
        XCTAssertTrue(isVisible(first, in: app))
        let labels = ["Reply", "Reply all", "Forward"]
        let actions = labels.map { app.buttons[$0] }
        for (label, button) in zip(labels, actions) {
            XCTAssertEqual(button.label, label)
            XCTAssertTrue(button.isHittable)
            XCTAssertGreaterThanOrEqual(button.frame.height, 44)
            XCTAssertGreaterThan(button.frame.width, app.frame.width * 0.7)
            XCTAssertTrue(app.frame.contains(button.frame))
        }
        XCTAssertLessThan(actions[0].frame.maxY, actions[1].frame.minY)
        XCTAssertLessThan(actions[1].frame.maxY, actions[2].frame.minY)
        let accessibilityOrder = app.buttons.matching(NSPredicate(format: "label IN %@", labels))
            .allElementsBoundByIndex.map { $0.label }
        XCTAssertEqual(accessibilityOrder, labels, "Accessible actions should follow their visual top-to-bottom order")
        XCTAssertLessThan(actions[0].frame.height, actions[0].frame.width / 2, "Reply must not wrap into a narrow vertical label")
        screenshot("reader-accessibility-stacked-actions")
        // Open and return from every action without editing or sending. This
        // checks each destination and that the reader remains usable afterward.
        for (label, title) in [("Reply", "Reply"), ("Reply all", "Reply All"), ("Forward", "Forward")] {
            app.buttons[label].tap()
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10))
            if label != "Forward" {
                let recipient = app.textFields["compose.to"]
                XCTAssertTrue(recipient.waitForExistence(timeout: 10))
                XCTAssertTrue(String(describing: recipient.value).contains("sofia@example.com"))
            }
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(app.navigationBars["Conversation"].waitForExistence(timeout: 10))
            XCTAssertTrue(app.buttons[label].isHittable)
        }
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
    }

    func testImagesRequireExplicitLoadingAndResetOnReopen() throws {
        guard ProcessInfo.processInfo.environment["ORCA_FIXTURE_IMAGES"] == "1" else { throw XCTSkip("Requires the isolated image fixture") }
        let initialDownloads = try imageDownloadCount()
        let app = try launchReader()
        let row = app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        let load = app.buttons["message.load-images"]
        XCTAssertTrue(load.waitForExistence(timeout: 10))
        for _ in 0..<4 { if load.isHittable { break }; app.swipeUp() }
        XCTAssertEqual(try imageDownloadCount(), initialDownloads, "Opening a message must not contact image hosts")
        screenshot("images-blocked-before-consent")
        load.tap()
        let status = app.staticTexts["message.images-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertTrue(status.label.contains("1 image loaded."))
        let landscape = app.images["Synthetic landscape"]
        for _ in 0..<4 { if landscape.exists && landscape.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(landscape.exists && landscape.isHittable)
        XCTAssertEqual(try imageDownloadCount(), initialDownloads + 1)
        screenshot("images-loaded-after-consent")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.buttons["message.load-images"].waitForExistence(timeout: 10))
        XCTAssertEqual(try imageDownloadCount(), initialDownloads + 1, "Reopening must reset consent without another request")
        screenshot("images-blocked-after-reopen")
        try delayFixtureImageResponse()
        let reopenedLoad = app.buttons["message.load-images"]
        for _ in 0..<4 { if reopenedLoad.isHittable { break }; app.swipeUp() }
        reopenedLoad.tap()
        for _ in 0..<10 {
            if try imageDownloadCount() == initialDownloads + 2 { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertEqual(try imageDownloadCount(), initialDownloads + 2, "The delayed request must be in flight before navigating away")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        row.tap()
        let lateResponse = expectation(description: "Delayed image response has finished")
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { lateResponse.fulfill() }
        wait(for: [lateResponse], timeout: 7)
        XCTAssertTrue(app.buttons["message.load-images"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["message.images-status"].exists, "A previous reader's response must not restore images")
        screenshot("images-late-response-discarded")
    }

    private func delayFixtureImageResponse() throws {
        let environment = ProcessInfo.processInfo.environment
        let base = try XCTUnwrap(environment["ORCA_FIXTURE_API_URL"])
        var request = URLRequest(url: try XCTUnwrap(URL(string: base + "/__fixture/image-delay")))
        request.httpMethod = "POST"
        request.setValue("Bearer " + (environment["ORCA_FIXTURE_ACCESS_TOKEN"] ?? ""), forHTTPHeaderField: "Authorization")
        let done = expectation(description: "Delay fixture image response")
        var status: Int?
        URLSession.shared.dataTask(with: request) { _, response, _ in status = (response as? HTTPURLResponse)?.statusCode; done.fulfill() }.resume()
        wait(for: [done], timeout: 5)
        XCTAssertEqual(status, 204)
    }

    private func imageDownloadCount() throws -> Int {
        let environment = ProcessInfo.processInfo.environment
        let base = try XCTUnwrap(environment["ORCA_FIXTURE_API_URL"])
        let token = try XCTUnwrap(environment["ORCA_FIXTURE_ACCESS_TOKEN"])
        var request = URLRequest(url: try XCTUnwrap(URL(string: base + "/__fixture/image-downloads")))
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let done = expectation(description: "Fixture image request count")
        var count: Int?
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Int] { count = value["count"] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 5)
        return try XCTUnwrap(count)
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

    private func reveal(_ text: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<16 {
            if isVisible(text, in: app) { return }
            let top = app.navigationBars["Conversation"].frame.maxY
            let bottom = app.buttons["Reply"].frame.minY - 12
            // Contextual jumps can cover the center drag origin at large
            // text sizes. Start in scroll content, above every visible jump,
            // so the gesture tests scrolling rather than dragging a Button.
            let jumps = ["thread.jump-unread", "thread.jump-latest"]
                .map { app.buttons[$0] }.filter { $0.exists && $0.isHittable }
            let gestureBottom = jumps.reduce(bottom) { min($0, $1.frame.minY - 12) }
            XCTAssertGreaterThan(gestureBottom - top, 80, "Reader needs an unobscured scroll gesture area")
            let frame = text.frame
            let step = max(40, (gestureBottom - top) * 0.5)
            let distance = frame.minY < top
                ? -min(top - frame.minY + 8, step)
                : min(max(frame.maxY - bottom + 8, 30), step)
            let startY = distance > 0 ? gestureBottom - 20 : top + 20
            let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            let start = origin.withOffset(CGVector(dx: app.frame.width / 2, dy: startY))
            let end = origin.withOffset(CGVector(dx: app.frame.width / 2, dy: startY - distance))
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
        }
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
