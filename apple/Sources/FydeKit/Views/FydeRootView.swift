import SwiftUI

public struct FydeRootView: View {
    @Bindable var store: FydeStore
    @State private var showSettings = false
    @State private var showBilling = false
    @State private var showVexoFromSettings = false

    public init(store: FydeStore) {
        self.store = store
    }

    public var body: some View {
        Group {
            if !store.isAuthenticated {
                FydeAuthGateView(store: store)
            } else {
                TabView(selection: $store.selectedTab) {
                    Tab("Search", systemImage: "magnifyingglass", value: FydeTab.search) {
                        SearchTabView(store: store, onOpenSettings: { showSettings = true })
                    }

                    Tab("Chat", systemImage: "bubble.left.and.bubble.right.fill", value: FydeTab.chat) {
                        ChatTabView(store: store, onOpenSettings: { showSettings = true })
                    }

                    Tab("Received", systemImage: "tray.and.arrow.down.fill", value: FydeTab.received) {
                        ReceivedTabView(store: store, onOpenSettings: { showSettings = true })
                    }
                    .badge(store.unreadReceivedBadgeCount)
                }
                .tint(FydeTheme.accent)
                .overlay(alignment: .top) {
                    if let banner = store.statusBanner {
                        FydeToast(text: banner) { store.statusBanner = nil }
                            .padding(.top, 4)
                            .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
                .task(id: store.statusBanner) {
                    guard store.statusBanner != nil else { return }
                    try? await Task.sleep(for: .seconds(5))
                    if !Task.isCancelled {
                        store.statusBanner = nil
                    }
                }
            }
        }
        .animation(.spring(duration: 0.35), value: store.statusBanner)
        .task {
            await store.bootstrap()
        }
        .sheet(isPresented: $showSettings) {
            FydeSettingsSheet(
                store: store,
                onOpenBilling: {
                    showSettings = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        showBilling = true
                    }
                },
                onOpenVexo: {
                    showSettings = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        showVexoFromSettings = true
                    }
                }
            )
        }
        .sheet(isPresented: $showBilling) {
            FydeBillingSheetView(store: store)
        }
        .sheet(isPresented: $showVexoFromSettings) {
            VexoBandSheetView(store: store)
        }
    }
}

struct FydeSettingsSheet: View {
    @Bindable var store: FydeStore
    var onOpenBilling: () -> Void
    var onOpenVexo: () -> Void
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

                    Button(role: .destructive) {
                        Task {
                            await store.signOut()
                            dismiss()
                        }
                    } label: {
                        Text("Sign Out")
                    }
                }

                Section("Cloudflare Edge") {
                    HStack {
                        Circle()
                            .fill(store.isRelayConnected ? FydeTheme.success : FydeBrand.terracotta)
                            .frame(width: 8, height: 8)
                        Text(store.isRelayConnected ? "Connected" : "Offline")
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

                Section("Vexo Open Wristband (Vexo-HACK-69)") {
                    HStack {
                        Circle()
                            .fill(store.vexo.isConnected ? FydeTheme.success : FydeTheme.muted)
                            .frame(width: 8, height: 8)
                        Text(store.vexo.isConnected ? "Connected to \(store.vexo.bandName)" : "\(store.vexo.bandName) Disconnected")
                            .font(.caption)
                        Spacer()
                        Button("Configure Vexo #\(store.vexo.bandNumber)…") {
                            onOpenVexo()
                        }
                        .font(.caption.bold())
                    }
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
            .scrollContentBackground(.hidden)
            .background(FydeTheme.paper)
            .tint(FydeTheme.accent)
            .navigationTitle("Settings")
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
