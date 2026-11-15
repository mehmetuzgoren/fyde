import SwiftUI

public struct ChatTabView: View {
    @Bindable var store: FydeStore
    var onOpenSettings: () -> Void

    @State private var draftText: String = ""
    @State private var showPermissionsSheet = false
    @State private var showVexoSheet = false
    @FocusState private var composerFocused: Bool
    #if os(iOS)
    @State private var composeIMessageRecipient: String?
    @State private var composeIMessageBody: String = ""
    #endif

    /// The conversation counts as started once the user has said something.
    private var hasConversation: Bool {
        store.chatMessages.contains { $0.role == "user" }
    }

    private var canSend: Bool {
        !store.isSendingChat && !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Active `@handle` query at the end of `draftText`, if any.
    private var activeAtQuery: String? {
        guard let lastAt = draftText.lastIndex(of: "@") else { return nil }
        if lastAt > draftText.startIndex {
            let prev = draftText[draftText.index(before: lastAt)]
            if !prev.isWhitespace { return nil }
        }
        let suffix = String(draftText[draftText.index(after: lastAt)...])
        if suffix.contains(where: \.isWhitespace) { return nil }
        return suffix.lowercased()
    }

    private var mentionSuggestions: [(handle: String, displayName: String)] {
        guard let query = activeAtQuery else { return [] }
        var seen = Set<String>()
        var pool: [(handle: String, displayName: String)] = []
        for f in store.socialFriends {
            let h = f.handle.lowercased()
            if seen.insert(h).inserted { pool.append((h, f.displayName)) }
        }
        for p in store.permissions {
            if let h = p.contactHandle?.lowercased(), !h.isEmpty, seen.insert(h).inserted {
                pool.append((h, p.contactName))
            }
        }
        for u in store.users where u.id != store.currentUserId {
            let h = u.handle.lowercased()
            if seen.insert(h).inserted { pool.append((h, u.displayName)) }
        }
        if query.isEmpty { return Array(pool.prefix(6)) }
        return Array(pool.filter { $0.handle.contains(query) || $0.displayName.lowercased().contains(query) }.prefix(6))
    }

    private func insertMention(_ handle: String) {
        guard let lastAt = draftText.lastIndex(of: "@") else { return }
        draftText = String(draftText[..<lastAt]) + "@\(handle) "
        composerFocused = true
    }

    /// Two starter suggestions for an empty conversation.
    private var suggestions: [String] {
        [
            "Find my recent photos",
            "Find PDFs or documents"
        ]
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            conversation
            composerArea
        }
        .background(FydeTheme.paper.ignoresSafeArea())
        .sheet(isPresented: $showPermissionsSheet) {
            PermissionsSheetView(store: store)
        }
        .sheet(isPresented: $showVexoSheet) {
            VexoBandSheetView(store: store)
        }
        #if os(iOS)
        .sheet(isPresented: Binding(
            get: { composeIMessageRecipient != nil },
            set: { if !$0 { composeIMessageRecipient = nil } }
        )) {
            if let rec = composeIMessageRecipient {
                IOSMessageComposerSheet(
                    recipients: [rec],
                    body: composeIMessageBody,
                    onFinish: { composeIMessageRecipient = nil }
                )
            }
        }
        #endif
    }

    // MARK: Header

