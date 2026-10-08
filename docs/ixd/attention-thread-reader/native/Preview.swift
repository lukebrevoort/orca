import SwiftUI

// Independent review app. No API client, credentials, account state, or writes.
struct Person: Decodable { let name: String?; let email: String }
struct Attachment: Decodable, Identifiable { let id: String; let filename: String; let size: Int }
struct Mail: Decodable, Identifiable {
    let id: String; let from: Person; let to: [Person]; let cc: [Person]
    let subject: String; let snippet: String; let receivedAt: String; var unread: Bool
    let bodyText: String?; let bodyHtml: String?; let attachments: [Attachment]
}
struct Row: Decodable, Identifiable { let id: String; let from: Person; let subject: String; let snippet: String; let receivedAt: String; let attentionBehavior: String }
struct Fixture: Decodable { let messages: [Mail]; let inbox: [Row] }
let fixture: Fixture = try! JSONDecoder().decode(Fixture.self, from: Data(contentsOf: Bundle.main.url(forResource: "fixture", withExtension: "json")!))
let previewMessages = fixture.messages.map { original -> Mail in var mail = original; if CommandLine.arguments.contains("--allread") { mail.unread = false }; return mail }
let order = ["notify", "focus", "normal", "quiet", "hidden"]

func quoteParts(_ body: String) -> (String, String) {
    let lines = body.components(separatedBy: "\n")
    guard let first = lines.indices.first(where: { $0 > 0 && lines[$0].hasPrefix("On ") && lines[$0].hasSuffix("wrote:") }) else { return (body, "") }
    let rest = lines.dropFirst(first + 1)
    guard rest.contains(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix(">") }), rest.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty || $0.trimmingCharacters(in: .whitespaces).hasPrefix(">") }) else { return (body, "") }
    let current = lines.prefix(first).joined(separator: "\n") + "\n"
    return (current, lines.dropFirst(first).joined(separator: "\n"))
}
func timestamp(_ raw: String) -> String { let p = raw.split(separator:"T"); return "Oct \(Int(p[0].suffix(2)) ?? 1) · \(p[1].prefix(5))" }

