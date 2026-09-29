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

    func test13MailboxControlsRemainVisibleWhileRefreshing() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        let list = app.collectionViews["inbox.list"]
        let picker = app.buttons["inbox.view-picker"]
        let settings = app.buttons["Choose visible views"]
        let search = app.searchFields["Search mail"]
        let title = app.staticTexts["What deserves you now"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        XCTAssertTrue(search.isHittable)
        XCTAssertTrue(picker.isHittable)
        XCTAssertTrue(settings.isHittable)
        let initialPickerY = picker.frame.minY
        let initialTitleY = title.frame.minY

        try refreshFixture("arm", method: "POST")
        // Release the pending response even if an assertion fails.
        addTeardownBlock { try self.refreshFixture("release", method: "POST") }
        let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
        let end = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        start.press(forDuration: 0.1, thenDragTo: end)
        // The server acknowledges only after the gesture makes a real inbox request.
        // Its response remains blocked while these assertions and screenshots run.
        try refreshFixture("wait", method: "GET")
        attachScreenshot(named: "27-inbox-refresh-pending")
        XCTAssertTrue(search.isHittable)
        XCTAssertTrue(picker.isHittable)
        XCTAssertTrue(settings.isHittable)
        XCTAssertTrue(app.buttons["compose.open"].isHittable)
        XCTAssertTrue(app.tabBars.buttons["Inbox"].isHittable)
        XCTAssertTrue(app.tabBars.buttons["Drafts"].isHittable)
        XCTAssertTrue(app.tabBars.buttons["Settings"].isHittable)
        XCTAssertEqual(picker.frame.minY, initialPickerY, accuracy: 2)
        XCTAssertGreaterThanOrEqual(picker.frame.minY, search.frame.maxY)
        XCTAssertGreaterThanOrEqual(list.frame.minY, max(picker.frame.maxY, settings.frame.maxY))

        // Check actual interaction as well as accessibility hit testing.
        picker.tap()
        XCTAssertTrue(app.buttons["All Mail"].waitForExistence(timeout: 3))
        attachScreenshot(named: "28-mailbox-picker-during-refresh")
        try refreshFixture("wait", method: "GET")
        try refreshFixture("release", method: "POST")
        app.buttons.matching(identifier: "Inbox").firstMatch.tap()
        let settled = NSPredicate { _, _ in
            title.isHittable && abs(title.frame.minY - initialTitleY) < 12
        }
        expectation(for: settled, evaluatedWith: nil)
        waitForExpectations(timeout: 10)
        attachScreenshot(named: "29-inbox-refresh-recovered")
    }

    private func refreshFixture(_ action: String, method: String) throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["ORCA_FIXTURE_API_URL"], let url = URL(string: base),
              ["127.0.0.1", "localhost"].contains(url.host ?? ""),
              let token = environment["ORCA_FIXTURE_ACCESS_TOKEN"] else {
            throw TestConfigurationError.missingFixtureEnvironment
        }
        var request = URLRequest(url: url.appendingPathComponent("__fixture/inbox-refresh/\(action)"))
        request.httpMethod = method
        request.timeoutInterval = 8
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let completed = expectation(description: "Fixture refresh \(action)")
        let task = URLSession.shared.dataTask(with: request) { _, response, error in
            XCTAssertNil(error)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 204)
            completed.fulfill()
        }
        task.resume()
        wait(for: [completed], timeout: 10)
        task.cancel()
    }

    func test12InboxIntroductionScrollsWithMailAndRefreshSettles() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        let list = app.collectionViews["inbox.list"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        let title = app.staticTexts["What deserves you now"]
        XCTAssertTrue(title.isHittable)
        let initialY = title.frame.minY
        attachScreenshot(named: "24-inbox-before-scroll")

        // The editorial introduction is content, not a pinned section heading.
        let scrollStart = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
        let scrollEnd = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        scrollStart.press(forDuration: 0.05, thenDragTo: scrollEnd)
        // Wait for the native scroll animation before inspecting geometry.
        let moved = NSPredicate { _, _ in
            !title.exists || title.frame.minY < initialY - 40
        }
        let movement = expectation(for: moved, evaluatedWith: nil)
        wait(for: [movement], timeout: 5)
        attachScreenshot(named: "25-inbox-scrolled")
        XCTAssertTrue(!title.exists || (title.frame.minY < initialY - 40 &&
                      (!title.isHittable || title.frame.maxY < list.frame.minY + 40)),
                      "The large introduction must scroll away with the messages")

        list.swipeDown()
        let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
        let end = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        for _ in 0..<3 { start.press(forDuration: 0.1, thenDragTo: end) }
        let settled = NSPredicate { _, _ in
            title.isHittable && abs(title.frame.minY - initialY) < 12
        }
        expectation(for: settled, evaluatedWith: nil)
        waitForExpectations(timeout: 10)
        attachScreenshot(named: "26-inbox-after-refresh")
        XCTAssertTrue(app.buttons["compose.open"].isHittable)
        XCTAssertTrue(app.buttons["inbox.view-picker"].isHittable)
    }

    func test10NativeLongPressMovesConversationAndBuildsSenderView() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        let maya = app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].firstMatch
        maya.press(forDuration: 1.4)
        XCTAssertTrue(app.buttons["Move mail…"].waitForExistence(timeout: 5))
        attachScreenshot(named: "10-native-long-press-menu")
        app.buttons["Move mail…"].tap()
        let destination = app.buttons["mail-action.destination"]
        XCTAssertTrue(destination.waitForExistence(timeout: 5))
        destination.tap()
        app.buttons["Focus"].tap()
        attachScreenshot(named: "11-native-focus-choice")
        app.buttons["mail-action.move"].tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        XCTAssertTrue(maya.waitForNonExistence(timeout: 10))
        chooseMailbox("Focus", in: app)
        XCTAssertTrue(maya.waitForExistence(timeout: 10))
        attachScreenshot(named: "12-native-focus-result")
        chooseMailbox("All Mail", in: app)
        XCTAssertTrue(maya.waitForExistence(timeout: 10))
        attachScreenshot(named: "13-native-all-mail-retention")

        maya.press(forDuration: 1.4)
        app.buttons["Move mail…"].tap()
        XCTAssertTrue(destination.waitForExistence(timeout: 5))
        destination.tap()
        app.buttons.matching(identifier: "Inbox").firstMatch.tap()
        app.buttons["mail-action.move"].tap()
        XCTAssertTrue(app.navigationBars["All Mail"].waitForExistence(timeout: 10))
        chooseMailbox("Focus", in: app)
        XCTAssertTrue(app.staticTexts["Nothing here"].waitForExistence(timeout: 10))
        chooseMailbox("Inbox", in: app)
        XCTAssertTrue(maya.waitForExistence(timeout: 10))

        maya.press(forDuration: 1.4)
        app.buttons["Use sender in View…"].tap()
        let name = app.textFields["mail-action.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        let viewName = "People " + String(UUID().uuidString.prefix(6))
        name.tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (name.value as? String ?? "").count))
        XCTAssertFalse(app.buttons["mail-action.preview"].isEnabled)
        attachScreenshot(named: "14a-native-disabled-preview-and-name-focus")
        name.typeText(viewName)
        app.buttons["mail-action.preview"].tap()
        XCTAssertTrue(app.buttons["mail-action.save-view"].waitForExistence(timeout: 10))
        attachScreenshot(named: "14-native-sender-view-preview")
        app.buttons["mail-action.save-view"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["view.thread.ios-fixture-thread-1"].waitForExistence(timeout: 10))
        attachScreenshot(named: "15-native-created-view-result")
        chooseMailbox("Inbox", in: app)
        let jordan = app.descendants(matching: .any)["inbox.message.ios-fixture-message-2"].firstMatch
        XCTAssertTrue(jordan.waitForExistence(timeout: 10))
        jordan.press(forDuration: 1.4)
        app.buttons["Use sender in View…"].tap()
        let viewPicker = app.buttons["mail-action.view"]
        XCTAssertTrue(viewPicker.waitForExistence(timeout: 5))
        viewPicker.tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", viewName)).firstMatch.tap()
        app.buttons["mail-action.preview"].tap()
        XCTAssertTrue(app.buttons["mail-action.save-view"].waitForExistence(timeout: 10))
        attachScreenshot(named: "16-native-existing-view-preview")
        app.buttons["mail-action.save-view"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["view.thread.ios-fixture-thread-1"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["view.thread.ios-fixture-thread-2"].waitForExistence(timeout: 10))
        attachScreenshot(named: "17-native-existing-view-result")
        chooseMailbox("Inbox", in: app)
        XCTAssertTrue(maya.waitForExistence(timeout: 10))
        XCTAssertTrue(jordan.exists)
    }

    func test11NativeSenderMoveRetainsBothConversationsInAllMail() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        let jordan = app.descendants(matching: .any)["inbox.message.ios-fixture-message-2"].firstMatch
        jordan.press(forDuration: 1.4)
        app.buttons["Move mail…"].tap()
        let destination = app.buttons["mail-action.destination"]
        XCTAssertTrue(destination.waitForExistence(timeout: 5))
        destination.tap(); app.buttons["Focus"].tap()
        app.buttons["mail-action.scope"].tap()
        app.buttons["Mail from this sender"].tap()
        attachScreenshot(named: "18-native-sender-scope")
        app.buttons["mail-action.move"].tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        XCTAssertTrue(jordan.waitForNonExistence(timeout: 10))
        chooseMailbox("Focus", in: app)
        XCTAssertTrue(jordan.waitForExistence(timeout: 10))
        let second = app.descendants(matching: .any)["inbox.message.ios-fixture-message-5"].firstMatch
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        XCTAssertFalse(app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].exists)
        attachScreenshot(named: "19-native-sender-focus-results")
        chooseMailbox("All Mail", in: app)
        XCTAssertTrue(jordan.waitForExistence(timeout: 10))
        app.swipeUp()
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        attachScreenshot(named: "20-native-sender-all-mail-retention")
        app.swipeDown()
        // Restore the isolated fixture for the dark appearance run.
        jordan.press(forDuration: 1.4); app.buttons["Move mail…"].tap()
        XCTAssertTrue(destination.waitForExistence(timeout: 5))
        destination.tap(); app.buttons.matching(identifier: "Inbox").firstMatch.tap()
        app.buttons["mail-action.scope"].tap(); app.buttons["Mail from this sender"].tap()
        app.buttons["mail-action.move"].tap()
        XCTAssertTrue(app.navigationBars["All Mail"].waitForExistence(timeout: 10))
    }

    private func chooseMailbox(_ title: String, in app: XCUIApplication) {
        let picker = app.buttons["inbox.view-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10))
        picker.tap()
        app.buttons.matching(identifier: title).firstMatch.tap()
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10))
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

        XCTAssertTrue(app.navigationBars["Reply"].waitForExistence(timeout: 5), "A reopened reply must keep its Reply title.")
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
        // UIKit owns the toolbar touch target; accessibility bounds describe its visible chrome.
        XCTAssertTrue(compose.isHittable)
        compose.tap()
        XCTAssertTrue(app.buttons["compose.send"].waitForExistence(timeout: 10))
        navigateBack(in: app)
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

    func test07ConversationOpensAtLatestMessage() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        openConversation(subject: Fixture.inboxSubject, in: app)
        let latest = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "I tried the new reading view")).firstMatch
        XCTAssertTrue(latest.waitForExistence(timeout: 10))
        XCTAssertTrue(latest.isHittable, "The newest message must be visible without scrolling past earlier replies.")
        attachScreenshot(named: "17-latest-message-on-open")

        let earlier = app.staticTexts["Earlier sender"]
        for _ in 0..<5 {
            if earlier.exists && earlier.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(earlier.isHittable, "Earlier replies must remain reachable below the latest message.")
        attachScreenshot(named: "18-earlier-reply")
        app.buttons["Reply"].tap()
        let recipient = app.textFields["compose.to"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 5))
        XCTAssertTrue(String(describing: recipient.value).contains("maya@example.com"), "Reply must still target the latest sender.")
        navigateBack(in: app)
        navigateBack(in: app)
        openConversation(subject: Fixture.inboxSubject, in: app)
        XCTAssertTrue(latest.waitForExistence(timeout: 10))
        XCTAssertTrue(latest.isHittable, "Reopening must start at the newest message again.")
    }

    func test08VisibleViewsAreIndependentAndPersist() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        app.tabBars.buttons["Settings"].tap()
        app.buttons["settings.visible-views"].tap()
        let hub = app.switches.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "settings.views.view:", "Hub notifications")).firstMatch
        XCTAssertTrue(hub.waitForExistence(timeout: 10))
        if hub.value as? String != "1" { hub.tap() }
        let focus = app.switches["settings.views.focus"]
        if focus.value as? String != "0" { focus.tap() }
        attachScreenshot(named: "19-visible-views-selected")
        navigateBack(in: app)
        let notification = app.switches.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "settings.notifications.space.view:", "Hub notifications")).firstMatch
        for _ in 0..<8 {
            if notification.exists && notification.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(notification.exists)
        XCTAssertEqual(notification.value as? String, "0", "Showing a View must not enable its notifications")
        attachScreenshot(named: "20-view-notifications-still-off")
        app.tabBars.buttons["Inbox"].tap()
        app.buttons["inbox.view-picker"].tap()
        attachScreenshot(named: "21-visible-views-menu")
        XCTAssertFalse(app.buttons["Focus"].exists)
        app.buttons["Hub notifications"].tap()
        let match = app.buttons["view.thread.ios-fixture-thread-2"]
        XCTAssertTrue(match.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["view.thread.ios-fixture-thread-1"].exists)
        attachScreenshot(named: "22-saved-view-results")
        match.tap()
        XCTAssertTrue(app.buttons["Reply"].waitForExistence(timeout: 10))
        app.buttons["Reply"].tap()
        let recipient = app.textFields["compose.to"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 10))
        XCTAssertTrue(String(describing: recipient.value).contains("jordan@example.com"))
        app.terminate()
        let reopened = try launchApp()
        assertInboxLoaded(in: reopened)
        reopened.buttons["inbox.view-picker"].tap()
        XCTAssertTrue(reopened.buttons["Hub notifications"].exists)
        XCTAssertFalse(reopened.buttons["Focus"].exists)
        reopened.buttons["Hub notifications"].tap()
        XCTAssertTrue(reopened.buttons["view.thread.ios-fixture-thread-2"].waitForExistence(timeout: 10))
        reopened.tabBars.buttons["Settings"].tap()
        reopened.buttons["settings.visible-views"].tap()
        let restored = reopened.switches.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "settings.views.view:", "Hub notifications")).firstMatch
        XCTAssertEqual(restored.value as? String, "1")
        restored.tap()
        reopened.switches["settings.views.focus"].tap()
        reopened.tabBars.buttons["Inbox"].tap()
        XCTAssertTrue(reopened.navigationBars["Inbox"].waitForExistence(timeout: 10), "Hiding the active View must return to Inbox")
    }

    func test09EmptySavedViewKeepsMailboxMenuAvailable() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        app.tabBars.buttons["Settings"].tap()
        app.buttons["settings.visible-views"].tap()
        let empty = app.switches.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "settings.views.view:", "Empty view")).firstMatch
        XCTAssertTrue(empty.waitForExistence(timeout: 10))
        if empty.value as? String != "1" { empty.tap() }
        app.tabBars.buttons["Inbox"].tap()
        app.buttons["inbox.view-picker"].tap()
        app.buttons["Empty view"].tap()
        XCTAssertTrue(app.staticTexts["No matching mail"].waitForExistence(timeout: 10))
        attachScreenshot(named: "23-empty-view-with-menu")
        XCTAssertTrue(app.buttons["inbox.view-picker"].isHittable)
        app.buttons["inbox.view-picker"].tap()
        app.buttons["All Mail"].tap()
        XCTAssertTrue(app.navigationBars["All Mail"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].waitForExistence(timeout: 10))
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
