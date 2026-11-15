import Foundation
import XCTest
@testable import FydeKit

final class RelayConnectionTests: XCTestCase {
    private func client() -> FydeRelayClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RelayStub.self]
        return FydeRelayClient(session: URLSession(configuration: configuration))
    }

    private var chatRequest: URLRequest {
        var request = URLRequest(url: URL(string: "https://relay.invalid/api/chat")!)
        request.httpMethod = "POST"
        request.httpBody = Data("{\"text\":\"Find my rafting photos\"}".utf8)
        return request
    }

    func testHTTPAndUnreadableRepliesAreNotReportedAsOffline() async throws {
        for (status, body) in [(200, "<html>Unavailable</html>"), (401, "{}"), (503, "{\"error\":\"Search is temporarily unavailable.\"}")] {
            RelayStub.state.reset(status: status, body: body)
            do {
                _ = try await client().chatReply(for: chatRequest)
                XCTFail("Expected a reply error")
            } catch let error as FydeRelayClient.ReplyError {
                switch (status, error) {
                case (200, .unreadable), (401, .http(401, _)), (503, .http(503, _)):
                    break
                default:
                    XCTFail("Unexpected reply error: \(error)")
                }
                let message = FydeRelayClient.failureMessage(for: error)
                XCTAssertFalse(message.contains("Offline"))
                if status == 401 { XCTAssertTrue(message.contains("Sign in again")) }
                if status == 503 { XCTAssertEqual(message, "Search is temporarily unavailable.") }
            }
            XCTAssertEqual(RelayStub.state.requestCount, 1)
        }
    }

    func testOnlyFailuresBeforeConnectingAreRetried() async throws {
        RelayStub.state.reset(failures: [.cannotConnectToHost])
        let request = chatRequest
        let reply = try await client().chatReply(for: request)
        XCTAssertEqual(reply.text, "No matching photos found.")
        XCTAssertEqual(RelayStub.state.requestCount, 2)
        XCTAssertTrue(RelayStub.state.bodies.allSatisfy { $0 == request.httpBody })

        // The server may already have sent files when a reply is lost or times out.
        for code in [URLError.networkConnectionLost, .timedOut] {
            RelayStub.state.reset(failures: [code])
            do {
                _ = try await client().chatReply(for: chatRequest)
                XCTFail("Expected a connection failure")
            } catch let error as URLError {
                XCTAssertEqual(error.code, code)
                XCTAssertTrue(FydeRelayClient.failureMessage(for: error).contains("before sending again"))
            }
            XCTAssertEqual(RelayStub.state.requestCount, 1)
        }
    }

    @MainActor
    func testDirectoryFailureDoesNotMarkHealthyRelayOffline() async {
        RelayStub.state.reset(badDirectory: true)
        let store = FydeStore(relayBaseURL: "https://relay.invalid", relaySession: client().session)
        await store.refreshAll()
        XCTAssertTrue(store.isRelayConnected)
    }

    @MainActor
    func testOfflineChatKeepsPromptAndReportsMissingConnection() async {
        RelayStub.state.reset(failures: [.notConnectedToInternet])
        let store = FydeStore(relayBaseURL: "https://relay.invalid", relaySession: client().session)
        store.isRelayConnected = true
        await store.sendChatPrompt("Find my rafting photos")
        XCTAssertEqual(store.chatMessages.first?.text, "Find my rafting photos")
        XCTAssertEqual(store.chatMessages.last?.text, "No internet connection. Reconnect, then try again.")
        XCTAssertFalse(store.isRelayConnected)
        XCTAssertFalse(store.isSendingChat)
    }

    @MainActor
    func testAutomaticVexoVoiceStopSendsChatWithoutCancellingRequest() async throws {
        RelayStub.state.reset()
        let store = FydeStore(relayBaseURL: "https://relay.invalid", relaySession: client().session)
        store.vexo.transportKind = .simulator
        store.vexo.voiceListenDurationSec = 3
        await store.vexo.connect()
        defer { store.vexo.disconnect() }

        let sendVoice = try XCTUnwrap(store.vexo.onVoiceCommandReady)
        let completed = expectation(description: "Automatic voice stop finishes the chat request")
        store.vexo.onVoiceCommandReady = { prompt in
            XCTAssertFalse(Task.isCancelled, "Stopping the microphone must not cancel transcription or chat")
            await sendVoice(prompt)
            completed.fulfill()
        }

        await store.vexo.simulateGesture(.doubleTap)
        XCTAssertTrue(store.vexo.isListeningVoice)
        store.vexo.liveTranscript = "Find my rafting photos"
        await fulfillment(of: [completed], timeout: 20)

        XCTAssertFalse(store.vexo.isListeningVoice)
        XCTAssertFalse(store.vexo.isMicLockedLED)
        XCTAssertTrue(store.isRelayConnected)
        XCTAssertFalse(store.isSendingChat)
        XCTAssertEqual(store.chatMessages.map(\.text), ["Find my rafting photos", "No matching photos found."])
        XCTAssertEqual(RelayStub.state.chatBodies.count, 1)
        let data = try XCTUnwrap(RelayStub.state.chatBodies.first)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(payload["source"] as? String, "vexo")
        XCTAssertEqual(payload["text"] as? String, "Find my rafting photos")
        XCTAssertEqual(payload["user_id"] as? String, store.currentUserId)
    }

    @MainActor
    func testSubmittingSimulatedVoiceStopsCaptureAndCancelsPendingAutoSend() async throws {
        RelayStub.state.reset()
        let store = FydeStore(relayBaseURL: "https://relay.invalid", relaySession: client().session)
        store.vexo.transportKind = .simulator
        store.vexo.voiceListenDurationSec = 3
        await store.vexo.connect()
        defer { store.vexo.disconnect() }

        await store.vexo.simulateGesture(.doubleTap)
        await store.vexo.simulateSpokenCommand("Find my rafting photos")
        XCTAssertFalse(store.vexo.isListeningVoice)
        XCTAssertFalse(store.vexo.isMicLockedLED)
        XCTAssertEqual(store.chatMessages.last?.text, "No matching photos found.")
        try await Task.sleep(for: .milliseconds(3300))
        XCTAssertEqual(RelayStub.state.chatBodies.count, 1)
    }
}