    private var header: some View {
        VStack(spacing: 6) {
            FydeTopBar {
                FydeAccountMenu(store: store, onOpenSettings: onOpenSettings)
            } center: {
                FydeWordmarkView(size: 28)
                    .accessibilityLabel("fyde chat")
            } trailing: {
                Button {
                    showPermissionsSheet = true
                } label: {
                    FydeCircleIcon(systemName: "person.2.badge.key")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("People and access")
            }

            VexoRibbonPillView(vexo: store.vexo) {
                showVexoSheet = true
            }
            .padding(.bottom, 6)
        }
        .frame(maxWidth: .infinity)
        .background(FydeTheme.paper)
        .overlay(alignment: .bottom) {
            if hasConversation {
                Rectangle().fill(FydeTheme.line).frame(height: 1)
            }
        }
    }

    // MARK: Conversation

    private var conversation: some View {
        GeometryReader { geo in
            ScrollViewReader { proxy in
                ScrollView {
                    if hasConversation {
                        messageList
                            .frame(maxWidth: 720)
                            .frame(maxWidth: .infinity)
                    } else {
                        welcomeHero
                            .frame(maxWidth: 720)
                            .frame(maxWidth: .infinity, minHeight: geo.size.height, alignment: .bottom)
                    }
                }
                .scrollDismissesKeyboard(.interactively)
                .defaultScrollAnchor(hasConversation ? .bottom : .top)
                .onChange(of: store.chatMessages.count) { _, _ in
                    scrollToBottom(proxy)
                }
                .onChange(of: store.isSendingChat) { _, _ in
                    scrollToBottom(proxy)
                }
                .onChange(of: composerFocused) { _, focused in
                    if focused { scrollToBottom(proxy, delay: 0.3) }
                }
            }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, delay: Double = 0.05) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            withAnimation(.easeOut(duration: 0.25)) {
                proxy.scrollTo("chat-bottom", anchor: .bottom)
            }
        }
    }

    private struct RowModel: Identifiable {
        let message: ChatMessage
        let dayLabel: String?
        let startsRun: Bool
        let endsRun: Bool
        var id: String { message.id }
    }

    private var rowModels: [RowModel] {
        let msgs = store.chatMessages
        let days: [Date?] = msgs.map { FydeFormat.date($0.createdAt) }
        let cal = Calendar.current
        return msgs.indices.map { i in
            let prevDay = i > 0 ? days[i - 1] : nil
            let newDay: Bool = {
                guard let d = days[i] else { return i == 0 }
                guard let p = prevDay else { return true }
                return !cal.isDate(d, inSameDayAs: p)
            }()
            let nextDifferent: Bool = {
                guard i + 1 < msgs.count else { return true }
                if msgs[i + 1].role != msgs[i].role { return true }
                if let d = days[i], let n = days[i + 1] { return !cal.isDate(d, inSameDayAs: n) }
                return false
            }()
            return RowModel(
                message: msgs[i],
                dayLabel: newDay ? days[i].map(FydeFormat.dayLabel) : nil,
                startsRun: newDay || i == 0 || msgs[i - 1].role != msgs[i].role,
                endsRun: nextDifferent
            )
        }
    }

    private var messageList: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(rowModels) { row in
                if let day = row.dayLabel {
                    Text(day)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(FydeTheme.muted)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(FydeTheme.sunken, in: Capsule())
                        .frame(maxWidth: .infinity)
                        .padding(.top, 14)
                        .padding(.bottom, 6)
                }

                Group {
                    if row.message.role == "user" {
                        UserMessageRow(message: row.message, showTime: row.endsRun)
                    } else {
                        AssistantMessageRow(
                            message: row.message,
                            startsRun: row.startsRun,
                            store: store,
                            onOpenIMessageFallback: openIMessageFallback
                        )
                    }
                }
                .padding(.top, row.startsRun ? 14 : 4)
                .id(row.id)
            }

            if store.isSendingChat {
                TypingRow()
                    .padding(.top, 14)
                    .transition(.opacity)
            }

