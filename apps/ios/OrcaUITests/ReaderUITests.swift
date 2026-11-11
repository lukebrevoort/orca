import XCTest

final class ReaderUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testEarlierMessagesRemainReadableAtAccessibilitySize() throws {
        try setLongReader(true)
        addTeardownBlock { try self.setLongReader(false) }
        let app = try launchReader(contentSize: "UICTContentSizeCategoryAccessibilityXXXL")
        let row = app.buttons["inbox.message.ios-fixture-message-1"]
        revealInboxRow("inbox.message.ios-fixture-message-1", in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        let toggle = app.buttons["Show 21 earlier messages"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        let text = app.staticTexts["21 earlier messages"]
        XCTAssertTrue(text.exists)
        // The complete words need room to wrap, rather than one or two letters
        // per line. Assert the actual text bounds, not just the hit target.
        XCTAssertGreaterThan(text.frame.width, toggle.frame.width * 0.6)
        XCTAssertLessThan(text.frame.height, text.frame.width)
        for _ in 0..<6 {
            if toggle.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(toggle.isHittable)
        XCTAssertGreaterThanOrEqual(toggle.frame.height, 44)
        revealReaderControl(toggle, in: app, scrollUp: true)
        screenshot( "earlier-messages-accessibility-collapsed")
        toggle.tap()
        let hide = app.buttons["Hide 21 earlier messages"]
        revealReaderControl(hide, in: app, scrollUp: false)
        XCTAssertTrue(hide.waitForExistence(timeout: 5))
        XCTAssertEqual(hide.value as? String, "Expanded")
        screenshot( "earlier-messages-accessibility-expanded")
        hide.tap()
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "Collapsed")
    }

    private func revealReaderControl(_ control: XCUIElement, in app: XCUIApplication, scrollUp: Bool,
                                     file: StaticString = #filePath, line: UInt = #line) {
        let reader = app.scrollViews["thread.reader"]
        XCTAssertTrue(reader.waitForExistence(timeout: 5), file: file, line: line)
        for attempt in 0..<12 {
            let top = max(reader.frame.minY, app.navigationBars.firstMatch.frame.maxY) + 8
            let bottom = min(reader.frame.maxY, app.buttons["Reply"].frame.minY) - 8
            if control.exists && control.isHittable && control.frame.minY >= top && control.frame.maxY <= bottom {
                print("[bre-459] reader_disclosure_frame=\(control.frame) visible_top=\(top) visible_bottom=\(bottom)")
                return
            }
            let up = control.exists && !control.frame.isEmpty ? control.frame.maxY > bottom : (attempt < 6 ? scrollUp : !scrollUp)
            reader.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: up ? 0.75 : 0.25))
                .press(forDuration: 0.05, thenDragTo: reader.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: up ? 0.25 : 0.75)))
        }
        screenshot("bre-459-reader-disclosure-unreachable")
        XCTFail("Earlier-message disclosure must be fully reachable between navigation and reply actions", file: file, line: line)
    }

    private func setLongReader(_ enabled: Bool) throws {
        let environment = ProcessInfo.processInfo.environment
        let base = try XCTUnwrap(environment["ORCA_FIXTURE_API_URL"])
        var request = URLRequest(url: try XCTUnwrap(URL(string: base + "/__fixture/reader")))
        request.httpMethod = "POST"
        request.setValue("Bearer " + (environment["ORCA_FIXTURE_ACCESS_TOKEN"] ?? ""), forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["enabled": enabled])
        let done = expectation(description: "Configure synthetic long reader")
        var status: Int?
        URLSession.shared.dataTask(with: request) { _, response, _ in
            status = (response as? HTTPURLResponse)?.statusCode; done.fulfill()
        }.resume()
        wait(for: [done], timeout: 5)
        XCTAssertEqual(status, 204)
    }

    func testLongHTMLScrollBackAndRepeatedOpen() throws {
        let app = try launchReader(htmlDiagnostics: true)
        for pass in 1...2 {
            openHTML(in: app)
            let first = app.staticTexts["Explicit dark foreground stays readable."]
            XCTAssertTrue(first.waitForExistence(timeout: 10))
            captureReaderGeometry(in: app, first: first, stage: "standard-initial-\(pass)")
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
            readerAction("back-\(pass)-tap-begin")
            app.navigationBars.buttons.firstMatch.tap()
            readerAction("back-\(pass)-tap-returned")
            let returnedToInbox = app.navigationBars["Inbox"].waitForExistence(timeout: 10)
            if !returnedToInbox {
                captureReaderFailure(in: app, stage: "back-\(pass)")
            }
            XCTAssertTrue(returnedToInbox, "One Back tap must return from the reader to Inbox")
        }
    }

    func testHTMLAtAccessibilityTypeSize() throws {
        let app = try launchReader(contentSize: "UICTContentSizeCategoryAccessibilityXXXL")
        openHTML(in: app)
        let first = app.staticTexts["Explicit dark foreground stays readable."]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        captureReaderGeometry(in: app, first: first, stage: "accessibility-initial")
        reveal(first, in: app)
        captureReaderGeometry(in: app, first: first, stage: "accessibility-revealed")
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

    func testMessageToolsPreserveFindFormattingAndWideContentChoices() throws {
        for size in ["UICTContentSizeCategoryL", "UICTContentSizeCategoryAccessibilityXXXL"] {
            let app = try launchReader(contentSize: size)
            openHTML(in: app)
            let tools = app.buttons["reader.tools"]
            XCTAssertFalse(app.buttons["reader.find"].exists)
            openMessageTools(in: app)
            let find = app.buttons["reader.find"]
            XCTAssertTrue(find.exists)
            let wide = app.switches["Keep tables and code wide"]
            revealReaderControl(wide, in: app, scrollUp: true)
            XCTAssertEqual(wide.value as? String, "0")
            wide.tap()
            XCTAssertEqual(wide.value as? String, "1")
            XCTAssertTrue(app.staticTexts["Scroll within this message to reach wide content. Ordinary prose keeps the reading width."].exists)
            revealReaderControl(tools, in: app, scrollUp: false); tools.tap()
            XCTAssertEqual(tools.value as? String, "Collapsed")
            XCTAssertFalse(wide.exists)
            screenshot("tools-wide-live-collapsed-\(size)")
            openMessageTools(in: app)
            revealReaderControl(wide, in: app, scrollUp: true)
            XCTAssertEqual(wide.value as? String, "1", "Closing Tools must preserve the user's active wide-content choice")
            XCTAssertTrue(app.staticTexts["Scroll within this message to reach wide content. Ordinary prose keeps the reading width."].exists)
            screenshot("tools-wide-live-reopened-\(size)")
            wide.tap()
            XCTAssertEqual(wide.value as? String, "0")
            let plain = app.buttons["Plain text"]
            revealReaderControl(plain, in: app, scrollUp: true); plain.tap()
            let plainFind = app.buttons["Find in message"]
            revealReaderControl(plainFind, in: app, scrollUp: false); plainFind.tap()
            let query = app.textFields["reader.find-query"]
            revealReaderControl(query, in: app, scrollUp: true)
            XCTAssertTrue(query.exists); query.tap(); query.typeText("protect")
            XCTAssertTrue(app.staticTexts["1 matches in the complete message"].exists)
            revealReaderControl(tools, in: app, scrollUp: false); tools.tap()
            XCTAssertEqual(tools.value as? String, "Collapsed")
            XCTAssertFalse(query.exists)
            XCTAssertFalse(app.buttons["Formatted message"].exists)
            screenshot("tools-query-live-collapsed-\(size)")
            openMessageTools(in: app)
            revealReaderControl(query, in: app, scrollUp: true)
            XCTAssertEqual(query.value as? String, "protect", "Closing Tools must preserve the live plain-text Find query")
            XCTAssertTrue(app.staticTexts["1 matches in the complete message"].exists)
            XCTAssertTrue(app.buttons["Formatted message"].exists, "Tools reopening must preserve plain-text mode")
            screenshot("tools-query-live-reopened-\(size)")
            let close = app.buttons["Close Find"]
            revealReaderControl(close, in: app, scrollUp: false); close.tap()
            let formatted = app.buttons["Formatted message"]
            revealReaderControl(formatted, in: app, scrollUp: true); formatted.tap()
            XCTAssertTrue(app.buttons["reader.find"].exists)
            revealReaderControl(tools, in: app, scrollUp: false); tools.tap()
            XCTAssertEqual(tools.value as? String, "Collapsed")
            XCTAssertFalse(app.switches["Keep tables and code wide"].exists)
            let first = app.staticTexts["Explicit dark foreground stays readable."]
            XCTAssertTrue(first.exists)
            reveal(first, in: app)
            XCTAssertTrue(isVisible(first, in: app))
            captureReaderGeometry(in: app, first: first, stage: "tools-restored-\(size)")
            app.terminate()
        }
    }

    private func openMessageTools(in app: XCUIApplication) {
        let tools = app.buttons["reader.tools"]
        revealReaderControl(tools, in: app, scrollUp: true)
        XCTAssertGreaterThanOrEqual(tools.frame.height, 44)
        XCTAssertEqual(tools.value as? String, "Collapsed")
        tools.tap()
        XCTAssertEqual(tools.value as? String, "Expanded")
    }

    func testImagesRequireExplicitLoadingAndResetOnReopen() throws {
        guard ProcessInfo.processInfo.environment["ORCA_FIXTURE_IMAGES"] == "1" else { throw XCTSkip("Requires the isolated image fixture") }
        try requireFixtureTransportReady()
        let initialDownloads = try imageDownloadCount()
        let app = try launchReader(htmlDiagnostics: true)
        let row = app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        let load = app.buttons["message.load-images"]
        XCTAssertTrue(load.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Images are blocked. Loading may tell the sender you opened this message."].exists)
        for _ in 0..<4 { if load.isHittable { break }; app.swipeUp() }
        XCTAssertEqual(try imageDownloadCount(), initialDownloads, "Opening a message must not contact image hosts")
        screenshot("images-blocked-before-consent")
        readerAction("load-images-tap-begin")
        load.tap()
        readerAction("load-images-tap-returned")
        let status = app.staticTexts["message.images-status"]
        let statusExists = status.waitForExistence(timeout: 10)
        if !statusExists { captureReaderFailure(in: app, stage: "image-status-exists") }
        XCTAssertTrue(statusExists)
        let loaded = status.label.contains("1 image loaded.")
        if !loaded { captureReaderFailure(in: app, stage: "image-status-loaded") }
        XCTAssertTrue(loaded)
        let landscape = app.images["Synthetic landscape"]
        for _ in 0..<4 { if landscape.exists && landscape.isHittable { break }; app.swipeUp() }
        let landscapeVisible = landscape.exists && landscape.isHittable
        if !landscapeVisible {
            // Record the original failure before observing asynchronous WebKit.
            // Late rendering is diagnostic evidence, never a successful retry.
            continueAfterFailure = true
            XCTAssertTrue(landscapeVisible)
            continueAfterFailure = false
            captureReaderFailure(in: app, stage: "image-landscape-visible")
            observeLateLandscape(in: app, landscape: landscape)
            captureReaderFailure(in: app, stage: "image-landscape-after-observation")
            return
        }
        XCTAssertTrue(landscapeVisible)
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
        XCTAssertFalse(reopenedLoad.isEnabled)
        screenshot("images-loading-disabled")
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

    func testChangedImageSourceRequiresSnapshotRefreshAndNewConsent() throws {
        guard ProcessInfo.processInfo.environment["ORCA_FIXTURE_IMAGES"] == "1" else { throw XCTSkip("Requires the isolated image fixture") }
        try requireFixtureTransportReady()
        try setFixtureImageSource(changed: false)
        try setFixtureImageCapability(enabled: true)
        try setFixtureImageSnapshot(fail: false, delayed: false)
        defer { try? setFixtureImageSource(changed: false); try? setFixtureImageCapability(enabled: true); try? setFixtureImageSnapshot(fail: false, delayed: false) }
        let initial = try imageDownloadCount()
        let app = try launchReader(htmlDiagnostics: true)
        let row = app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        let load = app.buttons["message.load-images"]
        XCTAssertTrue(load.waitForExistence(timeout: 10))
        try setFixtureImageSource(changed: true)
        for _ in 0..<4 { if load.isHittable { break }; app.swipeUp() }
        load.tap()
        let refresh = app.buttons["message.refresh-images-source"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["message.images-status"].label.contains("This message changed"))
        XCTAssertFalse(app.buttons["message.load-images"].exists)
        XCTAssertEqual(try imageDownloadCount(), initial, "Rejecting a stale revision must not fetch images")
        try setFixtureImageSnapshot(fail: true, delayed: false)
        refresh.tap()
        let failure = app.staticTexts["message.images-status"]
        let failedRefresh = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "Message could not be refreshed"), object: failure)
        XCTAssertEqual(XCTWaiter.wait(for: [failedRefresh], timeout: 10), .completed)
        XCTAssertEqual(try imageDownloadCount(), initial, "A failed snapshot refresh must not load images")
        try setFixtureImageSnapshot(fail: false, delayed: false)
        refresh.tap()
        XCTAssertTrue(app.buttons["message.load-images"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Updated synthetic message."].waitForExistence(timeout: 10))
        XCTAssertEqual(try imageDownloadCount(), initial, "Refreshing a safe snapshot must not load images")
        app.buttons["message.load-images"].tap()
        let status = app.staticTexts["message.images-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertTrue(status.label.contains("1 image loaded."))
        XCTAssertEqual(try imageDownloadCount(), initial + 1)
    }

    func testOversizedImageSnapshotRefreshOffersReadOnlyRecovery() throws {
        guard ProcessInfo.processInfo.environment["ORCA_FIXTURE_IMAGES"] == "1" else { throw XCTSkip("Requires the isolated image fixture") }
        try requireFixtureTransportReady()
        try setFixtureImageSource(changed: false)
        try setFixtureImageCapability(enabled: true)
        try setFixtureImageSnapshot(fail: false, delayed: false)
        defer { try? setFixtureImageSource(changed: false); try? setFixtureImageSnapshot(fail: false, delayed: false) }
        let initial = try imageDownloadCount()
        let app = try launchReader()
        let row = app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        let load = app.buttons["message.load-images"]
        XCTAssertTrue(load.waitForExistence(timeout: 10))
        try setFixtureImageSource(changed: true)
        load.tap()
        let refresh = app.buttons["message.refresh-images-source"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 10))
        try setFixtureImageSnapshot(fail: false, delayed: false, overflow: true)
        refresh.tap()
        let pages = app.buttons["Open in pages"]
        XCTAssertTrue(pages.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Reply"].exists); XCTAssertFalse(app.buttons["Forward"].exists)
        XCTAssertFalse(app.buttons["message.load-images"].exists)
        XCTAssertFalse(app.buttons["message.refresh-images-source"].exists)
        XCTAssertEqual(try imageDownloadCount(), initial)
        pages.tap()
        XCTAssertTrue(app.staticTexts["Read-only pages"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Reply"].exists); XCTAssertFalse(app.buttons["Forward"].exists)
        XCTAssertFalse(app.buttons["message.load-images"].exists)
        XCTAssertEqual(try imageDownloadCount(), initial)
        screenshot("image-refresh-overflow-read-only-pages")
    }

    func testNavigatingAwayDuringSnapshotRefreshDoesNotRestoreOldContentOrLoadImages() throws {
        guard ProcessInfo.processInfo.environment["ORCA_FIXTURE_IMAGES"] == "1" else { throw XCTSkip("Requires the isolated image fixture") }
        try requireFixtureTransportReady()
        try setFixtureImageSource(changed: false); try setFixtureImageCapability(enabled: true); try setFixtureImageSnapshot(fail: false, delayed: false)
        defer { try? setFixtureImageSource(changed: false); try? setFixtureImageCapability(enabled: true); try? setFixtureImageSnapshot(fail: false, delayed: false) }
        let initial = try imageDownloadCount()
        let app = try launchReader(htmlDiagnostics: true)
        let row = app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        let load = app.buttons["message.load-images"]
        XCTAssertTrue(load.waitForExistence(timeout: 10))
        try setFixtureImageSource(changed: true)
        for _ in 0..<4 { if load.isHittable { break }; app.swipeUp() }
        load.tap()
        let refresh = app.buttons["message.refresh-images-source"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 10))
        try setFixtureImageSnapshot(fail: false, delayed: true)
        refresh.tap()
        let refreshing = app.buttons.matching(identifier: "message.refresh-images-source").matching(NSPredicate(format: "label == %@", "Refreshing message…")).firstMatch
        XCTAssertTrue(refreshing.waitForExistence(timeout: 10))
        try waitForFixtureImageSnapshotStart()
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        try setFixtureImageSource(changed: false); try setFixtureImageSnapshot(fail: false, delayed: false)
        row.tap()
        XCTAssertTrue(app.buttons["message.load-images"].waitForExistence(timeout: 10))
        let late = expectation(description: "Earlier synthetic snapshot response has finished")
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { late.fulfill() }
        wait(for: [late], timeout: 7)
        XCTAssertFalse(app.staticTexts["Updated synthetic message."].exists)
        XCTAssertFalse(app.staticTexts["message.images-status"].exists)
        XCTAssertEqual(try imageDownloadCount(), initial)
    }

    func testMissingImageCapabilityOffersRefreshWithoutLoading() throws {
        guard ProcessInfo.processInfo.environment["ORCA_FIXTURE_IMAGES"] == "1" else { throw XCTSkip("Requires the isolated image fixture") }
        try requireFixtureTransportReady()
        try setFixtureImageSource(changed: false)
        try setFixtureImageCapability(enabled: false)
        try setFixtureImageSnapshot(fail: false, delayed: false)
        defer { try? setFixtureImageCapability(enabled: true); try? setFixtureImageSnapshot(fail: false, delayed: false) }
        let initial = try imageDownloadCount()
        let app = try launchReader(htmlDiagnostics: true)
        let row = app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        let refresh = app.buttons["message.refresh-images-source"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["message.load-images"].exists)
        // Reset ingress AFTER the initial thread read. Hold the existing fixture
        // response so XCTest can observe this real refresh instead of racing a
        // one-second success between its tap and first accessibility snapshot.
        try setFixtureImageSnapshot(fail: false, delayed: true)
        screenshot("missing-image-capability-before-refresh")
        refresh.tap()
        let refreshing = app.buttons.matching(identifier: "message.refresh-images-source").matching(NSPredicate(format: "label == %@", "Refreshing message…")).firstMatch
        XCTAssertTrue(refreshing.waitForExistence(timeout: 10))
        try waitForFixtureImageSnapshotStart()
        let refreshed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@ AND enabled == true", "Refresh message"), object: refresh)
        XCTAssertEqual(XCTWaiter.wait(for: [refreshed], timeout: 10), .completed)
        XCTAssertFalse(app.buttons["message.load-images"].exists)
        XCTAssertEqual(try imageDownloadCount(), initial)
        screenshot("missing-image-capability-refreshed-without-loading")
    }

    private func setFixtureImageSource(changed: Bool) throws {
        try setFixtureImageControl(path: "image-source", value: ["changed": changed])
    }

    private func setFixtureImageCapability(enabled: Bool) throws {
        try setFixtureImageControl(path: "image-capability", value: ["enabled": enabled])
    }

    private func setFixtureImageSnapshot(fail: Bool, delayed: Bool, overflow: Bool = false) throws {
        try setFixtureImageControl(path: "image-snapshot", value: ["fail": fail, "delayed": delayed, "overflow": overflow])
    }

    private func waitForFixtureImageSnapshotStart() throws {
        let environment = ProcessInfo.processInfo.environment
        let base = try XCTUnwrap(environment["ORCA_FIXTURE_API_URL"])
        let token = try XCTUnwrap(environment["ORCA_FIXTURE_ACCESS_TOKEN"])
        let root = try XCTUnwrap(URL(string: base))
        XCTAssertEqual(root.scheme, "http"); XCTAssertTrue(["127.0.0.1", "localhost"].contains(root.host ?? ""))
        for _ in 0..<30 {
            var request = URLRequest(url: root.appending(path: "__fixture/image-snapshot-started"))
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            let done = expectation(description: "Check synthetic snapshot start")
            var started = false
            URLSession.shared.dataTask(with: request) { data, _, _ in
                if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Bool] { started = json["started"] == true }
                done.fulfill()
            }.resume()
            wait(for: [done], timeout: 5)
            if started { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTFail("Synthetic snapshot refresh did not start")
    }

    private func setFixtureImageControl(path: String, value: [String: Bool]) throws {
        let environment = ProcessInfo.processInfo.environment
        let base = try XCTUnwrap(environment["ORCA_FIXTURE_API_URL"])
        let token = try XCTUnwrap(environment["ORCA_FIXTURE_ACCESS_TOKEN"])
        let root = try XCTUnwrap(URL(string: base))
        XCTAssertEqual(root.scheme, "http"); XCTAssertTrue(["127.0.0.1", "localhost"].contains(root.host ?? ""))
        var request = URLRequest(url: root.appending(path: "__fixture/\(path)"))
        request.httpMethod = "POST"; request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(value)
        let done = expectation(description: "Configure synthetic image fixture")
        var status: Int?
        URLSession.shared.dataTask(with: request) { _, response, _ in status = (response as? HTTPURLResponse)?.statusCode; done.fulfill() }.resume()
        wait(for: [done], timeout: 5); XCTAssertEqual(status, 204)
    }

    // Separate cold simulator transport readiness from image behavior. The
    // existing five-second image counter assertions remain unchanged.
    private func requireFixtureTransportReady() throws {
        let environment = ProcessInfo.processInfo.environment
        let base = try XCTUnwrap(environment["ORCA_FIXTURE_API_URL"])
        let token = try XCTUnwrap(environment["ORCA_FIXTURE_ACCESS_TOKEN"])
        let root = try XCTUnwrap(URL(string: base))
        XCTAssertEqual(root.scheme, "http")
        XCTAssertTrue(["127.0.0.1", "localhost"].contains(root.host ?? ""))
        var request = URLRequest(url: root.appending(path: "v1/auth/session"),
                                 cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let done = expectation(description: "Simulator fixture transport readiness")
        var status: Int?
        var authenticated = false
        let traceID = UUID().uuidString
        print("[counter-native] epoch_ms=\(Int64(Date().timeIntervalSince1970 * 1000)) id=\(traceID) event=readiness_started")
        // Same session as imageDownloadCount; one request, no retry or image load.
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            status = (response as? HTTPURLResponse)?.statusCode
            if let data, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                authenticated = value["isAuthenticated"] as? Bool == true
            }
            print("[counter-native] epoch_ms=\(Int64(Date().timeIntervalSince1970 * 1000)) id=\(traceID) event=readiness_completed status=\(status ?? -1) error_code=\((error as NSError?)?.code ?? 0)")
            done.fulfill()
        }
        task.resume()
        defer { task.cancel() }
        wait(for: [done], timeout: 35)
        XCTAssertEqual(status, 200, "Fixture transport must be ready before app behavior is tested")
        XCTAssertTrue(authenticated, "Fixture readiness requires the synthetic authenticated session")
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
        let traceID = UUID().uuidString
        request.setValue(traceID, forHTTPHeaderField: "X-Orca-Fixture-Trace")
        let done = expectation(description: "Fixture image request count")
        var count: Int?
        // Only generated IDs, timestamps and numeric transport facts are logged.
        // Do not print the request, URL, token, payload or error description.
        print("[counter-native] epoch_ms=\(Int64(Date().timeIntervalSince1970 * 1000)) id=\(traceID) event=created")
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            print("[counter-native] epoch_ms=\(Int64(Date().timeIntervalSince1970 * 1000)) id=\(traceID) event=callback status=\((response as? HTTPURLResponse)?.statusCode ?? -1) error_code=\((error as NSError?)?.code ?? 0) bytes=\(data?.count ?? 0)")
            if let data, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Int] { count = value["count"] }
            done.fulfill()
        }
        task.resume()
        print("[counter-native] epoch_ms=\(Int64(Date().timeIntervalSince1970 * 1000)) id=\(traceID) event=resumed")
        let observation = DispatchSource.makeTimerSource(queue: .global())
        observation.schedule(deadline: .now() + 4)
        observation.setEventHandler {
            print("[counter-native] epoch_ms=\(Int64(Date().timeIntervalSince1970 * 1000)) id=\(traceID) event=scheduler_probe state=\(task.state.rawValue) received=\(task.countOfBytesReceived)")
        }
        observation.resume()
        defer { observation.cancel() }
        wait(for: [done], timeout: 5)
        return try XCTUnwrap(count)
    }

    private func launchReader(contentSize: String = "UICTContentSizeCategoryL", htmlDiagnostics: Bool = false) throws -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        let url = try XCTUnwrap(environment["ORCA_FIXTURE_API_URL"])
        let token = try XCTUnwrap(environment["ORCA_FIXTURE_ACCESS_TOKEN"])
        XCTAssertFalse(url.isEmpty)
        XCTAssertFalse(token.isEmpty)
        let app = XCUIApplication()
        app.launchArguments = ["--fixture-api-url", url, "--fixture-access-token", token,
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-UIPreferredContentSizeCategoryName", contentSize]
        if htmlDiagnostics {
            let fixtureURL = try XCTUnwrap(URL(string: url))
            XCTAssertEqual(fixtureURL.scheme, "http", "Reader diagnostics require an isolated loopback fixture")
            XCTAssertTrue(["127.0.0.1", "localhost"].contains(fixtureURL.host ?? ""),
                "Reader diagnostics require an isolated loopback fixture")
            app.launchArguments.append("--fixture-html-diagnostics")
        }
        app.launch()
        XCTAssertTrue(app.buttons["inbox.view-picker"].waitForExistence(timeout: 20))
        app.buttons["inbox.view-picker"].tap()
        XCTAssertTrue(app.buttons["Inbox"].waitForExistence(timeout: 5)); app.buttons["Inbox"].tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 20))
        return app
    }

    private func openHTML(in app: XCUIApplication) {
        let row = app.buttons["inbox.message.ios-fixture-message-3"]
        revealInboxRow("inbox.message.ios-fixture-message-3", in: app)
        screenshot("reader-inbox-before-open")
        XCTAssertTrue(row.exists && row.isHittable)
        row.tap()
        XCTAssertTrue(app.navigationBars["Conversation"].waitForExistence(timeout: 10))
    }

    private func revealInboxRow(_ identifier: String, in app: XCUIApplication,
                                file: StaticString = #filePath, line: UInt = #line) {
        let list = app.descendants(matching: .any)["inbox.list"]
        let row = app.buttons[identifier]
        XCTAssertTrue(list.waitForExistence(timeout: 10), file: file, line: line)
        func record(_ stage: String, hierarchy: Bool = false) {
            let anyCount = app.descendants(matching: .any).matching(identifier: identifier).count
            let buttonCount = app.buttons.matching(identifier: identifier).count
            print("[reader-list] stage=\(stage) row_id=\(identifier) button_count=\(buttonCount) any_count=\(anyCount) app=\(app.frame) list=\(list.exists ? list.frame : .zero) navigation=\(app.navigationBars.firstMatch.frame) tabs=\(app.tabBars.firstMatch.frame) row=\(row.exists ? row.frame : .zero) mail_selected=\(app.tabBars.buttons["Mail"].isSelected)")
            screenshot("reader-list-\(identifier)-\(stage)")
            if hierarchy { print("[reader-list-hierarchy] stage=\(stage)\n\(app.debugDescription)") }
        }
        record("before", hierarchy: true)
        for attempt in 0..<12 {
            XCTAssertTrue(app.tabBars.buttons["Mail"].isSelected, "A content gesture must not navigate to another tab", file: file, line: line)
            guard list.exists, app.tabBars.buttons["Mail"].isSelected else { break }
            let top = max(list.frame.minY, app.navigationBars.firstMatch.frame.maxY) + 8
            let bottom = min(list.frame.maxY, app.tabBars.firstMatch.frame.minY) - 8
            if row.exists, row.isHittable, row.frame.midY >= top, row.frame.midY <= bottom { break }
            guard bottom - top > 80 else {
                XCTFail("Mail needs an unobscured content gesture region", file: file, line: line); break
            }
            var up = true
            if row.exists, !row.frame.isEmpty { up = row.frame.midY > bottom }
            // Like the draft-row helper, use a short drag inside actual content,
            // clamped above native tab chrome. A tab-bar hit in08f is unproven.
            let height = bottom - top
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let x = max(list.frame.minX + 8, min(list.frame.maxX - 8, app.frame.width * 0.7))
            let start = origin.withOffset(CGVector(dx: x, dy: top + height * (up ? 0.7 : 0.3)))
            let end = origin.withOffset(CGVector(dx: x, dy: top + height * (up ? 0.3 : 0.7)))
            print("[reader-list-gesture] attempt=\(attempt) top=\(top) bottom=\(bottom) x=\(x) up=\(up)")
            start.press(forDuration: 0.05, thenDragTo: end)
            record("after-\(attempt)")
            XCTAssertTrue(app.tabBars.buttons["Mail"].isSelected, "Mail must remain selected after the bounded content gesture", file: file, line: line)
        }
        record("final", hierarchy: true)
        XCTAssertEqual(app.buttons.matching(identifier: identifier).count, 1, "Keep the real row Button identity", file: file, line: line)
        XCTAssertTrue(row.exists && row.isHittable, file: file, line: line)
        XCTAssertTrue(app.tabBars.buttons["Mail"].isSelected, file: file, line: line)
    }

    private func captureReaderGeometry(in app: XCUIApplication, first: XCUIElement, stage: String) {
        let header = app.staticTexts["thread.subject"]
        let account = app.staticTexts["thread.account"]
        let body = app.webViews.firstMatch
        let importance = app.buttons["thread.importance"]
        let tools = app.buttons["reader.tools"].firstMatch
        let reply = app.buttons["Reply"], feedback = app.buttons["feedback.open"]
        let headerFrame = [header, account, importance].filter(\.exists).reduce(CGRect.null) { $0.union($1.frame) }
        print("[reader-chrome] stage=\(stage) app=\(app.frame) header=\(headerFrame) subject=\(header.exists ? header.frame : .zero) account=\(account.exists ? account.frame : .zero) importance=\(importance.exists ? importance.frame : .zero) tools=\(tools.exists ? tools.frame : .zero) body=\(body.exists ? body.frame : .zero) first=\(first.exists ? first.frame : .zero) reply=\(reply.exists ? reply.frame : .zero) feedback=\(feedback.exists ? feedback.frame : .zero)")
        screenshot("reader-chrome-\(stage)")
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

    private func observeLateLandscape(in app: XCUIApplication, landscape: XCUIElement) {
        // Passive, bounded observation only: no gestures, reloads or state changes.
        let started = ProcessInfo.processInfo.systemUptime
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            landscape.exists && landscape.isHittable
        }, object: nil)
        let result = XCTWaiter.wait(for: [ready], timeout: 15)
        let elapsedMS = Int64((ProcessInfo.processInfo.systemUptime - started) * 1_000)
        print("[reader-fixture-late-render] elapsed_ms=\(elapsedMS) visible=\(result == .completed)")
        screenshot("reader-image-after-passive-observation")
    }

    private func readerAction(_ stage: String) {
        // No additional AX queries, retries or waits before the original action.
        print("[reader-fixture-action] epoch_ms=\(Int64(Date().timeIntervalSince1970 * 1000)) stage=\(stage)")
    }

    private func captureReaderFailure(in app: XCUIApplication, stage: String) {
        // Capture only after the original predicate/timeout has failed. These
        // observations describe failure-time state, not proof a tap handler ran.
        screenshot("reader-failure-" + stage)
        var lines = ["[reader-fixture-failure] stage=\(stage) epoch_ms=\(Int64(Date().timeIntervalSince1970 * 1000))"]
        func state(_ name: String, _ element: XCUIElement) {
            let exists = element.exists
            lines.append("target=\(name) exists=\(exists)")
            if exists {
                lines.append("type=\(element.elementType.rawValue) frame=\(element.frame) enabled=\(element.isEnabled) hittable=\(element.isHittable)")
            }
        }
        state("first-navigation-button", app.navigationBars.buttons.firstMatch)
        state("inbox-navigation", app.navigationBars["Inbox"])
        state("conversation-navigation", app.navigationBars["Conversation"])
        state("load-images", app.buttons["message.load-images"])
        state("images-status", app.staticTexts["message.images-status"])
        state("synthetic-landscape", app.images["Synthetic landscape"])
        // No arbitrary identifiers, labels, values, URLs or debugDescription.
        // Keep the same bounded structural evidence as the styled HTML probe.
        func visit(_ element: XCUIElement, depth: Int) {
            guard lines.count < 120, depth < 14 else { return }
            lines.append("depth=\(depth) type=\(element.elementType.rawValue) frame=\(element.frame)")
            for child in element.children(matching: .any).allElementsBoundByIndex.prefix(30) {
                visit(child, depth: depth + 1)
            }
        }
        for webView in app.webViews.allElementsBoundByIndex.prefix(4) {
            let identifier = webView.identifier
            if identifier.hasPrefix("fixture-html-state ") {
                lines.append(String(identifier.prefix(1_200)))
                lines.append("webview-subtree (relative depth starts at 10)")
                visit(webView, depth: 10)
            }
        }
        lines.append("app-structure")
        visit(app, depth: 0)
        let diagnostic = String(lines.joined(separator: "\n").prefix(16_000))
        print(diagnostic)
        let attachment = XCTAttachment(string: diagnostic)
        attachment.name = "reader-fixture-state-" + stage
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
