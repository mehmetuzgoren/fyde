import SwiftUI

public struct PermissionsSheetView: View {
    @Bindable var store: FydeStore
    @Environment(\.dismiss) private var dismiss

    @State private var contactName: String = ""
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

    public var body: some View {
        NavigationStack {
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
                                            .background(Color.indigo.opacity(0.14), in: Capsule())
                                            .foregroundStyle(.indigo)
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
                    .disabled(contactName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("Contact Permissions")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 500, minHeight: 540)
        #endif
    }

    private func loadIntoEditor(_ perm: ContactPermission) {
        contactName = perm.contactName
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

        await store.savePermission(
            contactName: contactName.trimmingCharacters(in: .whitespacesAndNewlines),
            relationship: relationship,
            email: email,
            phone: phone,
            tier: selectedTier,
            smartScopes: scopes
        )
        contactName = ""
    }
}
