import Foundation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct VerificationCode: Equatable {
    let code: String
    /// UTF-16 offset in bodyText, or snippet when bodyText is empty.
    let start: Int

    static func detect(subject: String = "", bodyText: String? = nil, snippet: String = "") -> [VerificationCode] {
        // Cap before regex work, matching the shared detector's UTF-16 offsets.
        func capped(_ value: String) -> String { String(decoding: value.utf16.prefix(20_000), as: UTF16.self) }
        let text = capped((bodyText?.isEmpty == false ? bodyText : nil) ?? snippet) as NSString
        func matches(_ pattern: String, _ value: String, insensitive: Bool = false) -> [NSTextCheckingResult] {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: insensitive ? [.caseInsensitive] : []) else { return [] }
            return regex.matches(in: value, range: NSRange(location: 0, length: (value as NSString).length))
        }
        func has(_ pattern: String, _ value: String, insensitive: Bool = false) -> Bool { !matches(pattern, value, insensitive: insensitive).isEmpty }
        let keyword = #"\b(?:code|passcode|one-time|OTP|verification|verify|security code|sign[- ]in|login|2FA|PIN|confirmation code)\b"#
        let subjectSignal = has(keyword, capped(subject), insensitive: true)
        let signals = matches(keyword, text as String, insensitive: true)
        if !subjectSignal && signals.isEmpty { return [] }
        let tokens = matches(#"\S+"#, text as String)
        let scripts = matches(#"<script\b[^<>]*>[\s\S]*?(?:</script\s*>|$)"#, text as String, insensitive: true)
        // Space-separated groups must each contain a digit so adjacent prose stays outside the code.
        let candidates = matches(#"(?<![A-Za-z0-9\x{200B}-\x{200D}])(?!(?:CODE|OTP|PIN|VERIFY|LOGIN|2FA) )(?:[A-Za-z]-[0-9]{4,8}|[A-Z0-9]{1}-[A-Z0-9]{3,7}|[A-Z0-9]{2}-[A-Z0-9]{2,6}|[A-Z0-9]{3}-[A-Z0-9]{1,5}|[A-Z0-9]{4}-[A-Z0-9]{1,4}|[A-Z0-9]{5}-[A-Z0-9]{1,3}|[A-Z0-9]{6}-[A-Z0-9]{1,2}|[A-Z0-9]{7}-[A-Z0-9]{1,1}|(?=[A-Z0-9]{0,7}[0-9][A-Z0-9]{0,7} )(?:[A-Z0-9]{1} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{3,7}|[A-Z0-9]{2} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{2,6}|[A-Z0-9]{3} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{1,5}|[A-Z0-9]{4} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{1,4}|[A-Z0-9]{5} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{1,3}|[A-Z0-9]{6} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{1,2}|[A-Z0-9]{7} (?=[A-Z0-9]{0,7}[0-9])[A-Z0-9]{1,1})|[A-Z0-9]{4,8})(?![A-Za-z0-9\x{200B}-\x{200D}])"#, text as String)
        // Exclude whole dates: the candidate may combine the day and year.
        let dates = matches(#"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(?:0?[1-9]|[12][0-9]|3[01]),?\s+[0-9]{4}\b"#, text as String, insensitive: true)
        var signalIndex = 0, tokenIndex = 0, scriptIndex = 0, dateIndex = 0
        var results: [VerificationCode] = []
        for candidate in candidates {
            let start = candidate.range.location, end = NSMaxRange(candidate.range)
            while dateIndex < dates.count && NSMaxRange(dates[dateIndex].range) <= start { dateIndex += 1 }
            if dateIndex < dates.count && dates[dateIndex].range.location < end { continue }
            if has(#"^(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR|GU|VI|MP) [0-9]{5}$"#, text.substring(with: candidate.range)) { continue }
            if has(#"^(?:19|20)[0-9]{2}[- /](?:0?[1-9]|1[0-2])$"#, text.substring(with: candidate.range)) { continue }
            let code = text.substring(with: candidate.range).replacingOccurrences(of: #"^[A-Za-z]-(?=[0-9]{4,8}$)"#, with: "", options: .regularExpression).replacingOccurrences(of: "-", with: "").replacingOccurrences(of: " ", with: "")
            if !has(#"^(?:[0-9]{4,8}|(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{6,8})$"#, code) { continue }
            while signalIndex < signals.count && NSMaxRange(signals[signalIndex].range) < start - 80 { signalIndex += 1 }
            if !subjectSignal && (signalIndex == signals.count || signals[signalIndex].range.location > end + 80) { continue }
            while tokenIndex + 1 < tokens.count && tokens[tokenIndex + 1].range.location <= start { tokenIndex += 1 }
            let token = tokens.isEmpty ? "" : text.substring(with: tokens[tokenIndex].range)
            if has(#"://|www\.|@"#, token, insensitive: true) { continue }
            while scriptIndex < scripts.count && NSMaxRange(scripts[scriptIndex].range) <= start { scriptIndex += 1 }
            if scriptIndex < scripts.count && scripts[scriptIndex].range.location <= start { continue }
            let before = text.substring(with: NSRange(location: max(0, start - 35), length: min(start, 35)))
            let after = text.substring(with: NSRange(location: end, length: min(20, text.length - end)))
            if has(#"(?:order|tracking|invoice|ref)\b(?:\s+(?:code|passcode|OTP|PIN)\b[^\n]{0,24}|(?![^\n]{0,24}\b(?:code|passcode|OTP|PIN)\b)[^\n]{0,24})$"#, before, insensitive: true) { continue }
            if has(#"[$€]\s*$"#, before) { continue }
            if has(#"^\.[0-9]{2}"#, after) { continue }
            if has(#"[0-9][.:/\-]$"#, before) { continue }
            if has(#"^[.:/\-][0-9]"#, after) { continue }
            if has(#"\([0-9]{2,4}\)\s*$"#, before) { continue }
            if has(#"\+[^A-Za-z\n]*$"#, before) { continue }
            if has(#"[0-9][ -]$"#, before) { continue }
            if has(#"^[ -][0-9]"#, after) { continue }
            if has(#"\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR|GU|VI|MP)\s+$"#, before) && has(#"^[0-9]{5}$"#, code) { continue }
            if has(#"^(?:19|20)[0-9]{2}$"#, code) && (has(#"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*$"#, before, insensitive: true) || has(#"^\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b"#, after, insensitive: true)) { continue }
            if !results.contains(where: { $0.code == code }) { results.append(.init(code: code, start: start)) }
            if results.count == 2 { break }
        }
        return results
    }
}

struct VerificationCodeStrip: View {
    let codes: [VerificationCode]
    @State private var revealed = false
    @State private var status = ""
    var body: some View {
        if !codes.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Verification code").font(OrcaTheme.ui(12, weight: .semibold))
                ForEach(codes, id: \.start) { item in
                    HStack {
                        Text(revealed ? item.code : String(repeating: "•", count: item.code.count)).font(.system(.body, design: .monospaced))
                        Button(revealed ? "Hide" : "Reveal") { revealed.toggle() }
                        Button("Copy") {
                            UIPasteboard.general.setItems([[UTType.plainText.identifier: item.code]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(60)])
                            status = UIPasteboard.general.string == item.code ? "Code copied." : "Could not copy. Reveal the code to copy it manually."
                            UIAccessibility.post(notification: .announcement, argument: status)
                        }
                    }.buttonStyle(.bordered)
                }
                Text(status).font(OrcaTheme.ui(12)).accessibilityLabel(status)
            }.foregroundStyle(OrcaTheme.ink)
        }
    }
}
