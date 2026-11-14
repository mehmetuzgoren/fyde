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
}
