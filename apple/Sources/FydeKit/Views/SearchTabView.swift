import AVKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

public struct SearchTabView: View {
    @Bindable var store: FydeStore
    var onOpenSettings: () -> Void

    @State private var pickedPhotoItem: PhotosPickerItem?
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var selectedHit: SearchHit?
    @FocusState private var searchFocused: Bool

    private struct SearchKey: Equatable {
        let query: String
        let scope: String
        let filter: MediaType?
    }

    private var trimmedQuery: String {
        store.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private let exampleQueries = [
        "Recent photos",
        "Videos",
        "Documents",
        "Receipts",
        "Screenshots"
    ]

    public var body: some View {
        VStack(spacing: 0) {
            FydeTopBar {
                FydeAccountMenu(store: store, onOpenSettings: onOpenSettings)
            } center: {
                FydeTitle(text: "Search")
            } trailing: {
                importMenu
            }

            controls
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
                .frame(maxWidth: 720)

            Rectangle()
                .fill(FydeTheme.line)
                .frame(height: 1)

            GeometryReader { geo in
                ScrollView {
                    if store.searchHits.isEmpty {
                        emptyState
                            .frame(maxWidth: .infinity, minHeight: geo.size.height)
                    } else {
                        results
                            .frame(maxWidth: 720)
                            .frame(maxWidth: .infinity)
                    }
                }
                .scrollDismissesKeyboard(.immediately)
            }
        }
        .frame(maxWidth: .infinity)
        .background(FydeTheme.paper.ignoresSafeArea())
        .task(id: SearchKey(query: store.searchQuery, scope: store.searchScope, filter: store.selectedMediaFilter)) {
            try? await Task.sleep(for: .milliseconds(220))
            guard !Task.isCancelled else { return }
            await store.performSearch()
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $pickedPhotoItem, matching: .any(of: [.images, .videos]))
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
                pickedPhotoItem = nil
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
        .sheet(item: $selectedHit) { hit in
            AssetDetailSheet(hit: hit, store: store, showReason: !trimmedQuery.isEmpty)
        }
    }

    // MARK: Header actions

    private var importMenu: some View {
        Menu {
            Button {
                showPhotoPicker = true
            } label: {
                Label("Add from Photos", systemImage: "photo.on.rectangle")
            }
            Button {
                showFileImporter = true
            } label: {
                Label("Add from Files", systemImage: "folder")
            }
        } label: {
            FydeCircleIcon(systemName: "plus")
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add photos or files to your library")
    }

    // MARK: Controls

    private var controls: some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(searchFocused ? FydeTheme.accent : FydeTheme.muted)
                TextField("Places, people, moments, documents…", text: $store.searchQuery)
                    .font(.callout)
                    .foregroundStyle(FydeTheme.ink)
                    .textFieldStyle(.plain)
                    .focused($searchFocused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .onSubmit {
                        Task { await store.performSearch() }
                    }
                if store.isSearching {
                    ProgressView()
                        .controlSize(.small)
                } else if !store.searchQuery.isEmpty {
                    Button {
                        store.searchQuery = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 17))
                            .foregroundStyle(FydeTheme.muted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 50)
            .background(FydeTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(searchFocused ? FydeTheme.accent.opacity(0.45) : FydeTheme.line, lineWidth: 1)
            )

            FydeSegmented(
                selection: $store.searchScope,
                options: [
                    (value: "all", label: "Everything"),
                    (value: "mine", label: "Mine"),
                    (value: "contacts", label: "Shared with me")
                ]
            )

            HStack(spacing: 8) {
                typeChip(nil, "All", "square.grid.2x2")
                typeChip(.photo, "Photos", "photo")
                typeChip(.video, "Videos", "video")
                typeChip(.document, "Files", "doc.text")
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func typeChip(_ type: MediaType?, _ title: String, _ icon: String) -> some View {
        let isOn = store.selectedMediaFilter == type
        return Button {
            withAnimation(.easeOut(duration: 0.15)) {
                store.selectedMediaFilter = type
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                Text(title)
                    .font(.footnote.weight(.semibold))
            }
            .foregroundStyle(isOn ? FydeTheme.accent : FydeTheme.inkSecondary)
            .padding(.horizontal, 11)
            .frame(height: 32)
            .background(isOn ? FydeTheme.accentSoft : FydeTheme.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(isOn ? FydeTheme.accent.opacity(0.35) : FydeTheme.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }

    // MARK: Results

    private var resultsHeading: String {
        let n = store.searchHits.count
        if trimmedQuery.isEmpty {
            return "Recent · \(n) \(n == 1 ? "item" : "items")"
        }
        return "\(n) \(n == 1 ? "match" : "matches") for “\(trimmedQuery)”"
    }

    private let gridColumns = [GridItem(.adaptive(minimum: 104, maximum: 180), spacing: 8)]

    private var results: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(resultsHeading)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(FydeTheme.muted)
                .padding(.horizontal, 4)

            LazyVGrid(columns: gridColumns, spacing: 8) {
                ForEach(store.searchHits) { hit in
                    Button {
                        selectedHit = hit
                    } label: {
                        SearchTile(hit: hit, store: store)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(hit.asset.title)
                    .accessibilityHint("Shows details")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 28)
    }

    // MARK: Empty

    @ViewBuilder
    private var emptyState: some View {
        if trimmedQuery.isEmpty {
            FydeEmptyState(
                icon: "sparkle.magnifyingglass",
                title: "Search by memory",
                message: "Describe what you remember — a place, a person, a moment in a video, or words inside a PDF."
            ) {
                VStack(spacing: 16) {
                    FydeFlowLayout(spacing: 8) {
                        ForEach(exampleQueries, id: \.self) { example in
                            Button {
                                store.searchQuery = example
                            } label: {
                                Text(example)
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(FydeTheme.ink)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .background(FydeTheme.surface, in: Capsule())
                                    .overlay(Capsule().strokeBorder(FydeTheme.line, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .frame(maxWidth: 340)

                    Button {
                        showPhotoPicker = true
                    } label: {
                        Label("Add photos or videos", systemImage: "plus")
                    }
                    .buttonStyle(FydeSecondaryButtonStyle(fullWidth: false))
                }
            }
        } else {
            FydeEmptyState(
                icon: "magnifyingglass",
                title: "No matches for “\(trimmedQuery)”",
                message: "Try fewer words, a place or a person, or switch the scope to Everything."
            ) {
                Button {
                    store.searchQuery = ""
                    store.selectedMediaFilter = nil
                } label: {
                    Label("Clear search", systemImage: "xmark")
                }
                .buttonStyle(FydeSecondaryButtonStyle(fullWidth: false))
            }
        }
    }
}

// MARK: - Result Tile (icon only; details open on tap)

private struct SearchTile: View {
    let hit: SearchHit
    let store: FydeStore

    private var asset: IndexedAsset { hit.asset }
    private var isMine: Bool { asset.ownerId == store.currentUserId }

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay { content }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(FydeTheme.line.opacity(asset.mediaType == .photo ? 0 : 1), lineWidth: 1)
            )
            .overlay(alignment: .topLeading) {
                if !isMine {
                    FydeAvatar(
                        name: asset.ownerName,
                        hex: store.users.first(where: { $0.id == asset.ownerId })?.avatarColor,
                        size: 22
                    )
                    .overlay(Circle().strokeBorder(Color.white, lineWidth: 1.5))
                    .padding(6)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if asset.mediaType == .video, let badge = videoBadge {
                    HStack(spacing: 3) {
                        Image(systemName: "play.fill")
                            .font(.system(size: 8, weight: .bold))
                        Text(badge)
                            .font(.caption2.weight(.semibold).monospacedDigit())
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color.black.opacity(0.45), in: Capsule())
                    .padding(6)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var videoBadge: String? {
        if let ts = hit.matchedMomentSec { return FydeFormat.timestamp(ts) }
        if let d = asset.durationSec { return FydeFormat.timestamp(d) }
        return nil
    }

    private var fileExtension: String {
        let ext = (asset.filename as NSString).pathExtension
        return ext.isEmpty ? "FILE" : ext.uppercased()
    }

    @ViewBuilder
    private var content: some View {
        switch asset.mediaType {
        case .photo:
            ZStack {
                FydeTheme.sunken
                if let url = store.resolvedAssetURL(asset.thumbnailUrl) {
                    AsyncImage(url: url) { phase in
                        if case .success(let image) = phase {
                            image.resizable().scaledToFill()
                        } else {
                            Image(systemName: "photo")
                                .font(.title2)
                                .foregroundStyle(FydeTheme.muted)
                        }
                    }
                } else {
                    Image(systemName: "photo")
                        .font(.title2)
                        .foregroundStyle(FydeTheme.muted)
                }
            }
        case .video:
            ZStack {
                FydeTheme.ink.opacity(0.82)
                Image(systemName: "video")
                    .font(.title2)
                    .foregroundStyle(Color.white.opacity(0.9))
            }
        case .document:
            ZStack {
                FydeTheme.accentSoft
                VStack(spacing: 6) {
                    Image(systemName: "doc.text")
                        .font(.title2)
                    Text(fileExtension)
                        .font(.caption2.weight(.bold))
                        .tracking(0.6)
                }
                .foregroundStyle(FydeTheme.accent)
            }
        case .audio, .folder:
            ZStack {
                FydeTheme.sunken
                Image(systemName: asset.mediaType == .audio ? "waveform" : "folder")
                    .font(.title2)
                    .foregroundStyle(FydeTheme.muted)
            }
        }
    }
}

// MARK: - Asset Detail Sheet

private struct AssetDetailSheet: View {
    let hit: SearchHit
    let store: FydeStore
    let showReason: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?
    @State private var showDeleteConfirmation = false
    @State private var isDeleting = false
    @State private var deleteError: String?

    private var asset: IndexedAsset { hit.asset }
    private var isMine: Bool { asset.ownerId == store.currentUserId }

    private var reasonText: String? {
        let r = hit.matchReason.trimmingCharacters(in: .whitespaces)
        guard showReason, !r.isEmpty, r != "Recent item", r != "Local index" else { return nil }
        return r
    }

    private var typeLabel: String {
        switch asset.mediaType {
        case .photo: return "Photo"
        case .video: return "Video"
        case .document: return "Document"
        case .audio: return "Audio"
        case .folder: return "Folder"
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    preview

                    VStack(alignment: .leading, spacing: 8) {
                        Text(asset.title)
                            .font(FydeTheme.serif(24, relativeTo: .title2))
                            .foregroundStyle(FydeTheme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 6) {
                            FydeChip(text: typeLabel, tone: .neutral)
                            FydeChip(
                                text: isMine ? "Mine" : "From \(asset.ownerName)",
                                icon: isMine ? nil : "person.fill",
                                tone: isMine ? .neutral : .accent
                            )
                        }
                        if !asset.summary.isEmpty {
                            Text(asset.summary)
                                .font(.subheadline)
                                .foregroundStyle(FydeTheme.inkSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.top, 2)
                        }
                    }

                    infoRows

                    if let reasonText {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Why it matched")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(FydeTheme.muted)
                            Text(reasonText)
                                .font(.subheadline)
                                .foregroundStyle(FydeTheme.ink)
                        }
                    }

                    if asset.mediaType == .video, !asset.videoMoments.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Moments")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(FydeTheme.muted)
                            ForEach(Array(asset.videoMoments.enumerated()), id: \.offset) { _, m in
                                Button {
                                    player?.seek(to: CMTime(seconds: m.timestampSec, preferredTimescale: 600))
                                    player?.play()
                                } label: {
                                    HStack(spacing: 12) {
                                        FydeChip(text: FydeFormat.timestamp(m.timestampSec), icon: "play.fill", tone: .accent)
                                        Text(m.label)
                                            .font(.subheadline)
                                            .foregroundStyle(FydeTheme.ink)
                                            .multilineTextAlignment(.leading)
                                        Spacer(minLength: 0)
                                    }
                                    .fydeCard(padding: 12, radius: 14)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if asset.downloadUrl != "#", let url = store.resolvedAssetURL(asset.downloadUrl) {
                        Link(destination: url) {
                            Label("Open file", systemImage: "arrow.up.right.square")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 48)
                        }
                        .buttonStyle(.bordered)
                        .tint(FydeTheme.accent)
                    }
                    if isMine {
                        sendMenu
                            .disabled(isDeleting)
                        if let deleteError {
                            Text(deleteError)
                                .font(.subheadline)
                                .foregroundStyle(.red)
                                .accessibilityAddTraits(.updatesFrequently)
                        }
                        Button(role: .destructive) {
                            showDeleteConfirmation = true
                        } label: {
                            Label(isDeleting ? "Deleting…" : "Delete file", systemImage: "trash")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 48)
                        }
                        .buttonStyle(.bordered)
                        .tint(.red)
                        .disabled(isDeleting)
                    }
                }
                .padding(16)
            }
            .background(FydeTheme.paper.ignoresSafeArea())
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .tint(FydeTheme.accent)
                        .disabled(isDeleting)
                }
            }
            .confirmationDialog("Delete “\(asset.title)” from your library?", isPresented: $showDeleteConfirmation, titleVisibility: .visible) {
                Button("Delete file", role: .destructive) {
                    guard !isDeleting else { return }
                    isDeleting = true
                    deleteError = nil
                    Task {
                        defer { isDeleting = false }
                        do {
                            try await store.deleteAsset(asset)
                            dismiss()
                        } catch {
                            deleteError = error.localizedDescription
                        }
                    }
                }
                Button("Cancel", role: .cancel) { }
            } message: {
                Text("This can’t be undone. Copies already sent or saved elsewhere will remain.")
            }
            .interactiveDismissDisabled(isDeleting)
            .onAppear {
                guard asset.mediaType == .video, let url = store.resolvedAssetURL(asset.downloadUrl) else { return }
                let avPlayer = AVPlayer(url: url)
                if let ts = hit.matchedMomentSec {
                    avPlayer.seek(to: CMTime(seconds: ts, preferredTimescale: 600))
                }
                avPlayer.play()
                player = avPlayer
            }
            .onDisappear {
                player?.pause()
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 560)
        #endif
    }

    // MARK: Preview

    @ViewBuilder
    private var preview: some View {
        switch asset.mediaType {
        case .photo:
            ZStack {
                FydeTheme.sunken
                AsyncImage(url: store.resolvedAssetURL(asset.downloadUrl) ?? store.resolvedAssetURL(asset.thumbnailUrl)) { phase in
                    if case .success(let image) = phase {
                        image.resizable().scaledToFit()
                    } else {
                        ProgressView()
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 300)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        case .video:
            Group {
                if let player {
                    VideoPlayer(player: player)
                } else {
                    ZStack {
                        FydeTheme.ink.opacity(0.9)
                        Image(systemName: "video")
                            .font(.largeTitle)
                            .foregroundStyle(Color.white.opacity(0.8))
                    }
                }
            }
            .aspectRatio(16 / 9, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        default:
            ZStack {
                asset.mediaType == .document ? FydeTheme.accentSoft : FydeTheme.sunken
                VStack(spacing: 10) {
                    Image(systemName: asset.mediaType == .document ? "doc.text" : "folder")
                        .font(.system(size: 52, weight: .light))
                    Text(asset.filename)
                        .font(.footnote.weight(.medium))
                        .lineLimit(1)
                        .padding(.horizontal, 24)
                }
                .foregroundStyle(asset.mediaType == .document ? FydeTheme.accent : FydeTheme.muted)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 200)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }

    // MARK: Info

    private struct InfoItem {
        let icon: String
        let label: String
        let value: String
    }

    private var infoItems: [InfoItem] {
        var items: [InfoItem] = []
        if !asset.location.isEmpty {
            items.append(InfoItem(icon: "mappin", label: "Place", value: asset.location))
        }
        if !asset.people.isEmpty {
            items.append(InfoItem(icon: "person.2", label: "People", value: asset.people.joined(separator: ", ")))
        }
        if let d = FydeFormat.date(asset.createdAt) {
            items.append(InfoItem(icon: "calendar", label: "Added", value: d.formatted(date: .abbreviated, time: .omitted)))
        }
        if let dur = asset.durationSec, asset.mediaType == .video {
            items.append(InfoItem(icon: "clock", label: "Length", value: FydeFormat.timestamp(dur)))
        }
        if asset.sizeBytes > 0 {
            items.append(InfoItem(icon: "internaldrive", label: "Size", value: FydeFormat.bytes(asset.sizeBytes)))
        }
        if !asset.folderPath.isEmpty {
            items.append(InfoItem(icon: "folder", label: "Folder", value: asset.folderPath))
        }
        return items
    }

    @ViewBuilder
    private var infoRows: some View {
        let items = infoItems
        if !items.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(spacing: 12) {
                        Image(systemName: item.icon)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(FydeTheme.muted)
                            .frame(width: 20)
                        Text(item.label)
                            .font(.subheadline)
                            .foregroundStyle(FydeTheme.inkSecondary)
                        Spacer(minLength: 12)
                        Text(item.value)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(FydeTheme.ink)
                            .multilineTextAlignment(.trailing)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    if index < items.count - 1 {
                        Rectangle()
                            .fill(FydeTheme.line)
                            .frame(height: 1)
                            .padding(.leading, 46)
                    }
                }
            }
            .fydeCard(padding: 0, radius: 16)
        }
    }

    // MARK: Send

    private var sendMenu: some View {
        Menu {
            ForEach(store.permissions) { perm in
                Menu("Send to \(perm.contactName)") {
                    ForEach(SendChannel.allCases) { channel in
                        Button {
                            Task {
                                await store.quickSendAsset(asset, to: perm.contactName, channel: channel)
                            }
                        } label: {
                            Label(channel.label, systemImage: channel.systemImage)
                        }
                    }
                }
            }
            Button {
                dismiss()
                store.selectedTab = .chat
                Task {
                    await store.sendChatPrompt("Send \(asset.title) to Maya")
                }
            } label: {
                Label("Send to Maya in Chat", systemImage: "paperplane.fill")
            }
        } label: {
            Label("Send", systemImage: "paperplane.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(FydeTheme.accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Send \(asset.title)")
    }
}
