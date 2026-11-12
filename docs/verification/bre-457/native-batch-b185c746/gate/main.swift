import Foundation
import CoreGraphics
// Execute the exact source method body against assertion shims, not XCTest/UI.
var observations = 0
func require(_ ok: Bool, _ label: String) { observations += 1; if !ok { print("FAIL \(observations): \(label)"); exit(1) } }
func XCTAssertEqual<T: Equatable>(_ lhs: T, _ rhs: T) { require(lhs == rhs, "equality") }
func XCTAssertEqual(_ lhs: CGFloat, _ rhs: CGFloat, accuracy: CGFloat) { require(abs(lhs-rhs) <= accuracy, "approximate equality") }
func XCTAssertNil<T>(_ value: T?) { require(value == nil, "nil") }
func XCTAssertNotNil<T>(_ value: T?) { require(value != nil, "non-nil") }
func XCTAssertTrue(_ value: Bool) { require(value, "true") }
func testDraftRowGeometryPreservesFullFitAndOversizedNativeTarget() {
        let viewport = CGRect(x: 0, y: 124, width: 402, height: 570.3)
        let measured = ViewportGeometry.draftViewport(list: CGRect(x: 0, y: 0, width: 402, height: 785.3), application: CGRect(x: 0, y: 0, width: 402, height: 874), navigation: CGRect(x: 0, y: 62, width: 402, height: 54), fixed: [CGRect(x: 0, y: 702.3, width: 402, height: 83)])
        XCTAssertEqual(measured?.minY, 124)
        if let measured { XCTAssertEqual(measured.height, 570.3, accuracy: 0.01) }
        XCTAssertNil(ViewportGeometry.draftRowArea(row: CGRect(x: 0, y: 0, width: 402, height: 615), viewport: CGRect(x: 0, y: 280, width: 402, height: 43)))
        XCTAssertNotNil(ViewportGeometry.draftRowArea(row: CGRect(x: 0, y: 124, width: 402, height: 568.7), viewport: viewport))
        XCTAssertNil(ViewportGeometry.draftRowArea(row: CGRect(x: 0, y: 14.7, width: 402, height: 568.7), viewport: viewport))
        XCTAssertNotNil(ViewportGeometry.draftRowArea(row: CGRect(x: 0, y: 109.3, width: 402, height: 615), viewport: viewport))
        XCTAssertNil(ViewportGeometry.draftRowArea(row: CGRect(x: 0, y: 690, width: 402, height: 615), viewport: viewport))
        XCTAssertNil(ViewportGeometry.draftRowArea(row: CGRect(x: 0, y: 124, width: 43, height: 700), viewport: viewport))
        XCTAssertNil(ViewportGeometry.draftRowArea(row: CGRect(x: -1, y: 124, width: 402, height: 700), viewport: viewport))
        XCTAssertNil(ViewportGeometry.draftRowArea(row: .null, viewport: viewport))
        let pan = ViewportGeometry.draftAlignmentPan(row: CGRect(x: 0, y: 14.7, width: 402, height: 568.7), viewport: viewport)
        XCTAssertNotNil(pan)
        if let pan { XCTAssertTrue(viewport.contains(pan.start)); XCTAssertTrue(viewport.contains(pan.end)); XCTAssertEqual(pan.end.y - pan.start.y, 109.3, accuracy: 0.01) }
    }
testDraftRowGeometryPreservesFullFitAndOversizedNativeTarget()
require(observations == 14, "all14 original assertions reached")
print("GEOMETRY_REPLAY originalAssertions=14 scenarioInventory=10 pass=14 fail=0 XCTestRuntime=false")
