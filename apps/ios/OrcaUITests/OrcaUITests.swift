import XCTest

final class OrcaUITests: XCTestCase {
    private enum Fixture {
        static let inboxMessageID = "ios-fixture-message-1"
        static let searchResultMessageID = "ios-fixture-message-2"
        static let inboxSubject = "A quieter kind of inbox"
        static let searchResultSubject = "Friday by the water?"
        static let sender = "Maya Chen"
        static let account = "luke@example.com"
        static let replyBody = "Thank you, Maya. The calmer reading view is working beautifully."
        static let htmlSubject = "Notes from our conversation"
        static let htmlEndMarker = "End of the long reading fixture."
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Exercises the real fixture API through the same UI a person uses. Keeping this
    /// as one flow makes the draft/send assertions independent of XCTest method order.
    func test01InboxSearchReplyDraftSurvivesReopenAndSendsOnceInLightMode() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        attachScreenshot(named: "01-light-inbox")

        openConversation(subject: Fixture.inboxSubject, in: app)
        XCTAssertTrue(app.staticTexts[Fixture.sender].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "reading view")).firstMatch.waitForExistence(timeout: 10))
        attachScreenshot(named: "02-light-conversation")

        navigateBack(in: app)
        search(for: "Jordan", in: app)
        XCTAssertTrue(app.descendants(matching: .any)["inbox.message.\(Fixture.searchResultMessageID)"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.descendants(matching: .any)["inbox.message.\(Fixture.inboxMessageID)"].exists)
        attachScreenshot(named: "03-light-search")

        clearSearch(in: app)
        openConversation(subject: Fixture.inboxSubject, in: app)
        let reply = app.buttons["Reply"]
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        reply.tap()

        let body = messageBody(in: app)
        XCTAssertTrue(body.waitForExistence(timeout: 10))
        body.tap()
        body.typeText(Fixture.replyBody)
        Thread.sleep(forTimeInterval: 1)
        XCTAssertTrue(app.descendants(matching: .any)["compose.save-status"].waitForExistence(timeout: 5))
        attachScreenshot(named: "04-light-reply-saved")

        navigateBack(in: app)
        navigateBack(in: app)
        app.tabBars.buttons["Drafts"].tap()

        let savedReply = app.descendants(matching: .any).matching(
            NSPredicate(
                format: "identifier BEGINSWITH %@ AND label CONTAINS[c] %@",
                "draft.",
                "Re: \(Fixture.inboxSubject)"
            )
        ).firstMatch
        XCTAssertTrue(savedReply.waitForExistence(timeout: 10), "The locally saved reply must be visible in Drafts.")
        savedReply.tap()

        let reopenedBody = messageBody(in: app)
        XCTAssertTrue(reopenedBody.waitForExistence(timeout: 10))
        XCTAssertEqual(reopenedBody.value as? String, Fixture.replyBody)
        XCTAssertTrue(app.textFields["compose.to"].waitForExistence(timeout: 5))
        XCTAssertTrue(String(describing: app.textFields["compose.to"].value).localizedCaseInsensitiveContains("maya@example.com"))
        attachScreenshot(named: "05-light-reply-reopened")

        let send = app.buttons["Send"]
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(app.navigationBars["Drafts"].waitForExistence(timeout: 15), "A successful send should dismiss the composer exactly once.")
        XCTAssertFalse(savedReply.exists, "A sent local draft should leave the Drafts list.")
        attachScreenshot(named: "06-light-sent")
    }

    func test02SettingsRenderInDarkMode() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)

        openConversation(subject: Fixture.htmlSubject, in: app)
        let endMarker = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", Fixture.htmlEndMarker)).firstMatch
        for _ in 0..<12 {
            app.swipeUp(velocity: .fast)
        }
        XCTAssertTrue(endMarker.waitForExistence(timeout: 5), "The long HTML message must expand to its full height and scroll all the way to its final marker.")
        attachScreenshot(named: "07-dark-long-html-end")

        navigateBack(in: app)
        app.tabBars.buttons["Settings"].tap()

        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", Fixture.account)).firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", "Gmail")).firstMatch.exists)
        let allowNotifications = app.buttons["settings.allow-notifications"]
        XCTAssertTrue(allowNotifications.exists || app.buttons["Allow notifications"].exists)
        XCTAssertTrue(app.buttons["Sign out"].exists)
        XCTAssertTrue(app.buttons["Change server"].exists)
        attachScreenshot(named: "08-dark-settings")
    }

    /// Reused in both system appearances to inspect actual control states.
    func test03VisualControlStates() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        attachScreenshot(named: "09-inbox-controls")
        app.buttons["compose.open"].tap()
        let send = app.buttons["compose.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        XCTAssertFalse(send.isEnabled)
        attachScreenshot(named: "10-compose-disabled")
        let recipient = app.textFields["compose.to"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 5))
        recipient.tap()
        recipient.typeText("maya@example.com")
        let body = messageBody(in: app)
        body.tap()
        body.typeText("A little more space to think.")
        XCTAssertTrue(send.isEnabled)
        attachScreenshot(named: "11-compose-focused")
        navigateBack(in: app)
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        let inboxNotifications = app.switches["settings.notifications.inbox"]
        XCTAssertTrue(inboxNotifications.waitForExistence(timeout: 10))
        inboxNotifications.tap()
        attachScreenshot(named: "12-settings-selected")
        inboxNotifications.tap()
    }

    /// Run under both actual simulator appearances, not launch-default overrides.
    func test04StyledHTMLUsesReadableCanvas() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        openConversation(subject: Fixture.htmlSubject, in: app)
        let foreground = app.staticTexts["Explicit dark foreground stays readable."]
        let background = app.staticTexts["Explicit pale background keeps readable inherited text."]
        XCTAssertTrue(foreground.waitForExistence(timeout: 10))
        XCTAssertTrue(background.waitForExistence(timeout: 10))
        XCTAssertTrue(foreground.isHittable)
        XCTAssertTrue(background.isHittable)
        attachScreenshot(named: "13-styled-html-readable")
    }

    func test05ReadOnlyAccountKeepsDraftEditable() throws {
        guard ProcessInfo.processInfo.environment["ORCA_FIXTURE_READ_ONLY"] == "1" else { throw XCTSkip("Requires --read-only fixture") }
        let app = try launchApp()
        assertInboxLoaded(in: app)
        app.buttons["compose.open"].tap()
        let recipient = app.textFields["compose.to"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["compose.send-permission"].exists)
        attachScreenshot(named: "14-read-only-permission-guidance")
        recipient.tap(); recipient.typeText("maya@example.com")
        let body = messageBody(in: app)
        body.tap(); body.typeText("My draft stays editable while I enable sending.")
        XCTAssertTrue(body.isEnabled)
        XCTAssertFalse(app.buttons["compose.send"].isEnabled)
        XCTAssertTrue(app.descendants(matching: .any)["compose.send-permission"].exists)
        attachScreenshot(named: "14-read-only-editable-draft")
    }

    func test06NotificationDestinationsPersist() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        let compose = app.buttons["compose.open"]
        XCTAssertTrue(compose.exists)
        XCTAssertGreaterThanOrEqual(compose.frame.width, 44)
        XCTAssertGreaterThanOrEqual(compose.frame.height, 44)
        app.tabBars.buttons["Settings"].tap()
        let inbox = app.switches["settings.notifications.inbox"]
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Human mail"].exists)
        let projects = app.switches.matching(NSPredicate(format: "label CONTAINS %@", "Projects")).firstMatch
        for _ in 0..<6 {
            if projects.exists && projects.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(projects.waitForExistence(timeout: 10))
        if projects.value as? String != "1" { projects.tap() }
        XCTAssertEqual(projects.value as? String, "1")
        attachScreenshot(named: "15-notifications-spaces-selected")
        for _ in 0..<6 {
            if inbox.isHittable { break }
            app.swipeDown()
        }
        if inbox.value as? String != "0" { inbox.tap() }
        XCTAssertEqual(inbox.value as? String, "0")
        app.terminate()
        let reopened = try launchApp()
        assertInboxLoaded(in: reopened)
        reopened.tabBars.buttons["Settings"].tap()
        let restoredInbox = reopened.switches["settings.notifications.inbox"]
        XCTAssertTrue(restoredInbox.waitForExistence(timeout: 10))
        XCTAssertEqual(restoredInbox.value as? String, "0")
        let restoredProjects = reopened.switches.matching(NSPredicate(format: "label CONTAINS %@", "Projects")).firstMatch
        for _ in 0..<6 {
            if restoredProjects.exists && restoredProjects.isHittable { break }
            reopened.swipeUp()
        }
        XCTAssertEqual(restoredProjects.value as? String, "1")
        attachScreenshot(named: "16-notifications-spaces-restored")
        restoredProjects.tap()
        for _ in 0..<6 {
            if restoredInbox.isHittable { break }
            reopened.swipeDown()
        }
        restoredInbox.tap()
    }

    private func launchApp() throws -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        guard let apiURL = environment["ORCA_FIXTURE_API_URL"], !apiURL.isEmpty else {
            XCTFail("Set ORCA_FIXTURE_API_URL to the isolated fixture API URL before running OrcaUITests.")
            throw TestConfigurationError.missingFixtureEnvironment
        }
        guard let accessToken = environment["ORCA_FIXTURE_ACCESS_TOKEN"], !accessToken.isEmpty else {
            XCTFail("Set ORCA_FIXTURE_ACCESS_TOKEN to the synthetic fixture bearer before running OrcaUITests.")
            throw TestConfigurationError.missingFixtureEnvironment
        }

        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture-api-url", apiURL,
            "--fixture-access-token", accessToken,
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL",
        ]
        app.launch()
        return app
    }

    private func assertInboxLoaded(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 20), file: file, line: line)
        XCTAssertTrue(app.descendants(matching: .any)["inbox.message.\(Fixture.inboxMessageID)"].waitForExistence(timeout: 20), file: file, line: line)
        XCTAssertTrue(app.descendants(matching: .any)["inbox.message.\(Fixture.searchResultMessageID)"].exists, file: file, line: line)
        XCTAssertTrue(app.tabBars.buttons["Inbox"].isSelected, file: file, line: line)
    }

    private func openConversation(subject: String, in app: XCUIApplication) {
        let identifier: String
        switch subject {
        case Fixture.inboxSubject: identifier = "inbox.message.\(Fixture.inboxMessageID)"
        case Fixture.searchResultSubject: identifier = "inbox.message.\(Fixture.searchResultMessageID)"
        case Fixture.htmlSubject: identifier = "inbox.message.ios-fixture-message-3"
        default: XCTFail("No fixture message identifier for \(subject)"); return
        }
        let row = app.descendants(matching: .any)[identifier]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.navigationBars["Conversation"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts[subject].waitForExistence(timeout: 10))
    }

    private func search(for query: String, in app: XCUIApplication) {
        let identified = app.searchFields["inbox.search"]
        let search = identified.exists ? identified : app.searchFields["Search mail"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText(query)
        app.keyboards.buttons["Search"].tap()
    }

    private func clearSearch(in app: XCUIApplication) {
        let identified = app.searchFields["inbox.search"]
        let search = identified.exists ? identified : app.searchFields["Search mail"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.buttons["Clear text"].tap()
        app.keyboards.buttons["Search"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["inbox.message.\(Fixture.inboxMessageID)"].waitForExistence(timeout: 10))
    }

    private func messageBody(in app: XCUIApplication) -> XCUIElement {
        let identified = app.textViews["compose.body"]
        return identified.exists ? identified : app.textViews["Message body"]
    }

    private func navigateBack(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let back = app.navigationBars.buttons.firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 5), file: file, line: line)
        back.tap()
    }

    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

private enum TestConfigurationError: Error {
    case missingFixtureEnvironment
}
