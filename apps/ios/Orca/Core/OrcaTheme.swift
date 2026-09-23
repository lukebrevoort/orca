import SwiftUI

/// Shared with apps/web/src/desktop-switch.css. Semantic colors adapt as one system.
enum OrcaTheme {
    static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in UIColor(orcaHex: traits.userInterfaceStyle == .dark ? dark : light) })
    }
    static let paper = adaptive(0xf6faf7, 0x050505)
    static let surface = adaptive(0xffffff, 0x0d0d0d)
    static let ink = adaptive(0x102522, 0xf4f3ef)
    static let muted = adaptive(0x51645e, 0xb1b1ab)
    static let border = adaptive(0xd2ddd7, 0x242424)
    static let danger = adaptive(0xa8463f, 0xff8b87)
    static let accent = adaptive(0x087461, 0x6aa9f5)
    static let selected = adaptive(0xe8f1ec, 0x171717)
    static let unread = adaptive(0xf0f8f4, 0x121212)
    static let primary = adaptive(0x087461, 0xf4f3ef)
    static let primaryPressed = adaptive(0x065746, 0xd5d4d0)
    static let onPrimary = adaptive(0xffffff, 0x050505)

    static func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom("Sora-Regular", size: size, relativeTo: .body).weight(weight)
    }
    static func reader(_ size: CGFloat) -> Font {
        .custom("Newsreader16pt-Regular", size: size, relativeTo: .body)
    }
    static func configureNavigation() {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(orcaHex: 0x050505) : UIColor(orcaHex: 0xf6faf7) }
        let label = UIColor { $0.userInterfaceStyle == .dark ? UIColor(orcaHex: 0xf4f3ef) : UIColor(orcaHex: 0x102522) }
        appearance.titleTextAttributes = [.font: UIFont(name: "Sora-Regular", size: 15) ?? UIFont.systemFont(ofSize: 15), .foregroundColor: label]
        appearance.largeTitleTextAttributes = [.font: UIFont(name: "Newsreader16pt-Regular", size: 38) ?? UIFont.systemFont(ofSize: 38, weight: .regular), .foregroundColor: label]
        appearance.shadowColor = .clear
        UINavigationBar.appearance().standardAppearance = appearance
        UINavigationBar.appearance().scrollEdgeAppearance = appearance
        UINavigationBar.appearance().compactAppearance = appearance
    }
}

extension UIColor {
    convenience init(orcaHex: UInt32) {
        self.init(red: CGFloat((orcaHex >> 16) & 255) / 255, green: CGFloat((orcaHex >> 8) & 255) / 255, blue: CGFloat(orcaHex & 255) / 255, alpha: 1)
    }
}

struct OrcaPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(OrcaTheme.ui(14, weight: .semibold))
            .padding(.horizontal, 16).frame(minHeight: 44)
            .foregroundStyle(enabled ? OrcaTheme.onPrimary : OrcaTheme.muted)
            .background(enabled ? (configuration.isPressed ? OrcaTheme.primaryPressed : OrcaTheme.primary) : OrcaTheme.selected, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(OrcaTheme.border, lineWidth: enabled ? 0 : 1))
    }
}

struct OrcaWordmark: View {
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        HStack(spacing: 8) {
            Text("orca").font(OrcaTheme.reader(30)).fontWeight(.semibold).tracking(-1.5)
            if colorScheme == .dark { Image("OrcaBlackMark").resizable().frame(width: 22, height: 22) }
            else { OrcaWave().stroke(OrcaTheme.accent, style: StrokeStyle(lineWidth: 1.8, lineCap: .round)).frame(width: 24, height: 24) }
        }.foregroundStyle(OrcaTheme.ink).accessibilityElement(children: .ignore).accessibilityLabel("Orca")
    }
}

/// The light wordmark's wave paths, translated directly from the web WaveGlyph.
private struct OrcaWave: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        for y in [8.5, 14.5] {
            p.move(to: CGPoint(x: 3, y: y))
            p.addCurve(to: CGPoint(x: 10.1, y: y), control1: CGPoint(x: 5.5, y: y - 2.7), control2: CGPoint(x: 7.6, y: y - 2.7))
            p.addCurve(to: CGPoint(x: 17.2, y: y), control1: CGPoint(x: 12.6, y: y + 2.7), control2: CGPoint(x: 14.7, y: y + 2.7))
            p.addCurve(to: CGPoint(x: 21, y: y - 2.7), control1: CGPoint(x: 19.7, y: y - 2.7), control2: CGPoint(x: 21, y: y - 2.7))
        }
        return p.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24))
    }
}