            Color.clear
                .frame(height: 12)
                .id("chat-bottom")
        }
        .padding(.horizontal, 16)
        .animation(.easeOut(duration: 0.2), value: store.isSendingChat)
    }

    private func openIMessageFallback(_ recipient: String, _ text: String) {
        #if os(iOS)
        if IOSMessageComposerSheet.canSendMessages {
            composeIMessageBody = text
            composeIMessageRecipient = recipient
        } else {
            store.statusBanner = "iMessage compose requires a physical iPhone with Messages configured."
        }
        #endif
    }

    // MARK: Empty conversation

    private var welcomeHero: some View {
        VStack(spacing: 8) {
            Spacer(minLength: 0)
            ForEach(suggestions, id: \.self) { prompt in
                Button {
                    useSuggestion(prompt)
                } label: {
                    HStack(spacing: 12) {
                        Text(prompt)
                            .font(.callout)
                            .foregroundStyle(FydeTheme.ink)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "arrow.down")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(FydeTheme.muted)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .background(FydeTheme.paper, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(FydeTheme.line, lineWidth: 1)
                    )
                    .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityHint("Puts this request in the message box")
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 2)
    }

    private func useSuggestion(_ prompt: String) {
        draftText = prompt
        composerFocused = true
    }

    // MARK: Composer

    private var composerArea: some View {
        VStack(spacing: 10) {
            if !mentionSuggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(mentionSuggestions, id: \.handle) { item in
                            Button {
                                insertMention(item.handle)
                            } label: {
                                HStack(spacing: 4) {
                                    Text("@\(item.handle)")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(FydeTheme.accent)
                                    Text(item.displayName)
                                        .font(.caption)
                                        .foregroundStyle(FydeTheme.inkSecondary)
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(FydeTheme.surface, in: Capsule())
                                .overlay(Capsule().strokeBorder(FydeTheme.line, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }

            if store.vexo.isListeningVoice {
                VexoLiveMicBannerView(vexo: store.vexo)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            HStack(alignment: .bottom, spacing: 4) {
                micButton
                TextField("Ask fyde to send, get, or share…", text: $draftText, axis: .vertical)
                    .lineLimit(1...5)
                    .font(.callout)
                    .foregroundStyle(FydeTheme.ink)
                    .textFieldStyle(.plain)
                    .focused($composerFocused)
                    .padding(.vertical, 12)
                    .onSubmit(submitPrompt)
                sendButton
            }
            .padding(.horizontal, 6)
            .background(FydeTheme.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .strokeBorder(composerFocused ? FydeTheme.accent.opacity(0.45) : FydeTheme.line, lineWidth: 1)
            )
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .frame(maxWidth: 720)
        .frame(maxWidth: .infinity)
        .background(FydeTheme.paper)
        .animation(.spring(duration: 0.3), value: store.vexo.isListeningVoice)
    }

    private var sendButton: some View {
        Button(action: submitPrompt) {
            ZStack {
                Circle()
                    .fill(canSend ? FydeTheme.accent : FydeTheme.sunken)
                if store.isSendingChat {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(canSend ? Color.white : FydeTheme.muted)
                }
            }
            .frame(width: 34, height: 34)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .padding(.bottom, 6)
        .animation(.easeOut(duration: 0.15), value: canSend)
        .accessibilityLabel("Send")
    }

    private var micButton: some View {
        let listening = store.vexo.isListeningVoice
        let connected = store.vexo.isConnected
        return Button {
            if connected {
                if !store.vexo.hasDeepgramKey && store.vexo.transportKind != .simulator {
                    showVexoSheet = true
                } else {
                    Task { await store.vexo.toggleVoiceListening() }
                }
            } else {
                showVexoSheet = true
            }
        } label: {
            Image(systemName: listening ? "waveform" : "applewatch.radiowaves.left.and.right")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(listening ? FydeTheme.live : (connected ? FydeTheme.accent : FydeTheme.muted))
                .frame(width: 34, height: 34)
                .background(listening ? FydeTheme.liveSoft : (connected ? FydeTheme.accentSoft : Color.clear), in: Circle())
        }
        .buttonStyle(.plain)
        .padding(.bottom, 6)
        .help("Speak via Vexo-HACK-69 wristband")
        .accessibilityLabel(listening ? "Stop wrist microphone" : (connected ? "Speak through Vexo band" : "Connect Vexo band"))
    }

    private func submitPrompt() {
        let prompt = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !store.isSendingChat else { return }
        draftText = ""
        Task { await store.sendChatPrompt(prompt) }
    }
}

// MARK: - Message Rows

private struct UserMessageRow: View {
    let message: ChatMessage
    let showTime: Bool

    var body: some View {
        HStack {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: 4) {
                Text(.init(message.text))
                    .font(.callout)
                    .foregroundStyle(.white)
                    .tint(.white)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        FydeTheme.accent,
                        in: UnevenRoundedRectangle(
                            topLeadingRadius: 20,
                            bottomLeadingRadius: 20,
                            bottomTrailingRadius: 6,
                            topTrailingRadius: 20,
                            style: .continuous
                        )
                    )
                if showTime, let t = FydeFormat.time(message.createdAt) {
                    Text("You · \(t)")
                        .font(.caption2)
                        .foregroundStyle(FydeTheme.muted)
                        .padding(.trailing, 4)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You said: \(message.text)")
    }
}

private struct AssistantMessageRow: View {
    let message: ChatMessage
    let startsRun: Bool
    let store: FydeStore
    let onOpenIMessageFallback: (String, String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Group {
                if startsRun {
                    FydeMark(size: 28)
                } else {
                    Color.clear
                }
            }
            .frame(width: 30, height: 30)
            .padding(.top, startsRun ? 2 : 0)

            VStack(alignment: .leading, spacing: 6) {
                if startsRun {
                    HStack(spacing: 6) {
                        Text("fyde")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(FydeTheme.ink)
                        if let t = FydeFormat.time(message.createdAt) {
                            Text(t)
                                .font(.caption2)
                                .foregroundStyle(FydeTheme.muted)
                        }
                    }
                }

                if !message.text.isEmpty {
                    Text(.init(message.text))
                        .font(.callout)
                        .foregroundStyle(FydeTheme.ink)
                        .tint(FydeTheme.accent)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            FydeTheme.surface,
                            in: UnevenRoundedRectangle(
                                topLeadingRadius: 6,
                                bottomLeadingRadius: 20,
                                bottomTrailingRadius: 20,
                                topTrailingRadius: 20,
                                style: .continuous
                            )
                        )
                        .overlay(
                            UnevenRoundedRectangle(
                                topLeadingRadius: 6,
                                bottomLeadingRadius: 20,
                                bottomTrailingRadius: 20,
                                topTrailingRadius: 20,
                                style: .continuous
                            )
                            .strokeBorder(FydeTheme.line, lineWidth: 1)
                        )
                }

                if let card = message.actionCard {
                    ChatActionCardView(
                        messageId: message.id,
                        card: card,
                        store: store,
                        onOpenIMessageFallback: onOpenIMessageFallback
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.trailing, message.actionCard == nil ? 28 : 0)
        }
    }
}

private struct TypingRow: View {
    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            FydeMark(size: 28)
                .frame(width: 30, height: 30)
            TimelineView(.animation(minimumInterval: 0.08)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                HStack(spacing: 5) {
                    ForEach(0..<3, id: \.self) { i in
                        let phase = sin(t * 5.5 - Double(i) * 0.7)
                        Circle()
                            .fill(FydeTheme.muted)
                            .frame(width: 7, height: 7)
                            .opacity(0.35 + 0.65 * max(0, phase))
                            .offset(y: -2.5 * max(0, phase))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(FydeTheme.surface, in: Capsule())
                .overlay(Capsule().strokeBorder(FydeTheme.line, lineWidth: 1))
            }
            Spacer()
        }
        .accessibilityLabel("fyde is working on it")
    }
}

// MARK: - Action Card

private struct ChatActionCardView: View {
    let messageId: String
    let card: ChatActionCard
    let store: FydeStore
    let onOpenIMessageFallback: (String, String) -> Void
    @State private var isConfirming = false

    private struct Meta {
        let icon: String
        let tone: FydeTone
        let title: String
        let subtitle: String?
        let status: String
    }

    private var itemCount: Int {
        max(card.previews.count, card.bundle?.items.count ?? 0, card.assetIds.count)
    }

    private var itemsLabel: String {
        itemCount == 1 ? "1 item" : "\(itemCount) items"
    }

    private var meta: Meta {
        let recipient = card.recipientName ?? card.bundle?.recipientName ?? card.permission?.contactName
        switch card.actionType {
        case "send_completed":
            let via = card.channel.map { " · \($0.label)" } ?? ""
            return Meta(
                icon: "paperplane.fill",
                tone: .success,
                title: recipient.map { "Sent to \($0)" } ?? "Sent",
                subtitle: "\(itemsLabel)\(via)",
                status: "Sent"
            )
        case "send_confirmation":
            let via = card.channel.map { " · \($0.label)" } ?? ""
            return Meta(
                icon: "hand.raised.fill",
                tone: .warning,
                title: recipient.map { "Send to \($0)?" } ?? "Send?",
                subtitle: card.holdReason.map { "\(itemsLabel)\(via) — \($0)" } ?? "\(itemsLabel)\(via)",
                status: card.source == "vexo" ? "Vexo · Needs your OK" : "Needs your OK"
            )
        case "send_in_progress":
            return Meta(
                icon: "paperplane",
                tone: .accent,
                title: recipient.map { "Sending to \($0)…" } ?? "Sending…",
                subtitle: itemsLabel,
                status: "Sending"
            )
        case "send_cancelled":
            return Meta(
                icon: "xmark.circle",
                tone: .neutral,
                title: recipient.map { "Not sent to \($0)" } ?? "Not sent",
                subtitle: itemsLabel,
                status: "Cancelled"
            )
        case "permission_updated":
            return Meta(
                icon: "lock.shield.fill",
                tone: .accent,
                title: recipient.map { "Access updated for \($0)" } ?? "Access updated",
                subtitle: card.permission?.tier.title,
                status: "Saved"
            )
        case "peer_pull_completed":
            let from = card.bundle?.senderName ?? recipient
            return Meta(
                icon: "arrow.down.circle.fill",
                tone: .success,
                title: from.map { "Got \(itemsLabel) from \($0)" } ?? "Got \(itemsLabel)",
                subtitle: "Also waiting in your Received tab",
                status: "Received"
            )
        case "peer_request_pending":
            let owner = card.accessRequest?.ownerName ?? recipient
            return Meta(
                icon: "hourglass",
                tone: .warning,
                title: owner.map { "Asked \($0) to approve" } ?? "Approval requested",
                subtitle: "You'll get the files once they say yes.",
                status: "Waiting"
            )
        case "bundle_accepted":
            return Meta(
                icon: "checkmark.seal.fill",
                tone: .success,
                title: "Saved to your library",
                subtitle: card.bundle?.acceptedDestination,
                status: "Saved"
            )
        case "friend_connected":
            return Meta(
                icon: "person.2.fill",
                tone: .success,
                title: recipient.map { "Connected with \($0)" } ?? "Connected",
                subtitle: "You can now @mention and share files.",
                status: "Connected"
            )
        case "friend_request_sent":
            return Meta(
                icon: "person.badge.plus",
                tone: .accent,
                title: recipient.map { "Contact request sent to \($0)" } ?? "Request sent",
                subtitle: "Waiting for them to accept.",
                status: "Requested"
            )
        default:
            return Meta(
                icon: "sparkle.magnifyingglass",
                tone: .accent,
                title: itemCount == 1 ? "Found 1 match" : "Found \(itemCount) matches",
                subtitle: card.summary.isEmpty ? nil : card.summary,
                status: "Matches"
            )
        }
    }

    /// Prefer the live inbox copy so the card reflects a save made elsewhere.
    private var liveBundle: TransferBundle? {
        guard let bundle = card.bundle else { return nil }
        return store.receivedBundles.first(where: { $0.id == bundle.id }) ?? bundle
    }

    var body: some View {
        let m = meta
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                FydeIconTile(systemName: m.icon, tone: m.tone, size: 40)
                VStack(alignment: .leading, spacing: 3) {
                    FydeChip(text: m.status, tone: m.tone)
                        .padding(.bottom, 2)
                    Text(m.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(FydeTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if let sub = m.subtitle, !sub.isEmpty {
                        Text(sub)
                            .font(.caption)
                            .foregroundStyle(FydeTheme.inkSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if !card.previews.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 10) {
                        ForEach(card.previews) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                FydeThumbnail(
                                    mediaType: item.mediaType,
                                    url: store.resolvedAssetURL(item.thumbnailUrl),
                                    size: 76,
                                    radius: 14
                                )
                                Text(item.title)
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(FydeTheme.ink)
                                    .lineLimit(1)
                                if let ts = item.matchedTimestampSec {
                                    Text("at \(FydeFormat.timestamp(ts))")
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(FydeTheme.accent)
                                }
                            }
                            .frame(width: 76, alignment: .leading)
                        }
                    }
                }
            }

            if card.isPendingSendConfirmation {
                confirmActions
            }

            if let bundle = liveBundle {
                bundleActions(bundle)
            }
        }
        .fydeCard(padding: 14, radius: 18)
    }

    @ViewBuilder
    private var confirmActions: some View {
        HStack(spacing: 8) {
            Button {
                Task {
                    isConfirming = true
                    await store.confirmChatSend(messageId: messageId, approve: true)
                    isConfirming = false
                }
            } label: {
                Label(isConfirming ? "Sending…" : "Send", systemImage: "paperplane.fill")
            }
            .buttonStyle(FydePrimaryButtonStyle())
            .layoutPriority(1)

            Button {
                Task { await store.confirmChatSend(messageId: messageId, approve: false) }
            } label: {
                Label("Cancel", systemImage: "xmark")
            }
            .buttonStyle(FydeSecondaryButtonStyle())
        }
        .disabled(isConfirming)

        if card.bandConfirmable != false, card.source == "vexo" {
            Label("Or tap Vexo #\(store.vexo.bandNumber) once", systemImage: "hand.tap")
                .font(.caption)
                .foregroundStyle(FydeTheme.muted)
        }
    }

    @ViewBuilder
    private func bundleActions(_ bundle: TransferBundle) -> some View {
        if card.actionType == "peer_pull_completed" {
            if let dest = bundle.acceptedDestination {
                Label("Saved to \(dest)", systemImage: "checkmark.circle.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(FydeTheme.success)
            } else if bundle.items.contains(where: { $0.mediaType == .photo || $0.mediaType == .video }) {
                HStack(spacing: 8) {
                    Button {
                        Task { await store.acceptBundle(bundle, intoPhotos: true) }
                    } label: {
                        Label("Save to Photos", systemImage: "photo.on.rectangle.angled")
                    }
                    .buttonStyle(FydePrimaryButtonStyle())
                    .layoutPriority(1)

                    Button {
                        Task { await store.acceptBundle(bundle, intoPhotos: false) }
                    } label: {
                        Label("Files", systemImage: "folder")
                    }
                    .buttonStyle(FydeSecondaryButtonStyle())
                }
            } else {
                Button {
                    Task { await store.acceptBundle(bundle, intoPhotos: false) }
                } label: {
                    Label("Save to Files", systemImage: "folder.badge.plus")
                }
                .buttonStyle(FydePrimaryButtonStyle())
            }
        }

        #if os(iOS)
        if bundle.channel == .imessage {
            Button {
                onOpenIMessageFallback(
                    bundle.recipientAddress.isEmpty ? bundle.recipientName : bundle.recipientAddress,
                    "\(bundle.title) — \(bundle.shareLink)"
                )
            } label: {
                Label("Open in Messages", systemImage: "message.fill")
            }
            .buttonStyle(FydeSecondaryButtonStyle())
        }
        #endif
    }
}
