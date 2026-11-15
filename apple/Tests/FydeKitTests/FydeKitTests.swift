import XCTest
@testable import FydeKit

final class FydeKitTests: XCTestCase {
    func testEmbedderSemanticProximity() {
        let embedder = OnDeviceMultimodalEmbedder()
        let queryVec = embedder.embedText("China trip photos in Shanghai")
        let matchVec = embedder.embedText("Shanghai Bund skyline dinner travel Beijing")
        let unrelatedVec = embedder.embedText("Joint federal tax return IRS 1099")

        let simMatch = OnDeviceMultimodalEmbedder.cosineSimilarity(queryVec, matchVec)
        let simUnrelated = OnDeviceMultimodalEmbedder.cosineSimilarity(queryVec, unrelatedVec)

        XCTAssertEqual(queryVec.count, 256)
        XCTAssertGreaterThan(simMatch, 0.30)
        XCTAssertGreaterThan(simMatch, simUnrelated)
    }

    @MainActor
    func testDefaultLandingTabIsChat() {
        let store = FydeStore(relayBaseURL: "http://127.0.0.1:8765")
        XCTAssertEqual(store.selectedTab, .chat)
    }

    @MainActor
    func testOfflineSearchFindsRaftingForKayakPhotos() async {
        let store = FydeStore(relayBaseURL: "http://127.0.0.1:8765")
        store.currentUserId = "mehmet"
        store.isRelayConnected = false
        store.searchScope = "mine"
        store.selectedMediaFilter = .photo
        store.myAssets = [
            IndexedAsset(
                id: "rafting", ownerId: "mehmet", filename: "IMG_4829.jpg", title: "River Adventure",
                mediaType: .photo, mimeType: "image/jpeg", createdAt: "2026-11-01T00:00:00Z",
                tags: ["rafting", "watersport", "oar"]
            ),
            IndexedAsset(
                id: "cat", ownerId: "mehmet", filename: "IMG_4830.jpg", title: "Milo on the Couch",
                mediaType: .photo, mimeType: "image/jpeg", createdAt: "2026-11-01T00:00:00Z",
                tags: ["cat", "feline"]
            )
        ]
        for query in ["kayak photos", "kayaking", "canoeing pictures", "paddling"] {
            store.searchQuery = query
            await store.performSearch()
            XCTAssertEqual(store.searchHits.first?.asset.id, "rafting", query)
            XCTAssertFalse(store.searchHits.contains { $0.asset.id == "cat" }, query)
        }
    }

    @MainActor
    func testOfflineSearchIncludesReceivedFilesInSharedScopes() async {
        let store = FydeStore(relayBaseURL: "http://127.0.0.1:8765")
        store.currentUserId = "sarah"
        store.isRelayConnected = false
        let own = IndexedAsset(
            id: "own_receipt", ownerId: "sarah", filename: "receipt.pdf", title: "Receipt",
            mediaType: .document, mimeType: "application/pdf", createdAt: "2026-11-01T00:00:00Z"
        )
        store.myAssets = [own]
        let item = BundleItem(
            assetId: "tax_return", filename: "tax_return.pdf", title: "Annual documents",
            mediaType: .document, mimeType: "application/pdf", sizeBytes: 100,
            downloadUrl: "/api/blobs/tax_return", thumbnailUrl: "", location: "",
            people: ["Sarah"], matchedTimestampSec: nil
        )
        let bundle = TransferBundle(
            id: "latest_bundle", senderId: "mehmet", senderName: "Mehmet", recipientId: "sarah",
            recipientName: "Sarah", recipientAddress: "", channel: .fydeDirect, title: "Tax documents",
            message: "", items: [item], origin: "pushed", status: "delivered", deliveryDetail: "",
            acceptedDestination: nil, shareLink: "", createdAt: "2026-11-14T00:00:00Z"
        )
        var olderBundle = bundle
        olderBundle.id = "older_bundle"
        olderBundle.title = "Older tax documents"
        olderBundle.createdAt = "2026-11-02T00:00:00Z"
        var otherRecipientsBundle = bundle
        otherRecipientsBundle.id = "other_recipient"
        otherRecipientsBundle.recipientId = "maya"
        otherRecipientsBundle.items[0].assetId = "mayas_file"
        store.receivedBundles = [olderBundle, otherRecipientsBundle, bundle]

        for scope in ["all", "contacts"] {
            store.searchScope = scope
            store.searchQuery = ""
            await store.performSearch()
            XCTAssertEqual(store.searchHits.first?.asset.id, "tax_return")
            let matches = store.searchHits.filter { $0.asset.id == "tax_return" }
            XCTAssertEqual(matches.count, 1)
            XCTAssertEqual(matches.first?.asset.ownerId, "mehmet")
            XCTAssertEqual(matches.first?.asset.folderPath, "Received/Tax documents")
            XCTAssertEqual(matches.first?.matchReason, "Received from Mehmet")
            XCTAssertFalse(store.searchHits.contains { $0.asset.id == "mayas_file" })

            store.searchQuery = "return.pdf"
            await store.performSearch()
            XCTAssertTrue(store.searchHits.contains { $0.asset.id == "tax_return" })
        }

        store.searchQuery = ""
        store.searchScope = "contacts"
        store.selectedMediaFilter = .photo
        await store.performSearch()
        XCTAssertTrue(store.searchHits.isEmpty)
        store.selectedMediaFilter = .document
        await store.performSearch()
        XCTAssertEqual(store.searchHits.map(\.asset.id), ["tax_return"])
        store.searchScope = "mine"
        await store.performSearch()
        XCTAssertEqual(store.searchHits.map(\.asset.id), [own.id])

        let savedCopy = IndexedAsset(
            id: "saved_tax_return", ownerId: "sarah", filename: item.filename, title: item.title,
            mediaType: .document, mimeType: item.mimeType, createdAt: bundle.createdAt,
            downloadUrl: item.downloadUrl
        )
        store.myAssets.append(savedCopy)
        store.searchScope = "all"
        await store.performSearch()
        XCTAssertEqual(store.searchHits.filter { $0.asset.downloadUrl == item.downloadUrl }.count, 1)
    }

    func testSocialOverviewDecoding() throws {
        let json = """
        {
          "friends": [{"id":"maya","handle":"maya","display_name":"Maya","avatar_color":"#0A0A0A","bio":"Wife","friendship_status":"accepted"}],
          "incoming_requests": [],
          "outgoing_requests": [],
          "suggestions": [{"id":"sarah","handle":"sarah","display_name":"Sarah","avatar_color":"#262626","bio":"","friendship_status":"none"}],
          "feed": [{"id":"act_1","actor_id":"mehmet","actor_handle":"mehmet","actor_name":"Mehmet","actor_avatar_color":"#FF5500","kind":"connected","summary":"@mehmet and @maya connected","created_at":"2026-11-14T15:00:00Z"}]
        }
        """.data(using: .utf8)!
        let decoded = try FydeJSON.makeDecoder().decode(SocialOverview.self, from: json)
        XCTAssertEqual(decoded.friends.first?.handle, "maya")
        XCTAssertEqual(decoded.suggestions.first?.handle, "sarah")
        XCTAssertEqual(decoded.feed.first?.kind, "connected")
    }
}
