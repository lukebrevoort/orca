import XCTest
@testable import Orca

final class OrcaTests: XCTestCase {
    func testInboxDecodesExistingWireContract() throws {
        let json = #"{"accounts":[],"messages":[],"nextCursor":null,"counts":{"focus":1,"normal":2,"quiet":3,"hidden":4,"all":10}}"#.data(using: .utf8)!
        let page = try JSONDecoder().decode(InboxPage.self, from: json); XCTAssertEqual(page.counts.all, 10)
    }
    func testPKCEProducesURLSafeChallenge() { let verifier = PKCE.verifier(), challenge = PKCE.challenge(verifier); XCTAssertGreaterThanOrEqual(verifier.count, 43); XCTAssertFalse(challenge.contains("=")); XCTAssertFalse(challenge.contains("+")); XCTAssertFalse(challenge.contains("/")) }
    func testLocalDraftSurvivesStoreRecreationAndKeepsSendKey() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString); var draft = LocalDraft(ownerScope: "https://one.example", accountId: "account-a"); draft.content.subject = "Safe across termination"
        let first = DraftStore(directory: directory); try await first.save(draft); let sending = try await first.prepareSend(draft.id); let second = DraftStore(directory: directory); let restored = await second.all(ownerScope: "https://one.example", accountId: "account-a")
        XCTAssertEqual(restored.first?.content.subject, "Safe across termination"); XCTAssertEqual(restored.first?.idempotencyKey, sending.idempotencyKey); XCTAssertEqual(restored.first?.deliveryState, "sending")
    }
    func testDraftsAreAccountIsolated() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString); let store = DraftStore(directory: directory); try await store.save(LocalDraft(ownerScope: "one", accountId: "a")); try await store.save(LocalDraft(ownerScope: "two", accountId: "a")); let a = await store.all(ownerScope: "one", accountId: "a"); let b = await store.all(ownerScope: "two", accountId: "a"); XCTAssertEqual(a.count, 1); XCTAssertEqual(b.count, 1)
    }
    func testRecipientValidationRejectsPartialInvalidList() {
        let view = ComposeView()
        XCTAssertTrue(view.recipientsAreValid("one@example.com, two@example.com", allowingEmpty: false))
        XCTAssertFalse(view.recipientsAreValid("one@example.com, not-an-address", allowingEmpty: false))
        XCTAssertFalse(view.recipientsAreValid("one@example.com,", allowingEmpty: false))
    }
    func testReopenedDraftPreservesReplyContext() {
        let context = DraftContext(kind: "reply", threadId: "t", messageId: "m", providerMessageId: "pm", providerThreadId: "pt", inReplyTo: "<m@example.com>", references: [])
        let draft = LocalDraft(ownerScope: "origin|user", accountId: "a", content: DraftContent(context: context))
        XCTAssertEqual(ComposeView(localDraft: draft).content().context, context)
    }
    func testCorruptDraftFileIsPreservedAndBlocksOverwrite() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appending(path: "drafts.json"), original = Data("not-json".utf8); try original.write(to: file)
        let store = DraftStore(directory: directory)
        let recoveryMessage = await store.recoveryMessage(); XCTAssertNotNil(recoveryMessage)
        do { try await store.save(LocalDraft(ownerScope: "o", accountId: "a")); XCTFail("Expected recovery protection") } catch {}
        XCTAssertEqual(try Data(contentsOf: file), original)
    }
    func testPrepareSendReusesStableIdempotencyKey() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString); let store = DraftStore(directory: directory); let draft = LocalDraft(ownerScope: "o", accountId: "a")
        try await store.save(draft); let first = try await store.prepareSend(draft.id); let second = try await store.prepareSend(draft.id)
        XCTAssertNotNil(first.idempotencyKey); XCTAssertEqual(first.idempotencyKey, second.idempotencyKey)
    }
}
