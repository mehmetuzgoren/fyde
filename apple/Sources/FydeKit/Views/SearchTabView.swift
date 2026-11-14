import AVKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

public struct SearchTabView: View {
    @Bindable var store: FydeStore
    var onOpenSettings: () -> Void

    @State private var pickedPhotoItem: PhotosPickerItem?
    @State private var showFileImporter = false
    @State private var activeVideoHit: SearchHit?

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Scope & Media Filters
                VStack(spacing: 10) {
                    Picker("Library Scope", selection: $store.searchScope) {
                        Text("All Accessible").tag("all")
                        Text("My Library").tag("mine")
                        Text("Contacts' Shared").tag("contacts")
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: store.searchScope) { _, _ in
                        Task { await store.performSearch() }
                    }

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            FilterPill(title: "All Types", isSelected: store.selectedMediaFilter == nil) {
                                store.selectedMediaFilter = nil
                                Task { await store.performSearch() }
                            }
                            FilterPill(title: "Photos", icon: "photo.fill", isSelected: store.selectedMediaFilter == .photo) {
                                store.selectedMediaFilter = .photo
                                Task { await store.performSearch() }
                            }
                            FilterPill(title: "Videos", icon: "video.fill", isSelected: store.selectedMediaFilter == .video) {
                                store.selectedMediaFilter = .video
                                Task { await store.performSearch() }
                            }
                            FilterPill(title: "Files & PDFs", icon: "doc.richtext.fill", isSelected: store.selectedMediaFilter == .document) {
                                store.selectedMediaFilter = .document
                                Task { await store.performSearch() }
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)

                Divider()

                if store.searchHits.isEmpty {
                    ContentUnavailableView(
                        "No Multimodal Matches",
                        systemImage: "sparkle.magnifyingglass",
                        description: Text("Search scenes, spoken/visual video moments, places (\"China trip\"), or PDF contents.")
                    )
                } else {
                    List(store.searchHits) { hit in
                        SearchHitRow(
                            hit: hit,
                            store: store,
                            onPlayMoment: { activeVideoHit = hit }
                        )
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Search")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .searchable(text: $store.searchQuery, prompt: "Search photos, video moments, PDFs…")
            .onSubmit(of: .search) {
                Task { await store.performSearch() }
            }
            .onChange(of: store.searchQuery) { _, _ in
                Task { await store.performSearch() }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: onOpenSettings) {
                        HStack(spacing: 5) {
                            Circle()
                                .fill(store.isRelayConnected ? Color.green : Color.orange)
                                .frame(width: 7, height: 7)
                            Text("@\(store.currentUser.handle)")
                                .font(.caption.weight(.semibold))
                        }
                    }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    PhotosPicker(selection: $pickedPhotoItem, matching: .any(of: [.images, .videos])) {
                        Image(systemName: "photo.badge.plus")
                    }
                    Button {
                        showFileImporter = true
                    } label: {
                        Image(systemName: "doc.badge.plus")
                    }
                }
            }
            .onChange(of: pickedPhotoItem) { _, newItem in
                guard let newItem else { return }
                Task {
                    if let data = try? await newItem.loadTransferable(type: Data.self) {
                        let isVideo = newItem.supportedContentTypes.contains { $0.conforms(to: .movie) }
                        let ext = isVideo ? "mp4" : "jpg"
                        let mime = isVideo ? "video/mp4" : "image/jpeg"
                        await store.uploadAndIndexMedia(
                            data: data,
                            filename: "PhotoLibrary_\(Int(Date().timeIntervalSince1970)).\(ext)",
                            mimeType: mime
                        )
                    }
                }
            }
            .fileImporter(
                isPresented: $showFileImporter,
                allowedContentTypes: [.pdf, .image, .movie, .plainText, .data]
            ) { result in
                if case .success(let url) = result {
                    Task {
                        let accessed = url.startAccessingSecurityScopedResource()
                        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                        if let data = try? Data(contentsOf: url) {
                            let ext = url.pathExtension.lowercased()
                            let mime: String = switch ext {
                            case "pdf": "application/pdf"
                            case "jpg", "jpeg": "image/jpeg"
                            case "png": "image/png"
                            case "mp4", "mov": "video/mp4"
                            default: "application/octet-stream"
                            }
                            await store.uploadAndIndexMedia(data: data, filename: url.lastPathComponent, mimeType: mime)
                        }
                    }
                }
            }
            .sheet(item: $activeVideoHit) { hit in
                VideoMomentPlayerSheet(hit: hit, store: store)
            }
        }
    }
}

