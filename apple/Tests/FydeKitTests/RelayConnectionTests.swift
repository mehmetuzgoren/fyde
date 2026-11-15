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
                        ? "{\"id\":\"reply\",\"user_id\":\"mehmet\",\"role\":\"assistant\",\"text\":\"No matching photos found.\",\"created_at\":\"2026-11-15T01:00:00Z\"}"
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