private final class RelayStub: URLProtocol, @unchecked Sendable {
    final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var status = 200
        private var body = ""
        private var failures: [URLError.Code] = []
        private var badDirectory = false
        private var requests: [URLRequest] = []
        private var requestBodies: [Data?] = []

        var requestCount: Int { lock.withLock { requests.count } }
        var bodies: [Data?] { lock.withLock { requestBodies } }
        var chatBodies: [Data] {
            lock.withLock {
                zip(requests, requestBodies).compactMap { request, body -> Data? in
                    request.httpMethod == "POST" && request.url?.path == "/api/chat" ? body : nil
                }
            }
        }

        func reset(status: Int = 200, body: String = "", failures: [URLError.Code] = [], badDirectory: Bool = false) {
            lock.withLock {
                self.status = status
                self.body = body
                self.failures = failures
                self.badDirectory = badDirectory
                requests = []
                requestBodies = []
            }
        }

        func response(to request: URLRequest) throws -> (Int, Data) {
            try lock.withLock {
                requests.append(request)
                requestBodies.append(Self.body(of: request))
                if !failures.isEmpty { throw URLError(failures.removeFirst()) }
                if request.url?.path == "/api/health" {
                    return (200, Data("{\"status\":\"ok\",\"embedder\":\"test\"}".utf8))
                }
                if request.url?.path == "/api/users", badDirectory {
                    return (200, Data("{\"error\":\"Directory format changed\"}".utf8))
                }
                if request.httpMethod == "POST", request.url?.path == "/api/chat" {
                    let reply = body.isEmpty
                        ? "{\"id\":\"reply\",\"user_id\":\"mehmet\",\"role\":\"assistant\",\"text\":\"No matching photos found.\",\"created_at\":\"\(ISO8601DateFormatter().string(from: Date()))\"}"
                        : body
                    return (status, Data(reply.utf8))
                }
                return (200, Data("[]".utf8))
            }
        }

        private static func body(of request: URLRequest) -> Data? {
            if let body = request.httpBody { return body }
            // URLSession presents POST bodies to URLProtocol as an input stream.
            guard let stream = request.httpBodyStream else { return nil }
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count < 0 { return nil }
                if count == 0 { return data }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
    }

    static let state = State()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.state.response(to: request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}
