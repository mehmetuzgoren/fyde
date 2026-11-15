import SwiftUI

public struct ChatTabView: View {
    @Bindable var store: FydeStore
    var onOpenSettings: () -> Void

    @State private var draftText: String = ""
    @State private var showPermissionsSheet = false
    #if os(iOS)
    @State private var composeIMessageRecipient: String?
    @State private var composeIMessageBody: String = ""
    #endif

    private var suggestionChips: [String] {
        if store.currentUserId == "maya" {
            return [
                "Get our passport scans from Mehmet's files",
                "Get all China trip photos from Mehmet",
                "Accept Mehmet's bundle into my Photos"
            ]
        }
        if store.currentUserId == "alex" {
            return [
                "Get China trip photos from Mehmet",
                "Get 2025 tax return from Mehmet"
            ]
        }
        return [
            "Send China trip photos to Maya",
            "iMessage Maya the Pacifica surfing video",
            "Send 2025 tax return to Sarah via email",
            "Allow Alex to access all my China trip photos with him",
            "Get the vet invoice from Maya's files"
        ]
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Inline Contact Trust & Permissions Ribbon inside the Middle Chat Tab!
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        Button {
                            showPermissionsSheet = true
                        } label: {
                            Label("Manage Permissions", systemImage: "person.2.badge.key.fill")
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 11)
                                .padding(.vertical, 6)
                                .background(Color.indigo, in: Capsule())
                                .foregroundStyle(.white)
                        }
                        .buttonStyle(.plain)

                        ForEach(store.permissions) { perm in
                            Button {
                                showPermissionsSheet = true
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: tierIcon(perm.tier))
                                        .font(.caption2)
                                    Text("\(perm.contactName): \(shortTierName(perm.tier))")
                                        .font(.caption.weight(.medium))
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color.secondary.opacity(0.13), in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                }

                Divider()

                // Conversation Stream
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 14) {
                            ForEach(store.chatMessages) { msg in
                                ChatBubbleRow(
                                    message: msg,
                                    store: store,
                                    onOpenIMessageFallback: { recipient, text in
                                        #if os(iOS)
                                        if IOSMessageComposerSheet.canSendMessages {
                                            composeIMessageBody = text
                                            composeIMessageRecipient = recipient
                                        } else {
                                            store.statusBanner = "iMessage compose requires a physical iPhone with Messages configured."
                                        }
                                        #endif
                                    }
                                )
                                .id(msg.id)
                            }
                        }
                        .padding(14)
                    }
                    .refreshable { await store.refreshAll() }
                    .onChange(of: store.chatMessages.count) { _, _ in
                        if let lastId = store.chatMessages.last?.id {
                            withAnimation {
                                proxy.scrollTo(lastId, anchor: .bottom)
                            }
                        }
                    }
                }

                // Quick Prompt Suggestions
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(suggestionChips, id: \.self) { chip in
                            Button {
                                Task { await store.sendChatPrompt(chip) }
                            } label: {
                                Text(chip)
                                    .font(.caption)
                                    .padding(.horizontal, 11)
                                    .padding(.vertical, 6)
                                    .background(Color.indigo.opacity(0.1), in: Capsule())
                                    .foregroundStyle(.indigo)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                }

                Divider()

                // Chat Composer Bar
                HStack(spacing: 10) {
                    TextField(
                        "Send files, pull from contacts, or set permissions…",
                        text: $draftText,
                        axis: .vertical
                    )
                    .lineLimit(1...4)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
                    .onSubmit {
                        submitPrompt()
                    }

                    Button(action: submitPrompt) {
                        Image(systemName: store.isSendingChat ? "hourglass" : "arrow.up.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Color.secondary : Color.indigo)
                    }
                    .disabled(store.isSendingChat || draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            .navigationTitle("Fyde Chat")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Menu {
                        ForEach(store.users) { u in
                            Button {
                                Task { await store.switchUser(to: u.id) }
                            } label: {
                                HStack {
                                    Text("\(u.displayName) (@\(u.handle))")
                                    if u.id == store.currentUserId {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                        Divider()
                        Button("Node & Relay Settings…", action: onOpenSettings)
                    } label: {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(store.isRelayConnected ? Color.green : Color.orange)
                                .frame(width: 8, height: 8)
                            Text(store.currentUser.displayName)
                                .font(.subheadline.weight(.semibold))
                            Image(systemName: "chevron.down")
                                .font(.caption2)
                        }
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showPermissionsSheet = true
                    } label: {
                        Image(systemName: "slider.horizontal.3")
                    }
                }
            }
            .sheet(isPresented: $showPermissionsSheet) {
                PermissionsSheetView(store: store)
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
    }

    private func submitPrompt() {
        let prompt = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        draftText = ""
        Task { await store.sendChatPrompt(prompt) }
    }

    private func tierIcon(_ tier: PermissionTier) -> String {
        switch tier {
        case .trusted: return "checkmark.shield.fill"
        case .smartScope: return "sparkles"
        case .askFirst: return "hand.raised.fill"
        case .sendOnly: return "arrow.up.right"
        }
    }

    private func shortTierName(_ tier: PermissionTier) -> String {
        switch tier {
        case .trusted: return "Trusted"
        case .smartScope: return "Smart Scope"
        case .askFirst: return "Ask First"
        case .sendOnly: return "Send Only"
        }
    }
}

private struct ChatBubbleRow: View {
    let message: ChatMessage
    let store: FydeStore
    let onOpenIMessageFallback: (String, String) -> Void

    private var isUser: Bool { message.role == "user" }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 42) }

            VStack(alignment: .leading, spacing: 10) {
                Text(.init(message.text))
                    .font(.subheadline)
                    .foregroundStyle(isUser ? Color.white : Color.primary)

                if let card = message.actionCard {
                    ChatActionCardView(
                        card: card,
                        store: store,
                        onOpenIMessageFallback: onOpenIMessageFallback
                    )
                }
            }
            .padding(12)
            .background(
                isUser ? Color.indigo : Color.secondary.opacity(0.12),
                in: RoundedRectangle(cornerRadius: 16)
            )

            if !isUser { Spacer(minLength: 36) }
        }
    }
}

