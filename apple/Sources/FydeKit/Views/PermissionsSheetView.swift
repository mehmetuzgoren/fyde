import SwiftUI

public struct PermissionsSheetView: View {
    @Bindable var store: FydeStore
    @Environment(\.dismiss) private var dismiss

    private enum SheetSection: String, CaseIterable, Identifiable {
        case network = "Network"
        case access = "Access Rules"
        case profile = "Your @handle"
        var id: String { rawValue }
    }

    @State private var activeSection: SheetSection = .network

    // Social & @handle search
    @State private var handleQuery: String = ""
    @State private var searchResults: [DirectoryUser] = []
    @State private var isSearchingUsers = false
    @State private var socialFeedback: String?

    // Profile @handle editor
    @State private var myHandle: String = ""
    @State private var myDisplayName: String = ""
    @State private var myBio: String = ""
    @State private var profileMessage: String?

    // Access Rule editor
    @State private var contactName: String = ""
    @State private var contactHandle: String = ""
    @State private var relationship: String = ""
    @State private var email: String = ""
    @State private var phone: String = ""
    @State private var selectedTier: PermissionTier = .smartScope

    // Folderless Smart Scope Builder fields
    @State private var scopeLocations: String = "China"
    @State private var scopePeople: String = ""
    @State private var scopeTopic: String = "China trip"
    @State private var includePhotos: Bool = true
    @State private var includeVideos: Bool = true
    @State private var includeDocs: Bool = false