@main struct ReaderPreviewApp: App {
    var body: some Scene { WindowGroup { PreviewView().preferredColorScheme(CommandLine.arguments.contains("--dark") ? .dark : .light).environment(\.dynamicTypeSize, CommandLine.arguments.contains("--large") ? .accessibility3 : .large) } }
}
struct PreviewView: View {
    @State private var inbox = CommandLine.arguments.contains("--inbox")
    @State private var opened: Set<String> = [CommandLine.arguments.contains("--allread") ? "synthetic-message-24" : "synthetic-message-22"]
    @State private var earlier = false
    @State private var originals = Set<String>()
    @State private var why = false
    var firstUnread: Int { previewMessages.firstIndex(where: \.unread) ?? 23 }
    var unreadCount: Int { previewMessages.filter(\.unread).count }
    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment:.leading, spacing:18) {
                        Text("DESIGN PREVIEW · SYNTHETIC MAIL").font(OrcaTheme.ui(9)).tracking(1).foregroundStyle(OrcaTheme.accent)
                        if inbox { inboxContent } else {
                            heading
                            ViewThatFits(in: .horizontal) {
                                HStack { navigationButtons(proxy) }
                                VStack(alignment:.leading) { navigationButtons(proxy) }
                            }.font(OrcaTheme.ui(11)).buttonStyle(.bordered)
                            Button { earlier.toggle() } label: { HStack { Label("\(firstUnread) earlier messages",systemImage:earlier ? "minus" : "plus"); Spacer(); Text(firstUnread == 21 ? "Oct 1–7" : "Oct 1–8").foregroundStyle(OrcaTheme.muted) }.font(OrcaTheme.ui(11)).padding(14).frame(maxWidth:.infinity,alignment:.leading).background(OrcaTheme.selected,in:RoundedRectangle(cornerRadius:10)) }.foregroundStyle(OrcaTheme.ink).accessibilityValue(earlier ? "Expanded" : "Collapsed")
                            ForEach(Array(previewMessages.enumerated()), id:\.element.id) { index, mail in
                                if earlier || index >= firstUnread {
                                    if index == firstUnread && unreadCount > 0 { HStack { Text("First unread"); Spacer(); Text("Thursday, October 8") }.font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.accent) }
                                    messageCard(mail).id(mail.id)
                                }
                            }
                            Text("All 24 messages remain available.").font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                        }
                    }.padding(20)
                }.background(OrcaTheme.paper)
            }
            .navigationTitle(inbox ? "All mail" : "Conversation").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement:.topBarLeading) { Button(inbox ? "Read thread" : "All mail") { inbox.toggle() }.font(OrcaTheme.ui(12)) } }
            .safeAreaInset(edge:.bottom) { if !inbox { VStack(spacing:4) { HStack { Button("Reply") {}; Button("Reply all") {}; Button("Forward") {} }.buttonStyle(.bordered).disabled(true); Text("Sending is unavailable in this preview.").font(OrcaTheme.ui(9)).foregroundStyle(OrcaTheme.muted) }.padding(10).frame(maxWidth:.infinity).background(OrcaTheme.paper) } }
        }.tint(OrcaTheme.accent)
    }
    var heading: some View {
        VStack(alignment:.leading,spacing:12) {
            HStack { Text("CONVERSATION").font(OrcaTheme.ui(10)).tracking(1); Text("Focus").font(OrcaTheme.ui(10)).padding(.horizontal,8).padding(.vertical,3).background(OrcaTheme.selected,in:RoundedRectangle(cornerRadius:5)) }.foregroundStyle(OrcaTheme.accent)
            Text("Reading room · opening weekend").font(OrcaTheme.reader(34)).foregroundStyle(OrcaTheme.ink).fixedSize(horizontal:false,vertical:true)
            Text("Maya, Noah & you · 24 messages · \(unreadCount) unread").font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
            HStack { Text("Space: Everything else"); Button("Why Focus?") { why.toggle() } }.font(OrcaTheme.ui(10))
            if why { Text("Current attention: Focus. Rule provenance is unavailable. A space describes placement, not priority.").font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted) }
        }
    }
    @ViewBuilder func navigationButtons(_ proxy: ScrollViewProxy) -> some View {
        Button("First unread · \(unreadCount)") { jump(previewMessages[firstUnread].id, proxy) }.disabled(unreadCount == 0)
        Button("Newest ↓") { jump("synthetic-message-24", proxy) }
        Button(opened.count == 24 ? "Collapse all" : "Expand all") { let all = opened.count == 24; earlier = !all; opened = all ? [previewMessages[firstUnread].id] : Set(previewMessages.map(\.id)) }
    }
    func jump(_ id: String, _ proxy: ScrollViewProxy) { earlier = true; opened.insert(id); DispatchQueue.main.async { proxy.scrollTo(id,anchor:.top) } }
    func messageCard(_ mail: Mail) -> some View {
        let open = opened.contains(mail.id)
        return VStack(alignment:.leading,spacing:0) {
            Button { if open { opened.remove(mail.id) } else { opened.insert(mail.id) } } label: {
                HStack(alignment:.top,spacing:10) {
                    Text(mail.from.name!.split(separator:" ").compactMap(\.first).map(String.init).joined()).font(OrcaTheme.ui(10)).frame(width:30,height:30).background(OrcaTheme.selected,in:RoundedRectangle(cornerRadius:10))
                    VStack(alignment:.leading,spacing:5) {
                        HStack { Text(mail.from.name!).font(OrcaTheme.ui(12,weight:.semibold)); if mail.unread { Text("Unread").font(OrcaTheme.ui(9)).foregroundStyle(OrcaTheme.accent) } }
                        Text("To \(mail.to.map { $0.name ?? $0.email }.joined(separator:", "))\(mail.cc.isEmpty ? "" : " · Cc \(mail.cc.count)")").font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.muted)
                        if !open { Text(mail.snippet).font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted).lineLimit(1) }
                    }
                    Spacer(minLength:4)
                    VStack(alignment:.trailing,spacing:6) { Text(timestamp(mail.receivedAt)).font(OrcaTheme.ui(9)); Image(systemName:open ? "minus" : "plus").font(.caption) }.foregroundStyle(OrcaTheme.muted)
                }.padding(14).frame(maxWidth:.infinity,alignment:.leading).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                VStack(alignment:.leading,spacing:16) {
                    DisclosureGroup {
                        Text("From: \(mail.from.email)\nTo: \(mail.to.map(\.email).joined(separator:", "))\nCc: \(mail.cc.map(\.email).joined(separator:", "))\nSent: \(mail.receivedAt)").font(OrcaTheme.ui(11)).textSelection(.enabled)
                    } label: { Text("\(mail.from.email) · Details").font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.muted) }
                    let parts = quoteParts(mail.bodyText ?? mail.snippet)
                    Text(originals.contains(mail.id) ? mail.bodyText! : parts.0).font(OrcaTheme.reader(22)).lineSpacing(5).foregroundStyle(OrcaTheme.ink).textSelection(.enabled).fixedSize(horizontal:false,vertical:true)
                    if !originals.contains(mail.id), !parts.1.isEmpty { DisclosureGroup("Quoted history · show") { Text(parts.1).font(OrcaTheme.reader(18)).textSelection(.enabled) }.font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted) }
                    Button(originals.contains(mail.id) ? "Return to reading view" : "Show complete original text") { if originals.contains(mail.id) { originals.remove(mail.id) } else { originals.insert(mail.id) } }.font(OrcaTheme.ui(11))
                    if let html = mail.bodyHtml { DisclosureGroup("Complete email layout") { SafeHTMLView(html:html).fixedSize(horizontal:false,vertical:true) }.font(OrcaTheme.ui(11)) }
                    ForEach(mail.attachments) { attachment in VStack(alignment:.leading,spacing:5) { Label(attachment.filename,systemImage:"paperclip").font(OrcaTheme.ui(12)); Text("42 KB · Download unavailable in preview").font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.muted) }.padding(.top,5) }
                }.padding(.horizontal,16).padding(.bottom,18)
            }
        }.background(OrcaTheme.surface,in:RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(open ? OrcaTheme.muted : OrcaTheme.border,lineWidth:1)).foregroundStyle(OrcaTheme.ink)
    }
    var inboxContent: some View {
        VStack(alignment:.leading,spacing:20) {
            Text("All mail").font(OrcaTheme.reader(38))
            Text("Sorted by attention, then newest in each group.").font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
            ForEach(order,id:\.self) { behavior in
                VStack(alignment:.leading,spacing:10) {
                    HStack { Text(behavior.capitalized).font(OrcaTheme.reader(28)); Spacer(); Text("2 conversations").font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.muted) }
                    let rows = fixture.inbox.filter { $0.attentionBehavior == behavior }.sorted { $0.receivedAt > $1.receivedAt }
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        if index == 0 || dateGroup(row) != dateGroup(rows[index - 1]) {
                            Text(dateGroup(row)).font(OrcaTheme.ui(9)).tracking(1).foregroundStyle(OrcaTheme.muted)
                        }
                        if row.subject == "Reading room · opening weekend" {
                            Button { inbox = false } label: { rowContent(row) }.buttonStyle(.plain)
                        } else { rowContent(row) }
                    }
                }
            }
        }.foregroundStyle(OrcaTheme.ink)
    }
    func dateGroup(_ row: Row) -> String { row.receivedAt.contains("10-08") ? "TODAY" : row.receivedAt.contains("10-07") ? "YESTERDAY" : "EARLIER THIS WEEK" }
    func rowContent(_ row: Row) -> some View {
        VStack(alignment:.leading,spacing:7) {
            HStack { Text(row.from.name!).font(OrcaTheme.ui(12,weight:.semibold)); Spacer(); Text(row.attentionBehavior.capitalized).font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.accent) }
            Text(row.subject).font(OrcaTheme.ui(13))
            Text("Space: Everything else").font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.muted)
        }.padding(14).frame(maxWidth:.infinity,alignment:.leading).background(OrcaTheme.surface,in:RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(OrcaTheme.border,lineWidth:1))
    }
}
