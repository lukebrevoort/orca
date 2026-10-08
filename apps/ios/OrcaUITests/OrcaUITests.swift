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

    func test20EmptyInboxCanRefreshIntoMail() throws {
        _ = try composeFixtureRequest("__fixture/inbox-recovery/empty-once", method: "POST", body: [:])
        addTeardownBlock { _ = try self.composeFixtureRequest("__fixture/inbox-recovery/reset", method: "POST", body: [:]) }
        let app = try launchApp()
        XCTAssertTrue(app.staticTexts["Nothing here"].waitForExistence(timeout: 20))
        attachScreenshot(named: "40-empty-inbox-before-refresh")
        let list = app.collectionViews["inbox.list"]
        XCTAssertTrue(list.exists, "An empty mailbox must retain its refreshable scrolling surface")
        // Do not hold this response: XCTest waits for the empty-state spinner
        // to become idle after the gesture. The initial empty assertion and
        // subsequent fixture rows prove that the pull made a fresh request.
        let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
        let end = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        start.press(forDuration: 0.1, thenDragTo: end)
        assertInboxLoaded(in: app)
        attachScreenshot(named: "41-empty-inbox-refreshed")
    }

    func test21MoveCatalogLoadCanBeCancelledAndReopened() throws {
        let app = try launchApp(); assertInboxLoaded(in: app)
        _ = try composeFixtureRequest("__fixture/inbox-recovery/hold-catalog", method: "POST", body: [:])
        addTeardownBlock { _ = try self.composeFixtureRequest("__fixture/inbox-recovery/reset", method: "POST", body: [:]) }
        let row = app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].firstMatch
        row.press(forDuration: 1.4)
        app.buttons["Move mail…"].tap()
        _ = try composeFixtureRequest("__fixture/inbox-recovery/wait")
        let cancel = app.navigationBars["Move mail"].buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        attachScreenshot(named: "42-move-catalog-loading-cancel")
        XCTAssertTrue(cancel.isEnabled, "Read-only loading must not trap the user in a sheet")
        cancel.tap()
        XCTAssertTrue(app.navigationBars["Move mail"].waitForNonExistence(timeout: 5))
        _ = try composeFixtureRequest("__fixture/inbox-recovery/reset", method: "POST", body: [:])
        row.press(forDuration: 1.4); app.buttons["Move mail…"].tap()
        let move = app.buttons["mail-action.move"]
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: move)
        waitForExpectations(timeout: 10)
        app.navigationBars["Move mail"].buttons["Cancel"].tap()
        assertInboxLoaded(in: app)
        attachScreenshot(named: "43-move-catalog-cancelled-and-reopened")
    }

    func test22SenderViewCatalogLoadCanBeSwipedAway() throws {
        let app = try launchApp(); assertInboxLoaded(in: app)
        _ = try composeFixtureRequest("__fixture/inbox-recovery/hold-views", method: "POST", body: [:])
        addTeardownBlock { _ = try self.composeFixtureRequest("__fixture/inbox-recovery/reset", method: "POST", body: [:]) }
        app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].firstMatch.press(forDuration: 1.4)
        app.buttons["Use sender in View…"].tap()
        _ = try composeFixtureRequest("__fixture/inbox-recovery/wait")
        let bar = app.navigationBars["Use sender in View"]
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        attachScreenshot(named: "44-view-catalog-loading-swipe")
        let start = bar.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95))
        start.press(forDuration: 0.1, thenDragTo: end)
        XCTAssertTrue(bar.waitForNonExistence(timeout: 5), "Read-only loading must allow sheet dismissal")
        _ = try composeFixtureRequest("__fixture/inbox-recovery/reset", method: "POST", body: [:])
        assertInboxLoaded(in: app)
    }

    func test14SendingAccessRefreshPreservesWritingThroughFailureAndUpgrade() throws {
        try setFixtureSending(false)
        addTeardownBlock { try self.restoreFixtureSending() }
        let app = try launchApp(); assertInboxLoaded(in: app)
        app.buttons["compose.open"].tap()
        let recipient = app.textFields["compose.to"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 10))
        recipient.tap(); recipient.typeText("maya@example.com")
        let body = messageBody(in: app); body.tap(); body.typeText("Keep these words while access changes.")
        let refresh = app.buttons["compose.refresh-permission"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["compose.send"].isEnabled)
        let status = app.descendants(matching: .any)["compose.save-status"]
        expectation(for: NSPredicate(format: "label CONTAINS %@", "Saved locally"), evaluatedWith: status)
        waitForExpectations(timeout: 5)
        try setFixtureSending(false, accountsUnavailable: true)
        refresh.tap()
        expectation(for: NSPredicate(format: "label CONTAINS %@", "Could not refresh"), evaluatedWith: status)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(body.value as? String, "Keep these words while access changes.")
        XCTAssertTrue(body.isEnabled); XCTAssertFalse(app.buttons["compose.send"].isEnabled)
        attachScreenshot(named: "30-compose-capability-refresh-failed")
        try setFixtureSending(true)
        refresh.tap()
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: app.buttons["compose.send"])
        waitForExpectations(timeout: 5)
        XCTAssertEqual(recipient.value as? String, "maya@example.com")
        XCTAssertEqual(body.value as? String, "Keep these words while access changes.")
        XCTAssertFalse(refresh.exists)
        attachScreenshot(named: "31-compose-capability-refresh-upgraded")
    }

    func test15ServerDraftDeliveryCanBeCheckedWithoutSendingAgain() throws {
        let draft = try createComposeFixtureDraft(subject: "Recovery " + UUID().uuidString)
        let id = try XCTUnwrap(draft["id"] as? String)
        _ = try composeFixtureRequest("__fixture/compose/delivery", method: "POST", body: ["draftId": id, "status": "ambiguous"])
        let before = try composeFixtureRequest("__fixture/compose/state")
        let app = try launchApp(); assertInboxLoaded(in: app)
        app.tabBars.buttons["Drafts"].tap()
        let row = app.descendants(matching: .any)["draft.\(id)"]
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        let check = app.buttons["compose.send"]
        XCTAssertTrue(check.waitForExistence(timeout: 5)); XCTAssertTrue(check.isEnabled)
        XCTAssertEqual(check.label, "Check delivery")
        XCTAssertFalse(messageBody(in: app).isEnabled)
        check.tap()
        let status = app.descendants(matching: .any)["compose.save-status"]
        expectation(for: NSPredicate(format: "label CONTAINS %@", "Delivery remains uncertain"), evaluatedWith: status)
        waitForExpectations(timeout: 5)
        attachScreenshot(named: "32-compose-server-delivery-check")
        _ = try composeFixtureRequest("__fixture/compose/delivery", method: "POST", body: ["draftId": id, "status": "sent"])
        check.tap()
        XCTAssertTrue(app.navigationBars["Drafts"].waitForExistence(timeout: 10))
        XCTAssertFalse(row.exists)
        let after = try composeFixtureRequest("__fixture/compose/state")
        XCTAssertEqual(after["sendRequests"] as? Int, before["sendRequests"] as? Int, "Checking a server-origin draft must never POST a delivery command")
        XCTAssertEqual(after["deliveries"] as? Int, before["deliveries"] as? Int)
    }

    func test16AttachmentRemovalPersistsAndOnlyRemainingFileIsSent() throws {
        try setFixtureSending(true)
        addTeardownBlock { try self.restoreFixtureSending() }
        let attachments: [[String: Any]] = ["remove", "keep"].map { name in
            ["id": name, "filename": "\(name).txt", "mimeType": "text/plain", "size": 1, "contentBase64": "eA=="]
        }
        let subject = "Attachment removal " + UUID().uuidString
        let draft = try createComposeFixtureDraft(subject: subject, attachments: attachments)
        let id = try XCTUnwrap(draft["id"] as? String)
        let app = try launchApp(); assertInboxLoaded(in: app)
        app.tabBars.buttons["Drafts"].tap()
        let row = app.descendants(matching: .any)["draft.\(id)"]
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        let remove = app.buttons["compose.attachment.remove.remove"]
        for _ in 0..<5 { if remove.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(remove.isHittable); remove.tap()
        XCTAssertTrue(remove.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["compose.attachment.remove.keep"].exists)
        attachScreenshot(named: "33-compose-attachment-removed")
        navigateBack(in: app)
        let localRow = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "draft.", subject)).firstMatch
        XCTAssertTrue(localRow.waitForExistence(timeout: 10)); localRow.tap()
        for _ in 0..<5 { if app.buttons["compose.attachment.remove.keep"].isHittable { break }; app.swipeUp() }
        XCTAssertFalse(app.buttons["compose.attachment.remove.remove"].exists)
        XCTAssertTrue(app.buttons["compose.attachment.remove.keep"].exists)
        let send = app.buttons["compose.send"]; XCTAssertTrue(send.isEnabled); send.tap()
        XCTAssertTrue(app.navigationBars["Drafts"].waitForExistence(timeout: 15))
        let sent = try composeFixtureRequest("v1/drafts/\(id)?accountId=ios-fixture-account")
        XCTAssertEqual(sent["deliveryStatus"] as? String, "sent")
        XCTAssertEqual((sent["attachments"] as? [[String: Any]])?.compactMap { $0["id"] as? String }, ["keep"])
    }

    func test17ForegroundRefreshUnlocksSendingWithoutRelaunch() throws {
        try setFixtureSending(false)
        addTeardownBlock { try self.restoreFixtureSending() }
        let app = try launchApp(); assertInboxLoaded(in: app)
        app.buttons["compose.open"].tap()
        let recipient = app.textFields["compose.to"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 10))
        recipient.tap(); recipient.typeText("maya@example.com")
        let body = messageBody(in: app); body.tap(); body.typeText("Words survive a trip to the browser.")
        XCTAssertFalse(app.buttons["compose.send"].isEnabled)
        XCUIDevice.shared.press(.home)
        try setFixtureSending(true)
        app.activate()
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: app.buttons["compose.send"])
        waitForExpectations(timeout: 10)
        XCTAssertEqual(body.value as? String, "Words survive a trip to the browser.")
        attachScreenshot(named: "34-compose-foreground-upgraded")
    }

    func test18ConflictCopyKeepsLatestWritingAndRemovedAttachmentAfterTermination() throws {
        try setFixtureSending(true)
        addTeardownBlock { try self.restoreFixtureSending() }
        let subject = "Conflict local " + UUID().uuidString
        let remoteSubject = "Conflict remote " + UUID().uuidString
        let attachments: [[String: Any]] = ["remove", "keep"].map { name in
            ["id": name, "filename": "\(name).txt", "mimeType": "text/plain", "size": 1, "contentBase64": "eA=="]
        }
        let draft = try createComposeFixtureDraft(subject: subject, attachments: attachments)
        let id = try XCTUnwrap(draft["id"] as? String)
        let before = try composeFixtureRequest("__fixture/compose/state")
        let app = try launchApp(); assertInboxLoaded(in: app)
        app.tabBars.buttons["Drafts"].tap()
        let row = app.descendants(matching: .any)["draft.\(id)"]
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        let body = messageBody(in: app)
        XCTAssertTrue(body.waitForExistence(timeout: 10))
        // Another device edits the real fixture API after this composer seeded
        // its revision. The first send must stop before provider dispatch.
        _ = try composeFixtureRequest("v1/drafts/\(id)?accountId=ios-fixture-account", method: "PATCH", body: [
            "revision": try XCTUnwrap(draft["revision"] as? Int),
            "to": [["name": NSNull(), "email": "maya@example.com"]], "cc": [], "bcc": [],
            "subject": remoteSubject, "body": ["text": "Other device writing", "html": NSNull()],
            "context": NSNull(), "attachments": attachments,
        ])
        app.buttons["compose.send"].tap()
        let keepBoth = app.buttons["compose.keep-both"]
        XCTAssertTrue(keepBoth.waitForExistence(timeout: 10))
        let conflicted = try composeFixtureRequest("__fixture/compose/state")
        XCTAssertEqual(conflicted["sendRequests"] as? Int, before["sendRequests"] as? Int)
        let remove = app.buttons["compose.attachment.remove.remove"]
        revealComposeControl(remove, in: app, scrollUp: true)
        attachScreenshot(named: "50-compose-conflict-remove-fully-visible")
        remove.tap()
        let removed = remove.waitForNonExistence(timeout: 10)
        if !removed {
            attachScreenshot(named: "51-compose-conflict-remove-failed")
            print("COMPOSE_REMOVE_FAILURE enabled=\(remove.isEnabled) frame=\(remove.frame) status=\(app.descendants(matching: .any)["compose.save-status"].label)")
        }
        XCTAssertTrue(removed)
        for _ in 0..<5 { if body.isHittable { break }; app.swipeDown() }
        body.tap(); body.typeText(" Latest words before keeping both.")
        // A fresh simulator can show Apple's slide-to-type introduction after
        // the first spaced input. Dismiss it before testing our draft actions.
        let typingIntroduction = app.buttons["Continue"]
        if typingIntroduction.waitForExistence(timeout: 1) { typingIntroduction.tap() }
        let latestWriting = try XCTUnwrap(body.value as? String)
        XCTAssertTrue(latestWriting.contains("Latest words before keeping both."))
        keepBoth.tap()
        let status = app.descendants(matching: .any)["compose.save-status"]
        expectation(for: NSPredicate(format: "label CONTAINS %@", "Both drafts kept"), evaluatedWith: status)
        waitForExpectations(timeout: 10)
        attachScreenshot(named: "35-compose-conflict-copy-checkpoint")
        app.terminate()
        let reopened = try launchApp(); assertInboxLoaded(in: reopened)
        reopened.tabBars.buttons["Drafts"].tap()
        let localRow = reopened.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "draft.", subject)).firstMatch
        XCTAssertTrue(localRow.waitForExistence(timeout: 10)); localRow.tap()
        XCTAssertEqual(messageBody(in: reopened).value as? String, latestWriting)
        for _ in 0..<5 { if reopened.buttons["compose.attachment.remove.keep"].isHittable { break }; reopened.swipeUp() }
        XCTAssertFalse(reopened.buttons["compose.attachment.remove.remove"].exists)
        XCTAssertTrue(reopened.buttons["compose.attachment.remove.keep"].exists)
        attachScreenshot(named: "36-compose-conflict-copy-reopened")
        reopened.buttons["compose.send"].tap()
        XCTAssertTrue(reopened.navigationBars["Drafts"].waitForExistence(timeout: 15))
        let original = try composeFixtureRequest("v1/drafts/\(id)?accountId=ios-fixture-account")
        XCTAssertEqual(original["deliveryStatus"] as? String, "draft")
        XCTAssertEqual(original["subject"] as? String, remoteSubject)
        XCTAssertEqual((original["body"] as? [String: Any])?["text"] as? String, "Other device writing")
        XCTAssertEqual((original["attachments"] as? [[String: Any]])?.compactMap { $0["id"] as? String }, ["remove", "keep"])
        let drafts = try composeFixtureRequest("v1/drafts?accountId=ios-fixture-account")
        let copy = try XCTUnwrap((drafts["items"] as? [[String: Any]])?.first { ($0["subject"] as? String) == subject })
        XCTAssertEqual(copy["deliveryStatus"] as? String, "sent")
        XCTAssertEqual((copy["body"] as? [String: Any])?["text"] as? String, latestWriting)
        XCTAssertEqual((copy["attachments"] as? [[String: Any]])?.compactMap { $0["id"] as? String }, ["keep"])
        let after = try composeFixtureRequest("__fixture/compose/state")
        XCTAssertEqual(after["sendRequests"] as? Int, (before["sendRequests"] as? Int).map { $0 + 1 })
        XCTAssertEqual(after["deliveries"] as? Int, (before["deliveries"] as? Int).map { $0 + 1 })
    }

    func test30BackAndReopenDuringFirstCreateDoesNotDeliverTwice() throws {
        try setFixtureSending(true)
        addTeardownBlock {
            _ = try self.composeFixtureRequest("__fixture/draft-lifecycle/release-create", method: "POST")
            try self.restoreFixtureSending()
        }
        let before = try composeFixtureRequest("__fixture/draft-lifecycle/state")
        let subject = "Create race " + UUID().uuidString
        let app = try launchApp(); assertInboxLoaded(in: app)
        app.tabBars.buttons["Drafts"].tap()
        app.buttons["compose.open"].tap()
        let recipient = app.textFields["compose.to"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 10)); recipient.tap(); recipient.typeText("maya@example.com")
        let subjectField = app.textFields["compose.subject"]
        subjectField.tap(); subjectField.typeText(subject)
        let body = messageBody(in: app); body.tap(); body.typeText("Exactly one synthetic delivery.")
        navigateBack(in: app)
        let localRow = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "draft.", subject)).firstMatch
        XCTAssertTrue(localRow.waitForExistence(timeout: 10)); localRow.tap()
        _ = try composeFixtureRequest("__fixture/draft-lifecycle/arm-create", method: "POST")
        app.buttons["compose.send"].tap()
        _ = try composeFixtureRequest("__fixture/draft-lifecycle/wait-create")
        let back = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.exists); XCTAssertTrue(back.isEnabled)
        back.tap()
        XCTAssertTrue(app.navigationBars["Drafts"].waitForExistence(timeout: 5))
        XCTAssertTrue(localRow.waitForExistence(timeout: 5)); localRow.tap()
        let secondSend = app.buttons["compose.send"]
        XCTAssertTrue(secondSend.waitForExistence(timeout: 5))
        // A shared reservation may disable the reopened button. If it stays
        // enabled, it must reject another operation before a second POST.
        if secondSend.isEnabled { secondSend.tap() }
        // Give the competing operation a chance to reach the actual fixture.
        // A correct shared reservation instead rejects it before another POST.
        for _ in 0..<20 {
            let current = try composeFixtureRequest("__fixture/draft-lifecycle/state")
            if (current["createRequests"] as? Int ?? 0) >= (before["createRequests"] as? Int ?? 0) + 2 { break }
            Thread.sleep(forTimeInterval: 0.2)
        }
        let overlap = try composeFixtureRequest("__fixture/draft-lifecycle/state")
        XCTAssertEqual(overlap["pending"] as? Bool, true)
        XCTAssertEqual(overlap["released"] as? Bool, false)
        XCTAssertEqual(overlap["expired"] as? Bool, false, "The first create must still be held through the competing send")
        _ = try composeFixtureRequest("__fixture/draft-lifecycle/release-create", method: "POST")
        // Await the held request's actual draft, then its terminal delivery.
        var held: [String: Any] = [:]
        for _ in 0..<40 {
            let state = try composeFixtureRequest("__fixture/draft-lifecycle/state")
            if let id = state["heldDraftId"] as? String {
                held = try composeFixtureRequest("v1/drafts/\(id)?accountId=ios-fixture-account")
                if held["deliveryStatus"] as? String == "sent" { break }
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        XCTAssertEqual(held["deliveryStatus"] as? String, "sent")
        XCTAssertTrue(app.navigationBars["Drafts"].waitForExistence(timeout: 10), "The reopened composer must finish waiting when the original send completes")
        let after = try composeFixtureRequest("__fixture/draft-lifecycle/state")
        XCTAssertEqual(after["createRequests"] as? Int, (before["createRequests"] as? Int).map { $0 + 1 }, "The shared reservation must prevent even a second create request")
        XCTAssertEqual(after["deliveries"] as? Int, (before["deliveries"] as? Int).map { $0 + 1 }, "Reopening the same local draft must not create a second delivery")
        let drafts = try composeFixtureRequest("v1/drafts?accountId=ios-fixture-account")
        let copies = (drafts["items"] as? [[String: Any]])?.filter { $0["subject"] as? String == subject }
        XCTAssertEqual(copies?.count, 1, "The local draft must have exactly one server identity")
        attachScreenshot(named: "40-compose-create-reopen-single-delivery")
    }

    func test31SentServerDraftDoesNotRemainAnEditableLocalCopy() throws {
        let subject = "Remote sent " + UUID().uuidString
        let draft = try createComposeFixtureDraft(subject: subject)
        let id = try XCTUnwrap(draft["id"] as? String)
        let app = try launchApp(); assertInboxLoaded(in: app)
        app.tabBars.buttons["Drafts"].tap()
        let serverRow = app.descendants(matching: .any)["draft.\(id)"]
        XCTAssertTrue(serverRow.waitForExistence(timeout: 10)); serverRow.tap()
        XCTAssertTrue(messageBody(in: app).waitForExistence(timeout: 5))
        navigateBack(in: app)
        // A UUID local row distinct from the server row proves the production
        // autosave finished before the remote delivery transition.
        let localCopy = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier != %@ AND label CONTAINS %@", "draft.", "draft.\(id)", subject)).firstMatch
        XCTAssertTrue(localCopy.waitForExistence(timeout: 10))
        _ = try composeFixtureRequest("__fixture/compose/delivery", method: "POST", body: ["draftId": id, "status": "sent"])
        let marker = try createComposeFixtureDraft(subject: "Reload marker " + UUID().uuidString)
        let markerID = try XCTUnwrap(marker["id"] as? String)
        addTeardownBlock { _ = try self.composeFixtureRequest("v1/drafts/\(markerID)?accountId=ios-fixture-account", method: "DELETE") }
        // Re-enter the tab to run the production onAppear load reliably; a
        // short swipe may merely scroll and never cross refresh's threshold.
        app.tabBars.buttons["Inbox"].tap()
        app.tabBars.buttons["Drafts"].tap()
        // Seeing a server row created after the sent transition proves the
        // fresh server list has been applied, avoiding transient-empty passes.
        let markerRow = app.descendants(matching: .any)["draft.\(markerID)"]
        XCTAssertTrue(markerRow.waitForExistence(timeout: 10))
        let anyCopy = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "draft.", subject)).firstMatch
        XCTAssertFalse(anyCopy.exists, "A local copy must reconcile the server's terminal sent status")
        app.terminate()
        let reopened = try launchApp(); assertInboxLoaded(in: reopened)
        reopened.tabBars.buttons["Drafts"].tap()
        XCTAssertTrue(reopened.descendants(matching: .any)["draft.\(markerID)"].waitForExistence(timeout: 10))
        XCTAssertFalse(reopened.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "draft.", subject)).firstMatch.exists)
        attachScreenshot(named: "41-compose-remote-sent-reconciled")
    }

    func test32SentServerPreservesUnsentLocalEditsUntilExplicitCopy() throws {
        try exerciseSentLocalEditsRecovery()
    }

    func test36SentRecoveryStatusAtAccessibilitySize() throws {
        try exerciseSentLocalEditsRecovery(contentSize: "UICTContentSizeCategoryAccessibilityXXXL")
    }

    private func exerciseSentLocalEditsRecovery(contentSize: String = "UICTContentSizeCategoryL") throws {
        try setFixtureSending(true)
        addTeardownBlock { try self.restoreFixtureSending() }
        let subject = "Sent with local edits " + UUID().uuidString
        let draft = try createComposeFixtureDraft(subject: subject)
        let id = try XCTUnwrap(draft["id"] as? String)
        let app = try launchApp(contentSize: contentSize); assertInboxLoaded(in: app)
        app.tabBars.buttons["Drafts"].tap()
        let serverRow = app.descendants(matching: .any)["draft.\(id)"]
        revealDraftRow(serverRow, in: app); serverRow.tap()
        let body = messageBody(in: app)
        for _ in 0..<8 { if body.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(body.waitForExistence(timeout: 5)); body.tap(); body.typeText(" These local edits were never sent.")
        let latestWriting = try XCTUnwrap(body.value as? String)
        XCTAssertTrue(latestWriting.contains("These local edits were never sent."))
        navigateBack(in: app)
        _ = try composeFixtureRequest("__fixture/compose/delivery", method: "POST", body: ["draftId": id, "status": "sent"])
        app.tabBars.buttons["Inbox"].tap(); app.tabBars.buttons["Drafts"].tap()
        let preserved = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@ AND label CONTAINS[c] %@", "draft.", subject, "Sent elsewhere")).firstMatch
        revealDraftRow(preserved, in: app); preserved.tap()
        for _ in 0..<8 { if messageBody(in: app).exists { break }; app.swipeUp() }
        XCTAssertEqual(messageBody(in: app).value as? String, latestWriting)
        XCTAssertFalse(messageBody(in: app).isEnabled)
        let copy = app.buttons["compose.send"]
        XCTAssertEqual(copy.label, "Edit a new copy")
        let recoveryStatus = app.descendants(matching: .any)["compose.save-status"]
        XCTAssertEqual(recoveryStatus.label, "Sent elsewhere. Your local edits are preserved; edit a new copy to continue.")
        XCTAssertTrue(recoveryStatus.isHittable)
        XCTAssertTrue(copy.isHittable)
        attachScreenshot(named: "42-compose-sent-local-edits-preserved")
        copy.tap()
        expectation(for: NSPredicate(format: "label == %@ AND enabled == true", "Send"), evaluatedWith: copy)
        waitForExpectations(timeout: 10)
        XCTAssertTrue(messageBody(in: app).isEnabled)
        let before = try composeFixtureRequest("__fixture/compose/state")
        copy.tap()
        XCTAssertTrue(app.navigationBars["Drafts"].waitForExistence(timeout: 15))
        let original = try composeFixtureRequest("v1/drafts/\(id)?accountId=ios-fixture-account")
        XCTAssertEqual(original["deliveryStatus"] as? String, "sent")
        XCTAssertEqual((original["body"] as? [String: Any])?["text"] as? String, "Protected fixture writing")
        let listed = try composeFixtureRequest("v1/drafts?accountId=ios-fixture-account")
        let newCopy = try XCTUnwrap((listed["items"] as? [[String: Any]])?.first { $0["subject"] as? String == subject && $0["id"] as? String != id })
        let copyID = try XCTUnwrap(newCopy["id"] as? String)
        let sent = try composeFixtureRequest("v1/drafts/\(copyID)?accountId=ios-fixture-account")
        XCTAssertEqual(sent["deliveryStatus"] as? String, "sent")
        XCTAssertEqual((sent["body"] as? [String: Any])?["text"] as? String, latestWriting)
        let after = try composeFixtureRequest("__fixture/compose/state")
        XCTAssertEqual(after["deliveries"] as? Int, (before["deliveries"] as? Int).map { $0 + 1 })
        attachScreenshot(named: "43-compose-sent-local-edits-copy-delivered")
    }

    func test33RichDraftRequiresConfirmationAndCancelPreservesHTML() throws {
        try exerciseRichDraftConversion(confirm: false)
    }

    func test34RichDraftExplicitConversionPersistsAfterReopen() throws {
        try exerciseRichDraftConversion(confirm: true)
    }

    func test35RichDraftConversionAtAccessibilitySize() throws {
        try exerciseRichDraftConversion(confirm: false, contentSize: "UICTContentSizeCategoryAccessibilityXXXL")
    }

    private func exerciseRichDraftConversion(confirm: Bool, contentSize: String = "UICTContentSizeCategoryL") throws {
        try setFixtureSending(true)
        addTeardownBlock { try self.restoreFixtureSending() }
        let subject = "Rich conversion " + UUID().uuidString
        let richText = "Keep this link"
        let richHTML = "<p>Keep <a href=\"https://example.com/notes\">this link</a></p>"
        let draft = try createComposeFixtureDraft(subject: subject, message: ["text": richText, "html": richHTML])
        let id = try XCTUnwrap(draft["id"] as? String)
        let app = try launchApp(contentSize: contentSize); assertInboxLoaded(in: app)
        app.tabBars.buttons["Drafts"].tap()
        let row = app.descendants(matching: .any)["draft.\(id)"]
        if contentSize.contains("Accessibility") { attachScreenshot(named: "48-compose-large-draft-list-before-locating") }
        revealDraftRow(row, in: app)
        if contentSize.contains("Accessibility") { attachScreenshot(named: "49-compose-large-draft-row-visible") }
        row.tap()
        let body = messageBody(in: app)
        for _ in 0..<8 { if body.exists { break }; app.swipeUp() }
        XCTAssertTrue(body.waitForExistence(timeout: 10))
        let status = app.descendants(matching: .any)["compose.save-status"]
        expectation(for: NSPredicate(format: "label == %@", "Saved locally"), evaluatedWith: status)
        waitForExpectations(timeout: 10)
        attachScreenshot(named: "44-compose-rich-draft-protected")
        XCTAssertFalse(body.isEnabled, "A rich body must stay read-only until the user explicitly accepts conversion")
        XCTAssertEqual(body.value as? String, richText)
        if body.isHittable { body.tap() }
        XCTAssertEqual(body.value as? String, richText)
        XCTAssertFalse(app.keyboards.firstMatch.exists, "Focusing the protected body must not start editing")
        let edit = app.buttons["compose.edit-plain-text"]
        revealComposeControl(edit, in: app, scrollUp: true)
        XCTAssertEqual(edit.label, "Edit as plain text")
        edit.tap()
        let dialog = app.alerts["Edit as plain text?"]
        XCTAssertTrue(dialog.waitForExistence(timeout: 5))
        XCTAssertTrue(dialog.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@ AND label CONTAINS[c] %@", "formatting", "links")).firstMatch.exists)
        attachScreenshot(named: "45-compose-rich-conversion-confirmation")
        dialog.buttons["Cancel"].tap()
        XCTAssertTrue(dialog.waitForNonExistence(timeout: 5))
        XCTAssertFalse(body.isEnabled)
        XCTAssertEqual(body.value as? String, richText)
        // Interrupt a still-pending confirmation without accepting conversion.
        edit.tap(); XCTAssertTrue(dialog.waitForExistence(timeout: 5))
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(dialog.waitForNonExistence(timeout: 5))
        XCTAssertFalse(body.isEnabled)
        XCTAssertEqual(body.value as? String, richText)
        if confirm {
            revealComposeControl(edit, in: app, scrollUp: true)
            edit.tap(); XCTAssertTrue(dialog.waitForExistence(timeout: 5))
            dialog.buttons["Convert to plain text"].tap()
            expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: body)
            waitForExpectations(timeout: 10)
            XCTAssertFalse(edit.exists)
        } else {
            for _ in 0..<8 { if app.textFields["compose.subject"].isHittable { break }; app.swipeDown() }
            let title = app.textFields["compose.subject"]; title.tap(); title.typeText(" reviewed")
            let to = app.textFields["compose.to"]
            for _ in 0..<8 { if to.isHittable { break }; app.swipeDown() }
            to.tap(); to.typeText(", friend@example.com")
        }
        let expectedText = confirm ? try XCTUnwrap(body.value as? String) : richText
        navigateBack(in: app)
        let localRow = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "draft.", subject)).firstMatch
        revealDraftRow(localRow, in: app)
        app.terminate()
        let reopened = try launchApp(contentSize: contentSize); assertInboxLoaded(in: reopened)
        reopened.tabBars.buttons["Drafts"].tap()
        let savedRow = reopened.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "draft.", subject)).firstMatch
        revealDraftRow(savedRow, in: reopened); savedRow.tap()
        let reopenedBody = messageBody(in: reopened)
        for _ in 0..<8 { if reopenedBody.exists { break }; reopened.swipeUp() }
        XCTAssertTrue(reopenedBody.waitForExistence(timeout: 10))
        XCTAssertEqual(reopenedBody.value as? String, expectedText)
        expectation(for: NSPredicate(format: "enabled == %@", NSNumber(value: confirm)), evaluatedWith: reopenedBody)
        waitForExpectations(timeout: 10)
        if confirm {
            for _ in 0..<8 { if reopenedBody.isHittable { break }; reopened.swipeUp() }
            reopenedBody.tap(); reopenedBody.typeText(" Updated words.")
        }
        let sentText = confirm ? try XCTUnwrap(reopenedBody.value as? String) : expectedText
        if confirm { XCTAssertTrue(sentText.contains("Updated words.")) }
        attachScreenshot(named: confirm ? "46-compose-converted-draft-reopened" : "47-compose-cancelled-conversion-reopened")
        let send = reopened.buttons["compose.send"]
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: send)
        waitForExpectations(timeout: 10); send.tap()
        XCTAssertTrue(reopened.navigationBars["Drafts"].waitForExistence(timeout: 15))
        let sent = try composeFixtureRequest("v1/drafts/\(id)?accountId=ios-fixture-account")
        XCTAssertEqual(sent["deliveryStatus"] as? String, "sent")
        let sentBody = try XCTUnwrap(sent["body"] as? [String: Any])
        XCTAssertEqual(sentBody["text"] as? String, sentText)
        if confirm { XCTAssertTrue(sentBody["html"] is NSNull, "Only confirmed conversion may strip the original HTML") }
        else { XCTAssertEqual(sentBody["html"] as? String, richHTML, "Cancel, backgrounding, subject edits, autosave, and reopen must preserve exact HTML") }
    }

    private func revealComposeControl(_ control: XCUIElement, in app: XCUIApplication, scrollUp: Bool,
                                      file: StaticString = #filePath, line: UInt = #line) {
        let form = app.scrollViews["compose.form"]
        XCTAssertTrue(form.waitForExistence(timeout: 10), file: file, line: line)
        let status = app.descendants(matching: .any)["compose.save-status"]
        for attempt in 0..<10 {
            let top = app.navigationBars.firstMatch.frame.maxY + 8
            let bottom = status.frame.minY - 12
            if control.exists && control.isHittable && control.frame.minY >= top && control.frame.maxY <= bottom { break }
            let up = control.exists && !control.frame.isEmpty
                ? control.frame.maxY > bottom : (attempt < 5 ? scrollUp : !scrollUp)
            // Drag the outer form's padding. A gesture through TextEditor can
            // scroll its inner text instead of revealing the covered control.
            let start = form.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: up ? 0.75 : 0.25))
            let end = form.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: up ? 0.25 : 0.75))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        if !control.exists || !control.isHittable || control.frame.maxY > status.frame.minY - 8 {
            let namedEdit = app.buttons.matching(NSPredicate(format: "label == %@", "Edit as plain text")).firstMatch
            if namedEdit.exists { print("COMPOSE_EDIT_LOOKUP identifier=\(namedEdit.identifier) frame=\(namedEdit.frame) enabled=\(namedEdit.isEnabled)") }
            print("COMPOSE_REVEAL_FAILURE status=\(status.label) footer=\(status.frame)")
            attachScreenshot(named: "52-compose-control-reveal-failed")
        }
        XCTAssertTrue(control.exists && control.isHittable, file: file, line: line)
        XCTAssertLessThanOrEqual(control.frame.maxY, status.frame.minY - 8, "Control must be above the fixed footer before tapping", file: file, line: line)
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: control)
        waitForExpectations(timeout: 10)
    }

    private func revealDraftRow(_ row: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let list = app.descendants(matching: .any)["drafts.list"]
        XCTAssertTrue(list.waitForExistence(timeout: 10), file: file, line: line)
        if row.waitForExistence(timeout: 2), row.isHittable { return }
        // Accessibility-sized rows and retained local drafts can push a newly
        // created server row outside List's materialized accessibility range.
        for _ in 0..<16 {
            if row.exists && row.isHittable { return }
            list.swipeUp()
        }
        for _ in 0..<16 {
            if row.exists && row.isHittable { return }
            list.swipeDown()
        }
        XCTAssertTrue(row.exists && row.isHittable, "Expected draft row after scrolling the actual list", file: file, line: line)
    }

    private func setFixtureSending(_ enabled: Bool, accountsUnavailable: Bool = false) throws {
        _ = try composeFixtureRequest("__fixture/compose/capabilities", method: "POST", body: ["sendEnabled": enabled, "accountsUnavailable": accountsUnavailable])
    }
    private func restoreFixtureSending() throws {
        try setFixtureSending(ProcessInfo.processInfo.environment["ORCA_FIXTURE_READ_ONLY"] != "1")
    }
    private func createComposeFixtureDraft(subject: String, attachments: [[String: Any]] = [], message: [String: Any] = ["text": "Protected fixture writing", "html": NSNull()]) throws -> [String: Any] {
        try composeFixtureRequest("v1/drafts?accountId=ios-fixture-account", method: "POST", body: [
            "to": [["name": NSNull(), "email": "maya@example.com"]], "cc": [], "bcc": [], "subject": subject,
            "body": message, "context": NSNull(), "attachments": attachments,
        ])
    }
    private func composeFixtureRequest(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> [String: Any] {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["ORCA_FIXTURE_API_URL"], let root = URL(string: base), root.scheme == "http",
              ["127.0.0.1", "localhost"].contains(root.host ?? ""), let url = URL(string: path, relativeTo: root.appendingPathComponent("/")),
              let token = environment["ORCA_FIXTURE_ACCESS_TOKEN"] else { throw TestConfigurationError.missingFixtureEnvironment }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 8
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let completed = expectation(description: "Compose fixture \(path)")
        var output: [String: Any] = [:]
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            XCTAssertNil(error)
            XCTAssertTrue((200..<300).contains((response as? HTTPURLResponse)?.statusCode ?? 0), "Fixture \(path) returned HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
            if let data, !data.isEmpty {
                let json = try? JSONSerialization.jsonObject(with: data)
                output = json as? [String: Any] ?? ["items": json as? [[String: Any]] ?? []]
            }
            completed.fulfill()
        }
        task.resume(); wait(for: [completed], timeout: 10); task.cancel()
        return output
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

    private func launchApp(contentSize: String = "UICTContentSizeCategoryL") throws -> XCUIApplication {
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
            "-UIPreferredContentSizeCategoryName", contentSize,
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
        let tapStarted = ProcessInfo.processInfo.systemUptime
        row.tap()
        let tapFinished = ProcessInfo.processInfo.systemUptime
        let conversationOpened = app.navigationBars["Conversation"].waitForExistence(timeout: 10)
        let waitFinished = ProcessInfo.processInfo.systemUptime
        print("INBOX_NAVIGATION_TIMING row=\(identifier) tapSeconds=\(tapFinished - tapStarted) navigationWaitSeconds=\(waitFinished - tapFinished) opened=\(conversationOpened)")
        if !conversationOpened {
            attachScreenshot(named: "inbox-navigation-failure-after-tap")
            // App-only synthetic fixture state. Never log the launch arguments or
            // process environment. checks.log is also redacted by the CI exporter.
            var hierarchy = app.debugDescription
            if let token = ProcessInfo.processInfo.environment["ORCA_FIXTURE_ACCESS_TOKEN"], !token.isEmpty {
                hierarchy = hierarchy.replacingOccurrences(of: token, with: "[REDACTED]")
            }
            print("INBOX_NAVIGATION_FAILURE_HIERARCHY_BEGIN\n\(hierarchy)\nINBOX_NAVIGATION_FAILURE_HIERARCHY_END")
        }
        XCTAssertTrue(conversationOpened)
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
        // Keep the identifier query live while scroll content is offscreen.
        app.textViews["compose.body"]
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

