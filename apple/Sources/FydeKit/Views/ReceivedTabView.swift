import SwiftUI

public struct ReceivedTabView: View {
    @Bindable var store: FydeStore
    var onOpenSettings: () -> Void

    public var body: some View {
        NavigationStack {
            List {
                // 1. Incoming Access Requests (Ask-First or Out-of-Scope Queries)
                let pending = store.incomingRequests.filter { $0.status == "pending" }
                if !pending.isEmpty {
                    Section("Pending Access Approvals") {
                        ForEach(pending) { req in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Label("\(req.requesterName) requested:", systemImage: "person.wave.2.fill")
                                        .font(.subheadline.weight(.semibold))
                                    Spacer()
                                    Text("Ask First")
                                        .font(.caption2.weight(.bold))
                                        .padding(.horizontal, 7)
                                        .padding(.vertical, 2)
                                        .background(Color.orange.opacity(0.18), in: Capsule())
                                        .foregroundStyle(.orange)
                                }
                                Text("\"\(req.query)\"")
                                    .font(.subheadline)
                                    .italic()

                                if !req.matchedPreviews.isEmpty {
                                    Text("Candidate matches on your device (\(req.matchedPreviews.count)):")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                    ForEach(req.matchedPreviews) { item in
                                        Label(item.title, systemImage: item.mediaType.systemImage)
                                            .font(.caption)
                                            .foregroundStyle(.indigo)
                                    }
                                }

                                HStack(spacing: 10) {
                                    Button {
                                        Task { await store.resolveAccessRequest(req, approve: true) }
                                    } label: {
                                        Label("Approve & Send", systemImage: "checkmark.circle.fill")
                                            .font(.caption.weight(.bold))
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .tint(.green)

                                    Button(role: .destructive) {
                                        Task { await store.resolveAccessRequest(req, approve: false) }
                                    } label: {
                                        Label("Deny", systemImage: "xmark.circle")
                                            .font(.caption.weight(.semibold))
                                    }
                                    .buttonStyle(.bordered)
                                }
                                .padding(.top, 4)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }

                // 2. Received Direct Fyde Bundles & Pulled Files
                Section("Received over Fyde") {
                    if store.receivedBundles.isEmpty {
                        ContentUnavailableView(
                            "No Received Files Yet",
                            systemImage: "tray",
                            description: Text("Files sent directly over Fyde or pulled from your contacts' libraries appear here.")
                        )
                    } else {
                        ForEach(store.receivedBundles) { bundle in
                            ReceivedBundleCard(bundle: bundle, store: store)
                        }
                    }
                }

                // 3. Recent Outbound Activity Audit
                if !store.sentBundles.isEmpty {
                    Section("Sent & Auto-Shared Activity Log") {
                        ForEach(store.sentBundles.prefix(10)) { sent in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text("To \(sent.recipientName)")
                                        .font(.subheadline.weight(.semibold))
                                    Spacer()
                                    Label(sent.channel.label, systemImage: sent.channel.systemImage)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Text("\(sent.title) • \(originBadge(sent.origin))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Received")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .refreshable {
                await store.loadReceivedInbox()
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: onOpenSettings) {
                        Image(systemName: "gearshape")
                    }
                }
            }
        }
    }

    private func originBadge(_ origin: String) -> String {
        switch origin {
        case "pulled_by_trusted": return "Auto-pulled (Trusted)"
        case "pulled_by_smart_scope": return "Auto-pulled (Smart Scope)"
        case "approved_request": return "Approved Request"
        default: return "Sent"
        }
    }
}

private struct ReceivedBundleCard: View {
    let bundle: TransferBundle
    let store: FydeStore

    private var hasPhotosOrVideos: Bool {
        bundle.items.contains { $0.mediaType == .photo || $0.mediaType == .video }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(bundle.title)
                        .font(.subheadline.weight(.bold))
                    Text("From \(bundle.senderName) • \(bundle.items.count) item(s)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                StatusPill(status: bundle.status)
            }

            if !bundle.message.isEmpty {
                Text(bundle.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(bundle.items) { item in
                        HStack(spacing: 8) {
                            AssetThumbnailBox(
                                mediaType: item.mediaType,
                                url: store.resolvedAssetURL(item.thumbnailUrl)
                            )
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title)
                                    .font(.caption.weight(.semibold))
                                    .lineLimit(1)
                                Text(ByteCountFormatter.string(fromByteCount: Int64(item.sizeBytes), countStyle: .file))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(6)
                        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                    }
                }
            }

            if let acceptedDest = bundle.acceptedDestination {
                Label("Saved to \(acceptedDest)", systemImage: "checkmark.circle.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.green)
            } else {
                HStack(spacing: 10) {
                    if hasPhotosOrVideos {
                        Button {
                            Task { await store.acceptBundle(bundle, intoPhotos: true) }
                        } label: {
                            Label("Save to Apple Photos", systemImage: "photo.on.rectangle.angled")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    }

                    Button {
                        Task { await store.acceptBundle(bundle, intoPhotos: false) }
                    } label: {
                        Label("Accept into Files", systemImage: "folder.badge.plus")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
        .padding(.vertical, 6)
    }
}

private struct StatusPill: View {
    let status: String

    var body: some View {
        let (label, color): (String, Color) = switch status {
        case "accepted_photos": ("In Photos", .green)
        case "accepted_files": ("In Files", .green)
        default: ("New", .indigo)
        }
        Text(label)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}
