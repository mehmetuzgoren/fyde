import Foundation

public enum FydeTab: Int, Sendable, CaseIterable {
    case search = 0
    case chat = 1
    case received = 2
}

public enum PermissionTier: String, Codable, Sendable, CaseIterable, Identifiable {
    case trusted = "trusted"
    case smartScope = "smart_scope"
    case askFirst = "ask_first"
    case sendOnly = "send_only"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .trusted: return "Trusted (Full Access)"
        case .smartScope: return "Flexible Smart Scope"
        case .askFirst: return "Ask First"
        case .sendOnly: return "Send Only"
        }
    }

    public var subtitle: String {
        switch self {
        case .trusted:
            return "Can ask their Fyde Chat for any of your non-private files automatically."
        case .smartScope:
            return "Auto-access matching trips, locations, people, or topics—no folder needed."
        case .askFirst:
            return "Requests notify you in Chat & Received for 1-tap approval."
        case .sendOnly:
            return "Can receive files you send, cannot pull from your library."
        }
    }
}

public enum MediaType: String, Codable, Sendable, CaseIterable, Identifiable {
    case photo
    case video
    case document
    case audio
    case folder

    public var id: String { rawValue }

    public var systemImage: String {
        switch self {
        case .photo: return "photo.fill"
        case .video: return "video.fill"
        case .document: return "doc.richtext.fill"
        case .audio: return "waveform"
        case .folder: return "folder.fill"
        }
    }
}

public enum SendChannel: String, Codable, Sendable, CaseIterable, Identifiable {
    case fydeDirect = "fyde_direct"
    case imessage = "imessage"
    case email = "email"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .fydeDirect: return "Direct over Fyde"
        case .imessage: return "iMessage"
        case .email: return "Email"
        }
    }

    public var systemImage: String {
        switch self {
        case .fydeDirect: return "bolt.horizontal.circle.fill"
        case .imessage: return "message.fill"
        case .email: return "envelope.fill"
        }
    }
}

public enum PlanTier: String, Codable, Sendable, CaseIterable, Identifiable {
    case starter = "starter"
    case pro = "pro"
    case family = "family"

    public var id: String { rawValue }

    public var displayTitle: String {
        switch self {
        case .starter: return "Starter"
        case .pro: return "fyde. Pro"
        case .family: return "fyde. Household"
        }
    }
}

public struct PlanDefinition: Codable, Sendable, Identifiable, Equatable {
    public var id: String { tier.rawValue }
    public var tier: PlanTier
    public var name: String
    public var tagline: String
    public var monthlyUsd: Int
    public var yearlyUsd: Int
    public var features: [String]
    public var highlighted: Bool?

    public init(
        tier: PlanTier,
        name: String,
        tagline: String,
        monthlyUsd: Int,
        yearlyUsd: Int,
        features: [String],
        highlighted: Bool? = nil
    ) {
        self.tier = tier
        self.name = name
        self.tagline = tagline
        self.monthlyUsd = monthlyUsd
        self.yearlyUsd = yearlyUsd
        self.features = features
        self.highlighted = highlighted
    }
}

public struct UserProfile: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: String
    public var handle: String
    public var displayName: String
    public var email: String
    public var phone: String
    public var avatarColor: String
    public var bio: String?
    public var authProvider: String?
    public var planTier: PlanTier?
    public var billingInterval: String?
    public var subscriptionStatus: String?
    public var autoSaveTrustedToPhotos: Bool

    public init(
        id: String,
        handle: String,
        displayName: String,
        email: String = "",
        phone: String = "",
        avatarColor: String = "#293022",
        bio: String? = nil,
        authProvider: String? = nil,
        planTier: PlanTier? = .starter,
        billingInterval: String? = "monthly",
        subscriptionStatus: String? = "active",
        autoSaveTrustedToPhotos: Bool = true
    ) {
        self.id = id
        self.handle = handle
        self.displayName = displayName
        self.email = email
        self.phone = phone
        self.avatarColor = avatarColor
        self.bio = bio
        self.authProvider = authProvider
        self.planTier = planTier
        self.billingInterval = billingInterval
        self.subscriptionStatus = subscriptionStatus
        self.autoSaveTrustedToPhotos = autoSaveTrustedToPhotos
    }
}

public struct DirectoryUser: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: String
    public var handle: String
    public var displayName: String
    public var avatarColor: String
    public var bio: String
    public var friendshipStatus: String
    public var friendshipId: String?

    public init(
        id: String,
        handle: String,
        displayName: String,
        avatarColor: String = "#FF5500",
        bio: String = "",
        friendshipStatus: String = "none",
        friendshipId: String? = nil
    ) {
        self.id = id
        self.handle = handle
        self.displayName = displayName
        self.avatarColor = avatarColor
        self.bio = bio
        self.friendshipStatus = friendshipStatus
        self.friendshipId = friendshipId
    }
}

