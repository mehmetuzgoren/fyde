import Foundation
import Observation

@MainActor
@Observable
public final class FydeStore {
    public var relayBaseURL: String = "https://fyde.izbirakin.com" {
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

    // Social Graph & @handle Contacts state
    public var socialFriends: [DirectoryUser] = []
    public var incomingFriendRequests: [FriendRequestRecord] = []
    public var outgoingFriendRequests: [FriendRequestRecord] = []
    public var socialSuggestions: [DirectoryUser] = []
    public var socialFeed: [SocialFeedItem] = []

    // macOS Live Messages.app Automation opt-in
    public var enableLiveMacOSMessagesBridge: Bool = false

    // Vexo Open Wristband (#69 = Vexo-HACK-69) Bluetooth & Voice Controller
    public let vexo = VexoBandManager()

    public let onDeviceEmbedder = OnDeviceMultimodalEmbedder()
    private let deviceId: String = "apple_\(PlatformMediaBridge.currentPlatform)_\(UUID().uuidString.prefix(6))"
    private var webSocketTask: URLSessionWebSocketTask?
    private var wsListenerTask: Task<Void, Never>?

    public init(relayBaseURL: String? = nil) {
        if let custom = relayBaseURL, !custom.isEmpty {
            self.relayBaseURL = custom
        } else if let envURL = ProcessInfo.processInfo.environment["FYDE_RELAY_URL"], !envURL.isEmpty {
            self.relayBaseURL = envURL
        } else if let savedURL = UserDefaults.standard.string(forKey: "fyde.relayBaseURL"),
                  !savedURL.isEmpty,
                  !savedURL.contains("127.0.0.1"),
                  !savedURL.contains("localhost") {
            self.relayBaseURL = savedURL
        }
        if let savedToken = UserDefaults.standard.string(forKey: "fyde.sessionToken"), !savedToken.isEmpty {
            self.sessionToken = savedToken
            self.isAuthenticated = true
        }
        self.activeEmbedderName = onDeviceEmbedder.activeModelLabel
        configureVexoCallbacks()
    }

    private func configureVexoCallbacks() {
        vexo.onVoiceCommandReady = { [weak self] spokenPrompt in
            guard let self else { return }
            self.selectedTab = .chat
            self.statusBanner = "Vexo #\(self.vexo.bandNumber): \"\(spokenPrompt)\""
            // source=vexo makes the relay apply your contact permissions before sending anything.
            await self.sendChatPrompt(spokenPrompt, source: "vexo")
        }

        vexo.onSingleTapTriggered = { [weak self] in
            guard let self else { return nil }
            // A voice send waiting for your OK takes priority: the band is glowing amber for it.
            if let held = self.latestBandConfirmableSend() {
                return await self.confirmChatSend(messageId: held.id, approve: true, viaBand: true)
            }
            if let pendingReq = self.incomingRequests.first(where: { $0.status == "pending" }) {
                await self.resolveAccessRequest(pendingReq, approve: true)
                return "Approved & sent files to \(pendingReq.requesterName)"
            }
            if let deliveredBundle = self.receivedBundles.first(where: { $0.status == "delivered" }) {
                let hasMedia = deliveredBundle.items.contains { $0.mediaType == .photo || $0.mediaType == .video }
                await self.acceptBundle(deliveredBundle, intoPhotos: hasMedia)
                return "Saved '\(deliveredBundle.title)' to \(hasMedia ? "Apple Photos" : "Files")"
            }
            return nil
        }

        vexo.onTiltTriggered = { [weak self] in
            guard let self else { return nil }
            let nextTab: FydeTab
            let label: String
            switch self.selectedTab {
            case .search:
                nextTab = .chat
                label = "fyde. Chat"
            case .chat:
                nextTab = .received
                label = "Received"
            case .received:
                nextTab = .search
                label = "Search"
            }
            self.selectedTab = nextTab
            self.statusBanner = "Switched to \(label) via Vexo #\(self.vexo.bandNumber)"
            return "Switched to \(label)"
        }

        vexo.onShakeTriggered = { [weak self] in
            guard let self else { return nil }
            await self.refreshAll()
            self.statusBanner = "Refreshed Fyde via Vexo #\(self.vexo.bandNumber) wrist shake"
            return "Refreshed Fyde inbox & search"
        }
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
        let pendingFriends = incomingFriendRequests.count
        return pendingReqs + unacceptedBundles + pendingFriends
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

    public func verifyEmailOTP(email: String, code: String, displayName: String = "", handle: String = "") async -> String? {
        guard let url = URL(string: "\(relayBaseURL)/api/auth/email/verify-code") else { return "Invalid relay URL" }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var payload: [String: String] = [
            "email": email,
            "code": code,
            "display_name": displayName
        ]
        if !handle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            payload["handle"] = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        return await consumeAuthResponse(for: req)
    }

    public func authenticateWithPassword(
        email: String,
        password: String,
        displayName: String = "",
        handle: String = "",
        inviteCode: String = "",
        isRegister: Bool
    ) async -> String? {
        let path = isRegister ? "/api/auth/register" : "/api/auth/login"
        guard let url = URL(string: "\(relayBaseURL)\(path)") else { return "Invalid relay URL" }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var payload: [String: String] = [
            "email": email,
            "password": password,
            "display_name": displayName,
            "invite_code": inviteCode
        ]
        if !handle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            payload["handle"] = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
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

    public func refreshAll() async {
        await checkHealthAndUsers()
        async let a: Void = loadMyAssets()
        async let c: Void = loadChatHistory()
        async let d: Void = loadPermissions()
        async let e: Void = loadReceivedInbox()
        async let f: Void = loadSocialOverview()
        _ = await (a, c, d, e, f)
        await performSearch()
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
            var req = authorizedRequest(url: url, method: "POST")
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
        var pool = searchScope == "contacts" ? [] : myAssets.filter {
            $0.ownerId == currentUserId && (selectedMediaFilter == nil || $0.mediaType == selectedMediaFilter)
        }
        var seen = Set(pool.map(\.id))
        let ownSources = Set(pool.map(\.downloadUrl).filter { !$0.isEmpty && $0 != "#" })
        var receivedAt: [String: String] = [:]
        if searchScope != "mine" {
            for bundle in receivedBundles.sorted(by: { $0.createdAt > $1.createdAt })
                where bundle.recipientId == currentUserId && bundle.senderId != currentUserId {
                for item in bundle.items {
                    guard selectedMediaFilter == nil || item.mediaType == selectedMediaFilter,
                          !ownSources.contains(item.downloadUrl),
                          seen.insert(item.assetId).inserted else { continue }
                    pool.append(IndexedAsset(
                        id: item.assetId,
                        ownerId: bundle.senderId,
                        ownerName: bundle.senderName,
                        filename: item.filename,
                        title: item.title,
                        mediaType: item.mediaType,
                        mimeType: item.mimeType,
                        sizeBytes: item.sizeBytes,
                        createdAt: bundle.createdAt,
                        location: item.location,
                        people: item.people,
                        folderPath: bundle.acceptedDestination ?? "Received/\(bundle.title)",
                        summary: bundle.message,
                        downloadUrl: item.downloadUrl,
                        thumbnailUrl: item.thumbnailUrl
                    ))
                    receivedAt[item.assetId] = bundle.createdAt
                }
            }
        }
        func receivedReason(_ asset: IndexedAsset, fallback: String) -> String {
            receivedAt[asset.id] == nil ? fallback : "Received from \(asset.ownerName)"
        }
        guard !q.isEmpty else {
            pool.sort { (receivedAt[$0.id] ?? $0.createdAt) > (receivedAt[$1.id] ?? $1.createdAt) }
            searchHits = pool.map {
                SearchHit(asset: $0, score: 1.0, matchReason: receivedReason($0, fallback: "Local index"))
            }
            return
        }
        let qVec = onDeviceEmbedder.embedText(q)
        searchHits = pool.compactMap { asset in
            let text = "\(asset.title) \(asset.filename) \(asset.location) \(asset.people.joined(separator: " ")) \(asset.tags.joined(separator: " ")) \(asset.summary) \(asset.ocrText)"
            // Relay vectors from another embedder (e.g. 768-D EmbeddingGemma 2) aren't comparable
            // with this on-device 256-D query vector: fall back to the asset's text.
            let assetVec = (asset.embedding.isEmpty || asset.embedding.count != qVec.count)
                ? onDeviceEmbedder.embedText(text)
                : asset.embedding
            let sim = OnDeviceMultimodalEmbedder.cosineSimilarity(qVec, assetVec)
            let lex = text.lowercased().contains(q.lowercased()) ? 0.3 : 0.0
            let total = sim + lex
            guard total > 0.14 else { return nil }
            return SearchHit(asset: asset, score: min(0.99, total), matchReason: receivedReason(asset, fallback: "On-device Apple Neural Engine match"))
        }.sorted { $0.score > $1.score }
    }

    public func loadChatHistory() async {
        let userId = currentUserId
        guard let url = URL(string: "\(relayBaseURL)/api/chat/\(userId)") else { return }
        if let (data, response) = try? await URLSession.shared.data(for: authorizedRequest(url: url)),
           (response as? HTTPURLResponse)?.statusCode == 200,
           currentUserId == userId,
           let decoded = try? FydeJSON.makeDecoder().decode([ChatMessage].self, from: data) {
            chatMessages.removeAll { $0.userId != userId }
            for message in decoded { receiveChatMessage(message) }
        }
    }

    /// Relay events and HTTP replies may contain the same turn. Match the sender's
    /// optimistic ID as well so its transcript appears exactly once.
    func receiveChatMessage(_ message: ChatMessage) {
        guard message.userId == currentUserId else { return }
        if let index = chatMessages.firstIndex(where: {
            $0.id == message.id || (message.clientMessageId != nil && $0.id == message.clientMessageId)
        }) {
            chatMessages[index] = message
        } else {
            chatMessages.append(message)
        }
        chatMessages.sort {
            (FydeFormat.date($0.createdAt) ?? .distantPast) < (FydeFormat.date($1.createdAt) ?? .distantPast)
        }
    }

    public func resumeFromBackground() async {
        guard isAuthenticated else { return }
        connectWebSocket()
        await loadChatHistory()
        await loadReceivedInbox()
    }

    /// - Parameter source: `"vexo"` for wrist voice commands, so the relay gates sends on your permissions.
    @discardableResult
    public func sendChatPrompt(_ prompt: String, source: String? = nil) async -> ChatMessage? {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        isSendingChat = true
        defer { isSendingChat = false }
        let fromVexo = source == "vexo"

        let optimistic = ChatMessage(userId: currentUserId, role: "user", text: trimmed, source: source)
        chatMessages.append(optimistic)

        guard let url = URL(string: "\(relayBaseURL)/api/chat") else { return nil }
        var req = authorizedRequest(url: url, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [
            "user_id": currentUserId,
            "text": trimmed,
            "client_message_id": optimistic.id,
            "platform": PlatformMediaBridge.currentPlatform,
            "auto_send": true
        ]
        if let source { body["source"] = source }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
                chatMessages.append(ChatMessage(userId: currentUserId, role: "assistant", text: "Relay returned an error while processing your request."))
                if fromVexo { vexo.notifyFydeEventLED(kind: .attentionError) }
                return nil
            }
            let reply = try FydeJSON.makeDecoder().decode(ChatMessage.self, from: data)
            receiveChatMessage(reply)
            if let card = reply.actionCard {
                vexo.notifyFydeEventLED(kind: card.isPendingSendConfirmation ? .awaitingConfirmation : .actionSucceeded)
                if fromVexo, card.isPendingSendConfirmation {
                    statusBanner = card.bandConfirmable == false
                        ? "Vexo send needs your OK in fyde: \(card.holdReason ?? "private item")"
                        : "Tap Vexo #\(vexo.bandNumber) once to send — \(card.holdReason ?? "needs your OK")"
                }
            } else if fromVexo {
                // Nothing was sent (unknown contact, no match, unclear "that"): red blink + the reason.
                vexo.notifyFydeEventLED(kind: .attentionError)
                statusBanner = reply.text.replacingOccurrences(of: "**", with: "")
            }
            await loadChatHistory()
            await loadPermissions()
            await loadReceivedInbox()
            await loadMyAssets()
            await performSearch()
            return reply
        } catch {
            chatMessages.append(
                ChatMessage(
                    userId: currentUserId,
                    role: "assistant",
                    text: "Offline from Fyde Relay (\(relayBaseURL)). Start the relay server or configure your Cloud Run URL in Settings."
                )
            )
            if fromVexo { vexo.notifyFydeEventLED(kind: .attentionError) }
            return nil
        }
    }

    /// The most recent held send, if it is still waiting, was held in the last 10 minutes, and has no
    /// private items. Older holds are never reached by a tap (confirm those from their chat card).
    func latestBandConfirmableSend(now: Date = Date()) -> ChatMessage? {
        guard let msg = chatMessages.last(where: { $0.actionCard?.holdReason != nil }),
              let card = msg.actionCard,
              card.isPendingSendConfirmation,
              card.bandConfirmable != false else { return nil }
        if let created = FydeFormat.date(msg.createdAt), now.timeIntervalSince(created) > 600 {
            return nil
        }
        return msg
    }

    /// Confirms (or cancels) a voice send the relay held for your OK. Returns a short summary for the band log.
    @discardableResult
    public func confirmChatSend(messageId: String, approve: Bool, viaBand: Bool = false) async -> String? {
        guard let url = URL(string: "\(relayBaseURL)/api/chat/confirm") else { return nil }
        var req = authorizedRequest(url: url, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "user_id": currentUserId,
            "message_id": messageId,
            "decision": approve ? "send" : "cancel",
            "via": viaBand ? "band" : "app"
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        guard let (data, resp) = try? await URLSession.shared.data(for: req) else {
            statusBanner = "Offline from Fyde Relay — couldn't confirm the send."
            return nil
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let updated = try? FydeJSON.makeDecoder().decode(ChatMessage.self, from: data) else {
            struct RelayError: Decodable { let error: String? }
            let reason = (try? JSONDecoder().decode(RelayError.self, from: data))?.error ?? "Relay returned \(status)."
            statusBanner = reason
            if viaBand { vexo.notifyFydeEventLED(kind: .attentionError) }
            await loadChatHistory()
            return nil
        }
        if let idx = chatMessages.firstIndex(where: { $0.id == updated.id }) {
            chatMessages[idx] = updated
        } else {
            chatMessages.append(updated)
        }
        let recipient = updated.actionCard?.recipientName ?? "your contact"
        let summary = approve ? "Sent to \(recipient)" : "Cancelled send to \(recipient)"
        statusBanner = summary
        // A band tap already gets its green flash from VexoBandManager when this returns a summary.
        if approve && !viaBand { vexo.notifyFydeEventLED(kind: .actionSucceeded) }
        await loadReceivedInbox()
        return summary
    }

    public func quickSendAsset(
        _ asset: IndexedAsset,
        to recipientName: String,
        channel: SendChannel
    ) async {
        guard let url = URL(string: "\(relayBaseURL)/api/send") else { return }
        var req = authorizedRequest(url: url, method: "POST")
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
        let req = authorizedRequest(url: url)
        if let (data, _) = try? await URLSession.shared.data(for: req),
           let decoded = try? FydeJSON.makeDecoder().decode([ContactPermission].self, from: data) {
            permissions = decoded
        }
    }

    public func savePermission(
        contactName: String,
        contactHandle: String? = nil,
        relationship: String,
        email: String,
        phone: String,
        tier: PermissionTier,
        smartScopes: [SmartScopeRule]
    ) async {
        guard let url = URL(string: "\(relayBaseURL)/api/permissions") else { return }
        var req = authorizedRequest(url: url, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        struct Payload: Encodable {
            let ownerId: String
            let contactName: String
            let contactHandle: String?
            let relationship: String
            let email: String
            let phone: String
            let tier: PermissionTier
            let smartScopes: [SmartScopeRule]
        }
        let payload = Payload(
            ownerId: currentUserId,
            contactName: contactName,
            contactHandle: contactHandle,
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
            await loadSocialOverview()
            statusBanner = "Updated permissions for \(contactName)"
        }
    }

    // MARK: - Social Graph & @handle Contacts

    public func loadSocialOverview() async {
        guard let url = URL(string: "\(relayBaseURL)/api/social/overview/\(currentUserId)") else { return }
        let req = authorizedRequest(url: url)
        if let (data, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200,
           let overview = try? FydeJSON.makeDecoder().decode(SocialOverview.self, from: data) {
            socialFriends = overview.friends
            incomingFriendRequests = overview.incomingRequests
            outgoingFriendRequests = overview.outgoingRequests
            socialSuggestions = overview.suggestions
            socialFeed = overview.feed
        }
    }

    public func searchUsers(query: String) async -> [DirectoryUser] {
        let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        guard let url = URL(string: "\(relayBaseURL)/api/users/search?q=\(encoded)&user_id=\(currentUserId)") else {
            return []
        }
        let req = authorizedRequest(url: url)
        if let (data, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200,
           let decoded = try? FydeJSON.makeDecoder().decode([DirectoryUser].self, from: data) {
            return decoded
        }
        return []
    }

    public func sendFriendRequest(targetHandle: String) async -> String {
        guard let url = URL(string: "\(relayBaseURL)/api/social/request") else { return "Invalid relay URL" }
        var req = authorizedRequest(url: url, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "requester_id": currentUserId,
            "target_handle": targetHandle
        ])
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            if (resp as? HTTPURLResponse)?.statusCode == 200 {
                let msg = (obj["message"] as? String) ?? "Request sent to \(targetHandle)"
                statusBanner = msg.replacingOccurrences(of: "**", with: "")
                await loadSocialOverview()
                await loadPermissions()
                return statusBanner ?? msg
            }
            return (obj["error"] as? String) ?? "Could not add \(targetHandle)"
        } catch {
            return "Could not reach relay."
        }
    }

    public func resolveFriendRequest(_ reqRecord: FriendRequestRecord, accept: Bool) async {
        guard let url = URL(string: "\(relayBaseURL)/api/social/request/\(reqRecord.id)/resolve") else { return }
        var req = authorizedRequest(url: url, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "user_id": currentUserId,
            "decision": accept ? "accept" : "decline"
        ])
        if let (_, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200 {
            statusBanner = accept
                ? "Connected with @\(reqRecord.requesterHandle)"
                : "Declined @\(reqRecord.requesterHandle)"
            await loadSocialOverview()
            await loadPermissions()
        }
    }

    public func updateProfileHandle(handle: String, displayName: String, bio: String) async -> String? {
        guard let url = URL(string: "\(relayBaseURL)/api/auth/handle") else { return "Invalid relay URL" }
        var req = authorizedRequest(url: url, method: "PATCH")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "user_id": currentUserId,
            "handle": handle,
            "display_name": displayName,
            "bio": bio
        ])
        return await consumeAuthResponse(for: req)
    }

    public func loadReceivedInbox() async {
        guard let url = URL(string: "\(relayBaseURL)/api/received/\(currentUserId)") else { return }
        struct InboxResponse: Decodable {
            let bundles: [TransferBundle]
            let sentBundles: [TransferBundle]
            let incomingRequests: [AccessRequest]
        }
        let req = authorizedRequest(url: url)
        if let (data, _) = try? await URLSession.shared.data(for: req),
           let decoded = try? FydeJSON.makeDecoder().decode(InboxResponse.self, from: data) {
            receivedBundles = decoded.bundles
            sentBundles = decoded.sentBundles
            incomingRequests = decoded.incomingRequests
        }
    }

    public func resolveAccessRequest(_ request: AccessRequest, approve: Bool) async {
        guard let url = URL(string: "\(relayBaseURL)/api/requests/\(request.id)/resolve") else { return }
        var req = authorizedRequest(url: url, method: "POST")
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

        func appendFile(_ name: String, _ partFilename: String, _ partMime: String, _ partData: Data) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(partFilename)\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: \(partMime)\r\n\r\n".data(using: .utf8)!)
            body.append(partData)
            body.append("\r\n".data(using: .utf8)!)
        }

        // The relay embeds what the photo/video shows with EmbeddingGemma 2: send a HEIC-safe
        // ~1536 px JPEG preview of photos, and keyframes of videos (one searchable moment each).
        if mimeType.hasPrefix("image/"), let preview = OnDeviceMultimodalEmbedder.embeddingPreviewJPEG(from: data) {
            appendFile("preview", "preview.jpg", "image/jpeg", preview)
        } else if mimeType.hasPrefix("video/") {
            let (duration, frames) = await onDeviceEmbedder.extractVideoKeyframes(data: data)
            for (i, frame) in frames.enumerated() {
                appendFile("frame", "frame_\(i).jpg", "image/jpeg", frame.jpeg)
            }
            if !frames.isEmpty {
                appendField("frame_times", frames.map { String(format: "%.2f", $0.timestampSec) }.joined(separator: ","))
                appendField("frame_labels", frames.map { $0.label.replacingOccurrences(of: "|", with: " ") }.joined(separator: "|"))
            }
            if let duration { appendField("duration_sec", String(format: "%.2f", duration)) }
        }

        appendFile("file", filename, mimeType, data)
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
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
                guard let self else { break }
                do {
                    let message = try await task.receive()
                    if case .string(let text) = message,
                       let data = text.data(using: .utf8),
                       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let event = obj["event"] as? String {
                        await self.handleWebSocketEvent(event, payload: obj["payload"])
                    }
                } catch {
                    guard !Task.isCancelled, self.webSocketTask === task, self.isAuthenticated else { break }
                    self.isRelayConnected = false
                    try? await Task.sleep(for: .seconds(2))
                    guard !Task.isCancelled, self.webSocketTask === task else { break }
                    self.connectWebSocket()
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
            await loadChatHistory()
        case "bundle_received":
            vexo.notifyFydeEventLED(kind: .incomingBundleOrRequest)
            await loadReceivedInbox()
            await performSearch()
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
        case "bundle_accepted", "bundle_updated":
            await loadReceivedInbox()
            await loadMyAssets()
            await performSearch()
        case "access_request_created", "access_request_resolved":
            if event == "access_request_created" {
                vexo.notifyFydeEventLED(kind: .incomingBundleOrRequest)
            }
            await loadReceivedInbox()
            statusBanner = event == "access_request_created"
                ? "New file access request waiting for your approval"
                : "Your file access request was updated"
        case "permission_updated", "peer_permission_granted":
            await loadPermissions()
            await loadSocialOverview()
            await performSearch()
        case "friend_request_received":
            vexo.notifyFydeEventLED(kind: .incomingBundleOrRequest)
            await loadSocialOverview()
            statusBanner = "New @contact request waiting in People & Received"
        case "friend_request_accepted":
            vexo.notifyFydeEventLED(kind: .actionSucceeded)
            await loadSocialOverview()
            await loadPermissions()
            statusBanner = "Contact request accepted — you can now @mention and share"
        case "social_feed_updated":
            await loadSocialOverview()
        case "chat_message", "chat_message_updated":
            if let dict = payload as? [String: Any],
               let raw = try? JSONSerialization.data(withJSONObject: dict),
               let message = try? FydeJSON.makeDecoder().decode(ChatMessage.self, from: raw) {
                receiveChatMessage(message)
                if message.role == "assistant", message.actionCard?.bundle != nil {
                    await loadReceivedInbox()
                }
            }
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
