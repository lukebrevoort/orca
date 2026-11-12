import Foundation
import CoreGraphics

@main struct ViewportGeometryChecks {
    static func main() throws {
        var results = [[String: Any]]()
        func check(_ name: String, _ pass: Bool, _ detail: String) {
            results.append(["case": name, "pass": pass, "detail": detail])
            print("CASE \(name): \(pass ? "PASS" : "FAIL") — \(detail)")
        }
        let app = CGRect(x: 0, y: 0, width: 402, height: 874)
        let status = CGRect(x: 19, y: 406.3333435058594, width: 109.667, height: 16.667)
        let form14 = CGRect(x: 0, y: 0, width: 402, height: 487)
        let nav14 = CGRect(x: 0, y: 62, width: 402, height: 54)
        let body14 = CGRect(x: 22, y: 374.3333333333333, width: 358, height: 360)
        let old14 = CGRect(x: 0, y: 118, width: 402, height: status.minY - 2 - 118)
        check("viewport-actual14-17-30pt-witness", abs(body14.intersection(old14).height - 30) < 0.001, "retained actual snapshot values; not a new Apple execution")
        let form43 = CGRect(x: 0, y: 182, width: 402, height: 305)
        let nav43 = CGRect(x: 0, y: 192, width: 402, height: 54)
        let body43 = CGRect(x: 22, y: 361.3333333333333, width: 358, height: 177.667)
        let viewport43 = ViewportGeometry.content(form: form43, application: app, navigation: nav43, fixed: [status])!
        check("viewport-actual43-still-rejects43pt", abs(body43.intersection(viewport43).height - 43) < 0.001 && ViewportGeometry.writingArea(body: body43, viewport: viewport43) == nil, "strict44 unchanged; no tolerance or corrective tap")
        // Text snapshot frame from the permission-blocked hierarchy. Hosted
        // correction will measure its actual public permission/Refresh IDs.
        let permission = CGRect(x: 19.667, y: 284.6666564941406, width: 352, height: 65.667)
        let refresh = CGRect(x: 18, y: 364, width: 157, height: 16.667)
        let viewport14 = ViewportGeometry.content(form: form14, application: app, navigation: nav14, fixed: [status, permission, refresh])!
        check("viewport-earliest-permission-before-status", viewport14.maxY == permission.minY - 2 && viewport14.maxY < status.minY, "earliest fixed component sets the boundary, independent of array order")
        let pan14 = ViewportGeometry.pan(in: viewport14, up: true)!
        check("viewport-permission-pan-inside-content", viewport14.contains(pan14.start) && viewport14.contains(pan14.end) && pan14.start.y < permission.minY && pan14.end.y > nav14.maxY && pan14.start.x > body14.maxX, "outer content padding pan avoids permission and TextEditor inner scrolling")
        check("viewport-old-normalized-start-is-footer", form14.minY + form14.height * 0.75 > permission.minY && form43.minY + form43.height * 0.75 > status.minY && pan14.start.y < permission.minY, "actual old normalized starts occupy fixed chrome; new points do not")
        let visible44 = CGRect(x: 22, y: viewport43.minY + 10, width: 358, height: 44)
        check("viewport-exact44-admitted", ViewportGeometry.writingArea(body: visible44, viewport: viewport43) == visible44, "real44pt target succeeds, not merely body.isHittable")
        let pan43 = ViewportGeometry.pan(in: viewport43, up: true)!
        check("viewport-short43-pan-above-actions", viewport43.contains(pan43.start) && viewport43.contains(pan43.end) && pan43.start.y < status.minY && pan43.start.y > nav43.maxY, "both drag points stay within the short content region")
        let clipped = ViewportGeometry.content(form: CGRect(x: -20, y: -30, width: 500, height: 1100), application: app, navigation: nav14, fixed: [CGRect(x: 0, y: 800, width: 402, height: 74)])!
        check("viewport-clips-application", app.contains(clipped) && clipped.maxY == 798 && clipped.width == 390, "oversized outer frames cannot place gestures outside application")
        check("viewport-invalid-stops", ViewportGeometry.content(form: .null, application: app, navigation: nav14, fixed: []) == nil && ViewportGeometry.pan(in: CGRect(x: 0, y: 0, width: 100, height: 10), up: true) == nil, "invalid/too-small geometry is an honest unreachable precondition")
        check("viewport-covering-footer-stops", ViewportGeometry.content(form: form43, application: app, navigation: nav43, fixed: [CGRect(x: 0, y: 240, width: 402, height: 247)]) == nil, "footer covering the content cannot be ignored to admit an unsafe tap")
        let external = ViewportGeometry.content(form: form14, application: app, navigation: nav14, fixed: [status, CGRect(x: 0, y: 583, width: 402, height: 233)])!
        check("viewport-external-keyboard-not-extra-inset", external.maxY == status.minY - 2, "already-reduced form is not reduced twice by a disjoint keyboard frame")
        let list = CGRect(x: 0, y: 490.6666666666667, width: 402, height: 294.6666666666667)
        let tabs = CGRect(x: 68, y: 706.3333333333334, width: 266, height: 54)
        let listViewport = ViewportGeometry.content(form: list, application: app, navigation: CGRect(x: 0, y: 62, width: 402, height: 114), fixed: [tabs])!
        let up = ViewportGeometry.pan(in: listViewport, up: true)!, down = ViewportGeometry.pan(in: listViewport, up: false)!
        check("viewport-ax-list-avoids-tabbar", listViewport.contains(up.start) && listViewport.contains(up.end) && up.start.y < tabs.minY && up.start == down.end && up.end == down.start, "same bounded native list gesture and reverse stay above tab bar")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["scope": "UI-test pure rectangle geometry only; no event routing or native UI proof", "results": results], options: [.sortedKeys]), as: UTF8.self))
        if results.contains(where: { $0["pass"] as? Bool == false }) { exit(1) }
    }
}
