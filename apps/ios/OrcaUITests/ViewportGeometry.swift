import Foundation
import CoreGraphics

/// UI-test stimulus geometry only. This does not change app layout or state.
enum ViewportGeometry {
    struct Pan { var start: CGPoint; var end: CGPoint }
    static func content(form: CGRect, application: CGRect, navigation: CGRect, fixed: [CGRect]) -> CGRect? {
        guard valid(form), valid(application), valid(navigation) else { return nil }
        let frame = form.intersection(application)
        guard valid(frame), frame.width > 20 else { return nil }
        let top = max(frame.minY, navigation.maxY) + 2
        let boundaries = fixed.filter { valid($0) && $0.intersects(frame) && $0.maxY > top }
        let bottom = min(frame.maxY, boundaries.map(\.minY).min() ?? frame.maxY) - 2
        guard bottom > top else { return nil }
        return CGRect(x: frame.minX + 6, y: top, width: frame.width - 12, height: bottom - top)
    }
    static func writingArea(body: CGRect, viewport: CGRect) -> CGRect? {
        guard valid(body), valid(viewport) else { return nil }
        let visible = body.intersection(viewport)
        return valid(visible) && visible.width >= 44 && visible.height >= 44 ? visible : nil
    }
    static func pan(in viewport: CGRect, up: Bool) -> Pan? {
        guard valid(viewport), viewport.width > 8, viewport.height >= 20 else { return nil }
        // Use the form/list padding beside its text editor/rows, not an inner
        // TextEditor pan or fixed-footer background within an outer frame.
        let x = viewport.maxX - 4
        let high = viewport.minY + viewport.height * 0.2
        let low = viewport.maxY - viewport.height * 0.2
        return Pan(start: CGPoint(x: x, y: up ? low : high), end: CGPoint(x: x, y: up ? high : low))
    }
    // Keep the original eight-point vertical exclusion around navigation/tabs.
    // Row visibility uses the actual content width; pan() separately stays in padding.
    static func draftViewport(list: CGRect, application: CGRect, navigation: CGRect, fixed: [CGRect]) -> CGRect? {
        guard let available = content(form: list, application: application, navigation: navigation, fixed: fixed) else { return nil }
        let frame = list.intersection(application)
        let viewport = CGRect(x: frame.minX, y: available.minY + 6, width: frame.width, height: available.height - 12)
        return valid(viewport) ? viewport : nil
    }
    static func draftRowArea(row: CGRect, viewport: CGRect) -> CGRect? {
        guard valid(row), valid(viewport), row.minX >= viewport.minX, row.maxX <= viewport.maxX else { return nil }
        let visible = row.intersection(viewport)
        guard valid(visible), visible.width >= 44, visible.height >= 44 else { return nil }
        if row.height <= viewport.height { return viewport.contains(row) ? visible : nil }
        // Preserve a real native tap target within the visible portion. This is
        // geometry only; it does not establish XCTest's eventual hit point.
        guard viewport.contains(CGPoint(x: row.midX, y: row.midY)) else { return nil }
        return visible
    }
    static func draftAlignmentPan(row: CGRect, viewport: CGRect) -> Pan? {
        guard valid(row), valid(viewport), viewport.height > 20 else { return nil }
        let shift: CGFloat
        if row.height > viewport.height { shift = viewport.midY - row.midY }
        else if row.minY < viewport.minY { shift = viewport.minY - row.minY }
        else if row.maxY > viewport.maxY { shift = viewport.maxY - row.maxY }
        else { return nil }
        let start = CGPoint(x: viewport.maxX - 4, y: viewport.midY)
        let end = CGPoint(x: start.x, y: min(viewport.maxY - 8, max(viewport.minY + 8, start.y + shift)))
        return end.y != start.y ? Pan(start: start, end: end) : nil
    }
    private static func valid(_ rect: CGRect) -> Bool {
        !rect.isNull && !rect.isInfinite && !rect.isEmpty && [rect.minX, rect.minY, rect.width, rect.height].allSatisfy(\.isFinite)
    }
}