    public init(store: FydeStore) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Section", selection: $activeSection) {
                    ForEach(SheetSection.allCases) { sec in
                        Text(sec.rawValue).tag(sec)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(FydeTheme.paper)

                switch activeSection {
                case .network:
                    networkView
                case .access:
                    accessRulesView
                case .profile:
                    profileView
                }
            }
            .background(FydeTheme.paper.ignoresSafeArea())
            .tint(FydeTheme.accent)
            .navigationTitle("People & @Network")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                myHandle = store.currentUser.handle
                myDisplayName = store.currentUser.displayName
                myBio = store.currentUser.bio ?? ""
                await store.loadSocialOverview()
            }
            .task(id: handleQuery) {
                let q = handleQuery.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !q.isEmpty else {
                    searchResults = []
                    return
                }
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled else { return }
                isSearchingUsers = true
                searchResults = await store.searchUsers(query: q)
                isSearchingUsers = false
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 580)
        #endif
    }

    // MARK: - Network (@handle directory, requests, friends, feed)

    private var networkView: some View {
        Form {
            Section("Find & Add by @handle") {
                HStack(spacing: 8) {
                    Image(systemName: "at")
                        .foregroundStyle(FydeTheme.accent)
                        .font(.subheadline.weight(.bold))
                    TextField("Search @handle or name…", text: $handleQuery)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    if !handleQuery.isEmpty {
                        Button("Add") {
                            Task {
                                socialFeedback = await store.sendFriendRequest(targetHandle: handleQuery)
                                searchResults = await store.searchUsers(query: handleQuery)
                            }
                        }
                        .font(.caption.weight(.bold))
                        .buttonStyle(.borderedProminent)
                    }
                }

                if let msg = socialFeedback {
                    Text(msg)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(FydeTheme.accent)
                }

                if isSearchingUsers {
                    ProgressView()
                } else {
                    ForEach(searchResults) { user in
                        directoryUserRow(user)
                    }
                }
            }

            if !store.incomingFriendRequests.isEmpty {
                Section("Incoming Contact Requests (\(store.incomingFriendRequests.count))") {
                    ForEach(store.incomingFriendRequests) { req in
                        HStack(spacing: 12) {
                            FydeAvatar(name: req.requesterName, hex: req.requesterAvatarColor, size: 36)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(req.requesterName)
                                    .font(.subheadline.weight(.semibold))
                                Text("@\(req.requesterHandle)")
                                    .font(.caption)
                                    .foregroundStyle(FydeTheme.accent)
                            }
                            Spacer()
                            Button("Decline") {
                                Task { await store.resolveFriendRequest(req, accept: false) }
                            }
                            .font(.caption.weight(.semibold))
                            .buttonStyle(.bordered)
                            Button("Accept") {
                                Task { await store.resolveFriendRequest(req, accept: true) }
                            }
                            .font(.caption.weight(.bold))
                            .buttonStyle(.borderedProminent)
                        }
                    }
                }
            }

            Section("Connected Contacts (\(store.socialFriends.count))") {
                if store.socialFriends.isEmpty {
                    Text("No @contacts connected yet. Search a @handle above to connect.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(store.socialFriends) { friend in
                        HStack(spacing: 12) {
                            FydeAvatar(name: friend.displayName, hex: friend.avatarColor, size: 36)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(friend.displayName)
                                    .font(.subheadline.weight(.semibold))
                                Text("@\(friend.handle)\(friend.bio.isEmpty ? "" : " · \(friend.bio)")")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Button("Access") {
                                contactName = friend.displayName
                                contactHandle = friend.handle
                                activeSection = .access
                            }
                            .font(.caption.weight(.semibold))
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }

            if !store.socialSuggestions.isEmpty {
                Section("People on fyde.") {
                    ForEach(store.socialSuggestions) { person in
                        directoryUserRow(person)
                    }
                }
            }

            if !store.socialFeed.isEmpty {
                Section("Network Activity") {
                    ForEach(store.socialFeed.prefix(12)) { item in
                        HStack(alignment: .top, spacing: 10) {
                            FydeAvatar(name: item.actorName, hex: item.actorAvatarColor, size: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.summary)
                                    .font(.caption)
                                    .foregroundStyle(FydeTheme.ink)
                                if let rel = FydeFormat.relative(item.createdAt) {
                                    Text(rel)
                                        .font(.caption2)
                                        .foregroundStyle(FydeTheme.muted)
                                }
                            }
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func directoryUserRow(_ user: DirectoryUser) -> some View {
        HStack(spacing: 12) {
            FydeAvatar(name: user.displayName, hex: user.avatarColor, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(user.displayName)
                    .font(.subheadline.weight(.semibold))
                Text("@\(user.handle)\(user.bio.isEmpty ? "" : " · \(user.bio)")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            switch user.friendshipStatus {
            case "accepted":
                FydeChip(text: "Connected", icon: "checkmark", tone: .success)
            case "pending_outgoing":
                FydeChip(text: "Pending", icon: "clock", tone: .warning)
            case "pending_incoming":
                Button("Accept") {
                    if let match = store.incomingFriendRequests.first(where: { $0.requesterId == user.id }) {
                        Task { await store.resolveFriendRequest(match, accept: true) }
                    } else {
                        Task { socialFeedback = await store.sendFriendRequest(targetHandle: user.handle) }
                    }
                }
                .font(.caption.weight(.bold))
                .buttonStyle(.borderedProminent)
            default:
                Button("+ Add") {
                    Task {
                        socialFeedback = await store.sendFriendRequest(targetHandle: user.handle)
                        if !handleQuery.isEmpty {
                            searchResults = await store.searchUsers(query: handleQuery)
                        }
                    }
                }
                .font(.caption.weight(.bold))
                .buttonStyle(.borderedProminent)
            }
        }
    }

    // MARK: - Access Rules

    private var accessRulesView: some View {
        Form {
            Section("Existing Contact Permissions") {
                if store.permissions.isEmpty {
                    Text("No contact permissions configured yet.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(store.permissions) { perm in
                        Button {
                            loadIntoEditor(perm)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(perm.contactName)
                                        .font(.subheadline.weight(.semibold))
                                    if let h = perm.contactHandle, !h.isEmpty {
                                        Text("@\(h)")
                                            .font(.caption.weight(.medium))
                                            .foregroundStyle(FydeTheme.accent)
                                    }
                                    if !perm.relationship.isEmpty {
                                        Text("(\(perm.relationship))")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(perm.tier.title)
                                        .font(.caption2.weight(.bold))
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(FydeTheme.accentSoft, in: Capsule())
                                        .foregroundStyle(FydeTheme.accent)
                                }
                                ForEach(perm.smartScopes) { rule in
                                    Text("• \(rule.label)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            Section("Add or Update Contact Rule") {
                TextField("@handle (e.g. @alex)", text: $contactHandle)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                TextField("Contact Name (e.g. Maya, Alex)", text: $contactName)
                TextField("Relationship (e.g. Wife, Friend)", text: $relationship)
                TextField("Email (for background Email send)", text: $email)
                    .autocorrectionDisabled()
                TextField("Phone / Apple ID (for iMessage)", text: $phone)

                Picker("Trust Tier", selection: $selectedTier) {
                    ForEach(PermissionTier.allCases) { tier in
                        Text(tier.title).tag(tier)
                    }
                }
                Text(selectedTier.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if selectedTier == .smartScope {
                Section("Folderless Smart Scope Filter (Photos & Files)") {
                    TextField("Locations (comma-separated, e.g. China, Shanghai)", text: $scopeLocations)
                    TextField("With People (e.g. Alex, Maya)", text: $scopePeople)
                    TextField("Semantic Concept / Event (e.g. China trip)", text: $scopeTopic)
                    Toggle("Include Photos", isOn: $includePhotos)
                    Toggle("Include Videos", isOn: $includeVideos)
                    Toggle("Include Documents / PDFs", isOn: $includeDocs)
                }
            }

            Section {
                Button {
                    Task { await saveRule() }
                } label: {
                    HStack {
                        Spacer()
                        Label("Save Contact Permission", systemImage: "checkmark.shield.fill")
                            .font(.subheadline.weight(.bold))
                        Spacer()
                    }
                }
                .disabled(
                    contactName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                    contactHandle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }
        }
        .scrollContentBackground(.hidden)
    }

    // MARK: - Profile (@handle claim/edit)

    private var profileView: some View {
        Form {
            Section("Your fyde. Identity") {
                HStack(spacing: 6) {
                    Text("@")
                        .font(.headline.bold())
                        .foregroundStyle(FydeTheme.accent)
                    TextField("handle", text: $myHandle)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                TextField("Display Name", text: $myDisplayName)
                TextField("Short Bio (e.g. SF · Photos & Travel)", text: $myBio)

                if let profileMessage {
                    Text(profileMessage)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(FydeTheme.accent)
                }

                Button("Save @handle & Profile") {
                    Task {
                        let err = await store.updateProfileHandle(
                            handle: myHandle,
                            displayName: myDisplayName,
                            bio: myBio
                        )
                        profileMessage = err ?? "Saved as @\(store.currentUser.handle)"
                    }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func loadIntoEditor(_ perm: ContactPermission) {
        contactName = perm.contactName
        contactHandle = perm.contactHandle ?? ""
        relationship = perm.relationship
        email = perm.email
        phone = perm.phone
        selectedTier = perm.tier
        if let first = perm.smartScopes.first {
            scopeLocations = first.locations.joined(separator: ", ")
            scopePeople = first.people.joined(separator: ", ")
            scopeTopic = first.semanticQuery ?? ""
            includePhotos = first.mediaTypes.isEmpty || first.mediaTypes.contains(.photo)
            includeVideos = first.mediaTypes.isEmpty || first.mediaTypes.contains(.video)
            includeDocs = first.mediaTypes.contains(.document)
        }
    }

    private func saveRule() async {
        var scopes: [SmartScopeRule] = []
        if selectedTier == .smartScope {
            let locs = scopeLocations.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            let ppl = scopePeople.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            var types: [MediaType] = []
            if includePhotos { types.append(.photo) }
            if includeVideos { types.append(.video) }
            if includeDocs { types.append(.document) }
            let label = "Auto-access \(scopeTopic.isEmpty ? "matching items" : scopeTopic)"
                + (locs.isEmpty ? "" : " in \(locs.joined(separator: "/"))")
                + (ppl.isEmpty ? "" : " with \(ppl.joined(separator: ", "))")
            scopes.append(
                SmartScopeRule(
                    label: label,
                    locations: locs,
                    people: ppl,
                    mediaTypes: types,
                    semanticQuery: scopeTopic.isEmpty ? nil : scopeTopic
                )
            )
        }

        let cleanedHandle = contactHandle.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "@", with: "")
        let cleanedName = contactName.trimmingCharacters(in: .whitespacesAndNewlines)
        await store.savePermission(
            contactName: cleanedName.isEmpty ? cleanedHandle : cleanedName,
            contactHandle: cleanedHandle.isEmpty ? nil : cleanedHandle,
            relationship: relationship,
            email: email,
            phone: phone,
            tier: selectedTier,
            smartScopes: scopes
        )
        contactName = ""
        contactHandle = ""
    }
}
