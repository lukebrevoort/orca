import XCTest

final class OrcaUITests: XCTestCase {
    private var boundaryDiagnostics = false
    private var boundaryFailureCaptureRegistered = false
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
        boundaryDiagnostics = false
        boundaryFailureCaptureRegistered = false
    }

    func test54NamedSpacesCollectionsAndQueryPinsBrowseHideRestoreAndReturnToSource() throws {
        for size in ["UICTContentSizeCategoryL", "UICTContentSizeCategoryAccessibilityXXXL"] {
            let fixture = try createNativeBrowseFixture()
            let providerBefore = try composeFixtureRequest("/__fixture/compose/state")
            let app = try launchApp(contentSize: size); assertInboxLoaded(in: app)
            chooseMailboxID(try fixtureMailboxSelection("Focus"), title: "Focus", in: app)
            XCTAssertTrue(app.buttons["mail.filter.all"].isHittable, "Permanent All Mail remains one action away from the actual named Focus Space")
            chooseMailboxID(fixture.collectionSelection, title: fixture.collectionName, in: app)
            let collected = app.buttons["catalog.message.ios-fixture-message-1"]
            XCTAssertTrue(collected.waitForExistence(timeout: 10)); XCTAssertTrue(collected.label.contains(Fixture.inboxSubject))
            attachScreenshot(named: "bre457-collection-owned-rows-" + size)
            collected.tap(); XCTAssertTrue(app.navigationBars["Conversation"].waitForExistence(timeout: 10))
            navigateBack(in: app)
            XCTAssertTrue(app.navigationBars[fixture.collectionName].waitForExistence(timeout: 10))
            XCTAssertTrue(collected.waitForExistence(timeout: 10), "Back keeps the typed collection source and its owned rows")
            chooseMailboxID(fixture.pinSelection, title: fixture.pinName, in: app)
            let matching = app.buttons["catalog.message.ios-fixture-message-2"]
            XCTAssertTrue(matching.waitForExistence(timeout: 10)); XCTAssertFalse(app.buttons["catalog.message.ios-fixture-message-1"].exists)
            attachScreenshot(named: "bre457-query-pin-owned-results-" + size)
            app.buttons["inbox.view-picker"].tap()
            let choices = app.collectionViews["mailbox.choices"], pin = choices.buttons["mailbox.option." + fixture.pinSelection]
            for _ in 0..<12 { if pin.exists && pin.isHittable { break }; choices.swipeUp() }
            XCTAssertTrue(pin.isHittable); pin.press(forDuration: 1.2)
            app.buttons["Hide on this device"].tap()
            let restore = choices.buttons["mailbox.restore-open." + fixture.pinSelection]
            for _ in 0..<12 { if restore.exists && restore.isHittable { break }; choices.swipeUp() }
            XCTAssertTrue(restore.isHittable)
            attachScreenshot(named: "bre457-hidden-pin-restore-" + size)
            restore.tap()
            XCTAssertTrue(matching.waitForExistence(timeout: 10))
            app.buttons["mail.filter.all"].tap()
            XCTAssertTrue(app.buttons["inbox.message.ios-fixture-message-1"].waitForExistence(timeout: 10))
            let providerAfter = try composeFixtureRequest("/__fixture/compose/state")
            XCTAssertEqual(providerBefore["sendRequests"] as? Int, providerAfter["sendRequests"] as? Int)
            XCTAssertEqual(providerBefore["deliveries"] as? Int, providerAfter["deliveries"] as? Int)
        }
    }

    func test55FirstSearchFromCollectionAndQueryPinPreservesSubmittedAndUnfinishedQueries() throws {
        let fixture = try createNativeBrowseFixture()
        for (selection, title) in [(fixture.collectionSelection, fixture.collectionName), (fixture.pinSelection, fixture.pinName)] {
            let app = try launchApp(); assertInboxLoaded(in: app)
            chooseMailboxID(selection, title: title, in: app)
            XCTAssertTrue(app.collectionViews["catalog.results"].waitForExistence(timeout: 10))
            search(for: "Friday", in: app)
            let accepted = app.buttons["inbox.message.ios-fixture-message-2"]
            XCTAssertTrue(accepted.waitForExistence(timeout: 10)); XCTAssertFalse(app.collectionViews["catalog.results"].exists)
            let field = app.searchFields["Search All Mail"]
            field.tap(); field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (field.value as? String ?? "").count)); field.typeText("Unsubmitted native B")
            XCTAssertEqual(field.value as? String, "Unsubmitted native B")
            accepted.tap(); XCTAssertTrue(app.navigationBars["Conversation"].waitForExistence(timeout: 10)); navigateBack(in: app)
            XCTAssertTrue(accepted.waitForExistence(timeout: 10))
            XCTAssertEqual(field.value as? String, "Unsubmitted native B")
            XCTAssertTrue(app.staticTexts["Showing results for “Friday”. Press Search to update."].exists)
            attachScreenshot(named: "bre457-catalog-search-owned-A-B-" + selection.components(separatedBy: ":")[0])
            app.buttons["mail.search.clear-submitted"].tap()
            XCTAssertTrue(app.collectionViews["catalog.results"].waitForExistence(timeout: 10), "Explicit clear restores the real source, not an invented inbox lens")
            app.terminate()
        }
    }

    private struct NativeBrowseFixture {
        let collectionSelection: String; let pinSelection: String; let collectionName: String; let pinName: String
    }
    private func createNativeBrowseFixture() throws -> NativeBrowseFixture {
        let account = "ios-fixture-account", suffix = String(UUID().uuidString.prefix(8))
        let collectionName = "Native collection " + suffix, pinName = "Native query " + suffix
        func apply(_ change: [String: Any]) throws -> [String: Any] {
            try composeFixtureRequest("/v1/organization/collections-pins/apply", method: "POST", body: ["idempotencyKey": UUID().uuidString, "change": change])
        }
        let created = try apply(["kind": "collection", "action": "create", "accountId": account, "collection": ["name": collectionName, "color": "#70867d"]])
        let collection = try XCTUnwrap((created["change"] as? [String: Any])?["resourceId"] as? String)
        addTeardownBlock { _ = try apply(["kind": "collection", "action": "remove", "accountId": account, "collectionId": collection]) }
        _ = try apply(["kind": "collection_membership", "action": "add", "accountId": account, "collectionId": collection, "threadId": "ios-fixture-thread-1"])
        let result = try apply(["kind": "pin", "action": "create", "accountId": account, "pin": ["label": pinName, "icon": "search", "color": "#70867d", "target": ["type": "new_query", "name": pinName, "definition": ["revision": 1, "filters": ["text": "Friday", "accountId": account, "dataSource": "stored_mail"]]]]])
        let pin = try XCTUnwrap((result["change"] as? [String: Any])?["resourceId"] as? String)
        let state = try XCTUnwrap(result["state"] as? [String: Any])
        let exactPins = (state["pins"] as? [[String: Any]] ?? []).filter { $0["id"] as? String == pin }
        XCTAssertEqual(exactPins.count, 1)
        let query = try XCTUnwrap((exactPins.first?["target"] as? [String: Any])?["queryId"] as? String)
        // Teardown is LIFO: remove only these owned synthetic pin/query/collection
        // objects. Setup writes are not native product authoring or read-only proof.
        addTeardownBlock { _ = try apply(["kind": "saved_query", "action": "remove", "accountId": account, "queryId": query]) }
        addTeardownBlock { _ = try apply(["kind": "pin", "action": "remove", "accountId": account, "pinId": pin]) }
        func selection(_ kind: String, _ id: String) throws -> String {
            let data = try JSONSerialization.data(withJSONObject: [account, id], options: [.withoutEscapingSlashes])
            return kind + ":" + data.base64EncodedString()
        }
        return .init(collectionSelection: try selection("collection", collection), pinSelection: try selection("pin", pin), collectionName: collectionName, pinName: pinName)
    }

    func test53ExplicitLocalDiscardKeepsUnfinishedWritingOnCancelThenRemovesOnlyConfirmedCopy() throws {
        let app = try launchApp(); assertInboxLoaded(in: app)
        let subject = "Device discard " + String(UUID().uuidString.prefix(8))
        let before = try composeFixtureRequest("/__fixture/compose/state")
        app.buttons["compose.open"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["compose.from"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["compose.from"].label.contains(Fixture.account))
        let to = app.textFields["compose.to"]
        XCTAssertTrue(to.waitForExistence(timeout: 5)); to.tap(); to.typeText("Unfinished <person@")
        let title = app.textFields["compose.subject"]
        title.tap(); title.typeText(subject)
        focusComposeBody(in: app); messageBody(in: app).typeText("Keep this writing until I explicitly confirm.")
        app.buttons["compose.keyboard-done"].tap()
        let discard = app.buttons["compose.discard"]
        XCTAssertTrue(discard.isEnabled); discard.tap()
        XCTAssertTrue(app.alerts["Discard this draft?"].waitForExistence(timeout: 5))
        attachScreenshot(named: "bre457-discard-local-confirmation")
        app.alerts.buttons["Keep writing"].tap()
        XCTAssertEqual(title.value as? String, subject)
        XCTAssertEqual(to.value as? String, "Unfinished <person@")
        XCTAssertTrue((messageBody(in: app).value as? String ?? "").contains("Keep this writing"))
        discard.tap(); app.alerts.buttons["Discard draft"].tap()
        XCTAssertTrue(app.buttons["compose.open"].waitForExistence(timeout: 10))
        app.tabBars.buttons["Drafts"].tap()
        XCTAssertFalse(app.staticTexts[subject].exists, "Only the explicitly approved device copy is removed")
        let after = try composeFixtureRequest("/__fixture/compose/state")
        XCTAssertEqual(try XCTUnwrap(after["deliveries"] as? Int), try XCTUnwrap(before["deliveries"] as? Int))
        XCTAssertEqual(try XCTUnwrap(after["sendRequests"] as? Int), try XCTUnwrap(before["sendRequests"] as? Int))
        attachScreenshot(named: "bre457-discard-local-acknowledged")
    }

    func test52FirstSearchFromSavedViewShowsPendingSearchInsteadOfSavedRows() throws {
        let app = try launchApp(); assertInboxLoaded(in: app)
        app.tabBars.buttons["Settings"].tap()
        app.buttons["settings.visible-views"].tap()
        let hub = app.switches.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "settings.views.view:", "Hub notifications")).firstMatch
        XCTAssertTrue(hub.waitForExistence(timeout: 10))
        if hub.value as? String != "1" { hub.tap() }
        app.tabBars.buttons["Mail"].tap()
        app.buttons["inbox.view-picker"].tap(); app.buttons["Hub notifications"].tap()
        let saved = app.buttons["view.thread.ios-fixture-thread-2"]
        XCTAssertTrue(saved.waitForExistence(timeout: 10))
        try refreshFixture("arm", method: "POST", scenario: "controls")
        addTeardownBlock { try self.refreshFixture("release", method: "POST") }
        search(for: "Jordan", in: app)
        try refreshFixture("wait", method: "GET")
        XCTAssertTrue(app.collectionViews["inbox.list"].exists, "The first submitted search owns its pending surface before any accepted resultSearch exists")
        XCTAssertTrue(app.descendants(matching: .any)["mail.search.loading"].exists)
        XCTAssertFalse(saved.exists, "Saved View rows must not hide the in-flight All Mail search")
        XCTAssertEqual(app.searchFields["Search All Mail"].value as? String, "Jordan")
        attachScreenshot(named: "bre457-saved-first-search-pending")
        try refreshFixture("release", method: "POST")
        XCTAssertTrue(app.buttons["inbox.message.\(Fixture.searchResultMessageID)"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["mail.list-heading"].label.contains("Jordan"))
        XCTAssertFalse(app.descendants(matching: .any)["mail.search.loading"].exists)
        attachScreenshot(named: "bre457-saved-first-search-accepted")
    }

    func test50PrimaryMailKeepsSubmittedQueryAcrossReaderRefreshWithUnsubmittedText() throws {
        let app = try launchApp(); assertInboxLoaded(in: app)
        search(for: "Jordan", in: app)
        let accepted = app.buttons["inbox.message.\(Fixture.searchResultMessageID)"]
        XCTAssertTrue(accepted.waitForExistence(timeout: 10))
        let field = app.searchFields["Search All Mail"]
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (field.value as? String ?? "").count))
        let unfinished = "Unsubmitted native query"
        field.typeText(unfinished)
        XCTAssertEqual(field.value as? String, unfinished)
        XCTAssertTrue(accepted.exists, "Editing B must retain accepted A before any Submit")
        attachScreenshot(named: "bre457-primary-unsubmitted-before-reader")
        accepted.tap()
        XCTAssertTrue(app.navigationBars["Conversation"].waitForExistence(timeout: 10))
        navigateBack(in: app)
        XCTAssertTrue(accepted.waitForExistence(timeout: 10), "The acknowledged read refresh still requests submitted A")
        XCTAssertEqual(field.value as? String, unfinished, "Reader return preserves unfinished B")
        XCTAssertTrue(app.staticTexts["Showing results for “Jordan”. Press Search to update."].exists)
        attachScreenshot(named: "bre457-primary-submitted-after-read-refresh")
        app.buttons["mail.search.clear-submitted"].tap()
        XCTAssertTrue(app.buttons["inbox.message.\(Fixture.inboxMessageID)"].waitForExistence(timeout: 10))
        XCTAssertFalse(field.buttons["Clear text"].exists, "Explicit clear removes unfinished text as it restores the real mailbox")
    }

    func test51SenderViewShowsActualMatchingRowsAndExplicitSubjectRefinement() throws {
        for size in ["UICTContentSizeCategoryL", "UICTContentSizeCategoryAccessibilityXXXL"] {
            let viewName = "Native sender " + String(UUID().uuidString.prefix(8))
            addTeardownBlock {
                let catalog = try self.composeFixtureRequest("/v1/organization/views")
                for view in (catalog["items"] as? [[String: Any]] ?? []).filter({ $0["name"] as? String == viewName }) {
                    let id = try XCTUnwrap(view["id"] as? String), revision = try XCTUnwrap(view["revision"] as? Int)
                    let current = try self.composeFixtureRequest("/v1/organization/views")
                    let workspace = try XCTUnwrap(current["workspaceRevision"] as? Int)
                    _ = try self.composeFixtureRequest("/v1/organization/views/\(id)?expectedRevision=\(revision)&expectedWorkspaceRevision=\(workspace)&idempotencyKey=\(UUID().uuidString)", method: "DELETE")
                }
            }
            let before = try composeFixtureRequest("/v1/organization/views")
            let providerBefore = try composeFixtureRequest("/__fixture/compose/state")
            let app = try launchApp(contentSize: size); assertInboxLoaded(in: app)
            let row = app.buttons["inbox.message.\(Fixture.inboxMessageID)"]
            XCTAssertTrue(row.waitForExistence(timeout: 10)); row.press(forDuration: 1.4)
            app.buttons["Use sender in View…"].tap()
            let name = app.textFields["mail-action.name"]
            XCTAssertTrue(name.waitForExistence(timeout: 10)); name.tap()
            name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (name.value as? String ?? "").count)); name.typeText(viewName)
            app.buttons["mail-action.preview"].tap()
            let refine = app.switches["view-editor.refine-subject"]
            XCTAssertTrue(refine.waitForExistence(timeout: 10)); refine.tap()
            let subject = app.textFields["view-editor.subject"]
            XCTAssertTrue(subject.exists); subject.tap(); subject.typeText("A quieter")
            let preview = app.buttons["view-editor.preview"]
            for _ in 0..<8 { if preview.isHittable { break }; app.swipeUp() }
            XCTAssertTrue(preview.isHittable); preview.tap()
            let matching = app.descendants(matching: .any)["view-editor.preview-row.ios-fixture-thread-1"]
            XCTAssertTrue(matching.waitForExistence(timeout: 10))
            XCTAssertTrue(matching.label.contains(Fixture.inboxSubject), "Preview displays actual subject, not only a count")
            let afterPreview = try composeFixtureRequest("/v1/organization/views")
            XCTAssertEqual((afterPreview["items"] as? [[String: Any]])?.count, (before["items"] as? [[String: Any]])?.count, "Preview/refinement writes no View")
            attachScreenshot(named: "bre457-native-sender-actual-preview-\(size)")
            let save = app.buttons["view-editor.save"]
            for _ in 0..<8 { if save.isHittable { break }; app.swipeUp() }
            XCTAssertTrue(save.isHittable); save.tap()
            XCTAssertTrue(app.descendants(matching: .any)["view.thread.ios-fixture-thread-1"].waitForExistence(timeout: 10))
            let saved = try composeFixtureRequest("/v1/organization/views")
            let created = (saved["items"] as? [[String: Any]] ?? []).filter { $0["name"] as? String == viewName }
            XCTAssertEqual(created.count, 1)
            let definition = try XCTUnwrap(created.first?["definition"] as? [String: Any])
            XCTAssertEqual((definition["thread"] as? [String: Any])?["subjectContains"] as? String, "A quieter")
            XCTAssertEqual((definition["sender"] as? [String: Any])?["addresses"] as? [String], ["maya@example.com"])
            let providerAfter = try composeFixtureRequest("/__fixture/compose/state")
            XCTAssertEqual(providerAfter["sendRequests"] as? Int, providerBefore["sendRequests"] as? Int)
            XCTAssertEqual(providerAfter["deliveries"] as? Int, providerBefore["deliveries"] as? Int)
            attachScreenshot(named: "bre457-native-sender-refined-result-\(size)")
            app.terminate()
        }
    }

    /// BRE-457 acceptance baseline. Runs against real native controls, never source text.
    func test44MailStartsImportantAndKeepsAllMailReachable() throws {
        let app = try launchApp(openInbox: false)
        XCTAssertTrue(app.buttons["inbox.view-picker"].waitForExistence(timeout: 20))
        attachScreenshot(named: "bre457-mail-entry-before-choice")
        XCTAssertTrue(app.tabBars.buttons["Mail"].isSelected, "The primary native destination is Mail.")
        let picker = app.buttons["inbox.view-picker"]
        XCTAssertTrue((picker.label + " " + (picker.value as? String ?? "")).contains("Important"), "Launch opens Important, independently of Inbox placement.")
        let all = app.buttons["mail.filter.all"]
        XCTAssertTrue(all.isHittable, "All Mail must remain one action away even with no Important conversations.")
        all.tap()
        XCTAssertTrue(app.descendants(matching: .any)["inbox.message.\(Fixture.inboxMessageID)"].waitForExistence(timeout: 15))
        attachScreenshot(named: "bre457-all-mail-recovery")
        app.descendants(matching: .any)["inbox.message.\(Fixture.inboxMessageID)"].press(forDuration: 1)
        XCTAssertTrue(app.buttons["Importance…"].waitForExistence(timeout: 5), "Importance must be distinct from Move mail.")
    }

    func test45ImportancePersistsWithoutReadingOrMovingAndDirectCorrectionSurvivesReopen() throws {
        let thread = "ios-fixture-thread-1"
        // Resolve actual account ownership from the authenticated fixture, never a live account.
        let accounts = try composeFixtureRequest("/v1/accounts")
        let accountID = try XCTUnwrap((accounts["items"] as? [[String: Any]])?.first?["id"] as? String)
        XCTAssertFalse(accountID.isEmpty)
        func current() throws -> [String: Any] {
            let envelope = try composeFixtureRequest("/v1/importance/conversations/" + thread + "?accountId=" + accountID)
            return try XCTUnwrap(envelope["importance"] as? [String: Any])
        }
        func reset() throws {
            let original = try current(), choice = try XCTUnwrap(original["conversation"] as? [String: Any])
            _ = try composeFixtureRequest("/v1/importance/choices", method: "POST", body: ["accountId": accountID, "target": ["kind": "conversation", "threadId": thread], "choice": NSNull(), "expectedRevision": choice["revision"]!, "operationId": UUID().uuidString.lowercased()])
        }
        try reset()
        addTeardownBlock { try reset() }
        addTeardownBlock { if (self.testRun?.totalFailureCount ?? 0) > 0 { try self.captureMailFixtureReadback(stage: "importance-before-teardown-reset", accountID: accountID) } }
        let providerBefore = try composeFixtureRequest("/__fixture/compose/state")
        let before = try composeFixtureRequest("/v1/inbox?accountId=" + accountID + "&view=all&limit=30")
        let beforeRow = try XCTUnwrap((before["messages"] as? [[String: Any]])?.first { $0["threadId"] as? String == thread })
        let app = try launchApp(openInbox: false)
        app.buttons["mail.filter.all"].tap()
        let choiceButton = app.buttons["mail.importance." + thread]
        XCTAssertTrue(choiceButton.waitForExistence(timeout: 15)); choiceButton.tap()
        XCTAssertTrue(app.buttons["importance.important"].waitForExistence(timeout: 10))
        attachScreenshot(named: "bre457-conversation-scope-before-choice")
        app.buttons["importance.important"].tap()
        let originalStatusFound = app.staticTexts["importance.status"].waitForExistence(timeout: 10)
        if !originalStatusFound { captureMailBoundary(in: app, stage: "importance-after-original-status-wait") }
        XCTAssertTrue(originalStatusFound)
        XCTAssertEqual(try current()["effective"] as? String, "important")
        XCTAssertTrue(app.buttons["importance.undo"].isEnabled)
        attachScreenshot(named: "bre457-importance-acknowledged-undo")
        app.buttons["Done"].tap()
        app.terminate()
        let reopened = try launchApp(openInbox: false)
        XCTAssertTrue(reopened.descendants(matching: .any)["inbox.message." + thread].waitForExistence(timeout: 15))
        attachScreenshot(named: "bre457-important-reopened")
        reopened.buttons["mail.importance." + thread].tap()
        XCTAssertTrue(reopened.buttons["importance.not-important"].waitForExistence(timeout: 10))
        reopened.buttons["importance.not-important"].tap()
        XCTAssertTrue(reopened.staticTexts["importance.status"].waitForExistence(timeout: 10))
        XCTAssertEqual(try current()["effective"] as? String, "not_important")
        reopened.buttons["Done"].tap()
        let removed = reopened.descendants(matching: .any)["inbox.message." + thread]
        let disappears = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: removed)
        wait(for: [disappears], timeout: 10)
        XCTAssertTrue(reopened.buttons["mail.filter.all"].isHittable)
        let after = try composeFixtureRequest("/v1/inbox?accountId=" + accountID + "&view=all&limit=30")
        let afterRow = try XCTUnwrap((after["messages"] as? [[String: Any]])?.first { $0["threadId"] as? String == thread })
        XCTAssertEqual(beforeRow["unread"] as? Bool, afterRow["unread"] as? Bool, "Importance does not mark read")
        XCTAssertEqual(beforeRow["labels"] as? [String], afterRow["labels"] as? [String], "Importance does not move provider mail")
        let providerAfter = try composeFixtureRequest("/__fixture/compose/state")
        XCTAssertEqual(providerBefore["sendRequests"] as? Int, providerAfter["sendRequests"] as? Int)
        XCTAssertEqual(providerBefore["deliveries"] as? Int, providerAfter["deliveries"] as? Int)
        let report: [String: Any] = ["scenario": "native-importance-correction", "acknowledgedUIChoices": 2,
            "sendRequestsBefore": providerBefore["sendRequests"] ?? NSNull(), "sendRequestsAfter": providerAfter["sendRequests"] ?? NSNull(),
            "deliveriesBefore": providerBefore["deliveries"] ?? NSNull(), "deliveriesAfter": providerAfter["deliveries"] ?? NSNull(),
            "allMailTargetWidth": reopened.buttons["mail.filter.all"].frame.width, "allMailTargetHeight": reopened.buttons["mail.filter.all"].frame.height]
        print("NATIVE_BRE457_RESULT " + String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
        attachScreenshot(named: "bre457-important-removal-all-mail-recovery")
    }

    func test46SettingsKeepsEditsAcrossSectionsAndGuardsLeaving() throws {
        let app = try launchApp()
        app.tabBars.buttons["Settings"].tap()
        chooseSettingsSection("Writing", in: app)
        let signature = app.textFields["settings.signature"]
        XCTAssertTrue(signature.waitForExistence(timeout: 10))
        signature.tap(); signature.typeText(" Unsaved synthetic edit")
        chooseSettingsSection("Appearance & reading", in: app)
        XCTAssertTrue(app.buttons["settings.save"].isEnabled, "Shared account Save stays reachable outside Writing")
        app.tabBars.buttons["Mail"].tap()
        XCTAssertTrue(app.buttons["Stay"].waitForExistence(timeout: 5)); app.buttons["Stay"].tap()
        XCTAssertTrue(app.tabBars.buttons["Settings"].isSelected)
        chooseSettingsSection("Writing", in: app)
        XCTAssertTrue((signature.value as? String ?? "").contains("Unsaved synthetic edit"))
        attachScreenshot(named: "bre457-settings-unsaved-stay")
        app.buttons["Discard edits"].tap()
        app.tabBars.buttons["Mail"].tap()
        XCTAssertTrue(app.tabBars.buttons["Mail"].isSelected)
    }

    func test49NativeSearchViewEditorPreviewsWithoutWritingAndReopensCreatedIdentity() throws {
        for size in ["UICTContentSizeCategoryL", "UICTContentSizeCategoryAccessibilityXXXL"] {
            let name = "Native editor " + String(UUID().uuidString.prefix(8))
            func ownedViews() throws -> [[String: Any]] {
                let catalog = try composeFixtureRequest("/v1/organization/views")
                return (catalog["items"] as? [[String: Any]] ?? []).filter { $0["name"] as? String == name }
            }
            addTeardownBlock {
                let catalog = try self.composeFixtureRequest("/v1/organization/views")
                for view in (catalog["items"] as? [[String: Any]] ?? []).filter({ $0["name"] as? String == name }) {
                    let id = try XCTUnwrap(view["id"] as? String), revision = try XCTUnwrap(view["revision"] as? Int)
                    let current = try self.composeFixtureRequest("/v1/organization/views")
                    let workspace = try XCTUnwrap(current["workspaceRevision"] as? Int)
                    _ = try self.composeFixtureRequest("/v1/organization/views/\(id)?expectedRevision=\(revision)&expectedWorkspaceRevision=\(workspace)&idempotencyKey=\(UUID().uuidString)", method: "DELETE")
                }
            }
            let app = try launchApp(contentSize: size)
            addTeardownBlock { if (self.testRun?.totalFailureCount ?? 0) > 0 { try self.captureMailFixtureReadback(stage: "search-save-before-view-cleanup", accountID: "ios-fixture-account") } }
            search(for: "Friday", in: app)
            let saveSearch = app.buttons["search.save-view"]
            let originalSaveFound = saveSearch.waitForExistence(timeout: 10)
            if !originalSaveFound { captureMailBoundary(in: app, stage: "search-save-after-original-wait") }
            XCTAssertTrue(originalSaveFound); saveSearch.tap()
            let field = app.textFields["view-editor.name"]
            XCTAssertTrue(field.waitForExistence(timeout: 10)); field.tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (field.value as? String ?? "").count)); field.typeText(String(name))
            let preview = app.buttons["view-editor.preview"]
            for _ in 0..<5 { if preview.isHittable { break }; app.swipeUp() }
            XCTAssertTrue(preview.isHittable); preview.tap()
            let save = app.buttons["view-editor.save"]
            for _ in 0..<5 { if save.exists { break }; app.swipeUp() }
            XCTAssertTrue(save.waitForExistence(timeout: 10)); XCTAssertFalse(save.isEnabled, "Unsupported general search requires explicit replacement")
            XCTAssertTrue(try ownedViews().isEmpty, "Preview must create no View")
            attachScreenshot(named: "bre457-native-editor-unsupported-" + size)
            let replacement = app.switches["Replace search with subject contains"]
            for _ in 0..<5 { if replacement.isHittable { break }; app.swipeDown() }
            XCTAssertTrue(replacement.isHittable); replacement.tap()
            for _ in 0..<5 { if preview.isHittable { break }; app.swipeUp() }; preview.tap()
            for _ in 0..<5 { if save.isHittable { break }; app.swipeUp() }
            XCTAssertTrue(save.waitForExistence(timeout: 10)); XCTAssertTrue(save.isEnabled)
            attachScreenshot(named: "bre457-native-editor-reviewed-" + size); save.tap()
            let searchField = app.searchFields["Search All Mail"]
            XCTAssertTrue(searchField.waitForExistence(timeout: 10))
            XCTAssertTrue(searchField.buttons["Clear text"].exists); searchField.buttons["Clear text"].tap()
            let edit = app.buttons["view.edit"]
            XCTAssertTrue(edit.waitForExistence(timeout: 15))
            let created = try ownedViews(); XCTAssertEqual(created.count, 1)
            let createdID = try XCTUnwrap(created.first?["id"] as? String)
            edit.tap(); XCTAssertTrue(field.waitForExistence(timeout: 10))
            XCTAssertEqual(field.value as? String, String(name))
            attachScreenshot(named: "bre457-native-editor-reopened-" + size)
            app.buttons["Cancel"].tap()
            XCTAssertEqual(try ownedViews().first?["id"] as? String, createdID, "Reopening the created View must retain its actual identity")
            app.terminate()
        }
    }

    func test48ImportantNotificationAdoptionIsExplicitAccountScopedAndNotDeliveryProof() throws {
        let accounts = try composeFixtureRequest("/v1/accounts")
        let accountID = try XCTUnwrap((accounts["items"] as? [[String: Any]])?.first?["id"] as? String)
        let app = try launchApp()
        app.tabBars.buttons["Settings"].tap(); chooseSettingsSection("Notifications", in: app)
        let identity = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "notifications.installation.")).firstMatch
        for _ in 0..<6 { if identity.exists { break }; app.swipeUp() }
        XCTAssertTrue(identity.waitForExistence(timeout: 15), "A real server installation status must precede adoption")
        let installationID = String(identity.identifier.dropFirst("notifications.installation.".count))
        XCTAssertFalse(installationID.isEmpty)
        func current() throws -> [String: Any] { try composeFixtureRequest("/v1/notifications/installations/" + installationID + "?channel=apns") }
        let before = try current()
        let edit = app.buttons["notifications.edit-important"]
        for _ in 0..<8 { if edit.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(edit.isHittable); edit.tap()
        // Entering/editing/canceling the review must not adopt or revise anything.
        let cancel = app.buttons["Cancel changes"]
        for _ in 0..<8 { if cancel.isHittable { break }; app.swipeUp() }
        cancel.tap()
        XCTAssertEqual(try current()["revision"] as? Int, before["revision"] as? Int)
        for _ in 0..<8 { if edit.isHittable { break }; app.swipeDown() }
        edit.tap()
        let enable = app.switches["notifications.enabled"], account = app.switches["notifications.account." + accountID]
        for _ in 0..<8 { if account.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(account.isHittable)
        if enable.value as? String != "1" { enable.tap() }
        if account.value as? String != "1" { account.tap() }
        let review = app.buttons["notifications.review-important"]
        for _ in 0..<8 { if review.isHittable { break }; app.swipeUp() }
        review.tap()
        XCTAssertTrue(app.buttons["Confirm device choices"].waitForExistence(timeout: 5))
        attachScreenshot(named: "bre457-important-notification-explicit-confirmation")
        app.buttons["Confirm device choices"].tap()
        let saved = app.staticTexts["notifications.important-status"]
        XCTAssertTrue(saved.waitForExistence(timeout: 15))
        let after = try current(), policy = try XCTUnwrap(after["policy"] as? [String: Any])
        XCTAssertEqual(policy["kind"] as? String, "important_only"); XCTAssertEqual(policy["enabled"] as? Bool, true)
        XCTAssertTrue((policy["accountIds"] as? [String] ?? []).contains(accountID))
        XCTAssertEqual(after["cooldownSeconds"] as? Int, 900)
        let delivery = try XCTUnwrap(after["delivery"] as? [String: Any])
        XCTAssertEqual(delivery["scope"] as? String, "apns")
        // No system permission action was taken here; intent/status never proves an OS alert.
        attachScreenshot(named: "bre457-important-notification-policy-and-delivery-separate")
        let permission = after["permission"] as? String ?? "default"
        _ = try composeFixtureRequest("/v1/notifications/installations/" + installationID, method: "PUT", body: ["channel": "apns", "policyVersion": 1, "enabled": false, "accountIds": policy["accountIds"] ?? [], "permission": permission == "unknown" ? "default" : permission, "expectedRevision": after["revision"]!, "operationId": UUID().uuidString.lowercased()])
    }

    /// Runs in both themes against the authenticated loopback fixture only.
    func test43FeedbackReservesShortReaderAndWriterAtStandardAndAccessibilitySizes() throws {
        boundaryDiagnostics = true
        try setFixtureSending(true)
        addTeardownBlock { try self.restoreFixtureSending() }
        for size in ["UICTContentSizeCategoryL", "UICTContentSizeCategoryAccessibilityXXXL"] {
            let name = size.contains("Accessibility") ? "short-accessibility" : "short-standard"
            let subject = "Feedback layout " + UUID().uuidString
            let attachments: [[String: Any]] = [["id": "layout-file", "filename": String(repeating: "synthetic-long-filename-", count: 4) + ".txt",
                                                "mimeType": "text/plain", "size": 1, "contentBase64": "eA=="]]
            let draft = try createComposeFixtureDraft(subject: subject, attachments: attachments)
            let id = try XCTUnwrap(draft["id"] as? String)
            let before = try composeFixtureRequest("__fixture/compose/state")
            let app = try launchApp(contentSize: size, shortLayout: true)
            assertInboxLoaded(in: app)
            openConversation(subject: Fixture.inboxSubject, in: app)
            assertFeedbackClear(of: [app.buttons["Reply"], app.buttons["Reply all"], app.buttons["Forward"]],
                                in: app, checkpoint: name + "-reader")
            app.swipeUp()
            assertFeedbackClear(of: [app.buttons["Reply"], app.buttons["Reply all"], app.buttons["Forward"]],
                                in: app, checkpoint: name + "-reader-scrolled")
            navigateBack(in: app)
            app.tabBars.buttons["Drafts"].tap()
            let row = app.descendants(matching: .any)["draft.\(id)"]
            revealDraftRow(row, in: app); row.tap()
            let body = messageBody(in: app)
            revealComposeBody(in: app)
            for _ in 0..<8 { if body.isHittable { break }; app.swipeUp() }
            XCTAssertTrue(body.isHittable); focusComposeBody(in: app); body.typeText(" Layout writing.")
            dismissTypingIntroduction(in: app)
            XCTAssertTrue(app.keyboards.firstMatch.exists)
            let send = app.buttons["compose.send"]
            let status = app.descendants(matching: .any)["compose.save-status"]
            assertFeedbackClear(of: [send, status, app.buttons["compose.keyboard-done"]], in: app, checkpoint: name + "-keyboard")
            let writing = try XCTUnwrap(body.value as? String)
            app.buttons["feedback.open"].tap()
            XCTAssertTrue(app.textViews["feedback.message"].waitForExistence(timeout: 5))
            app.buttons["feedback.close"].tap()
            XCTAssertTrue(body.waitForExistence(timeout: 5))
            XCTAssertEqual(body.value as? String, writing)
            // Resume actual editing after the support sheet, then interrupt the
            // scene. Both transitions must preserve this account's draft.
            for _ in 0..<8 { if body.isHittable { break }; app.swipeDown() }
            XCTAssertTrue(body.isHittable); focusComposeBody(in: app); body.typeText(" Resumed.")
            dismissTypingIntroduction(in: app)
            let latest = try XCTUnwrap(body.value as? String)
            XCTAssertTrue(latest.contains("Resumed."))
            XCUIDevice.shared.press(.home); app.activate()
            XCTAssertEqual(body.value as? String, latest)
            assertFeedbackClear(of: [send, status], in: app, checkpoint: name + "-foreground")
            if !app.keyboards.firstMatch.exists { focusComposeBody(in: app) }
            XCTAssertTrue(app.buttons["compose.keyboard-done"].waitForExistence(timeout: 5))
            app.buttons["compose.keyboard-done"].tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
            let remove = app.buttons["compose.attachment.remove.layout-file"]
            revealComposeControl(remove, in: app, scrollUp: true)
            assertFeedbackClear(of: [remove, send, status], in: app, checkpoint: name + "-keyboard-down-attachment")
            expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: send)
            waitForExpectations(timeout: 10); send.tap()
            XCTAssertTrue(app.navigationBars["Drafts"].waitForExistence(timeout: 15))
            let sent = try composeFixtureRequest("v1/drafts/\(id)?accountId=ios-fixture-account")
            XCTAssertEqual(sent["deliveryStatus"] as? String, "sent")
            XCTAssertEqual((sent["body"] as? [String: Any])?["text"] as? String, latest)
            XCTAssertEqual((sent["to"] as? [[String: Any]])?.compactMap { $0["email"] as? String }, ["maya@example.com"])
            XCTAssertEqual((sent["attachments"] as? [[String: Any]])?.compactMap { $0["id"] as? String }, ["layout-file"])
            let after = try composeFixtureRequest("__fixture/compose/state")
            XCTAssertEqual(after["sendRequests"] as? Int, (before["sendRequests"] as? Int).map { $0 + 1 })
            XCTAssertEqual(after["deliveries"] as? Int, (before["deliveries"] as? Int).map { $0 + 1 })
            print("[bre-459] checkpoint=\(name)-delivered send_requests_delta=\(try XCTUnwrap(after["sendRequests"] as? Int) - XCTUnwrap(before["sendRequests"] as? Int)) deliveries_delta=\(try XCTUnwrap(after["deliveries"] as? Int) - XCTUnwrap(before["deliveries"] as? Int))")
            app.terminate()
        }
    }

    func test38FeedbackCornerCreatesLinearTicket() throws {
        let message = "Synthetic feedback " + UUID().uuidString
        let app = try launchApp(); assertInboxLoaded(in: app)
        let corner = app.buttons["feedback.open"]
        XCTAssertTrue(corner.waitForExistence(timeout: 10)); XCTAssertTrue(corner.isHittable)
        attachScreenshot(named: "feedback-persistent-corner")
        corner.tap()
        let submit = app.buttons["feedback.submit"]
        XCTAssertTrue(submit.waitForExistence(timeout: 5)); XCTAssertFalse(submit.isEnabled)
        attachScreenshot(named: "feedback-empty-composer")
        let editor = app.textViews["feedback.message"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5)); editor.tap(); editor.typeText(message)
        let done = app.buttons["feedback.keyboard-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5)); XCTAssertTrue(done.isHittable)
        attachScreenshot(named: "feedback-keyboard-done")
        done.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        app.buttons["feedback.close"].tap()
        for tab in ["Drafts", "Settings"] {
            app.tabBars.buttons[tab].tap()
            XCTAssertTrue(corner.waitForExistence(timeout: 5)); XCTAssertTrue(corner.isHittable)
            corner.tap()
            XCTAssertTrue(editor.waitForExistence(timeout: 5)); XCTAssertEqual(editor.value as? String, message)
            if tab == "Drafts" { app.buttons["feedback.close"].tap() }
        }
        let photos = app.buttons["feedback.photos"]
        XCTAssertTrue(photos.waitForExistence(timeout: 5))
        for _ in 0..<4 where !photos.isHittable { app.swipeUp() }
        XCTAssertTrue(photos.isHittable); photos.tap()
        let importDay = try XCTUnwrap(ProcessInfo.processInfo.environment["ORCA_FIXTURE_MEDIA_DAY"])
        let escapedDay = NSRegularExpression.escapedPattern(for: importDay)
        // The hosted picker exposes media as images, not collection cells.
        // Current-year Photos labels omit the year. Require the injected month/day
        // followed immediately by time, excluding older stock photos with a year.
        let photoQuery = app.images.matching(NSPredicate(format: "identifier == %@ AND label MATCHES %@",
                                                        "PXGGridLayout-Info", "Photo, \(escapedDay), [0-9]{1,2}:.*"))
        // Photos may finish indexing without exposing a Loading... node. Requery
        // the exact fixture asset throughout the existing readiness budget;
        // never retain an early false result after a later picker snapshot.
        let photoReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            photoQuery.count == 1
        }, object: nil)
        let photoWait = XCTWaiter.wait(for: [photoReady], timeout: 60)
        attachScreenshot(named: "feedback-system-picker-before-selection")
        let photoCount = photoQuery.count
        if feedbackFixtureDiagnosticsAllowed() {
            print("[feedback picker readiness] expected_day=\(importDay) result=\(photoWait.rawValue) exact_photo_count=\(photoCount)")
        }
        guard photoWait == .completed, photoCount == 1, photoQuery.firstMatch.exists else {
            logFeedbackPicker(in: app)
            XCTFail("System picker must expose exactly one photo imported for this fixture day")
            return
        }
        // Only dismiss the observed system privacy banner, never Orca's Close.
        for _ in 0..<2 {
            guard app.images.matching(identifier: "PickerOnboardingHeaderViewIcon").firstMatch.exists else { break }
            let bannerClose = app.buttons.matching(NSPredicate(format: "identifier == '' AND label == 'Close'")).firstMatch
            guard bannerClose.exists, bannerClose.isHittable else { break }
            bannerClose.tap()
        }
        attachScreenshot(named: "feedback-system-picker-banner-dismissed")
        guard tapFeedbackPickerAsset(photoQuery.firstMatch, in: app) else { return }
        // The committed recording can predate the generated photo across midnight.
        // Require the owned simulator's unique video, then verify its exact SHA below.
        let videoQuery = app.images.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@",
                                                        "PXGGridLayout-Info", "Video, "))
        guard videoQuery.firstMatch.waitForExistence(timeout: 10), videoQuery.count == 1 else {
            logFeedbackPicker(in: app)
            XCTFail("System picker must expose exactly one fixture recording")
            return
        }
        guard tapFeedbackPickerAsset(videoQuery.firstMatch, in: app) else { return }
        attachScreenshot(named: "feedback-system-picker-selected-media")
        if feedbackFixtureDiagnosticsAllowed() {
            // System image nodes may not expose selection reliably; these are
            // observations only and never replace the two-preview assertion.
            let photo = photoQuery.firstMatch, video = videoQuery.firstMatch
            let photoExists = photo.exists, videoExists = video.exists
            print("[feedback picker selection] photo_exists=\(photoExists) photo_selected=\(photoExists && photo.isSelected) video_exists=\(videoExists) video_selected=\(videoExists && video.isSelected)")
        }
        logFeedbackPicker(in: app)
        let finishSelection = app.buttons["Done"]
        XCTAssertTrue(finishSelection.waitForExistence(timeout: 5))
        XCTAssertTrue(finishSelection.isEnabled); finishSelection.tap()
        let previews = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "feedback.preview."))
        let previewsReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 2"), object: previews)
        let previewWait = XCTWaiter.wait(for: [previewsReady], timeout: 10)
        if previewWait != .completed { logFeedbackImportState(in: app, previews: previews) }
        XCTAssertEqual(previewWait, .completed, "Expected two selected media previews within 10 seconds")
        XCTAssertEqual(previews.count, 2); XCTAssertFalse(submit.isEnabled)
        for (index, identifier) in previews.allElementsBoundByIndex.map({ $0.identifier }).enumerated() {
            let preview = app.buttons[identifier]
            for _ in 0..<4 where !preview.isHittable { app.swipeUp() }
            XCTAssertTrue(preview.isHittable); preview.tap()
            let approve = app.buttons["feedback.media-reviewed"]
            XCTAssertTrue(approve.waitForExistence(timeout: 5))
            expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: approve)
            waitForExpectations(timeout: 10)
            attachScreenshot(named: "feedback-selected-media-review-\(index)")
            approve.tap()
            if index == 0 { XCTAssertFalse(submit.isEnabled, "Every selected file needs explicit review") }
        }
        for _ in 0..<4 where !submit.isHittable { app.swipeUp() }
        XCTAssertTrue(submit.isHittable); XCTAssertTrue(submit.isEnabled)
        attachScreenshot(named: "feedback-ready-to-send")
        _ = try composeFixtureRequest("__fixture/feedback/fail-once", method: "POST", body: [:])
        submit.tap()
        XCTAssertTrue(app.staticTexts["feedback.error"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.descendants(matching: .any)["feedback.confirmation"].exists)
        XCTAssertEqual(editor.value as? String, message); XCTAssertFalse(editor.isEnabled)
        XCTAssertEqual(submit.label, "Retry submission")
        let firstState = try composeFixtureRequest("__fixture/feedback/state")
        let firstTicket = try XCTUnwrap((firstState["tickets"] as? [[String: Any]])?.first { $0["message"] as? String == message })
        let firstAttachments = try XCTUnwrap(firstTicket["attachments"] as? [[String: Any]])
        XCTAssertEqual(firstAttachments.count, 2)
        let preparedPairs = try firstAttachments.map {
            (try XCTUnwrap($0["mimeType"] as? String), try XCTUnwrap($0["sha256"] as? String))
        }
        let preparedDigests = Dictionary(preparedPairs, uniquingKeysWith: { first, _ in first })
        XCTAssertEqual(Set(preparedDigests.keys), Set(["image/png", "video/mp4"]))
        XCTAssertEqual(preparedDigests["video/mp4"], "0a901c954fd7f21eeab6c48c2ac77e74368df72f9d2a061e88a1a462b1b376d4")
        let preparedImage = try XCTUnwrap(firstAttachments.first { $0["mimeType"] as? String == "image/png" })
        XCTAssertEqual(preparedImage["imageWidth"] as? Int, 32)
        XCTAssertEqual(preparedImage["imageHeight"] as? Int, 32)
        XCTAssertTrue(preparedDigests.values.allSatisfy { $0.count == 64 })
        attachScreenshot(named: "feedback-uncertain-retry")
        for _ in 0..<4 where !submit.isHittable { app.swipeUp() }
        XCTAssertTrue(submit.isHittable); submit.tap()
        XCTAssertTrue(app.descendants(matching: .any)["feedback.confirmation"].waitForExistence(timeout: 10))
        let state = try composeFixtureRequest("__fixture/feedback/state")
        let matching = (state["tickets"] as? [[String: Any]] ?? []).filter { $0["message"] as? String == message }
        XCTAssertEqual(matching.count, 1, "Retry after a lost receipt must recover the same Linear ticket")
        let ticket = try XCTUnwrap(matching.first)
        XCTAssertEqual(ticket["platform"] as? String, "ios")
        let attachments = try XCTUnwrap(ticket["attachments"] as? [[String: Any]])
        XCTAssertEqual(attachments.count, 2)
        let confirmedPairs = try attachments.map {
            XCTAssertGreaterThan(try XCTUnwrap($0["size"] as? Int), 0)
            return (try XCTUnwrap($0["mimeType"] as? String), try XCTUnwrap($0["sha256"] as? String))
        }
        let confirmedDigests = Dictionary(confirmedPairs, uniquingKeysWith: { first, _ in first })
        XCTAssertEqual(confirmedDigests, preparedDigests)
        let identifier = try XCTUnwrap(ticket["identifier"] as? String)
        let link = app.descendants(matching: .any)["feedback.ticket-link"].firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 5)); XCTAssertTrue(link.label.contains(identifier))
        attachScreenshot(named: "feedback-linear-confirmed")
        app.buttons["feedback.close"].tap(); corner.tap()
        XCTAssertTrue(app.descendants(matching: .any)["feedback.confirmation"].waitForExistence(timeout: 5))
        print("[feedback-fixture] PASS: persistent corner on three tabs, draft reopen, keyboard Done, ambiguous retry, one confirmed synthetic Linear ticket")
    }

    /// Actual UIKit capture of the synthetic fixture app; no Photos import.
    func test39FeedbackCapturesCurrentOrcaScreen() throws {
        let app = try launchApp(); assertInboxLoaded(in: app)
        let message = "Synthetic current-screen feedback " + UUID().uuidString
        app.buttons["feedback.open"].tap()
        let editor = app.textViews["feedback.message"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5)); editor.tap(); editor.typeText(message)
        app.buttons["feedback.keyboard-done"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        let screenshot = app.buttons["feedback.capture-screenshot"]
        XCTAssertTrue(screenshot.waitForExistence(timeout: 5)); XCTAssertTrue(screenshot.isHittable)
        attachScreenshot(named: "feedback-current-screen-capture-controls")
        screenshot.tap()
        let previews = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "feedback.preview."))
        expectation(for: NSPredicate(format: "count == 1"), evaluatedWith: previews)
        waitForExpectations(timeout: 10)
        let submit = app.buttons["feedback.submit"]
        XCTAssertFalse(submit.isEnabled, "Captured screen requires explicit review")
        let preview = previews.firstMatch
        for _ in 0..<4 where !preview.isHittable { app.swipeUp() }
        XCTAssertTrue(preview.isHittable); preview.tap()
        let review = app.buttons["feedback.media-reviewed"]
        XCTAssertTrue(review.waitForExistence(timeout: 5)); XCTAssertTrue(review.isEnabled)
        attachScreenshot(named: "feedback-current-orca-screen-review")
        review.tap()
        for _ in 0..<4 where !submit.isHittable { app.swipeUp() }
        XCTAssertTrue(submit.isHittable); XCTAssertTrue(submit.isEnabled); submit.tap()
        XCTAssertTrue(app.descendants(matching: .any)["feedback.confirmation"].waitForExistence(timeout: 10))
        let ledger = try composeFixtureRequest("__fixture/feedback/state")
        let tickets = (ledger["tickets"] as? [[String: Any]] ?? []).filter { $0["message"] as? String == message }
        XCTAssertEqual(tickets.count, 1)
        let attachments = try XCTUnwrap(tickets.first?["attachments"] as? [[String: Any]])
        XCTAssertEqual(attachments.count, 1)
        let image = try XCTUnwrap(attachments.first)
        XCTAssertEqual(image["mimeType"] as? String, "image/png")
        XCTAssertGreaterThan(try XCTUnwrap(image["imageWidth"] as? Int), 300)
        XCTAssertGreaterThan(try XCTUnwrap(image["imageHeight"] as? Int), 500)
        XCTAssertLessThanOrEqual(try XCTUnwrap(image["size"] as? Int), 10 * 1_024 * 1_024)
        attachScreenshot(named: "feedback-current-screen-confirmed")
        print("[feedback-fixture] PASS: current Orca screen captured, explicitly reviewed, confirmed synthetic ticket")
    }

    private func tapFeedbackPickerAsset(_ asset: XCUIElement, in app: XCUIApplication) -> Bool {
        // PXGGridLayout-Info is the picker’s descriptive image accessibility
        // node; XCTest cannot derive its hit point. Tap the uniquely identified
        // visible media tile’s center, constrained to the actual picker bounds.
        let picker = app.scrollViews["photosView_content_scroll_view"]
        guard asset.exists, picker.exists else {
            XCTFail("Selected fixture asset and system picker must exist")
            return false
        }
        let frame = asset.frame, pickerFrame = picker.frame, appFrame = app.frame
        let coordinates = [frame.minX, frame.minY, frame.width, frame.height,
                           pickerFrame.minX, pickerFrame.minY, pickerFrame.width, pickerFrame.height,
                           appFrame.minX, appFrame.minY, appFrame.width, appFrame.height]
        guard coordinates.allSatisfy({ $0.isFinite }), frame.width > 0, frame.height > 0,
              pickerFrame.width > 0, pickerFrame.height > 0, appFrame.width > 0, appFrame.height > 0,
              pickerFrame.contains(frame), appFrame.contains(frame) else {
            XCTFail("Fixture media must be fully visible inside the system picker before tapping")
            return false
        }
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: frame.midX - appFrame.minX, dy: frame.midY - appFrame.minY)).tap()
        return true
    }

    private func feedbackFixtureDiagnosticsAllowed() -> Bool {
        guard let raw = ProcessInfo.processInfo.environment["ORCA_FIXTURE_API_URL"],
              let url = URL(string: raw), url.scheme == "http" else { return false }
        return ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")
    }

    private func logFeedbackImportState(in app: XCUIApplication, previews: XCUIElementQuery) {
        guard feedbackFixtureDiagnosticsAllowed() else { return }
        // Counts and fixed UI state only: do not print feedback or media labels.
        let importing = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Adding selected files…")).count
        let photos = app.buttons["feedback.photos"]
        let submit = app.buttons["feedback.submit"]
        print("[feedback import] preview_count=\(previews.count) importing_nodes=\(importing) error_exists=\(app.staticTexts["feedback.error"].exists) composer_exists=\(app.descendants(matching: .any)["feedback.composer"].exists) photos_exists=\(photos.exists) photos_enabled=\(photos.exists && photos.isEnabled) submit_exists=\(submit.exists) submit_enabled=\(submit.exists && submit.isEnabled) picker_done_exists=\(app.buttons["Done"].exists)")
    }

    private func logFeedbackPicker(in app: XCUIApplication) {
        // Diagnostics only run against the explicitly supplied loopback fixture.
        guard feedbackFixtureDiagnosticsAllowed() else { return }
        let kinds: [(String, XCUIElement.ElementType)] = [("Button", .button), ("StaticText", .staticText), ("Image", .image), ("Cell", .cell),
                                                          ("CollectionView", .collectionView), ("ScrollView", .scrollView), ("Sheet", .sheet), ("Other", .other)]
        var remaining = 40
        var remainingBytes = 8_000
        func emit(_ line: String) {
            guard line.utf8.count <= remainingBytes else { return }
            remainingBytes -= line.utf8.count
            print(line)
        }
        func bounded(_ value: String) -> String {
            // Only synthetic fixture/system UI is inspected; never print a
            // fixture credential even if an accessibility label contains it.
            var text = value
            if let token = ProcessInfo.processInfo.environment["ORCA_FIXTURE_ACCESS_TOKEN"], !token.isEmpty {
                text = text.replacingOccurrences(of: token, with: "[REDACTED]")
            }
            text = text.replacingOccurrences(of: #"(?i)Bearer\s+[^\s]+|orca_session=[^;\s]+"#,
                                            with: "[REDACTED]", options: .regularExpression)
            text = text.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }.joined()
            return String(text.replacingOccurrences(of: "::", with: ": :").replacingOccurrences(of: "##[", with: "# #[").prefix(160))
        }
        do {
            // One immutable accessibility snapshot avoids stale live indices as
            // the remote system picker changes its accessibility hierarchy.
            let root = try app.snapshot()
            var snapshots: [XCUIElementSnapshot] = []
            var pending = [root]
            while let item = pending.popLast(), snapshots.count < 500 {
                snapshots.append(item)
                pending.append(contentsOf: item.children.reversed())
            }
            emit("[feedback picker] snapshot_nodes=\(snapshots.count) truncated=\(!pending.isEmpty) app_state=\(app.state.rawValue)")
            for (name, kind) in kinds {
                var matches = snapshots.filter { $0.elementType == kind }
                if kind == .image {
                    matches.sort { ($0.identifier == "PXGGridLayout-Info" ? 0 : 1) < ($1.identifier == "PXGGridLayout-Info" ? 0 : 1) }
                }
                emit("[feedback picker] kind=\(name) count=\(matches.count)")
                for element in matches.prefix(min(remaining, kind == .image ? 16 : 8)) {
                    emit("[feedback picker] kind=\(name) label=\(bounded(element.label)) identifier=\(bounded(element.identifier))")
                    remaining -= 1
                }
            }
        } catch {
            emit("[feedback picker] snapshot unavailable")
        }
    }

    func test20EmptyInboxCanRefreshIntoMail() throws {
        _ = try composeFixtureRequest("__fixture/inbox-recovery/empty-once", method: "POST", body: [:])
        addTeardownBlock { _ = try self.composeFixtureRequest("__fixture/inbox-recovery/reset", method: "POST", body: [:]) }
        let app = try launchApp()
        XCTAssertTrue(app.staticTexts["No matching mail"].waitForExistence(timeout: 20))
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
        boundaryDiagnostics = true
        try setFixtureSending(false)
        addTeardownBlock { try self.restoreFixtureSending() }
        let app = try launchApp(); assertInboxLoaded(in: app)
        app.buttons["compose.open"].tap()
        let recipient = app.textFields["compose.to"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 10))
        recipient.tap(); recipient.typeText("maya@example.com")
        let body = messageBody(in: app); focusComposeBody(in: app); body.typeText("Keep these words while access changes.")
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
        assertFeedbackClear(of: [refresh, status, app.buttons["compose.send"]], in: app, checkpoint: "permission-retry")
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
        assertFeedbackClear(of: [check, status], in: app, checkpoint: "uncertain-delivery-check")
        _ = try composeFixtureRequest("__fixture/compose/delivery", method: "POST", body: ["draftId": id, "status": "sent"])
        check.tap()
        XCTAssertTrue(app.navigationBars["Drafts"].waitForExistence(timeout: 10))
        XCTAssertFalse(row.exists)
        let after = try composeFixtureRequest("__fixture/compose/state")
        XCTAssertEqual(after["sendRequests"] as? Int, before["sendRequests"] as? Int, "Checking a server-origin draft must never POST a delivery command")
        XCTAssertEqual(after["deliveries"] as? Int, before["deliveries"] as? Int)
    }

    func test16AttachmentRemovalPersistsAndOnlyRemainingFileIsSent() throws {
        boundaryDiagnostics = true
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
        let removedAfterTap = remove.waitForNonExistence(timeout: 5)
        XCTAssertTrue(removedAfterTap)
        let keep = app.buttons["compose.attachment.remove.keep"]
        revealComposeControl(keep, in: app, scrollUp: true)
        XCTAssertTrue(keep.exists)
        attachScreenshot(named: "33-compose-attachment-removed")
        assertFeedbackClear(of: [app.buttons["compose.attachment.remove.keep"], app.buttons["compose.send"]],
                            in: app, checkpoint: "attachment-removed")
        navigateBack(in: app)
        let localRow = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "draft.", subject)).firstMatch
        XCTAssertTrue(localRow.waitForExistence(timeout: 10)); localRow.tap()
        revealComposeControl(keep, in: app, scrollUp: true)
        XCTAssertFalse(app.buttons["compose.attachment.remove.remove"].exists)
        XCTAssertTrue(app.buttons["compose.attachment.remove.keep"].exists)
        let send = app.buttons["compose.send"]; XCTAssertTrue(send.isEnabled); send.tap()
        XCTAssertTrue(app.navigationBars["Drafts"].waitForExistence(timeout: 15))
        let sent = try composeFixtureRequest("v1/drafts/\(id)?accountId=ios-fixture-account")
        XCTAssertEqual(sent["deliveryStatus"] as? String, "sent")
        XCTAssertEqual((sent["attachments"] as? [[String: Any]])?.compactMap { $0["id"] as? String }, ["keep"])
    }

    func test17ForegroundRefreshUnlocksSendingWithoutRelaunch() throws {
        boundaryDiagnostics = true
        try setFixtureSending(false)
        addTeardownBlock { try self.restoreFixtureSending() }
        let app = try launchApp(); assertInboxLoaded(in: app)
        app.buttons["compose.open"].tap()
        let recipient = app.textFields["compose.to"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 10))
        recipient.tap(); recipient.typeText("maya@example.com")
        let body = messageBody(in: app); focusComposeBody(in: app); body.typeText("Words survive a trip to the browser.")
        XCTAssertFalse(app.buttons["compose.send"].isEnabled)
        XCUIDevice.shared.press(.home)
        try setFixtureSending(true)
        app.activate()
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: app.buttons["compose.send"])
        waitForExpectations(timeout: 10)
        XCTAssertEqual(body.value as? String, "Words survive a trip to the browser.")
        attachScreenshot(named: "34-compose-foreground-upgraded")
        assertFeedbackClear(of: [app.buttons["compose.send"], app.descendants(matching: .any)["compose.save-status"]],
                            in: app, checkpoint: "writer-foreground")
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
        dismissTypingIntroduction(in: app)
        let latestWriting = try XCTUnwrap(body.value as? String)
        XCTAssertTrue(latestWriting.contains("Latest words before keeping both."))
        keepBoth.tap()
        let status = app.descendants(matching: .any)["compose.save-status"]
        expectation(for: NSPredicate(format: "label CONTAINS %@", "Both drafts kept"), evaluatedWith: status)
        waitForExpectations(timeout: 10)
        dismissTypingIntroduction(in: app)
        attachScreenshot(named: "35-compose-conflict-copy-checkpoint")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "Reproduce the recovered copy with its writing keyboard still visible")
        assertFeedbackClear(of: [app.buttons["compose.send"], status], in: app, checkpoint: "conflict-copy-keyboard")
        // A separate real interaction checks Feedback's target. Geometry above
        // is required even when XCTest calls a partly covered Send hittable.
        app.buttons["feedback.open"].tap()
        XCTAssertTrue(app.textViews["feedback.message"].waitForExistence(timeout: 5))
        app.buttons["feedback.close"].tap()
        XCTAssertEqual(body.value as? String, latestWriting, "Opening support must preserve the recovered writing")
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
        assertFeedbackClear(of: [reopened.buttons["compose.send"], reopened.descendants(matching: .any)["compose.save-status"]],
                            in: reopened, checkpoint: "conflict-copy-reopened")
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
        print("[bre-459] checkpoint=conflict-copy-delivered send_requests_delta=\(try XCTUnwrap(after["sendRequests"] as? Int) - XCTUnwrap(before["sendRequests"] as? Int)) deliveries_delta=\(try XCTUnwrap(after["deliveries"] as? Int) - XCTUnwrap(before["deliveries"] as? Int))")
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
        // Earlier journeys leave local drafts above the lazy server section.
        revealDraftRow(serverRow, in: app)
        XCTAssertTrue(serverRow.waitForExistence(timeout: 10)); serverRow.tap()
        XCTAssertTrue(messageBody(in: app).waitForExistence(timeout: 5))
        navigateBack(in: app)
        // A UUID local row distinct from the server row proves the production
        // autosave finished before the remote delivery transition.
        let localCopy = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier != %@ AND label CONTAINS %@", "draft.", "draft.\(id)", subject)).firstMatch
        revealDraftRow(localCopy, in: app)
        XCTAssertTrue(localCopy.waitForExistence(timeout: 10))
        _ = try composeFixtureRequest("__fixture/compose/delivery", method: "POST", body: ["draftId": id, "status": "sent"])
        let marker = try createComposeFixtureDraft(subject: "Reload marker " + UUID().uuidString)
        let markerID = try XCTUnwrap(marker["id"] as? String)
        addTeardownBlock { _ = try self.composeFixtureRequest("v1/drafts/\(markerID)?accountId=ios-fixture-account", method: "DELETE") }
        // Re-enter the tab to run the production onAppear load reliably; a
        // short swipe may merely scroll and never cross refresh's threshold.
        app.tabBars.buttons["Mail"].tap()
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
        boundaryDiagnostics = true
        try exerciseSentLocalEditsRecovery(contentSize: "UICTContentSizeCategoryAccessibilityXXXL", revealInitialInbox: true)
    }

    private func exerciseSentLocalEditsRecovery(contentSize: String = "UICTContentSizeCategoryL", revealInitialInbox: Bool = false) throws {
        try setFixtureSending(true)
        addTeardownBlock { try self.restoreFixtureSending() }
        let subject = "Sent with local edits " + UUID().uuidString
        let draft = try createComposeFixtureDraft(subject: subject)
        let id = try XCTUnwrap(draft["id"] as? String)
        let app = try launchApp(contentSize: contentSize); assertInboxLoaded(in: app, boundedListReveal: revealInitialInbox)
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
        app.tabBars.buttons["Mail"].tap(); app.tabBars.buttons["Drafts"].tap()
        let preserved = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@ AND label CONTAINS[c] %@", "draft.", subject, "Sent elsewhere")).firstMatch
        revealDraftRow(preserved, in: app); preserved.tap()
        XCTAssertTrue(app.scrollViews["compose.form"].waitForExistence(timeout: 10))
        revealComposeBody(in: app)
        XCTAssertEqual(messageBody(in: app).value as? String, latestWriting)
        XCTAssertFalse(messageBody(in: app).isEnabled)
        let copy = app.buttons["compose.send"]
        XCTAssertEqual(copy.label, "Edit a new copy")
        let recoveryStatus = app.descendants(matching: .any)["compose.save-status"]
        XCTAssertEqual(recoveryStatus.label, "Sent elsewhere. Your local edits are preserved; edit a new copy to continue.")
        XCTAssertTrue(recoveryStatus.isHittable)
        XCTAssertTrue(copy.isHittable)
        attachScreenshot(named: "42-compose-sent-local-edits-preserved")
        assertFeedbackClear(of: [copy, recoveryStatus], in: app, checkpoint: "sent-recovery-\(contentSize.contains("Accessibility") ? "accessibility" : "standard")")
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
        boundaryDiagnostics = true
        try exerciseRichDraftConversion(confirm: false, contentSize: "UICTContentSizeCategoryAccessibilityXXXL", revealInitialInbox: true)
    }

    private func exerciseRichDraftConversion(confirm: Bool, contentSize: String = "UICTContentSizeCategoryL", revealInitialInbox: Bool = false) throws {
        try setFixtureSending(true)
        addTeardownBlock { try self.restoreFixtureSending() }
        let subject = "Rich conversion " + UUID().uuidString
        var savedSubject = subject
        let richText = "Keep this link"
        let richHTML = "<p>Keep <a href=\"https://example.com/notes\">this link</a></p>"
        let draft = try createComposeFixtureDraft(subject: subject, message: ["text": richText, "html": richHTML])
        // The server canonicalizes HTML on create. The composer must preserve
        // the exact rich body it receives, including canonical link safeguards.
        let canonicalHTML = try XCTUnwrap((draft["body"] as? [String: Any])?["html"] as? String)
        XCTAssertTrue(canonicalHTML.contains("href=\"https://example.com/notes\""))
        XCTAssertTrue(canonicalHTML.contains("target=\"_blank\""))
        XCTAssertTrue(canonicalHTML.contains("rel=\"noopener noreferrer\""))
        let id = try XCTUnwrap(draft["id"] as? String)
        let app = try launchApp(contentSize: contentSize); assertInboxLoaded(in: app, boundedListReveal: revealInitialInbox)
        app.tabBars.buttons["Drafts"].tap()
        let row = app.descendants(matching: .any)["draft.\(id)"]
        if contentSize.contains("Accessibility") { attachScreenshot(named: "48-compose-large-draft-list-before-locating") }
        revealDraftRow(row, in: app)
        if contentSize.contains("Accessibility") { attachScreenshot(named: "49-compose-large-draft-row-visible") }
        row.tap()
        XCTAssertTrue(app.scrollViews["compose.form"].waitForExistence(timeout: 10))
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
            savedSubject = try XCTUnwrap(title.value as? String)
            XCTAssertTrue(savedSubject.contains("reviewed"))
            // Use an initially empty recipient field: tapping an existing To
            // address can place the caret in its middle at large text sizes.
            let disclosure = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Cc and Bcc")).firstMatch
            revealComposeControl(disclosure, in: app, scrollUp: false)
            disclosure.tap()
            let cc = app.textFields["compose.cc"]
            revealComposeControl(cc, in: app, scrollUp: false)
            cc.tap(); cc.typeText("friend@example.com")
            XCTAssertEqual(cc.value as? String, "friend@example.com")
        }
        let expectedText = confirm ? try XCTUnwrap(body.value as? String) : richText
        navigateBack(in: app)
        let localRow = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "draft.", savedSubject)).firstMatch
        revealDraftRow(localRow, in: app)
        let localRowID = localRow.identifier
        XCTAssertTrue(localRowID.hasPrefix("draft."))
        app.terminate()
        let reopened = try launchApp(contentSize: contentSize); assertInboxLoaded(in: reopened)
        reopened.tabBars.buttons["Drafts"].tap()
        let savedRow = reopened.descendants(matching: .any)[localRowID]
        revealDraftRow(savedRow, in: reopened); savedRow.tap()
        XCTAssertTrue(reopened.scrollViews["compose.form"].waitForExistence(timeout: 10))
        XCTAssertEqual(reopened.textFields["compose.subject"].value as? String, savedSubject)
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
        assertFeedbackClear(of: [reopened.buttons["compose.send"], reopened.descendants(matching: .any)["compose.save-status"]],
                            in: reopened, checkpoint: "rich-recovery-\(contentSize.contains("Accessibility") ? "accessibility" : "standard")")
        let send = reopened.buttons["compose.send"]
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: send)
        waitForExpectations(timeout: 10); send.tap()
        XCTAssertTrue(reopened.navigationBars["Drafts"].waitForExistence(timeout: 15))
        let sent = try composeFixtureRequest("v1/drafts/\(id)?accountId=ios-fixture-account")
        XCTAssertEqual(sent["deliveryStatus"] as? String, "sent")
        XCTAssertEqual(sent["subject"] as? String, savedSubject)
        if !confirm { XCTAssertEqual((sent["cc"] as? [[String: Any]])?.compactMap { $0["email"] as? String }, ["friend@example.com"]) }
        let sentBody = try XCTUnwrap(sent["body"] as? [String: Any])
        XCTAssertEqual(sentBody["text"] as? String, sentText)
        if confirm { XCTAssertTrue(sentBody["html"] is NSNull, "Only confirmed conversion may strip the original HTML") }
        else { XCTAssertEqual(sentBody["html"] as? String, canonicalHTML, "Cancel, backgrounding, subject edits, autosave, and reopen must preserve exact HTML") }
    }

    private func revealComposeControl(_ control: XCUIElement, in app: XCUIApplication, scrollUp: Bool,
                                      file: StaticString = #filePath, line: UInt = #line) {
        let form = app.scrollViews["compose.form"]
        let originalFormFound = form.waitForExistence(timeout: 10)
        if !originalFormFound { captureComposeBoundary(in: app, stage: "original-form-wait-failed", observed: ["original_10s_result": "false"]) }
        XCTAssertTrue(originalFormFound, file: file, line: line)
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

    private func focusComposeBody(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        if boundaryDiagnostics && feedbackFixtureDiagnosticsAllowed() && !boundaryFailureCaptureRegistered {
            boundaryFailureCaptureRegistered = true
            // Capture only after the original test has failed. Observing AX or
            // taking a PNG between tap() and the caller's typeText() could give
            // delayed focus time to recover and hide the original boundary.
            addTeardownBlock { [weak self] in
                guard let self, (self.testRun?.totalFailureCount ?? 0) > 0 else { return }
                self.captureComposeBoundary(in: app, stage: "after-original-test-failure")
            }
        }
        let body = messageBody(in: app)
        let form = app.scrollViews["compose.form"]
        let status = app.descendants(matching: .any)["compose.save-status"]
        let originalFormFound = form.waitForExistence(timeout: 10)
        if !originalFormFound { captureComposeBoundary(in: app, stage: "original-form-wait-failed", observed: ["original_10s_result": "false"]) }
        XCTAssertTrue(originalFormFound, file: file, line: line)
        for _ in 0..<12 {
            let fixed = [status, app.descendants(matching: .any)["compose.send-permission"], app.buttons["compose.refresh-permission"],
                         app.staticTexts["Account defaults could not be loaded. Your writing is kept; add a signature if needed."]]
                .filter(\.exists).map(\.frame)
            guard let viewport = ViewportGeometry.content(form: form.frame, application: app.frame, navigation: app.navigationBars.firstMatch.frame, fixed: fixed) else { break }
            let visible = body.exists ? body.frame.intersection(viewport) : .null
            if boundaryDiagnostics && feedbackFixtureDiagnosticsAllowed() { print("[native-writing-area] viewport=\(viewport) intersection=\(visible)") }
            if body.exists && body.isHittable, let visible = ViewportGeometry.writingArea(body: body.frame, viewport: viewport) {
                // TextEditor is taller than the keyboard-reduced viewport.
                // XCTest's default center may be behind the fixed footer;
                // tap its actual visible writing area, as a user does.
                let offset = CGVector(dx: (visible.midX - body.frame.minX) / body.frame.width,
                                      dy: (visible.midY - body.frame.minY) / body.frame.height)
                if boundaryDiagnostics && feedbackFixtureDiagnosticsAllowed() {
                    print("[native-writing-tap] viewport=\(viewport) body=\(body.frame) intersection=\(visible) normalized=\(offset) absolute_x=\(visible.midX) absolute_y=\(visible.midY)")
                }
                body.coordinate(withNormalizedOffset: offset).tap()
                return
            }
            let up = !body.exists || body.frame.minY >= viewport.minY
            guard let pan = ViewportGeometry.pan(in: viewport, up: up) else { break }
            panContent(pan, in: form)
        }
        captureComposeBoundary(in: app, stage: "original-writing-area-attempts-exhausted")
        attachScreenshot(named: "bre-459-writing-area-unreachable")
        XCTFail("Message body needs a visible 44pt writing area above the fixed actions", file: file, line: line)
    }

    private func revealComposeBody(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let form = app.scrollViews["compose.form"]
        let originalFormFound = form.waitForExistence(timeout: 10)
        if !originalFormFound { captureComposeBoundary(in: app, stage: "original-form-wait-failed", observed: ["original_10s_result": "false"]) }
        XCTAssertTrue(originalFormFound, file: file, line: line)
        for _ in 0..<12 {
            if messageBody(in: app).exists { return }
            let start = form.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.75))
            let end = form.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.25))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        attachScreenshot(named: "53-compose-body-not-revealed")
        XCTAssertTrue(messageBody(in: app).waitForExistence(timeout: 5), file: file, line: line)
    }

    private func revealDraftRow(_ row: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let list = app.descendants(matching: .any)["drafts.list"]
        XCTAssertTrue(list.waitForExistence(timeout: 10), file: file, line: line)
        func isFullyVisible() -> Bool {
            guard row.exists, row.isHittable else { return false }
            let top = max(list.frame.minY, app.navigationBars.firstMatch.frame.maxY) + 8
            let bottom = min(list.frame.maxY, app.tabBars.firstMatch.frame.minY) - 8
            return row.frame.minY >= top && row.frame.maxY <= bottom
        }
        _ = row.waitForExistence(timeout: 2)
        for attempt in 0..<32 {
            if isFullyVisible() { return }
            var up = attempt < 16
            if row.exists && !row.frame.isEmpty {
                let bottom = min(list.frame.maxY, app.tabBars.firstMatch.frame.minY) - 8
                up = row.frame.maxY > bottom
            }
            // Smaller list drags avoid skipping a tall accessibility-sized row.
            let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: up ? 0.65 : 0.35))
            let end = list.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: up ? 0.35 : 0.65))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        attachScreenshot(named: "54-draft-row-not-fully-visible")
        print("DRAFT_ROW_LOOKUP expected=\(row.debugDescription)")
        XCTAssertTrue(isFullyVisible(), "Expected full draft row above the tab bar before tapping", file: file, line: line)
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
        // Only the fixed route, method and timing/error code are diagnostic.
        // Never print the request, URL query, headers, body or credentials.
        let diagnosticPath = url.path
        let started = ProcessInfo.processInfo.systemUptime
        print("[compose-fixture-transport] event=start method=\(method) path=\(diagnosticPath) epoch_ms=\(Int64(Date().timeIntervalSince1970 * 1_000))")
        let completed = expectation(description: "Compose fixture \(path)")
        var output: [String: Any] = [:]
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            let failure = error as NSError?
            print("[compose-fixture-transport] event=end method=\(method) path=\(diagnosticPath) epoch_ms=\(Int64(Date().timeIntervalSince1970 * 1_000)) elapsed_ms=\(Int64((ProcessInfo.processInfo.systemUptime - started) * 1_000)) status=\((response as? HTTPURLResponse)?.statusCode ?? 0) error_code=\(failure?.code ?? 0)")
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
        let search = app.searchFields["Search All Mail"]
        let title = app.staticTexts["mail.list-heading"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        XCTAssertTrue(search.isHittable)
        XCTAssertTrue(picker.isHittable)
        XCTAssertTrue(settings.isHittable)
        let initialPickerY = picker.frame.minY
        let initialTitleY = title.frame.minY

        try refreshFixture("arm", method: "POST", scenario: "controls")
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
        XCTAssertTrue(app.tabBars.buttons["Mail"].isHittable)
        XCTAssertTrue(app.tabBars.buttons["Drafts"].isHittable)
        XCTAssertTrue(app.tabBars.buttons["Settings"].isHittable)
        XCTAssertEqual(picker.frame.minY, initialPickerY, accuracy: 2)
        XCTAssertGreaterThanOrEqual(picker.frame.minY, search.frame.maxY)
        XCTAssertGreaterThanOrEqual(list.frame.minY, max(picker.frame.maxY, settings.frame.maxY))

        // Check actual interaction as well as accessibility hit testing.
        picker.tap()
        XCTAssertTrue(app.buttons["mailbox.option.all"].waitForExistence(timeout: 3))
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

    private func refreshFixture(_ action: String, method: String, scenario: String? = nil) throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["ORCA_FIXTURE_API_URL"], let url = URL(string: base),
              ["127.0.0.1", "localhost"].contains(url.host ?? ""),
              let token = environment["ORCA_FIXTURE_ACCESS_TOKEN"] else {
            throw TestConfigurationError.missingFixtureEnvironment
        }
        var endpoint = url.appendingPathComponent("__fixture/inbox-refresh/\(action)")
        if let scenario {
            endpoint.append(queryItems: [URLQueryItem(name: "scenario", value: scenario)])
        }
        var request = URLRequest(url: endpoint)
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
        let title = app.staticTexts["mail.list-heading"]
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
        let restoreOriginal = try registerOwnedRoutingCompensation(thread: "ios-fixture-thread-1")
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
        XCTAssertTrue(app.staticTexts["No matching mail"].waitForExistence(timeout: 10))
        chooseMailbox("Inbox", in: app)
        XCTAssertTrue(maya.waitForExistence(timeout: 10))
        // Restore the original explicit-vs-inherited choice at the exact last
        // UI-owned receipt revision, before View authoring advances workspace.
        try restoreOriginal()

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
        XCTAssertTrue(app.buttons["view-editor.preview"].waitForExistence(timeout: 10))
        app.buttons["view-editor.preview"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["view-editor.preview-row.ios-fixture-thread-1"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["view-editor.save"].waitForExistence(timeout: 10))
        attachScreenshot(named: "14-native-sender-view-preview")
        app.buttons["view-editor.save"].tap()
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
        XCTAssertTrue(app.buttons["view-editor.preview"].waitForExistence(timeout: 10))
        app.buttons["view-editor.preview"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["view-editor.preview-row.ios-fixture-thread-1"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["view-editor.save"].waitForExistence(timeout: 10))
        attachScreenshot(named: "16-native-existing-view-preview")
        app.buttons["view-editor.save"].tap()
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

    private func registerOwnedRoutingCompensation(thread: String) throws -> () throws -> Void {
        guard feedbackFixtureDiagnosticsAllowed(), thread == "ios-fixture-thread-1" else { throw TestConfigurationError.missingFixtureEnvironment }
        let account = "ios-fixture-account", path = "/v1/destinations/routing?accountId=ios-fixture-account&threadId=" + thread
        let original = try composeFixtureRequest(path)
        let originalSelection = try XCTUnwrap(original["selection"] as? [String: Any])
        let explicit = try XCTUnwrap(originalSelection["explicitDestinationId"])
        let revision = try XCTUnwrap(original["revision"] as? Int)
        let baseline = try composeFixtureRequest("/__fixture/routing-receipts?threadId=" + thread)
        let ordinal = try XCTUnwrap(baseline["ordinal"] as? Int)
        let originalSQL = try XCTUnwrap(baseline["sqlite"] as? [String: Any])
        let catalog = try composeFixtureRequest("/v1/destinations"), legacy = try XCTUnwrap(catalog["legacyDestinationIds"] as? [String: Any])
        let scope = RoutingCompensationScope(accountID: account, threadID: thread, revision: revision, explicitID: explicit as? String, ordinal: ordinal,
            allowedDestinationIDs: [try XCTUnwrap(legacy["normal"] as? String), try XCTUnwrap(legacy["focus"] as? String)])
        var done = false
        let compensate: () throws -> Void = {
            guard !done else { return }
            let witness = try self.composeFixtureRequest("/__fixture/routing-receipts?threadId=" + thread)
            XCTAssertEqual(witness["truncated"] as? Bool, false)
            guard witness["truncated"] as? Bool == false else { throw TestConfigurationError.missingFixtureEnvironment }
            let entries = (witness["receipts"] as? [[String: Any]] ?? []).filter { ($0["ordinal"] as? Int ?? 0) > ordinal }
            if entries.isEmpty {
                let unchanged = try self.composeFixtureRequest(path)
                XCTAssertEqual(unchanged["revision"] as? Int, revision, "Missing receipt is safe only when no routing mutation committed")
                guard unchanged["revision"] as? Int == revision else { throw TestConfigurationError.missingFixtureEnvironment }
                done = true; return
            }
            let encodedWitness = try JSONSerialization.data(withJSONObject: witness)
            let plan = try XCTUnwrap(scope.plan(encodedWitness), "Only an exact, complete owned receipt chain can authorize compensation")
            let command = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plan)) as! [String: Any]
            let result = try self.composeFixtureRequest("/v1/destinations/routing?accountId=" + account, method: "PUT", body: command)
            let restoredState = try XCTUnwrap(result["state"] as? [String: Any]), selection = try XCTUnwrap(restoredState["selection"] as? [String: Any])
            XCTAssertEqual(selection["explicitDestinationId"] as? NSObject, explicit as? NSObject)
            let readback = try self.composeFixtureRequest(path), currentSelection = try XCTUnwrap(readback["selection"] as? [String: Any])
            XCTAssertEqual(currentSelection["explicitDestinationId"] as? NSObject, explicit as? NSObject)
            let sql = try self.composeFixtureRequest("/__fixture/routing-receipts?threadId=" + thread), currentSQL = try XCTUnwrap(sql["sqlite"] as? [String: Any])
            // Original fixture has no manual choice. Compare independent raw
            // selected-target SQL, not response-derived membership or a GET CAS.
            XCTAssertEqual(currentSQL["manualOverrideDestinationId"] as? NSObject, (explicit is NSNull ? originalSQL["manualOverrideDestinationId"] : explicit) as? NSObject)
            done = true
        }
        addTeardownBlock { try compensate() }
        return compensate
    }

    private func fixtureMailboxSelection(_ title: String) throws -> String {
        switch title { case "Important": return "important"; case "All Mail": return "all"; case "Inbox": return "normal"; case "Inbox focus": return "focus"; default: break }
        if title == "Focus" {
            let routing = try composeFixtureRequest("/v1/destinations")
            let legacy = try XCTUnwrap(routing["legacyDestinationIds"] as? [String: Any])
            return "destination:" + (try XCTUnwrap(legacy["focus"] as? String))
        }
        let destinations = try composeFixtureRequest("/v1/destinations")
        let spaces = (destinations["destinations"] as? [[String: Any]] ?? []).filter { $0["name"] as? String == title && $0["retiredAt"] is NSNull }
        let catalog = try composeFixtureRequest("/v1/organization/views")
        let views = (catalog["items"] as? [[String: Any]] ?? []).filter { $0["name"] as? String == title }
        let exact = spaces.compactMap { ($0["id"] as? String).map { "destination:" + $0 } } + views.compactMap { ($0["id"] as? String).map { "view:" + $0 } }
        XCTAssertEqual(exact.count, 1, "Fixture title must resolve to one typed server-owned choice, never firstMatch")
        return try XCTUnwrap(exact.count == 1 ? exact[0] : nil)
    }
    private func chooseMailboxID(_ id: String, title: String, in app: XCUIApplication) {
        let picker = app.buttons["inbox.view-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10)); picker.tap()
        let list = app.collectionViews["mailbox.choices"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        let option = list.buttons["mailbox.option." + id]
        for _ in 0..<12 { if option.exists && option.isHittable { break }; list.swipeUp() }
        XCTAssertTrue(option.exists); XCTAssertTrue(option.isHittable)
        option.tap()
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10))
    }
    private func chooseMailbox(_ title: String, in app: XCUIApplication) {
        do { chooseMailboxID(try fixtureMailboxSelection(title), title: title, in: app) }
        catch { XCTFail("Owned fixture mailbox identity unavailable: \(error)") }
    }

    /// Exercises the real fixture API through the same UI a person uses. Keeping this
    /// as one flow makes the draft/send assertions independent of XCTest method order.
    func test01InboxSearchReplyDraftSurvivesReopenAndSendsOnceInLightMode() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        attachScreenshot(named: "01-light-inbox")

        let entryRow = app.descendants(matching: .any)["inbox.message.\(Fixture.inboxMessageID)"]
        XCTAssertTrue(entryRow.isEnabled, "The initial inbox conversation must be enabled")
        XCTAssertTrue(entryRow.isHittable, "The initial inbox conversation must be tappable before its single tap")
        openConversation(subject: Fixture.inboxSubject, in: app)
        XCTAssertTrue(app.staticTexts[Fixture.sender].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "reading view")).firstMatch.waitForExistence(timeout: 10))
        attachScreenshot(named: "02-light-conversation")

        navigateBack(in: app)
        search(for: "Jordan", in: app)
        let searchResult = app.descendants(matching: .any)["inbox.message.\(Fixture.searchResultMessageID)"]
        let searchResultAppeared = searchResult.waitForExistence(timeout: 10)
        if !searchResultAppeared {
            attachScreenshot(named: "03-light-search-missing-result")
            // This suite only launches the isolated synthetic fixture. Keep the
            // failure state in the redacted log when hosted artifacts are unavailable.
            print("[search-fixture] missing-result-ui=\(app.debugDescription.prefix(20000))")
        }
        XCTAssertTrue(searchResultAppeared)
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
        chooseSettingsSection("Notifications", in: app)
        let allowNotifications = app.buttons["settings.allow-notifications"]
        XCTAssertTrue(allowNotifications.exists || app.buttons["Allow notifications"].exists)
        chooseSettingsSection("Privacy & data", in: app)
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
        chooseSettingsSection("Notifications", in: app)
        let inboxNotifications = app.switches["settings.notifications.inbox"]
        XCTAssertTrue(inboxNotifications.waitForExistence(timeout: 10))
        inboxNotifications.tap()
        attachScreenshot(named: "12-settings-selected")
        inboxNotifications.tap()
    }

    /// Run under both actual simulator appearances, not launch-default overrides.
    func test04StyledHTMLUsesReadableCanvas() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let rawURL = environment["ORCA_FIXTURE_API_URL"], let url = URL(string: rawURL),
              url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? "") else {
            throw TestConfigurationError.missingFixtureEnvironment
        }
        let app = try launchApp(htmlDiagnostics: true)
        assertInboxLoaded(in: app)
        openConversation(subject: Fixture.htmlSubject, in: app)
        let foreground = app.staticTexts["Explicit dark foreground stays readable."]
        let background = app.staticTexts["Explicit pale background keeps readable inherited text."]
        let foregroundExists = foreground.waitForExistence(timeout: 10)
        if !foregroundExists { captureStyledHTMLFailure(in: app, stage: "foreground") }
        XCTAssertTrue(foregroundExists)
        let backgroundExists = background.waitForExistence(timeout: 10)
        if !backgroundExists { captureStyledHTMLFailure(in: app, stage: "background") }
        XCTAssertTrue(backgroundExists)
        let foregroundHittable = foreground.isHittable
        if !foregroundHittable { captureStyledHTMLFailure(in: app, stage: "foreground-hittable") }
        XCTAssertTrue(foregroundHittable)
        let backgroundHittable = background.isHittable
        if !backgroundHittable { captureStyledHTMLFailure(in: app, stage: "background-hittable") }
        XCTAssertTrue(backgroundHittable)
        attachScreenshot(named: "13-styled-html-readable")
    }

    private func captureStyledHTMLFailure(in app: XCUIApplication, stage: String) {
        attachScreenshot(named: "13-styled-html-failure-" + stage)
        // Deliberately omit debugDescription, labels and values: they can contain
        // body text and URLs. Preserve only bounded XCTest structure/geometry.
        var lines = ["[styled-html-fixture] stage=\(stage)"]
        func visit(_ element: XCUIElement, depth: Int) {
            guard lines.count < 120, depth < 14 else { return }
            lines.append("depth=\(depth) type=\(element.elementType.rawValue) frame=\(element.frame)")
            for child in element.children(matching: .any).allElementsBoundByIndex.prefix(30) {
                visit(child, depth: depth + 1)
            }
        }
        // Prioritize WebView metadata before a potentially large hierarchy.
        for webView in app.webViews.allElementsBoundByIndex.prefix(4) {
            let identifier = webView.identifier
            if identifier.hasPrefix("fixture-html-state ") {
                lines.append(String(identifier.prefix(300)))
                // Start below the wrapper-depth limit so body structure is
                // represented even in a deeply nested SwiftUI container.
                lines.append("webview-subtree (relative depth starts at 10)")
                visit(webView, depth: 10)
            }
        }
        lines.append("app-structure")
        visit(app, depth: 0)
        let diagnostic = String(lines.joined(separator: "\n").prefix(16_000))
        print(diagnostic)
        let attachment = XCTAttachment(string: diagnostic)
        attachment.name = "styled-html-fixture-state"
        attachment.lifetime = .keepAlways
        add(attachment)
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
        chooseSettingsSection("Notifications", in: app)
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
        chooseSettingsSection("Notifications", in: reopened)
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

    func test37LongConversationOffersOffscreenUnreadAndLatestJumps() throws {
        _ = try composeFixtureRequest("__fixture/reader", method: "POST", body: ["enabled": true])
        addTeardownBlock { _ = try self.composeFixtureRequest("__fixture/reader", method: "POST", body: ["enabled": false]) }
        let app = try launchApp()
        assertInboxLoaded(in: app)
        openConversation(subject: Fixture.inboxSubject, in: app)
        let unread = app.staticTexts["Reader sender 22"]
        let newest = app.staticTexts["Reader sender 24"]
        let jumpUnread = app.buttons["thread.jump-unread"]
        let jumpLatest = app.buttons["thread.jump-latest"]
        XCTAssertTrue(unread.waitForExistence(timeout: 10))
        XCTAssertTrue(unread.isHittable)
        attachScreenshot(named: "reader-jumps-first-unread")
        XCTAssertTrue(jumpLatest.waitForExistence(timeout: 5), "Latest is below the long first-unread card and needs a jump")
        XCTAssertTrue(jumpLatest.isHittable)
        XCTAssertFalse(jumpUnread.exists, "Unread is already visible")
        assertFeedbackClear(of: [jumpLatest, app.buttons["Reply"], app.buttons["Reply all"], app.buttons["Forward"]],
                            in: app, checkpoint: "reader-jump-latest")
        jumpLatest.tap()
        XCTAssertTrue(newest.waitForExistence(timeout: 5))
        XCTAssertTrue(newest.isHittable)
        XCTAssertTrue(jumpUnread.waitForExistence(timeout: 5))
        XCTAssertFalse(jumpLatest.exists, "Latest jump must disappear at its target")
        attachScreenshot(named: "reader-jumps-at-latest")
        jumpUnread.tap()
        XCTAssertTrue(unread.isHittable)
        XCTAssertTrue(jumpLatest.waitForExistence(timeout: 5))
        XCTAssertFalse(jumpUnread.exists)
        // AX may report a disclosure behind native navigation as hittable.
        // Use the SAME reveal gesture/budget, but require its full44pt target
        // inside actual reading content before the original single tap.
        let history = app.buttons["Show 21 earlier messages"]
        func historyViewport() -> CGRect {
            let reader = app.descendants(matching: .any)["thread.reader"]
            let navigation = app.navigationBars.firstMatch, reply = app.buttons["Reply"]
            guard reader.exists, navigation.exists, reply.exists else { return .null }
            let bounds = reader.frame.intersection(app.frame)
            guard !bounds.isNull, !bounds.isEmpty else { return .null }
            let top = max(bounds.minY, navigation.frame.maxY) + 8
            let bottom = min(bounds.maxY, reply.frame.minY) - 8
            guard bottom > top else { return .null }
            return CGRect(x: bounds.minX, y: top, width: bounds.width, height: bottom - top)
        }
        func historyIsFullyReachable() -> Bool {
            guard history.exists, history.isHittable else { return false }
            let viewport = historyViewport(), target = history.frame
            return !viewport.isNull && target.width >= 44 && target.height >= 44 && viewport.contains(target)
        }
        for _ in 0..<6 {
            if historyIsFullyReachable() { break }
            app.swipeDown()
        }
        let historyReachableBeforeTap = historyIsFullyReachable()
        captureHistoryBoundary(in: app, stage: "history-before-show21", observed: [
            "full_target_reachable": String(historyReachableBeforeTap), "reading_viewport": String(describing: historyViewport())
        ])
        XCTAssertTrue(historyReachableBeforeTap, "Show21 needs its full44pt target below navigation and above Reply before tapping")
        guard historyReachableBeforeTap else { return }
        history.tap()
        // Keep the original5s predicate and capture its result before the
        // first extra AX read or hierarchy/PNG work. Diagnostics cannot rescue
        // a failure by moving the original wait's start later.
        let unreadJumpAfterHistory = jumpUnread.waitForExistence(timeout: 5)
        let showAfterOriginalWait = app.buttons["Show 21 earlier messages"].exists
        let hideAfterOriginalWait = app.buttons["Hide 21 earlier messages"].exists
        captureHistoryBoundary(in: app, stage: "history-after-original-wait", observed: [
            "show_after_original_wait": String(showAfterOriginalWait), "hide_after_original_wait": String(hideAfterOriginalWait),
            "original_5s_jump_result": String(unreadJumpAfterHistory)
        ])
        XCTAssertTrue(unreadJumpAfterHistory)
        XCTAssertTrue(jumpLatest.isHittable)
        attachScreenshot(named: "reader-jumps-earlier-history")
        assertFeedbackClear(of: [jumpUnread, jumpLatest, app.buttons["Reply"], app.buttons["Reply all"], app.buttons["Forward"]],
                            in: app, checkpoint: "reader-history-jumps")
        jumpUnread.tap()
        XCTAssertTrue(unread.isHittable)
        XCTAssertFalse(jumpUnread.exists)
        // Scroll back into preceding messages until the entire unread card is
        // outside the viewport, not just its sender heading.
        for _ in 0..<6 {
            if jumpUnread.exists { break }
            app.swipeDown()
        }
        XCTAssertTrue(jumpUnread.waitForExistence(timeout: 5))
        jumpUnread.tap()
        XCTAssertTrue(unread.isHittable)
        XCTAssertFalse(jumpUnread.exists)
        attachScreenshot(named: "reader-jumps-return-to-unread")
    }

    func test07ConversationOpensAtLatestMessage() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        openConversation(subject: Fixture.inboxSubject, in: app)
        let latest = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "I tried the new reading view")).firstMatch
        XCTAssertTrue(latest.waitForExistence(timeout: 10))
        XCTAssertTrue(latest.isHittable, "The newest message must be visible without scrolling past earlier replies.")
        attachScreenshot(named: "17-latest-message-on-open")
        assertFeedbackClear(of: [app.buttons["Reply"], app.buttons["Reply all"], app.buttons["Forward"]],
                            in: app, checkpoint: "reader-actions")

        let actions = app.buttons["thread.actions"]
        XCTAssertTrue(actions.isHittable, "Conversation actions must remain reachable in the toolbar.")
        actions.tap()
        XCTAssertTrue(app.buttons["Expand all"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Collapse all"].exists)
        attachScreenshot(named: "17b-conversation-actions")
        app.buttons["Expand all"].tap()
        XCTAssertTrue(app.buttons["Hide 1 earlier messages"].exists)
        actions.tap()
        app.buttons["Collapse all"].tap()
        XCTAssertTrue(latest.isHittable, "Collapse all must retain the entry message.")

        let earlierToggle = app.buttons["Show 1 earlier messages"]
        XCTAssertTrue(earlierToggle.exists)
        earlierToggle.tap()
        let earlier = app.staticTexts["Earlier sender"]
        for _ in 0..<5 {
            if earlier.exists && earlier.isHittable { break }
            app.swipeDown()
        }
        XCTAssertTrue(earlier.isHittable, "Earlier replies must remain reachable through the earlier-messages disclosure.")
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
        chooseSettingsSection("Notifications", in: app)
        let notification = app.switches.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "settings.notifications.space.view:", "Hub notifications")).firstMatch
        for _ in 0..<8 {
            if notification.exists && notification.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(notification.exists)
        XCTAssertEqual(notification.value as? String, "0", "Showing a View must not enable its notifications")
        attachScreenshot(named: "20-view-notifications-still-off")
        app.tabBars.buttons["Mail"].tap()
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
        XCTAssertFalse(reopened.buttons["mailbox.option.focus"].exists)
        XCTAssertTrue(reopened.buttons["mailbox.option.destination:" + (try XCTUnwrap((try composeFixtureRequest("/v1/destinations")["legacyDestinationIds"] as? [String: Any])?["focus"] as? String))].exists, "Hiding Inbox focus does not hide the actual named Focus Space")
        reopened.buttons["Hub notifications"].tap()
        XCTAssertTrue(reopened.buttons["view.thread.ios-fixture-thread-2"].waitForExistence(timeout: 10))
        reopened.tabBars.buttons["Settings"].tap()
        reopened.buttons["settings.visible-views"].tap()
        let restored = reopened.switches.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "settings.views.view:", "Hub notifications")).firstMatch
        XCTAssertEqual(restored.value as? String, "1")
        restored.tap()
        reopened.switches["settings.views.focus"].tap()
        reopened.tabBars.buttons["Mail"].tap()
        XCTAssertTrue(reopened.navigationBars["Important"].waitForExistence(timeout: 10), "Hiding the active View must return to Important")
    }

    func test09EmptySavedViewKeepsMailboxMenuAvailable() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        app.tabBars.buttons["Settings"].tap()
        app.buttons["settings.visible-views"].tap()
        let empty = app.switches.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "settings.views.view:", "Empty view")).firstMatch
        XCTAssertTrue(empty.waitForExistence(timeout: 10))
        if empty.value as? String != "1" { empty.tap() }
        app.tabBars.buttons["Mail"].tap()
        app.buttons["inbox.view-picker"].tap()
        app.buttons["Empty view"].tap()
        XCTAssertTrue(app.staticTexts["No matching mail"].waitForExistence(timeout: 10))
        attachScreenshot(named: "23-empty-view-with-menu")
        XCTAssertTrue(app.buttons["inbox.view-picker"].isHittable)
        app.buttons["inbox.view-picker"].tap()
        app.buttons["mailbox.option.all"].tap()
        XCTAssertTrue(app.navigationBars["All Mail"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].waitForExistence(timeout: 10))
    }

    /// Native Picker semantics and real hit testing, reused in both appearances.
    func test40MailboxSelectorCancelsAndSwitchesRepeatedly() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        let picker = app.buttons["inbox.view-picker"]
        assertMailboxControl("Inbox", in: app)
        attachScreenshot(named: "mailbox-selector-inbox")

        // Tap near the top edge rather than only the native text's center.
        picker.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        XCTAssertTrue(app.buttons["mailbox.option.all"].waitForExistence(timeout: 5))
        attachScreenshot(named: "mailbox-selector-open")
        // The grouped native disclosure has an explicit Done cancellation.
        app.navigationBars["Mailboxes"].buttons["Done"].tap()
        XCTAssertTrue(app.buttons["mailbox.option.all"].waitForNonExistence(timeout: 5))
        assertMailboxControl("Inbox", in: app)
        XCTAssertTrue(app.navigationBars["Inbox"].exists)
        attachScreenshot(named: "mailbox-selector-cancelled")
        // The opposite padded edge must activate the same native menu too.
        picker.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)).tap()
        XCTAssertTrue(app.buttons["mailbox.option.all"].waitForExistence(timeout: 5))
        app.buttons["mailbox.option.all"].tap()
        assertMailboxControl("All Mail", in: app)

        for title in ["All Mail", "Focus", "Inbox", "All Mail", "Inbox", "Inbox"] {
            chooseMailbox(title, in: app)
            assertMailboxControl(title, in: app)
            if title == "Focus" { attachScreenshot(named: "mailbox-selector-focus-selected") }
        }
        attachScreenshot(named: "mailbox-selector-repeated-return")
        app.buttons["inbox.visible-views"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        app.tabBars.buttons["Mail"].tap()
        assertMailboxControl("Inbox", in: app)
        attachScreenshot(named: "mailbox-selector-settings-return")
    }

    func test41MailboxSelectorLongNameAtLargestAccessibilitySize() throws {
        let app = try launchApp(contentSize: "UICTContentSizeCategoryAccessibilityXXXL")
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 20))
        let name = "Research planning and weekly product follow-ups"
        let picker = app.buttons["inbox.view-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10))
        let option = app.buttons["mailbox.option." + (try fixtureMailboxSelection(name))]
        // Catalog loading is independent of the navigation title. Native menus
        // may snapshot their options, so reopen within a bounded readiness wait.
        for attempt in 0..<4 {
            picker.tap()
            if option.waitForExistence(timeout: 3) { break }
            if attempt < 3 {
                app.navigationBars["Mailboxes"].buttons["Done"].tap()
                XCTAssertTrue(app.buttons["mailbox.option.all"].waitForNonExistence(timeout: 5))
            }
        }
        XCTAssertTrue(option.exists, "Run with the opt-in mailbox-control fixture; its catalog must load")
        attachScreenshot(named: "mailbox-selector-accessibility-menu")
        option.tap()
        assertMailboxControl(name, in: app)
        attachScreenshot(named: "mailbox-selector-accessibility-long-name")
        // Keep all rendered title lines inside the fixed controls row. The
        // previous native Picker fragmented text far outside its reported frame;
        // this bound supplements, but does not replace, pixel review.
        XCTAssertLessThanOrEqual(picker.frame.height, 160)
        let content = app.collectionViews["inbox.list"]
        XCTAssertTrue(content.waitForExistence(timeout: 10))
        XCTAssertGreaterThanOrEqual(content.frame.minY, picker.frame.maxY)
        chooseMailbox("Inbox", in: app)
        assertMailboxControl("Inbox", in: app)
        attachScreenshot(named: "mailbox-selector-accessibility-return")
    }

    func test42MailboxSwitchWhileInboxRefreshIsPending() throws {
        let app = try launchApp()
        assertInboxLoaded(in: app)
        let list = app.collectionViews["inbox.list"]
        try refreshFixture("arm", method: "POST", scenario: "switch")
        addTeardownBlock { try self.refreshFixture("release", method: "POST") }
        let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
        let end = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        start.press(forDuration: 0.1, thenDragTo: end)
        try refreshFixture("wait", method: "GET")
        chooseMailbox("All Mail", in: app)
        assertMailboxControl("All Mail", in: app)
        attachScreenshot(named: "mailbox-selector-switched-during-refresh")
        try refreshFixture("wait", method: "GET")
        try refreshFixture("release", method: "POST")
        XCTAssertTrue(app.descendants(matching: .any)["inbox.message.ios-fixture-message-1"].waitForExistence(timeout: 10))
        assertMailboxControl("All Mail", in: app)
        chooseMailbox("Inbox", in: app)
        assertMailboxControl("Inbox", in: app)
        attachScreenshot(named: "mailbox-selector-refresh-switch-return")
    }

    private func chooseSettingsSection(_ title: String, in app: XCUIApplication) {
        let picker = app.buttons["settings.section"]
        for _ in 0..<6 { if picker.isHittable { break }; app.swipeDown() }
        XCTAssertTrue(picker.waitForExistence(timeout: 10)); picker.tap()
        let option = app.buttons[title]
        XCTAssertTrue(option.waitForExistence(timeout: 5)); option.tap()
    }

    private func assertMailboxControl(_ title: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let picker = app.buttons["inbox.view-picker"]
        let settings = app.buttons["inbox.visible-views"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10), file: file, line: line)
        XCTAssertTrue(picker.isHittable, file: file, line: line)
        XCTAssertGreaterThanOrEqual(picker.frame.height, 44, file: file, line: line)
        XCTAssertGreaterThanOrEqual(picker.frame.width, 44, file: file, line: line)
        // Native Picker exposes its selection as its label or value by OS version.
        let accessibleText = picker.label + " " + (picker.value as? String ?? "")
        XCTAssertTrue(accessibleText.contains(title), "Full mailbox name must remain accessible: \(accessibleText)", file: file, line: line)
        XCTAssertTrue(settings.isHittable, file: file, line: line)
        XCTAssertGreaterThanOrEqual(settings.frame.minX, picker.frame.maxX, file: file, line: line)
        XCTAssertTrue(app.frame.contains(picker.frame), file: file, line: line)
        XCTAssertTrue(app.frame.contains(settings.frame), file: file, line: line)
    }

    private func launchApp(contentSize: String = "UICTContentSizeCategoryL", htmlDiagnostics: Bool = false, shortLayout: Bool = false, openInbox: Bool = true) throws -> XCUIApplication {
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
        if htmlDiagnostics { app.launchArguments.append("--fixture-html-diagnostics") }
        if shortLayout { app.launchArguments.append("--fixture-short-layout") }
        app.launch()
        if openInbox {
            // Existing compose/reader/placement fixtures explicitly enter Inbox.
            // test44 separately asserts the real default Important entry.
            XCTAssertTrue(app.buttons["inbox.view-picker"].waitForExistence(timeout: 20))
            chooseMailbox("Inbox", in: app)
        }
        return app
    }

    private func captureMailBoundary(in app: XCUIApplication, stage: String) {
        captureSyntheticBoundary(in: app, stage: stage, targets: [
            ("mail-list", app.collectionViews["inbox.list"]), ("search", app.searchFields["Search All Mail"]),
            ("save-view", app.buttons["search.save-view"]), ("importance-status", app.staticTexts["importance.status"]),
            ("importance-save", app.buttons["importance.important"]), ("importance-undo", app.buttons["importance.undo"]),
            ("mail-tab", app.tabBars.buttons["Mail"]), ("navigation", app.navigationBars.firstMatch)
        ])
    }
    private func captureMailFixtureReadback(stage: String, accountID: String) throws {
        guard feedbackFixtureDiagnosticsAllowed(), accountID == "ios-fixture-account" else { return }
        let page = try composeFixtureRequest("/v1/inbox?accountId=" + accountID + "&view=all&limit=30")
        let rows = (page["messages"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }.filter { $0.hasPrefix("ios-fixture-") }
        let importance = try composeFixtureRequest("/v1/importance/conversations/ios-fixture-thread-1?accountId=" + accountID)
        let witness = try composeFixtureRequest("/__fixture/routing-receipts?threadId=ios-fixture-thread-1")
        let snapshot: [String: Any] = ["stage": stage, "sqlite": witness["sqlite"] ?? NSNull(), "syntheticRowIDs": rows, "accountID": accountID, "effective": (importance["importance"] as? [String: Any])?["effective"] ?? NSNull(), "epoch_ms": Int64(Date().timeIntervalSince1970 * 1000)]
        let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json"); attachment.name = "native-mail-readback-" + stage; attachment.lifetime = .keepAlways; add(attachment)
    }

    private func captureHistoryBoundary(in app: XCUIApplication, stage: String, observed: [String: String] = [:]) {
        captureSyntheticBoundary(in: app, stage: stage, targets: [
            ("show21", app.buttons["Show 21 earlier messages"]), ("hide21", app.buttons["Hide 21 earlier messages"]),
            ("earliest-sender", app.staticTexts["Reader sender 1"]), ("unread-sender", app.staticTexts["Reader sender 22"]),
            ("latest-sender", app.staticTexts["Reader sender 24"]),
            ("earliest-header", app.buttons.matching(NSPredicate(format: "label MATCHES %@", ".*Reader sender 1([^0-9].*)?")).firstMatch),
            ("unread-header", app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Reader sender 22")).firstMatch),
            ("latest-header", app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Reader sender 24")).firstMatch),
            ("jump-unread", app.buttons["thread.jump-unread"]), ("jump-latest", app.buttons["thread.jump-latest"]),
            ("reader", app.descendants(matching: .any)["thread.reader"]), ("navigation", app.navigationBars.firstMatch),
            ("reply", app.buttons["Reply"]), ("feedback", app.buttons["feedback.open"])
        ], observed: observed)
    }

    private func captureComposeBoundary(in app: XCUIApplication, stage: String, observed: [String: String] = [:]) {
        guard boundaryDiagnostics else { return }
        captureSyntheticBoundary(in: app, stage: stage, targets: [
            ("form", app.scrollViews["compose.form"]), ("body", messageBody(in: app)),
            ("navigation", app.navigationBars.firstMatch), ("inbox-nav", app.navigationBars["Inbox"]),
            ("drafts-nav", app.navigationBars["Drafts"]), ("footer-status", app.descendants(matching: .any)["compose.save-status"]),
            ("permission-footer", app.descendants(matching: .any)["compose.send-permission"]), ("refresh-footer", app.buttons["compose.refresh-permission"]),
            ("defaults-footer", app.staticTexts["Account defaults could not be loaded. Your writing is kept; add a signature if needed."]),
            ("send", app.buttons["compose.send"]), ("done", app.buttons["compose.keyboard-done"]),
            ("keyboard", app.keyboards.firstMatch), ("feedback", app.buttons["feedback.open"]),
            ("removed-attachment", app.buttons["compose.attachment.remove.remove"]),
            ("retained-attachment", app.buttons["compose.attachment.remove.keep"])
        ], observed: observed)
    }

    /// Read-only evidence for the explicitly configured loopback fixture.
    /// No message text, addresses, identifiers, token or arbitrary value output.
    private func captureSyntheticBoundary(in app: XCUIApplication, stage: String,
        targets: [(String, XCUIElement)], observed: [String: String] = [:]) {
        guard let raw = ProcessInfo.processInfo.environment["ORCA_FIXTURE_API_URL"],
              let url = URL(string: raw), url.scheme == "http",
              ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "") else { return }
        var lines = ["[native-boundary] stage=\(stage) epoch_ms=\(Int64(Date().timeIntervalSince1970 * 1000))"]
        for key in observed.keys.sorted() { lines.append("observed_\(key)=\(observed[key]!)") }
        for (name, element) in targets {
            let exists = element.exists
            lines.append("target=\(name) exists=\(exists)")
            if exists {
                lines.append("type=\(element.elementType.rawValue) frame=\(element.frame) enabled=\(element.isEnabled) hittable=\(element.isHittable) selected=\(element.isSelected) public_ui_focus=\(element.hasFocus)")
            }
        }
        // One public snapshot supplies a bounded structural hierarchy. Omit
        // labels/values/identifiers rather than truncating potentially private text.
        if let snapshot = try? app.snapshot() {
            var nodes = 0
            func visit(_ node: XCUIElementSnapshot, depth: Int) {
                guard nodes < 60, depth < 28 else { return }
                nodes += 1
                lines.append("node=\(nodes) depth=\(depth) type=\(node.elementType.rawValue) frame=\(node.frame)")
                for child in node.children.prefix(10) { visit(child, depth: depth + 1) }
            }
            visit(snapshot, depth: 0)
        }
        let diagnostic = String(lines.joined(separator: "\n").prefix(16_000))
        print(diagnostic)
        let text = XCTAttachment(string: diagnostic); text.name = "native-boundary-" + stage
        text.lifetime = .keepAlways; add(text)
        let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        image.name = "native-boundary-" + stage; image.lifetime = .keepAlways; add(image)
    }

    private func assertInboxLoaded(in app: XCUIApplication, boundedListReveal: Bool = false, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 20), file: file, line: line)
        if boundedListReveal {
            for _ in 0..<6 {
                if app.descendants(matching: .any)["inbox.message.\(Fixture.inboxMessageID)"].exists { break }
                XCTAssertTrue(app.tabBars.buttons["Mail"].isSelected, file: file, line: line)
                guard revealInboxContent(in: app, up: true) else { break }
                XCTAssertTrue(app.tabBars.buttons["Mail"].isSelected, file: file, line: line)
            }
        }
        let firstRowFound = app.descendants(matching: .any)["inbox.message.\(Fixture.inboxMessageID)"].waitForExistence(timeout: 20)
        if !firstRowFound && boundaryDiagnostics && feedbackFixtureDiagnosticsAllowed() {
            let id = "inbox.message." + Fixture.inboxMessageID
            captureSyntheticBoundary(in: app, stage: "initial-ax-inbox-row-missing", targets: [
                ("row-any", app.descendants(matching: .any)[id]), ("row-button", app.buttons[id]),
                ("list", app.descendants(matching: .any)["inbox.list"]), ("navigation", app.navigationBars.firstMatch),
                ("mail-tab", app.tabBars.buttons["Mail"]), ("drafts-tab", app.tabBars.buttons["Drafts"]),
                ("settings-tab", app.tabBars.buttons["Settings"])
            ], observed: ["original_20s_result": String(firstRowFound),
                "button_count": String(app.buttons.matching(identifier: id).count),
                "any_count": String(app.descendants(matching: .any).matching(identifier: id).count)])
        }
        XCTAssertTrue(firstRowFound, file: file, line: line)
        // List realizes rows within its viewport. At accessibility sizes the
        // attention/date headings can put the second fixture below that viewport.
        let secondRow = app.descendants(matching: .any)["inbox.message.\(Fixture.searchResultMessageID)"]
        var scrolls = 0
        while !secondRow.exists && scrolls < 5 {
            if boundedListReveal {
                guard revealInboxContent(in: app, up: true) else { break }
            } else { app.swipeUp() }
            scrolls += 1
        }
        XCTAssertTrue(secondRow.exists, file: file, line: line)
        // Leave callers at their original inbox entry point.
        for _ in 0..<scrolls {
            if boundedListReveal { _ = revealInboxContent(in: app, up: false) }
            else { app.swipeDown() }
        }
        XCTAssertTrue(app.descendants(matching: .any)["inbox.message.\(Fixture.inboxMessageID)"].exists, file: file, line: line)
        XCTAssertTrue(app.tabBars.buttons["Mail"].isSelected, file: file, line: line)
    }

    private func panContent(_ pan: ViewportGeometry.Pan, in element: XCUIElement) {
        let frame = element.frame
        guard frame.width > 0, frame.height > 0 else { return }
        func coordinate(_ point: CGPoint) -> XCUICoordinate {
            element.coordinate(withNormalizedOffset: CGVector(dx: (point.x - frame.minX) / frame.width, dy: (point.y - frame.minY) / frame.height))
        }
        coordinate(pan.start).press(forDuration: 0.05, thenDragTo: coordinate(pan.end))
    }
    private func revealInboxContent(in app: XCUIApplication, up: Bool) -> Bool {
        let list = app.descendants(matching: .any)["inbox.list"]
        guard list.exists, app.navigationBars["Inbox"].exists, app.tabBars.buttons["Mail"].isSelected else { return false }
        var fixed = [CGRect]()
        if app.tabBars.element.exists { fixed.append(app.tabBars.element.frame) }
        if app.buttons["feedback.open"].exists { fixed.append(app.buttons["feedback.open"].frame) }
        guard let viewport = ViewportGeometry.content(form: list.frame, application: app.frame, navigation: app.navigationBars["Inbox"].frame, fixed: fixed),
              let pan = ViewportGeometry.pan(in: viewport, up: up) else { return false }
        panContent(pan, in: list)
        return true
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
        print("INBOX_NAVIGATION_TARGET row=\(identifier) type=\(row.elementType.rawValue) frame=\(row.frame) hittable=\(row.isHittable) enabled=\(row.isEnabled)")
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
        let search = identified.exists ? identified : app.searchFields["Search All Mail"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText(query)
        print("[search-fixture] submitted-value=\(String(describing: search.value))")
        XCTAssertEqual(search.value as? String, query, "The search field must contain the requested synthetic query")
        app.keyboards.buttons["Search"].tap()
    }

    private func clearSearch(in app: XCUIApplication) {
        let identified = app.searchFields["inbox.search"]
        let search = identified.exists ? identified : app.searchFields["Search All Mail"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.buttons["Clear text"].tap()
        // Editing through empty does not replace the accepted result query.
        // Use the real explicit clear action; iOS disables Search for empty text.
        XCTAssertTrue(search.buttons["Clear text"].waitForNonExistence(timeout: 5), "Clearing search must remove the clear control")
        let clear = app.buttons["mail.search.clear-submitted"]
        XCTAssertTrue(clear.waitForExistence(timeout: 5)); clear.tap()
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

    private func dismissTypingIntroduction(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        // Apple's first-use panel can appear after the initial tap has returned.
        // Match its actual explanatory copy, never an arbitrary Continue button.
        let introduction = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Speed up your typing")).firstMatch
        if introduction.waitForExistence(timeout: 2) {
            let proceed = app.buttons["Continue"]
            XCTAssertTrue(proceed.waitForExistence(timeout: 5), file: file, line: line)
            proceed.tap()
            XCTAssertTrue(introduction.waitForNonExistence(timeout: 5), file: file, line: line)
        }
    }

    /// Measure actual accessibility frames, not SwiftUI padding constants.
    /// Keep diagnostics to fixed checkpoint names and numeric geometry; do not
    /// log recipients, writing, subjects, attachment names or API credentials.
    private func assertFeedbackClear(of controls: [XCUIElement], in app: XCUIApplication, checkpoint: String,
                                     file: StaticString = #filePath, line: UInt = #line) {
        let feedback = app.buttons["feedback.open"]
        XCTAssertTrue(feedback.waitForExistence(timeout: 10), "Feedback must remain available", file: file, line: line)
        let feedbackFrame = feedback.frame
        let frames = controls.map { $0.frame }
        let overlaps = frames.map { frame -> CGFloat in
            let intersection = frame.intersection(feedbackFrame)
            return intersection.isNull ? 0 : intersection.width * intersection.height
        }
        let overlapCount = overlaps.filter { $0 > 0 }.count
        var protectedOverlapPairs = 0
        for first in frames.indices {
            for second in frames.indices where second > first {
                let intersection = frames[first].intersection(frames[second])
                if !intersection.isNull && intersection.width * intersection.height > 0 { protectedOverlapPairs += 1 }
            }
        }
        let keyboard = app.keyboards.firstMatch
        let keyboardFrame = keyboard.exists ? keyboard.frame : .zero
        // A shifted footer must not solve Feedback by moving actions into the
        // system keyboard. The Done toolbar is outside the keyboard's frame.
        let keyboardOverlaps = keyboard.exists ? ([feedbackFrame] + frames).filter {
            let intersection = $0.intersection(keyboardFrame)
            return !intersection.isNull && intersection.width * intersection.height > 0
        }.count : 0
        // Capture before any assertion aborts this test, including on baseline.
        attachScreenshot(named: "bre-459-\(checkpoint)")
        print("[bre-459] checkpoint=\(checkpoint) controls=\(controls.count) overlapping_controls=\(overlapCount) keyboard=\(app.keyboards.firstMatch.exists) feedback_frame=\(feedbackFrame) control_frames=\(frames) intersection_areas_pt2=\(overlaps)")
        print("[bre-459] checkpoint=\(checkpoint) keyboard_overlap_controls=\(keyboardOverlaps) keyboard_frame=\(keyboardFrame)")
        print("[bre-459] checkpoint=\(checkpoint) protected_overlap_pairs=\(protectedOverlapPairs)")
        XCTAssertFalse(feedbackFrame.isEmpty, file: file, line: line)
        XCTAssertTrue(app.frame.contains(feedbackFrame), "Feedback must be fully on screen", file: file, line: line)
        XCTAssertTrue(feedback.isHittable, "Feedback must remain operable", file: file, line: line)
        XCTAssertGreaterThanOrEqual(feedbackFrame.width, 44, file: file, line: line)
        XCTAssertGreaterThanOrEqual(feedbackFrame.height, 44, file: file, line: line)
        XCTAssertEqual(overlapCount, 0, "Feedback must not cover any protected control", file: file, line: line)
        XCTAssertEqual(keyboardOverlaps, 0, "Feedback and protected controls must stay above the keyboard", file: file, line: line)
        XCTAssertEqual(protectedOverlapPairs, 0, "Protected controls must not cover one another", file: file, line: line)
        for (index, control) in controls.enumerated() {
            XCTAssertTrue(control.exists, "Protected control \(index) must exist", file: file, line: line)
            XCTAssertFalse(frames[index].isEmpty, "Protected control \(index) needs visible geometry", file: file, line: line)
            XCTAssertTrue(app.frame.contains(frames[index]), "Protected control \(index) must be fully on screen", file: file, line: line)
            XCTAssertTrue(control.isHittable, "Protected control \(index) must remain reachable", file: file, line: line)
            if control.elementType == .button {
                XCTAssertGreaterThanOrEqual(frames[index].width, 44, file: file, line: line)
                XCTAssertGreaterThanOrEqual(frames[index].height, 44, file: file, line: line)
                XCTAssertFalse(control.label.isEmpty, "Protected action \(index) needs an accessible label", file: file, line: line)
            }
        }
        // setUp's continueAfterFailure=false means this record is reached only
        // after every assertion above executed successfully, not on baseline.
        let buttons = controls.filter { $0.elementType == .button }.count
        print("[bre-459] checkpoint=\(checkpoint) geometry_assertions_passed=\(9 + 4 * controls.count + 3 * buttons)")
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

