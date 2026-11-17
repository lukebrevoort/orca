import Foundation

func runRoutingCompensationCases(check: (String, Bool, String) -> Void) throws {
    let target: [String: Any] = ["scope": "conversation", "threadId": "fixed-thread"]
    func entry(_ ordinal: Int = 1, expected: Int = 10, chosen: String = "focus", previous: Any = NSNull()) -> [String: Any] {
        ["ordinal": ordinal, "receivedAt": 100, "responseAt": 101, "accountId": "account", "status": 200,
         "command": ["expectedRevision": expected, "target": target, "destinationId": chosen],
         "receipt": ["state": ["accountId": "account", "revision": expected + 1, "selection": ["target": target, "explicitDestinationId": chosen]], "undo": ["expectedRevision": expected + 1, "target": target, "destinationId": previous]]]
    }
    func data(_ entries: [[String: Any]], ordinal: Int? = nil, truncated: Bool = false, account: String = "account") throws -> Data {
        try ReviewRegressions.json(["accountId": account, "ordinal": ordinal ?? entries.count, "truncated": truncated, "receipts": entries])
    }
    let scope = RoutingCompensationScope(accountID: "account", threadID: "fixed-thread", revision: 10, explicitID: nil, ordinal: 0, allowedDestinationIDs: ["focus", "inbox"])
    let one = try scope.plan(data([entry()]))
    check("NAV-B-routing-CAS-one-owned-ack", one?.expectedRevision == 11 && one?.target.threadId == "fixed-thread" && one?.destinationId == nil, "cleanup after failed Focus browse uses only the exact real owned acknowledgement revision and original inherit")
    let two = try scope.plan(data([entry(), entry(2, expected: 11, chosen: "inbox", previous: "focus")]))
    check("NAV-B-routing-CAS-success-chain", two?.expectedRevision == 12 && two?.destinationId == nil, "successful UI Focus→Inbox chain can restore original explicit-null before later View authoring")
    let originalExplicit = RoutingCompensationScope(accountID: "account", threadID: "fixed-thread", revision: 10, explicitID: "original", ordinal: 0, allowedDestinationIDs: ["focus", "inbox"])
    check("NAV-B-routing-CAS-original-explicit-ID", try originalExplicit.plan(data([entry(previous: "original")]))?.destinationId == "original", "non-null original choices are not replaced by inherit/default")
    check("NAV-B-routing-no-ack-no-write-plan", try scope.plan(data([])) == nil, "no receipt never fabricates a compensating command; UI additionally verifies unchanged original revision before declaring cleanup unnecessary")
    let mutations: [(String, ([String: Any]) -> [String: Any])] = [
        ("wrong-account", { var v = $0; v["accountId"] = "other"; return v }),
        ("bad-status", { var v = $0; v["status"] = 409; return v }),
        ("missing-receipt", { var v = $0; v["receipt"] = NSNull(); return v }),
        ("wrong-thread", { var v = $0, c = v["command"] as! [String: Any]; c["target"] = ["scope": "conversation", "threadId": "other"]; v["command"] = c; return v }),
        ("wrong-inverse", { var v = $0, r = v["receipt"] as! [String: Any], undo = r["undo"] as! [String: Any]; undo["destinationId"] = "foreign"; r["undo"] = undo; v["receipt"] = r; return v }),
        ("missing-null-inverse", { var v = $0, r = v["receipt"] as! [String: Any], undo = r["undo"] as! [String: Any]; undo.removeValue(forKey: "destinationId"); r["undo"] = undo; v["receipt"] = r; return v }),
        ("unexpected-destination", { var v = $0, c = v["command"] as! [String: Any]; c["destinationId"] = "foreign"; v["command"] = c; return v }),
        ("request-revision-gap", { var v = $0, c = v["command"] as! [String: Any]; c["expectedRevision"] = 99; v["command"] = c; return v }),
        ("response-revision-gap", { var v = $0, r = v["receipt"] as! [String: Any], state = r["state"] as! [String: Any]; state["revision"] = 99; r["state"] = state; v["receipt"] = r; return v }),
        ("wrong-result-account", { var v = $0, r = v["receipt"] as! [String: Any], state = r["state"] as! [String: Any]; state["accountId"] = "other"; r["state"] = state; v["receipt"] = r; return v }),
        ("reversed-timestamps", { var v = $0; v["receivedAt"] = 200; return v }),
        ("ordinal-gap", { var v = $0; v["ordinal"] = 2; return v })
    ]
    for (name, mutate) in mutations {
        check("NAV-B-routing-CAS-reject-" + name, (try? scope.plan(data([mutate(entry())]))) == nil, "incomplete/foreign/non-owned receipt evidence cannot authorize a revision overwrite")
    }
    check("NAV-B-routing-CAS-truncated", (try? scope.plan(data([entry()], truncated: true))) == nil, "bounded witness overflow is an honest cleanup failure")
    check("NAV-B-routing-CAS-missing-ordinal", (try? scope.plan(data([entry()], ordinal: 2))) == nil, "an unobserved intervening command cannot be filled in from GET-current revision")
    check("NAV-B-routing-CAS-repeat-stale-ack", (try? scope.plan(data([entry(), entry(2)]))) == nil, "repeated old acknowledgement is not a new owned revision chain")
    if let one {
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(one)) as! [String: Any]
        check("NAV-B-routing-CAS-explicit-null-wire", object["destinationId"] is NSNull, "compensation encodes explicit null; omitted choice cannot change reset meaning")
    } else { check("NAV-B-routing-CAS-explicit-null-wire", false, "positive control did not establish a command") }
}
