import XCTest
@testable import FydeKit

/// Voice sends ("Vexo, send my cat picture to John") that the relay holds for a confirmation tap.
final class VexoVoiceSendTests: XCTestCase {
    @MainActor
    func testBackgroundTranscriptAndReceiptSyncWithoutDuplicates() {
        let store = FydeStore(relayBaseURL: "http://127.0.0.1:9")
        let optimistic = ChatMessage(id: "local_voice", userId: "mehmet", role: "user", text: "Vexo send my cat photos to Johnny", source: "vexo")
        store.chatMessages = [optimistic]
        let transcript = ChatMessage(id: "saved_voice", userId: "mehmet", role: "user", text: optimistic.text,
                                     source: "vexo", clientMessageId: optimistic.id)
        let receipt = ChatMessage(id: "sent_receipt", userId: "mehmet", role: "assistant", text: "Sent 2 photos to Johnny.", source: "vexo")
        store.receiveChatMessage(transcript)
        store.receiveChatMessage(transcript)
        store.receiveChatMessage(receipt)
        store.receiveChatMessage(receipt)
        XCTAssertEqual(store.chatMessages.map(\.id), [transcript.id, receipt.id])
        XCTAssertEqual(store.chatMessages.first?.source, "vexo")

        var updated = receipt
        updated.text = "Johnny saved the photos."
        store.receiveChatMessage(updated)
        XCTAssertEqual(store.chatMessages.last?.text, updated.text)
        store.receiveChatMessage(ChatMessage(userId: "someone_else", role: "user", text: "Private transcript"))
        XCTAssertEqual(store.chatMessages.count, 2)
    }

    private func heldMessageJSON(id: String, createdAt: String, bandConfirmable: Bool) -> Data {
        // Shape returned by the edge relay's /api/chat for a held voice send.
        """
        {
          "id": "\(id)",
          "user_id": "mehmet",
          "role": "assistant",
          "text": "Ready to send **Milo the Cat** to **John Appleseed**, but John Appleseed isn't one of your contacts yet.",
          "created_at": "\(createdAt)",
          "action_card": {
            "action_type": "send_confirmation",
            "summary": "Ready to send",
            "channel": "fyde_direct",
            "recipient_name": "John Appleseed",
            "recipient_id": "usr_john",
            "recipient_address": null,
            "asset_ids": ["asset_cat"],
            "previews": [],
            "requires_confirmation": true,
            "hold_reason": "John Appleseed isn't one of your contacts yet",
            "band_confirmable": \(bandConfirmable),
            "source": "vexo"
          }
        }
        """.data(using: .utf8)!
    }

    func testDecodesHeldVoiceSendCard() throws {
        let msg = try FydeJSON.makeDecoder().decode(
            ChatMessage.self,
            from: heldMessageJSON(id: "msg_1", createdAt: "2026-11-14T10:00:00.000Z", bandConfirmable: true)
        )
        let card = try XCTUnwrap(msg.actionCard)
        XCTAssertTrue(card.isPendingSendConfirmation)
        XCTAssertEqual(card.holdReason, "John Appleseed isn't one of your contacts yet")
        XCTAssertEqual(card.bandConfirmable, true)
        XCTAssertEqual(card.source, "vexo")
        XCTAssertEqual(card.assetIds, ["asset_cat"])
    }

    func testOlderCardsWithoutNewFieldsStillDecode() throws {
        let json = """
        {"id":"m","user_id":"mehmet","role":"assistant","text":"Sent","created_at":"2026-11-14T10:00:00Z",
         "action_card":{"action_type":"send_completed","summary":"Sent","asset_ids":[],"previews":[],"requires_confirmation":false}}
        """.data(using: .utf8)!
        let msg = try FydeJSON.makeDecoder().decode(ChatMessage.self, from: json)
        XCTAssertNil(msg.actionCard?.holdReason)
        XCTAssertFalse(msg.actionCard?.isPendingSendConfirmation ?? true)
    }

    @MainActor
    func testBandTapOnlyConfirmsFreshNonPrivateHolds() throws {
        let store = FydeStore(relayBaseURL: "http://127.0.0.1:9")
        let decoder = FydeJSON.makeDecoder()
        let now = try XCTUnwrap(FydeFormat.date("2026-11-14T10:05:00.000Z"))

        let fresh = try decoder.decode(ChatMessage.self, from: heldMessageJSON(id: "fresh", createdAt: "2026-11-14T10:00:00.000Z", bandConfirmable: true))
        store.chatMessages = [fresh]
        XCTAssertEqual(store.latestBandConfirmableSend(now: now)?.id, "fresh")

        // Held 20 minutes ago: a stray tap must not send it.
        let stale = try decoder.decode(ChatMessage.self, from: heldMessageJSON(id: "stale", createdAt: "2026-11-14T09:45:00.000Z", bandConfirmable: true))
        store.chatMessages = [stale]
        XCTAssertNil(store.latestBandConfirmableSend(now: now))

        // Private items need the in-app Send button.
        let privateHold = try decoder.decode(ChatMessage.self, from: heldMessageJSON(id: "private", createdAt: "2026-11-14T10:04:00.000Z", bandConfirmable: false))
        store.chatMessages = [privateHold]
        XCTAssertNil(store.latestBandConfirmableSend(now: now))

        // Once the newest hold is sent, a second tap must not reach an older pending hold.
        var newestDone = try decoder.decode(ChatMessage.self, from: heldMessageJSON(id: "newest", createdAt: "2026-11-14T10:03:00.000Z", bandConfirmable: true))
        newestDone.actionCard?.actionType = "send_completed"
        newestDone.actionCard?.requiresConfirmation = false
        store.chatMessages = [fresh, newestDone]
        XCTAssertNil(store.latestBandConfirmableSend(now: now))
    }
}
