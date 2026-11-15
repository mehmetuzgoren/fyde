import SwiftUI

public struct ReceivedTabView: View {
    @Bindable var store: FydeStore
    var onOpenSettings: () -> Void

    @State private var isRefreshing = false

    private var pending: [AccessRequest] {
        store.incomingRequests.filter { $0.status == "pending" }
    }

    private var isEmpty: Bool {
        pending.isEmpty && store.incomingFriendRequests.isEmpty && store.receivedBundles.isEmpty && store.sentBundles.isEmpty
    }

    public var body: some View {
        VStack(spacing: 0) {
            FydeTopBar {
                FydeAccountMenu(store: store, onOpenSettings: onOpenSettings)
            } center: {
                FydeTitle(text: "Received")
            } trailing: {
                Button {
                    Task {
                        isRefreshing = true
                        await store.loadReceivedInbox()
                        isRefreshing = false
                    }
                } label: {
                    FydeCircleIcon(systemName: "arrow.clockwise")
                        .rotationEffect(.degrees(isRefreshing ? 360 : 0))
                        .animation(isRefreshing ? .linear(duration: 0.8).repeatForever(autoreverses: false) : .default, value: isRefreshing)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Refresh")
            }

            Rectangle()
                .fill(FydeTheme.line)
                .frame(height: 1)

            GeometryReader { geo in
                ScrollView {
                    if isEmpty {
                        FydeEmptyState(
                            icon: "tray",
                            title: "Nothing here yet",
                            message: "Files people send you — and requests to see yours — show up here."
                        ) {
                            Button {
                                store.selectedTab = .chat
                            } label: {
                                Label("Ask for something in Chat", systemImage: "bubble.left.and.bubble.right")
                            }
                            .buttonStyle(FydeSecondaryButtonStyle(fullWidth: false))
                        }
                        .frame(maxWidth: .infinity, minHeight: geo.size.height)
                    } else {
                        content
                            .frame(maxWidth: 720)
                            .frame(maxWidth: .infinity)
                    }
                }
                .refreshable {
                    await store.loadReceivedInbox()
                }
            }
        }
        .background(FydeTheme.paper.ignoresSafeArea())
    }

    private var content: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            summary
                .padding(.bottom, 6)

            if !store.incomingFriendRequests.isEmpty {
                FydeSectionHeader(title: "Contact requests", count: store.incomingFriendRequests.count, tone: .accent)
                ForEach(store.incomingFriendRequests) { req in
                    FriendRequestCard(request: req, store: store)
                }
                Spacer().frame(height: 8)
            }

            if !pending.isEmpty {
                FydeSectionHeader(title: "Needs your OK", count: pending.count, tone: .warning)
                ForEach(pending) { req in
                    AccessRequestCard(request: req, store: store)
                }
                Spacer().frame(height: 8)
            }

            FydeSectionHeader(
                title: "Incoming",
                count: store.receivedBundles.isEmpty ? nil : store.receivedBundles.count
            )
            if store.receivedBundles.isEmpty {
                HStack(spacing: 12) {
                    FydeIconTile(systemName: "tray", tone: .neutral, size: 36)
                    Text("No files received yet. Anything sent to you over fyde will land here.")
                        .font(.footnote)
                        .foregroundStyle(FydeTheme.inkSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .fydeCard(padding: 14, radius: 18)
            } else {
                ForEach(store.receivedBundles) { bundle in
                    ReceivedBundleCard(bundle: bundle, store: store)
                }
            }

            if !store.sentBundles.isEmpty {
                Spacer().frame(height: 8)
                FydeSectionHeader(title: "Sent", count: store.sentBundles.count)
                VStack(spacing: 0) {
                    let recent = Array(store.sentBundles.prefix(10))
                    ForEach(Array(recent.enumerated()), id: \.element.id) { index, sent in
                        SentRow(bundle: sent)
                        if index < recent.count - 1 {
                            Rectangle()
                                .fill(FydeTheme.line)
                                .frame(height: 1)
                                .padding(.leading, 62)
                        }
                    }
                }
                .fydeCard(padding: 0, radius: 18)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 28)
    }

    /// Three centered counters so the state of the inbox reads at a glance.
    private var summary: some View {
        let newCount = store.receivedBundles.filter { $0.status == "delivered" }.count
        let approvalCount = pending.count + store.incomingFriendRequests.count
        return HStack(spacing: 0) {
            summaryCell(value: approvalCount, label: "To approve", tone: approvalCount == 0 ? .neutral : .warning)
            divider
            summaryCell(value: newCount, label: "New files", tone: newCount == 0 ? .neutral : .accent)
            divider
            summaryCell(value: store.sentBundles.count, label: "Sent", tone: .neutral)
        }
        .padding(.vertical, 12)
        .fydeCard(padding: 0, radius: 18)
    }

    private var divider: some View {
        Rectangle()
            .fill(FydeTheme.line)
            .frame(width: 1, height: 32)
    }

    private func summaryCell(value: Int, label: String, tone: FydeTone) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(FydeTheme.serif(24, relativeTo: .title2))
                .foregroundStyle(tone == .neutral ? FydeTheme.ink : tone.foreground)
            Text(label)
                .font(.caption)
                .foregroundStyle(FydeTheme.inkSecondary)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Friend Request

private struct FriendRequestCard: View {
    let request: FriendRequestRecord
    let store: FydeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                FydeAvatar(name: request.requesterName, hex: request.requesterAvatarColor, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(request.requesterName) wants to connect")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(FydeTheme.ink)
                    Text("@\(request.requesterHandle)")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(FydeTheme.accent)
                }
                Spacer(minLength: 6)
                FydeChip(text: "Contact", icon: "at", tone: .accent)
            }

            HStack(spacing: 8) {
                Button {
                    Task { await store.resolveFriendRequest(request, accept: false) }
                } label: {
                    Text("Decline")
                }
                .buttonStyle(FydeSecondaryButtonStyle())

                Button {
                    Task { await store.resolveFriendRequest(request, accept: true) }
                } label: {
                    Label("Accept @\(request.requesterHandle)", systemImage: "person.badge.plus")
                }
                .buttonStyle(FydePrimaryButtonStyle())
            }
        }
        .fydeCard(padding: 14, radius: 20, stroke: FydeTheme.accent.opacity(0.35))
    }
}

