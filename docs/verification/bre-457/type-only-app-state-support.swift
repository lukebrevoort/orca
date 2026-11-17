import Foundation
import SwiftUI
// Type-only support for Foundation/ObservableObject controllers. Not runtime behavior.
@MainActor final class AppState {
    enum Phase { case ready, signedOut }
    var phase: Phase = .ready
    var client: APIClient?
    var accounts = [MailAccount]()
    var selectedAccount: MailAccount? { accounts.first }
    var ownerScope = ""
    var userID: String?
    var baseURLText = "https://example.invalid"
    func validatedBaseURL(_ value: String) -> URL? { URL(string: value) }
    func importanceDidChange(accountId: String) {}
}
