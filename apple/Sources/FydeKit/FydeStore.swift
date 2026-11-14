import Foundation
import Observation

@MainActor
@Observable
public final class FydeStore {
    public var relayBaseURL: String = "http://127.0.0.1:8787" {
        didSet {
            UserDefaults.standard.set(relayBaseURL, forKey: "fyde.relayBaseURL")
        }
    }
    public var selectedTab: FydeTab = .chat  // Default landing tab: Middle Chat tab!

    public var isAuthenticated: Bool = false
    public var sessionToken: String? {
        didSet {
            if let token = sessionToken, !token.isEmpty {
                UserDefaults.standard.set(token, forKey: "fyde.sessionToken")
            } else {
                UserDefaults.standard.removeObject(forKey: "fyde.sessionToken")
            }
        }
    }

    public var plans: [PlanDefinition] = [
        PlanDefinition(
            tier: .starter,
            name: "Starter",
            tagline: "Private on-device search & peer transfers",
            monthlyUsd: 0,
            yearlyUsd: 0,
            features: [
                "Local EmbeddingGemma 2 / Apple Neural Engine search",
                "Up to 2 GB Direct Fyde transfers per month",
                "Up to 3 Contact Permission rules",
                "iPhone, macOS & Web access"
            ]
        ),
        PlanDefinition(
            tier: .pro,
            name: "fyde. Pro",
            tagline: "Always-on edge relay & zero-egress 4K video sharing",
            monthlyUsd: 12,
            yearlyUsd: 99,
            features: [
                "Unlimited zero-egress R2 photo & 4K video relays",
                "Unlimited Folderless Smart Scopes",
                "Always-On Edge Index for instant trusted pulls",
                "Automatic background Email + macOS Messages.app bridge"
            ],
            highlighted: true
        ),
        PlanDefinition(
            tier: .family,
            name: "fyde. Household",
            tagline: "Shared trust & Direct-to-Photos across up to 6 members",
            monthlyUsd: 19,
            yearlyUsd: 159,
            features: [
                "Everything in fyde. Pro for up to 6 family members",
                "Mutual Trusted Spouse / Partner auto-pulling",
                "AirDrop-style automatic PhotoKit album syncing",
                "Priority video keyframe & multimodal cloud indexing"
            ]
        )
    ]

    public var users: [UserProfile] = [
        UserProfile(id: "mehmet", handle: "mehmet", displayName: "Mehmet", email: "mehmet@izbirakin.com", phone: "+14155550101", avatarColor: "#293022", planTier: .pro, autoSaveTrustedToPhotos: true),
        UserProfile(id: "maya", handle: "maya", displayName: "Maya", email: "maya@izbirakin.com", phone: "+14155550102", avatarColor: "#BF5134", planTier: .family, autoSaveTrustedToPhotos: true),
        UserProfile(id: "alex", handle: "alex", displayName: "Alex", email: "alex@example.com", phone: "+14155550103", avatarColor: "#3D5A45", planTier: .starter, autoSaveTrustedToPhotos: false),
        UserProfile(id: "sarah", handle: "sarah", displayName: "Sarah", email: "sarah@taxfirm.example.com", phone: "+14155550104", avatarColor: "#5C6454", planTier: .starter, autoSaveTrustedToPhotos: false)
    ]
    public var currentUserId: String = "mehmet"

    public var isRelayConnected: Bool = false
    public var activeEmbedderName: String = ""
    public var statusBanner: String?

    // Left Tab: Search state
    public var searchQuery: String = ""
    public var searchScope: String = "all" // "all" | "mine" | "contacts"
    public var selectedMediaFilter: MediaType?
    public var searchHits: [SearchHit] = []
    public var myAssets: [IndexedAsset] = []
    public var isSearching: Bool = false

    // Middle Tab: Chat & Permissions state
    public var chatMessages: [ChatMessage] = []
    public var isSendingChat: Bool = false
    public var permissions: [ContactPermission] = []