// MARK: - Access Request

private struct AccessRequestCard: View {
    let request: AccessRequest
    let store: FydeStore

    private var avatarHex: String? {
        store.users.first(where: { $0.id == request.requesterId })?.avatarColor
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                FydeAvatar(name: request.requesterName, hex: avatarHex, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(request.requesterName) is asking for files")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(FydeTheme.ink)
                    if let when = FydeFormat.relative(request.createdAt) {
                        Text(when)
                            .font(.caption)
                            .foregroundStyle(FydeTheme.muted)
                    }
                }
                Spacer(minLength: 6)
                FydeChip(text: "Ask first", icon: "hand.raised.fill", tone: .warning)
            }

            Text("“\(request.query)”")
                .font(FydeTheme.serif(17, bold: false, relativeTo: .body))
                .italic()
                .foregroundStyle(FydeTheme.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(FydeTheme.sunken, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

            if !request.matchedPreviews.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Would share \(request.matchedPreviews.count) \(request.matchedPreviews.count == 1 ? "item" : "items") from your library")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(FydeTheme.inkSecondary)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(request.matchedPreviews) { item in
                                VStack(alignment: .leading, spacing: 4) {
                                    FydeThumbnail(
                                        mediaType: item.mediaType,
                                        url: store.resolvedAssetURL(item.thumbnailUrl),
                                        size: 64,
                                        radius: 12
                                    )
                                    Text(item.title)
                                        .font(.caption2)
                                        .foregroundStyle(FydeTheme.inkSecondary)
                                        .lineLimit(1)
                                }
                                .frame(width: 64)
                            }
                        }
                    }
                }
            }

            HStack(spacing: 8) {
                Button {
                    Task { await store.resolveAccessRequest(request, approve: false) }
                } label: {
                    Text("Decline")
                }
                .buttonStyle(FydeSecondaryButtonStyle())

                Button {
                    Task { await store.resolveAccessRequest(request, approve: true) }
                } label: {
                    Label("Approve & send", systemImage: "checkmark")
                }
                .buttonStyle(FydePrimaryButtonStyle())
            }
        }
        .fydeCard(padding: 14, radius: 20, stroke: FydeTheme.warning.opacity(0.35))
    }
}