public struct FriendRequestRecord: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var requesterId: String
    public var requesterHandle: String
    public var requesterName: String
    public var requesterAvatarColor: String
    public var addresseeId: String
    public var addresseeHandle: String
    public var addresseeName: String
    public var addresseeAvatarColor: String
    public var status: String
    public var createdAt: String
    public var updatedAt: String
}

public struct SocialFeedItem: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var actorId: String
    public var actorHandle: String
    public var actorName: String
    public var actorAvatarColor: String
    public var targetUserId: String?
    public var targetHandle: String?
    public var targetName: String?
    public var kind: String
    public var summary: String
    public var bundleId: String?
    public var createdAt: String
}

public struct SocialOverview: Codable, Sendable, Equatable {
    public var friends: [DirectoryUser]
    public var incomingRequests: [FriendRequestRecord]
    public var outgoingRequests: [FriendRequestRecord]
    public var suggestions: [DirectoryUser]
    public var feed: [SocialFeedItem]
}

public struct SmartScopeRule: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var label: String
    public var locations: [String]
    public var people: [String]
    public var mediaTypes: [MediaType]
    public var dateFrom: String?
    public var dateTo: String?
    public var semanticQuery: String?
    public var similarityThreshold: Double
    public var excludedTags: [String]

    public init(
        id: String = "scope_\(UUID().uuidString.prefix(8))",
        label: String,
        locations: [String] = [],
        people: [String] = [],
        mediaTypes: [MediaType] = [],
        dateFrom: String? = nil,
        dateTo: String? = nil,
        semanticQuery: String? = nil,
        similarityThreshold: Double = 0.24,
        excludedTags: [String] = ["private", "hidden"]
    ) {
        self.id = id
        self.label = label
        self.locations = locations
        self.people = people
        self.mediaTypes = mediaTypes
        self.dateFrom = dateFrom
        self.dateTo = dateTo
        self.semanticQuery = semanticQuery
        self.similarityThreshold = similarityThreshold
        self.excludedTags = excludedTags
    }
}

public struct ContactPermission: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var ownerId: String
    public var contactUserId: String?
    public var contactName: String
    public var contactHandle: String?
    public var email: String
    public var phone: String
    public var relationship: String
    public var tier: PermissionTier
    public var excludedTags: [String]
    public var smartScopes: [SmartScopeRule]
    public var updatedAt: String

    public init(
        id: String = "perm_\(UUID().uuidString.prefix(8))",
        ownerId: String,
        contactUserId: String? = nil,
        contactName: String,
        contactHandle: String? = nil,
        email: String = "",
        phone: String = "",
        relationship: String = "",
        tier: PermissionTier = .sendOnly,
        excludedTags: [String] = ["private", "hidden"],
        smartScopes: [SmartScopeRule] = [],
        updatedAt: String = ""
    ) {
        self.id = id
        self.ownerId = ownerId
        self.contactUserId = contactUserId
        self.contactName = contactName
        self.contactHandle = contactHandle
        self.email = email
        self.phone = phone
        self.relationship = relationship
        self.tier = tier
        self.excludedTags = excludedTags
        self.smartScopes = smartScopes
        self.updatedAt = updatedAt
    }
}

public struct VideoMoment: Codable, Sendable, Equatable {
    public var timestampSec: Double
    public var label: String
    public var embedding: [Double]

    public init(timestampSec: Double, label: String, embedding: [Double] = []) {
        self.timestampSec = timestampSec
        self.label = label
        self.embedding = embedding
    }
}