private struct FilterPill: View {
    let title: String
    var icon: String?
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let icon {
                    Image(systemName: icon)
                        .font(.caption2)
                }
                Text(title)
                    .font(.caption.weight(.semibold))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(isSelected ? Color.indigo : Color.secondary.opacity(0.14), in: Capsule())
            .foregroundStyle(isSelected ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
    }
}

private struct SearchHitRow: View {
    let hit: SearchHit
    let store: FydeStore
    let onPlayMoment: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AssetThumbnailBox(
                mediaType: hit.asset.mediaType,
                url: store.resolvedAssetURL(hit.asset.thumbnailUrl)
            )

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(hit.asset.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Spacer()
                    Text(hit.asset.ownerId == store.currentUserId ? "Mine" : hit.asset.ownerName)
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(
                            (hit.asset.ownerId == store.currentUserId ? Color.indigo : Color.pink).opacity(0.15),
                            in: Capsule()
                        )
                        .foregroundStyle(hit.asset.ownerId == store.currentUserId ? Color.indigo : Color.pink)
                }

                if !hit.asset.location.isEmpty || !hit.asset.people.isEmpty {
                    Text(
                        [
                            hit.asset.location.isEmpty ? nil : "📍 \(hit.asset.location)",
                            hit.asset.people.isEmpty ? nil : "👥 \(hit.asset.people.joined(separator: ", "))"
                        ].compactMap { $0 }.joined(separator: "  •  ")
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                Text(hit.matchReason)
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                if let ts = hit.matchedMomentSec {
                    Button(action: onPlayMoment) {
                        Label(
                            "Jump to \(String(format: "%.1f", ts))s — \(hit.matchedMomentLabel ?? "Matched visual scene")",
                            systemImage: "play.circle.fill"
                        )
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.indigo)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 2)
                }
            }

            Menu {
                ForEach(store.permissions) { perm in
                    Menu("Send to \(perm.contactName)") {
                        ForEach(SendChannel.allCases) { channel in
                            Button {
                                Task {
                                    await store.quickSendAsset(hit.asset, to: perm.contactName, channel: channel)
                                }
                            } label: {
                                Label(channel.label, systemImage: channel.systemImage)
                            }
                        }
                    }
                }
                Button {
                    store.selectedTab = .chat
                    Task {
                        await store.sendChatPrompt("Send \(hit.asset.title) to Maya")
                    }
                } label: {
                    Label("Send to Maya in Chat", systemImage: "paperplane.fill")
                }
            } label: {
                Image(systemName: "square.and.arrow.up.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.indigo)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 6)
    }
}

struct AssetThumbnailBox: View {
    let mediaType: MediaType
    let url: URL?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.indigo.opacity(0.12))
                .frame(width: 54, height: 54)

            if mediaType == .photo, let url {
                AsyncImage(url: url) { phase in
                    if case .success(let image) = phase {
                        image
                            .resizable()
                            .scaledToFill()
                            .frame(width: 54, height: 54)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    } else {
                        Image(systemName: mediaType.systemImage)
                            .foregroundStyle(.indigo)
                    }
                }
            } else {
                Image(systemName: mediaType.systemImage)
                    .font(.title3)
                    .foregroundStyle(.indigo)
            }
        }
    }
}

private struct VideoMomentPlayerSheet: View {
    let hit: SearchHit
    let store: FydeStore
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if let player {
                    VideoPlayer(player: player)
                        .frame(minHeight: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .padding(.horizontal)
                } else {
                    ProgressView("Loading video stream…")
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text(hit.asset.title)
                        .font(.headline)
                    if let ts = hit.matchedMomentSec {
                        Text("Seeked directly to multimodal moment @ \(String(format: "%.1f", ts))s: \(hit.matchedMomentLabel ?? "")")
                            .font(.subheadline)
                            .foregroundStyle(.indigo)
                    }
                    ForEach(Array(hit.asset.videoMoments.enumerated()), id: \.offset) { _, m in
                        Button {
                            let target = CMTime(seconds: m.timestampSec, preferredTimescale: 600)
                            player?.seek(to: target)
                            player?.play()
                        } label: {
                            HStack {
                                Image(systemName: "clock.arrow.circlepath")
                                Text("\(String(format: "%.1f", m.timestampSec))s — \(m.label)")
                                Spacer()
                            }
                            .font(.caption)
                            .padding(8)
                            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)
                Spacer()
            }
            .navigationTitle("Video Moment")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                if let url = store.resolvedAssetURL(hit.asset.downloadUrl) {
                    let avPlayer = AVPlayer(url: url)
                    if let ts = hit.matchedMomentSec {
                        avPlayer.seek(to: CMTime(seconds: ts, preferredTimescale: 600))
                    }
                    avPlayer.play()
                    self.player = avPlayer
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 440)
        #endif
    }
}