// MARK: - Received Bundle

private struct ReceivedBundleCard: View {
    let bundle: TransferBundle
    let store: FydeStore

    private var hasPhotosOrVideos: Bool {
        bundle.items.contains { $0.mediaType == .photo || $0.mediaType == .video }
    }

    private var avatarHex: String? {
        store.users.first(where: { $0.id == bundle.senderId })?.avatarColor
    }

    private var subtitle: String {
        var parts = ["From \(bundle.senderName)", bundle.items.count == 1 ? "1 item" : "\(bundle.items.count) items"]
        if let when = FydeFormat.relative(bundle.createdAt) { parts.append(when) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                FydeAvatar(name: bundle.senderName, hex: avatarHex, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(bundle.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(FydeTheme.ink)
                        .lineLimit(2)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(FydeTheme.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 6)
                statusChip
            }

            if !bundle.message.isEmpty {
                Text(bundle.message)
                    .font(.footnote)
                    .foregroundStyle(FydeTheme.inkSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 10) {
                    ForEach(bundle.items) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            FydeThumbnail(
                                mediaType: item.mediaType,
                                url: store.resolvedAssetURL(item.thumbnailUrl),
                                size: 84,
                                radius: 14
                            )
                            Text(item.title)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(FydeTheme.ink)
                                .lineLimit(1)
                            Text(FydeFormat.bytes(item.sizeBytes))
                                .font(.caption2)
                                .foregroundStyle(FydeTheme.muted)
                        }
                        .frame(width: 84, alignment: .leading)
                    }
                }
            }

            if let acceptedDest = bundle.acceptedDestination {
                Label("Saved to \(acceptedDest)", systemImage: "checkmark.circle.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(FydeTheme.success)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .frame(height: 40)
                    .background(FydeTheme.successSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                HStack(spacing: 8) {
                    if hasPhotosOrVideos {
                        Button {
                            Task { await store.acceptBundle(bundle, intoPhotos: true) }
                        } label: {
                            Label("Save to Photos", systemImage: "photo.on.rectangle.angled")
                        }
                        .buttonStyle(FydePrimaryButtonStyle())

                        Button {
                            Task { await store.acceptBundle(bundle, intoPhotos: false) }
                        } label: {
                            Label("Files", systemImage: "folder")
                        }
                        .buttonStyle(FydeSecondaryButtonStyle())
                    } else {
                        Button {
                            Task { await store.acceptBundle(bundle, intoPhotos: false) }
                        } label: {
                            Label("Save to Files", systemImage: "folder.badge.plus")
                        }
                        .buttonStyle(FydePrimaryButtonStyle())
                    }
                }
            }
        }
        .fydeCard(padding: 14, radius: 20)
    }

    private var statusChip: some View {
        switch bundle.status {
        case "accepted_photos": return FydeChip(text: "In Photos", icon: "checkmark", tone: .success)
        case "accepted_files": return FydeChip(text: "In Files", icon: "checkmark", tone: .success)
        default: return FydeChip(text: "New", tone: .accent)
        }
    }
}

// MARK: - Sent Row

private struct SentRow: View {
    let bundle: TransferBundle

    private var originText: String {
        switch bundle.origin {
        case "pulled_by_trusted": return "Auto-shared · Trusted"
        case "pulled_by_smart_scope": return "Auto-shared · Smart Scope"
        case "approved_request": return "You approved"
        default: return bundle.channel.label
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            FydeIconTile(systemName: bundle.channel.systemImage, tone: .neutral, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text("To \(bundle.recipientName)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(FydeTheme.ink)
                Text("\(bundle.title) · \(originText)")
                    .font(.caption)
                    .foregroundStyle(FydeTheme.inkSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if let when = FydeFormat.relative(bundle.createdAt) {
                Text(when)
                    .font(.caption2)
                    .foregroundStyle(FydeTheme.muted)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }
}