    // Right Tab: Received & Approvals state
    public var receivedBundles: [TransferBundle] = []
    public var sentBundles: [TransferBundle] = []
    public var incomingRequests: [AccessRequest] = []

    // macOS Live Messages.app Automation opt-in
    public var enableLiveMacOSMessagesBridge: Bool = false

    public let onDeviceEmbedder = OnDeviceMultimodalEmbedder()
    private let deviceId: String = "apple_\(PlatformMediaBridge.currentPlatform)_\(UUID().uuidString.prefix(6))"
    private var webSocketTask: URLSessionWebSocketTask?
    private var wsListenerTask: Task<Void, Never>?

    public init(relayBaseURL: String? = nil) {
        if let custom = relayBaseURL, !custom.isEmpty {
            self.relayBaseURL = custom
        } else if let envURL = ProcessInfo.processInfo.environment["FYDE_RELAY_URL"], !envURL.isEmpty {
            self.relayBaseURL = envURL
        } else if let savedURL = UserDefaults.standard.string(forKey: "fyde.relayBaseURL"), !savedURL.isEmpty {
            self.relayBaseURL = savedURL
        }
        if let savedToken = UserDefaults.standard.string(forKey: "fyde.sessionToken"), !savedToken.isEmpty {
            self.sessionToken = savedToken
            self.isAuthenticated = true
        }
        self.activeEmbedderName = onDeviceEmbedder.activeModelLabel
    }

    private func authorizedRequest(url: URL, method: String = "GET") -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let token = sessionToken, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    public var currentUser: UserProfile {
        users.first(where: { $0.id == currentUserId })
            ?? UserProfile(id: currentUserId, handle: currentUserId, displayName: currentUserId.capitalized)
    }

    public var unreadReceivedBadgeCount: Int {
        let pendingReqs = incomingRequests.filter { $0.status == "pending" }.count
        let unacceptedBundles = receivedBundles.filter { $0.status == "delivered" }.count
        return pendingReqs + unacceptedBundles
    }

    public func resolvedAssetURL(_ relativeOrAbsolute: String) -> URL? {
        guard !relativeOrAbsolute.isEmpty else { return nil }
        if relativeOrAbsolute.hasPrefix("http://") || relativeOrAbsolute.hasPrefix("https://") || relativeOrAbsolute.hasPrefix("file://") {
            return URL(string: relativeOrAbsolute)
        }
        let base = relayBaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let rel = relativeOrAbsolute.hasPrefix("/") ? relativeOrAbsolute : "/\(relativeOrAbsolute)"
        return URL(string: base + rel)
    }

    // MARK: - Lifecycle, Auth, Waitlist & Billing

    public func bootstrap() async {
        await restoreSessionIfAvailable()
        await loadBillingPlans()
        await refreshAll()
        if isAuthenticated {
            connectWebSocket()
        }
    }

    public func restoreSessionIfAvailable() async {
        guard let token = sessionToken, !token.isEmpty,
              let url = URL(string: "\(relayBaseURL)/api/auth/me") else { return }
        let req = authorizedRequest(url: url)
        struct MeResponse: Decodable {
            let authenticated: Bool
            let user: UserProfile?
        }
        if let (data, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200,
           let decoded = try? FydeJSON.makeDecoder().decode(MeResponse.self, from: data) {
            if decoded.authenticated, let u = decoded.user {
                applyAuthenticatedSession(user: u, token: token)
            }
        }
    }

    private func applyAuthenticatedSession(user: UserProfile, token: String?) {
        if let idx = users.firstIndex(where: { $0.id == user.id }) {
            users[idx] = user
        } else {
            users.append(user)
        }
        currentUserId = user.id
        if let token, !token.isEmpty {
            sessionToken = token
        }
        isAuthenticated = true
        selectedTab = .chat
    }

    public func sendEmailOTP(email: String) async -> (sent: Bool, previewHint: String?, error: String?) {
        guard let url = URL(string: "\(relayBaseURL)/api/auth/email/send-code") else {
            return (false, nil, "Invalid relay URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["email": email])
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            if (resp as? HTTPURLResponse)?.statusCode == 200 {
                return (true, obj["dev_code_hint"] as? String, nil)
            }
            return (false, nil, (obj["error"] as? String) ?? "Failed to send verification code.")
        } catch {
            return (false, nil, "Cannot reach relay (\(relayBaseURL)). Check Edge URL or use Offline Sandbox.")
        }
    }

    public func verifyEmailOTP(email: String, code: String, displayName: String = "") async -> String? {
        guard let url = URL(string: "\(relayBaseURL)/api/auth/email/verify-code") else { return "Invalid relay URL" }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "email": email,
            "code": code,
            "display_name": displayName
        ])
        return await consumeAuthResponse(for: req)
    }