private struct ChatActionCardView: View {
    let card: ChatActionCard
    let store: FydeStore
    let onOpenIMessageFallback: (String, String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            HStack {
                Image(systemName: iconForAction(card.actionType))
                    .foregroundStyle(.indigo)
                Text(labelForAction(card.actionType))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.indigo)
                Spacer()
                if let ch = card.channel {
                    Text(ch.label)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color.indigo.opacity(0.14), in: Capsule())
                }
            }

            if !card.previews.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(card.previews) { item in
                            HStack(spacing: 6) {
                                Image(systemName: item.mediaType.systemImage)
                                    .font(.caption)
                                    .foregroundStyle(.indigo)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.title)
                                        .font(.caption2.weight(.semibold))
                                        .lineLimit(1)
                                    if let ts = item.matchedTimestampSec {
                                        Text("@ \(String(format: "%.1f", ts))s")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .padding(7)
                            .background(.background, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }

            if let bundle = card.bundle {
                HStack(spacing: 8) {
                    if card.actionType == "peer_pull_completed" {
                        Button {
                            Task { await store.acceptBundle(bundle, intoPhotos: true) }
                        } label: {
                            Label("Save to Photos", systemImage: "photo.on.rectangle.angled")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)

                        Button {
                            Task { await store.acceptBundle(bundle, intoPhotos: false) }
                        } label: {
                            Label("Save to Files", systemImage: "folder.badge.plus")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }

                    #if os(iOS)
                    if bundle.channel == .imessage {
                        Button {
                            onOpenIMessageFallback(
                                bundle.recipientAddress.isEmpty ? bundle.recipientName : bundle.recipientAddress,
                                "\(bundle.title) — \(bundle.shareLink)"
                            )
                        } label: {
                            Label("1-Tap iOS Messages", systemImage: "message.fill")
                                .font(.caption2)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                    #endif
                }
            }
        }
    }

    private func iconForAction(_ type: String) -> String {
        switch type {
        case "send_completed": return "paperplane.circle.fill"
        case "permission_updated": return "lock.shield.fill"
        case "peer_pull_completed": return "arrow.down.doc.fill"
        case "peer_request_pending": return "clock.badge.questionmark"
        case "bundle_accepted": return "checkmark.seal.fill"
        default: return "sparkle.magnifyingglass"
        }
    }

    private func labelForAction(_ type: String) -> String {
        switch type {
        case "send_completed": return "Sent Automatically in Background"
        case "permission_updated": return "Contact Permission Updated"
        case "peer_pull_completed": return "Retrieved into Received Tab"
        case "peer_request_pending": return "Approval Requested from Owner"
        case "bundle_accepted": return "Accepted into Library"
        default: return "Multimodal Matches"
        }
    }
}
