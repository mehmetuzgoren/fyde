import SwiftUI

public struct FydeRootView: View {
    @Bindable var store: FydeStore
    @State private var showSettings = false
    @State private var showBilling = false

    public init(store: FydeStore) {
        self.store = store
    }

    public var body: some View {
        Group {
            if !store.isAuthenticated {
                FydeAuthGateView(store: store)
            } else {
                ZStack(alignment: .top) {
                    TabView(selection: $store.selectedTab) {
                        // LEFT TAB: Multimodal Search
                        SearchTabView(store: store, onOpenSettings: { showSettings = true })
                            .tabItem {
                                Label("Search", systemImage: "magnifyingglass")
                            }
                            .tag(FydeTab.search)

                        // MIDDLE TAB (DEFAULT LANDING): fyde. Chat & Permissions
                        ChatTabView(store: store, onOpenSettings: { showSettings = true })
                            .tabItem {
                                Label("fyde. Chat", systemImage: "bubble.left.and.bubble.right.fill")
                            }
                            .tag(FydeTab.chat)

                        // RIGHT TAB: Received & Approvals
                        ReceivedTabView(store: store, onOpenSettings: { showSettings = true })
                            .tabItem {
                                Label("Received", systemImage: "tray.and.arrow.down.fill")
                            }
                            .badge(store.unreadReceivedBadgeCount)
                            .tag(FydeTab.received)
                    }
                    .tint(FydeBrand.terracotta)

                    if let banner = store.statusBanner {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(FydeBrand.terracotta)
                                .frame(width: 8, height: 8)
                            Text(banner)
                                .font(.footnote.weight(.medium))
                                .lineLimit(2)
                            Spacer(minLength: 4)
                            Button {
                                store.statusBanner = nil
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.caption.bold())
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(.ultraThinMaterial, in: Capsule())
                        .shadow(radius: 6)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                        .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
            }
        }
        .animation(.spring(duration: 0.3), value: store.statusBanner)
        .task {
            await store.bootstrap()
        }
        .sheet(isPresented: $showSettings) {
            FydeSettingsSheet(store: store, onOpenBilling: {
                showSettings = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    showBilling = true
                }
            })
        }
        .sheet(isPresented: $showBilling) {
            FydeBillingSheetView(store: store)
        }
    }
}

struct FydeSettingsSheet: View {
    @Bindable var store: FydeStore
    var onOpenBilling: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Account & Subscription") {
                    LabeledContent("Signed in as", value: "\(store.currentUser.displayName) (@\(store.currentUser.handle))")
                    LabeledContent("Current Plan", value: (store.currentUser.planTier ?? .starter).displayTitle)

                    Button {
                        onOpenBilling()
                    } label: {
                        Label("Upgrade / Manage Subscription (Apple Pay & Stripe)", systemImage: "sparkles")
                            .foregroundStyle(FydeBrand.terracotta)
                    }

                    Picker("Quick Switch Peer (Test P2P)", selection: Binding(
                        get: { store.currentUserId },
                        set: { newId in Task { await store.switchUser(to: newId) } }
                    )) {
                        ForEach(store.users) { u in
                            Text("\(u.displayName) (@\(u.handle))").tag(u.id)
                        }
                    }

                    Button(role: .destructive) {
                        Task {
                            await store.signOut()
                            dismiss()
                        }
                    } label: {
                        Text("Sign Out")
                    }
                }

                Section("Cloudflare Edge Relay (fyde.izbirakin.com)") {
                    TextField("Edge URL", text: $store.relayBaseURL)
                        .autocorrectionDisabled()
                    HStack(spacing: 10) {
                        Button("Use Local (:8787)") {
                            store.relayBaseURL = "http://127.0.0.1:8787"
                            Task { await store.bootstrap() }
                        }
                        .font(.caption.weight(.semibold))

                        Button("Use fyde.izbirakin.com") {
                            store.relayBaseURL = "https://fyde.izbirakin.com"
                            Task { await store.bootstrap() }
                        }
                        .font(.caption.weight(.semibold))
                    }
                    HStack {
                        Circle()
                            .fill(store.isRelayConnected ? Color.green : FydeBrand.terracotta)
                            .frame(width: 8, height: 8)
                        Text(store.isRelayConnected ? "Connected to Cloudflare Edge" : "Offline Local Mode")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Reconnect") {
                            Task { await store.bootstrap() }
                        }
                        .font(.caption.bold())
                    }
                }

                Section("Multimodal Embedding Engine") {
                    LabeledContent("Active Provider", value: store.activeEmbedderName)
                        .font(.caption)
                }

                #if os(macOS)
                Section("macOS Background iMessage Bridge") {
                    Toggle("Enable Live Messages.app Automation", isOn: $store.enableLiveMacOSMessagesBridge)
                    Text("When enabled, iMessage requests from your iPhone or Web app are dispatched automatically in the background through macOS Messages.app via your Durable Object WebSocket.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                #endif
            }
            .navigationTitle("fyde. Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 440)
        #endif
    }
}