    public func authenticateWithPassword(
        email: String,
        password: String,
        displayName: String = "",
        inviteCode: String = "",
        isRegister: Bool
    ) async -> String? {
        let path = isRegister ? "/api/auth/register" : "/api/auth/login"
        guard let url = URL(string: "\(relayBaseURL)\(path)") else { return "Invalid relay URL" }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "email": email,
            "password": password,
            "display_name": displayName,
            "invite_code": inviteCode
        ])
        return await consumeAuthResponse(for: req)
    }

    public func authenticateWithAppleNative(identityToken: String, fullName: String, email: String) async -> String? {
        guard let url = URL(string: "\(relayBaseURL)/api/auth/apple/native") else { return "Invalid relay URL" }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "identity_token": identityToken,
            "full_name": fullName,
            "email": email
        ])
        return await consumeAuthResponse(for: req)
    }

    public func signInDemo(handle: String) async {
        if let url = URL(string: "\(relayBaseURL)/api/auth/demo") {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["handle": handle])
            if await consumeAuthResponse(for: req) == nil {
                return
            }
        }
        // Offline local fallback if edge relay isn't running yet
        currentUserId = handle
        isAuthenticated = true
        await refreshAll()
    }

    private func consumeAuthResponse(for req: URLRequest) async -> String? {
        struct AuthPayload: Decodable {
            let user: UserProfile
            let token: String?
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            if (resp as? HTTPURLResponse)?.statusCode == 200,
               let decoded = try? FydeJSON.makeDecoder().decode(AuthPayload.self, from: data) {
                applyAuthenticatedSession(user: decoded.user, token: decoded.token)
                await refreshAll()
                connectWebSocket()
                return nil
            }
            let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            return (obj["error"] as? String) ?? "Authentication failed."
        } catch {
            return "Could not connect to \(relayBaseURL)."
        }
    }

    public func joinWaitlist(email: String, name: String, platform: String = "ios_macos") async -> String {
        guard let url = URL(string: "\(relayBaseURL)/api/waitlist") else { return "Invalid relay URL." }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "email": email,
            "name": name,
            "platform_interest": platform
        ])
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            return (obj["message"] as? String) ?? (obj["error"] as? String) ?? "Joined fyde. waitlist!"
        } catch {
            return "Could not reach waitlist endpoint (\(relayBaseURL))."
        }
    }

    public func loadBillingPlans() async {
        guard let url = URL(string: "\(relayBaseURL)/api/billing/plans") else { return }
        struct PlansResp: Decodable {
            let plans: [PlanDefinition]
        }
        if let (data, resp) = try? await URLSession.shared.data(from: url),
           (resp as? HTTPURLResponse)?.statusCode == 200,
           let decoded = try? FydeJSON.makeDecoder().decode(PlansResp.self, from: data),
           !decoded.plans.isEmpty {
            plans = decoded.plans
        }
    }

    public func startPlanCheckout(tier: PlanTier, interval: String) async -> (checkoutURL: URL?, message: String?) {
        guard let url = URL(string: "\(relayBaseURL)/api/billing/checkout") else {
            return (nil, "Invalid relay URL")
        }
        var req = authorizedRequest(url: url, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["tier": tier.rawValue, "interval": interval])
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            if (resp as? HTTPURLResponse)?.statusCode == 200 {
                if let urlStr = obj["checkout_url"] as? String, let checkoutURL = URL(string: urlStr) {
                    return (checkoutURL, nil)
                }
                if let idx = users.firstIndex(where: { $0.id == currentUserId }) {
                    users[idx].planTier = tier
                }
                let msg = (obj["message"] as? String) ?? "Activated \(tier.displayTitle)!"
                statusBanner = msg
                return (nil, msg)
            }
            return (nil, (obj["error"] as? String) ?? "Checkout failed.")
        } catch {
            return (nil, "Could not reach billing service.")
        }
    }

    public func signOut() async {
        if let url = URL(string: "\(relayBaseURL)/api/auth/logout") {
            let req = authorizedRequest(url: url, method: "POST")
            _ = try? await URLSession.shared.data(for: req)
        }
        disconnectWebSocket()
        sessionToken = nil
        isAuthenticated = false
    }

    public func switchUser(to userId: String) async {
        guard userId != currentUserId else { return }
        await signInDemo(handle: userId)
    }

    public func refreshAll() async {
        await checkHealthAndUsers()
        async let a: Void = loadMyAssets()
        async let b: Void = performSearch()
        async let c: Void = loadChatHistory()
        async let d: Void = loadPermissions()
        async let e: Void = loadReceivedInbox()
        _ = await (a, b, c, d, e)
    }

    // MARK: - REST Calls

    private func checkHealthAndUsers() async {
        guard let healthURL = URL(string: "\(relayBaseURL)/api/health") else { return }
        do {
            let (data, resp) = try await URLSession.shared.data(from: healthURL)
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                isRelayConnected = true
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let serverEmbedder = json["embedder"] as? String {
                    activeEmbedderName = "\(onDeviceEmbedder.activeModelLabel) + P2P (\(serverEmbedder))"
                }
            }
            if let usersURL = URL(string: "\(relayBaseURL)/api/users") {
                let (uData, _) = try await URLSession.shared.data(from: usersURL)
                let decoded = try FydeJSON.makeDecoder().decode([UserProfile].self, from: uData)
                if !decoded.isEmpty {
                    self.users = decoded
                }
            }
        } catch {
            isRelayConnected = false
            activeEmbedderName = onDeviceEmbedder.activeModelLabel + " (Offline Local Mode)"
        }
    }

    public func loadMyAssets() async {
        guard let url = URL(string: "\(relayBaseURL)/api/assets/\(currentUserId)") else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            myAssets = try FydeJSON.makeDecoder().decode([IndexedAsset].self, from: data)
        } catch {
            // Keep existing cached local assets
        }
    }

    public func performSearch() async {
        isSearching = true
        defer { isSearching = false }

        if isRelayConnected, let url = URL(string: "\(relayBaseURL)/api/search") {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var payload: [String: Any] = [
                "user_id": currentUserId,
                "query": searchQuery,
                "scope": searchScope,
                "limit": 24
            ]
            if let filter = selectedMediaFilter {
                payload["media_type"] = filter.rawValue
            }
            req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
            if let (data, resp) = try? await URLSession.shared.data(for: req),
               (resp as? HTTPURLResponse)?.statusCode == 200,
               let decoded = try? FydeJSON.makeDecoder().decode([SearchHit].self, from: data) {
                searchHits = decoded
                return
            }
        }

        // Offline local Apple Neural Engine fallback search
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let pool = myAssets.filter { selectedMediaFilter == nil || $0.mediaType == selectedMediaFilter }
        guard !q.isEmpty else {
            searchHits = pool.map { SearchHit(asset: $0, score: 1.0, matchReason: "Local index") }
            return
        }
        let qVec = onDeviceEmbedder.embedText(q)
        searchHits = pool.compactMap { asset in
            let assetVec = asset.embedding.isEmpty
                ? onDeviceEmbedder.embedText("\(asset.title) \(asset.location) \(asset.summary) \(asset.ocrText)")
                : asset.embedding
            let sim = OnDeviceMultimodalEmbedder.cosineSimilarity(qVec, assetVec)
            let lex = "\(asset.title) \(asset.location) \(asset.tags.joined(separator: " "))".lowercased().contains(q.lowercased()) ? 0.3 : 0.0
            let total = sim + lex
            guard total > 0.14 else { return nil }
            return SearchHit(asset: asset, score: min(0.99, total), matchReason: "On-device Apple Neural Engine match")
        }.sorted { $0.score > $1.score }
    }

    public func loadChatHistory() async {
        guard let url = URL(string: "\(relayBaseURL)/api/chat/\(currentUserId)") else { return }
        if let (data, _) = try? await URLSession.shared.data(from: url),
           let decoded = try? FydeJSON.makeDecoder().decode([ChatMessage].self, from: data) {
            chatMessages = decoded
        }
    }

    public func sendChatPrompt(_ prompt: String) async {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isSendingChat = true
        defer { isSendingChat = false }

        let optimistic = ChatMessage(userId: currentUserId, role: "user", text: trimmed)
        chatMessages.append(optimistic)

        guard let url = URL(string: "\(relayBaseURL)/api/chat") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "user_id": currentUserId,
            "text": trimmed,
            "platform": PlatformMediaBridge.currentPlatform,
            "auto_send": true
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
                chatMessages.append(ChatMessage(userId: currentUserId, role: "assistant", text: "Relay returned an error while processing your request."))
                return
            }
            let reply = try FydeJSON.makeDecoder().decode(ChatMessage.self, from: data)
            if !chatMessages.contains(where: { $0.id == reply.id }) {
                chatMessages.append(reply)
            }
            await loadPermissions()
            await loadReceivedInbox()
            await loadMyAssets()
            await performSearch()
        } catch {
            chatMessages.append(
                ChatMessage(
                    userId: currentUserId,
                    role: "assistant",
                    text: "Offline from Fyde Relay (\(relayBaseURL)). Start the relay server or configure your Cloud Run URL in Settings."
                )
            )
        }
    }

    public func quickSendAsset(
        _ asset: IndexedAsset,
        to recipientName: String,
        channel: SendChannel
    ) async {
        guard let url = URL(string: "\(relayBaseURL)/api/send") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "sender_id": currentUserId,
            "asset_ids": [asset.id],
            "recipient_name": recipientName,
            "channel": channel.rawValue,
            "title": asset.title,
            "message": "Shared via Fyde: \(asset.title)",
            "sender_platform": PlatformMediaBridge.currentPlatform
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        if let (data, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200,
           let bundle = try? FydeJSON.makeDecoder().decode(TransferBundle.self, from: data) {
            statusBanner = "Sent '\(bundle.title)' to \(bundle.recipientName) via \(channel.label)"
            await loadReceivedInbox()
        }
    }

    public func loadPermissions() async {
        guard let url = URL(string: "\(relayBaseURL)/api/permissions/\(currentUserId)") else { return }
        if let (data, _) = try? await URLSession.shared.data(from: url),
           let decoded = try? FydeJSON.makeDecoder().decode([ContactPermission].self, from: data) {
            permissions = decoded
        }
    }

    public func savePermission(
        contactName: String,
        relationship: String,
        email: String,
        phone: String,
        tier: PermissionTier,
        smartScopes: [SmartScopeRule]
    ) async {
        guard let url = URL(string: "\(relayBaseURL)/api/permissions") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        struct Payload: Encodable {
            let ownerId: String
            let contactName: String
            let relationship: String
            let email: String
            let phone: String
            let tier: PermissionTier
            let smartScopes: [SmartScopeRule]
        }
        let payload = Payload(
            ownerId: currentUserId,
            contactName: contactName,
            relationship: relationship,
            email: email,
            phone: phone,
            tier: tier,
            smartScopes: smartScopes
        )
        req.httpBody = try? FydeJSON.makeEncoder().encode(payload)
        if let (_, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200 {
            await loadPermissions()
            statusBanner = "Updated permissions for \(contactName)"
        }
    }

    public func loadReceivedInbox() async {
        guard let url = URL(string: "\(relayBaseURL)/api/received/\(currentUserId)") else { return }
        struct InboxResponse: Decodable {
            let bundles: [TransferBundle]
            let sentBundles: [TransferBundle]
            let incomingRequests: [AccessRequest]
        }
        if let (data, _) = try? await URLSession.shared.data(from: url),
           let decoded = try? FydeJSON.makeDecoder().decode(InboxResponse.self, from: data) {
            receivedBundles = decoded.bundles
            sentBundles = decoded.sentBundles
            incomingRequests = decoded.incomingRequests
        }
    }

    public func resolveAccessRequest(_ request: AccessRequest, approve: Bool) async {
        guard let url = URL(string: "\(relayBaseURL)/api/requests/\(request.id)/resolve") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = [
            "owner_id": currentUserId,
            "decision": approve ? "approve" : "deny"
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        if let (_, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200 {
            statusBanner = approve
                ? "Approved & sent files to \(request.requesterName)"
                : "Denied request from \(request.requesterName)"
            await loadReceivedInbox()
        }
    }

    // MARK: - AirDrop-Style Direct Save to Apple Photos & Local Files Acceptance

    public func acceptBundle(_ bundle: TransferBundle, intoPhotos: Bool, customAlbumOrFolder: String = "") async {
        do {
            // 1. Download actual binary files from the relay
            var downloadedFiles: [(item: BundleItem, localFileURL: URL, data: Data)] = []
            let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("fyde_\(bundle.id)", isDirectory: true)
            try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)

            for item in bundle.items {
                if let dlURL = resolvedAssetURL(item.downloadUrl) {
                    let (data, _) = try await URLSession.shared.data(from: dlURL)
                    let localURL = tempDir.appendingPathComponent(item.filename)
                    try data.write(to: localURL, options: .atomic)
                    downloadedFiles.append((item, localURL, data))
                }
            }

            let targetAlbum = customAlbumOrFolder.isEmpty ? "Fyde — \(bundle.senderName)" : customAlbumOrFolder
            if intoPhotos {
                let savedCount = try await PlatformMediaBridge.saveBundleItemsToApplePhotos(
                    items: downloadedFiles.map { ($0.item, $0.localFileURL) },
                    albumTitle: targetAlbum
                )
                statusBanner = "Saved \(savedCount) media item(s) directly to Apple Photos album '\(targetAlbum)'"
            } else {
                let savedDir = try PlatformMediaBridge.saveBundleItemsToLocalFiles(
                    items: downloadedFiles.map { ($0.item, $0.data) },
                    folderName: customAlbumOrFolder.isEmpty ? bundle.title : customAlbumOrFolder
                )
                statusBanner = "Saved \(downloadedFiles.count) file(s) to \(savedDir.lastPathComponent)"
            }

            // 2. Mark accepted on relay & index into recipient's library
            if let url = URL(string: "\(relayBaseURL)/api/bundles/\(bundle.id)/accept") {
                var req = URLRequest(url: url)
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                let payload: [String: String] = [
                    "user_id": currentUserId,
                    "destination_type": intoPhotos ? "photos" : "files",
                    "album_or_folder": targetAlbum
                ]
                req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
                _ = try? await URLSession.shared.data(for: req)
            }
            await loadReceivedInbox()
            await loadMyAssets()
            await performSearch()
        } catch {
            statusBanner = "Save note: \(error.localizedDescription)"
        }
    }

    // MARK: - Upload & On-Device Vision Enrichment

    public func uploadAndIndexMedia(
        data: Data,
        filename: String,
        mimeType: String,
        location: String = "",
        people: String = ""
    ) async {
        var tags: [String] = []
        var summary = ""
        if mimeType.hasPrefix("image/") {
            let insights = onDeviceEmbedder.extractImageInsights(data: data)
            tags.append(contentsOf: insights.sceneTags)
            if !insights.ocrText.isEmpty {
                summary = "On-device OCR: \(insights.ocrText.prefix(240))"
            }
        }

        guard let url = URL(string: "\(relayBaseURL)/api/assets/upload") else { return }
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func appendField(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }

        appendField("owner_id", currentUserId)
        appendField("device_id", deviceId)
        appendField("location", location)
        appendField("people", people)
        appendField("tags", tags.joined(separator: ","))
        appendField("summary", summary)

        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body

        if let (_, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200 {
            statusBanner = "Indexed '\(filename)' with multimodal embeddings"
            await loadMyAssets()
            await performSearch()
        }
    }

    // MARK: - Live P2P WebSocket Client

    public func connectWebSocket() {
        disconnectWebSocket()
        let wsBase = relayBaseURL
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
        let encodedName = PlatformMediaBridge.deviceDisplayName.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "Fyde"
        guard let wsURL = URL(
            string: "\(wsBase)/ws/\(currentUserId)?device_id=\(deviceId)&platform=\(PlatformMediaBridge.currentPlatform)&device_name=\(encodedName)"
        ) else { return }

        let task = URLSession.shared.webSocketTask(with: wsURL)
        self.webSocketTask = task
        task.resume()

        wsListenerTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let ws = self.webSocketTask else { break }
                do {
                    let message = try await ws.receive()
                    if case .string(let text) = message,
                       let data = text.data(using: .utf8),
                       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let event = obj["event"] as? String {
                        await self.handleWebSocketEvent(event, payload: obj["payload"])
                    }
                } catch {
                    break
                }
            }
        }
    }

    public func disconnectWebSocket() {
        wsListenerTask?.cancel()
        wsListenerTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
    }

    private func handleWebSocketEvent(_ event: String, payload: Any?) async {
        switch event {
        case "connected":
            isRelayConnected = true
        case "bundle_received":
            await loadReceivedInbox()
            if let dict = payload as? [String: Any],
               let raw = try? JSONSerialization.data(withJSONObject: dict),
               let bundle = try? FydeJSON.makeDecoder().decode(TransferBundle.self, from: raw) {
                statusBanner = "New Fyde bundle from \(bundle.senderName): \(bundle.title)"
                // AirDrop-style automatic PhotoKit save when sender is Trusted and autoSaveTrustedToPhotos is enabled!
                let senderIsTrusted = permissions.contains {
                    ($0.contactUserId == bundle.senderId || $0.contactName.lowercased() == bundle.senderName.lowercased())
                        && $0.tier == .trusted
                }
                let hasPhotosOrVideos = bundle.items.contains { $0.mediaType == .photo || $0.mediaType == .video }
                if currentUser.autoSaveTrustedToPhotos && senderIsTrusted && hasPhotosOrVideos && bundle.status == "delivered" {
                    await acceptBundle(bundle, intoPhotos: true, customAlbumOrFolder: "Fyde — \(bundle.senderName)")
                }
            }
        case "access_request_created", "access_request_resolved":
            await loadReceivedInbox()
            statusBanner = event == "access_request_created"
                ? "New file access request waiting for your approval"
                : "Your file access request was updated"
        case "permission_updated", "peer_permission_granted":
            await loadPermissions()
            await performSearch()
        case "imessage_bridge_job":
            #if os(macOS)
            if enableLiveMacOSMessagesBridge,
               let dict = payload as? [String: Any],
               let handle = dict["recipient_handle"] as? String,
               let msg = dict["message"] as? String,
               let bundleId = dict["bundle_id"] as? String {
                let res = PlatformMediaBridge.sendMacOSiMessage(recipientHandle: handle, message: msg, attachmentURLs: [])
                if case .success(let detail) = res {
                    let ack: [String: String] = ["type": "imessage_bridge_ack", "bundle_id": bundleId, "detail": detail]
                    if let ackData = try? JSONSerialization.data(withJSONObject: ack),
                       let ackStr = String(data: ackData, encoding: .utf8) {
                        try? await webSocketTask?.send(.string(ackStr))
                    }
                }
            }
            #endif
        default:
            break
        }
    }
}