public struct IndexedAsset: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var ownerId: String
    public var ownerName: String
    public var deviceId: String
    public var filename: String
    public var title: String
    public var mediaType: MediaType
    public var mimeType: String
    public var sizeBytes: Int
    public var createdAt: String
    public var location: String
    public var people: [String]
    public var tags: [String]
    public var folderPath: String
    public var ocrText: String
    public var summary: String
    public var durationSec: Double?
    public var videoMoments: [VideoMoment]
    public var embedding: [Double]
    public var embedderName: String
    public var blobId: String?
    public var downloadUrl: String
    public var thumbnailUrl: String

    public init(
        id: String,
        ownerId: String,
        ownerName: String = "",
        deviceId: String = "local",
        filename: String,
        title: String,
        mediaType: MediaType,
        mimeType: String,
        sizeBytes: Int = 0,
        createdAt: String,
        location: String = "",
        people: [String] = [],
        tags: [String] = [],
        folderPath: String = "",
        ocrText: String = "",
        summary: String = "",
        durationSec: Double? = nil,
        videoMoments: [VideoMoment] = [],
        embedding: [Double] = [],
        embedderName: String = "apple-ane-multimodal-256",
        blobId: String? = nil,
        downloadUrl: String = "",
        thumbnailUrl: String = ""
    ) {
        self.id = id
        self.ownerId = ownerId
        self.ownerName = ownerName
        self.deviceId = deviceId
        self.filename = filename
        self.title = title
        self.mediaType = mediaType
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.createdAt = createdAt
        self.location = location
        self.people = people
        self.tags = tags
        self.folderPath = folderPath
        self.ocrText = ocrText
        self.summary = summary
        self.durationSec = durationSec
        self.videoMoments = videoMoments
        self.embedding = embedding
        self.embedderName = embedderName
        self.blobId = blobId
        self.downloadUrl = downloadUrl
        self.thumbnailUrl = thumbnailUrl
    }
}

public struct SearchHit: Codable, Sendable, Identifiable, Equatable {
    public var id: String { asset.id + "_" + String(matchedMomentSec ?? -1) }
    public var asset: IndexedAsset
    public var score: Double
    public var matchedMomentSec: Double?
    public var matchedMomentLabel: String?
    public var matchReason: String

    public init(
        asset: IndexedAsset,
        score: Double,
        matchedMomentSec: Double? = nil,
        matchedMomentLabel: String? = nil,
        matchReason: String = ""
    ) {
        self.asset = asset
        self.score = score
        self.matchedMomentSec = matchedMomentSec
        self.matchedMomentLabel = matchedMomentLabel
        self.matchReason = matchReason
    }
}

public struct BundleItem: Codable, Sendable, Identifiable, Equatable {
    public var id: String { assetId }
    public var assetId: String
    public var filename: String
    public var title: String
    public var mediaType: MediaType
    public var mimeType: String
    public var sizeBytes: Int
    public var downloadUrl: String
    public var thumbnailUrl: String
    public var location: String
    public var people: [String]
    public var matchedTimestampSec: Double?
}

public struct TransferBundle: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var senderId: String
    public var senderName: String
    public var recipientId: String?
    public var recipientName: String
    public var recipientAddress: String
    public var channel: SendChannel
    public var title: String
    public var message: String
    public var items: [BundleItem]
    public var origin: String
    public var status: String
    public var deliveryDetail: String
    public var acceptedDestination: String?
    public var shareLink: String
    public var createdAt: String
}

public struct AccessRequest: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var requesterId: String
    public var requesterName: String
    public var ownerId: String
    public var ownerName: String
    public var query: String
    public var matchedAssetIds: [String]
    public var matchedPreviews: [BundleItem]
    public var status: String
    public var bundleId: String?
    public var createdAt: String
}

public struct ChatActionCard: Codable, Sendable, Equatable {
    public var actionType: String
    public var summary: String
    public var channel: SendChannel?
    public var recipientName: String?
    public var recipientId: String?
    public var recipientAddress: String?
    public var assetIds: [String]
    public var previews: [BundleItem]
    public var permission: ContactPermission?
    public var bundle: TransferBundle?
    public var accessRequest: AccessRequest?
    public var requiresConfirmation: Bool
    /// Why a voice send is waiting for confirmation (`send_confirmation` cards).
    public var holdReason: String?
    /// `false` when a held send includes private items: confirm in the app, not with a band tap.
    public var bandConfirmable: Bool?
    /// `"vexo"` when the request came from Vexo #69.
    public var source: String?

    public var isPendingSendConfirmation: Bool {
        actionType == "send_confirmation" && requiresConfirmation
    }
}

public struct ChatMessage: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var userId: String
    public var role: String
    public var text: String
    public var actionCard: ChatActionCard?
    public var createdAt: String

    public init(
        id: String = "msg_\(UUID().uuidString.prefix(8))",
        userId: String,
        role: String,
        text: String,
        actionCard: ChatActionCard? = nil,
        createdAt: String = ISO8601DateFormatter().string(from: Date())
    ) {
        self.id = id
        self.userId = userId
        self.role = role
        self.text = text
        self.actionCard = actionCard
        self.createdAt = createdAt
    }
}

public enum FydeJSON {
    public static func makeDecoder() -> JSONDecoder {
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        return dec
    }

    public static func makeEncoder() -> JSONEncoder {
        let enc = JSONEncoder()
        enc.keyEncodingStrategy = .convertToSnakeCase
        return enc
    }
}
