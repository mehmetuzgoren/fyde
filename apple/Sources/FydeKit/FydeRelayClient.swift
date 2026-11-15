import Foundation

/// Keeps HTTP, decoding, and connection failures distinct. A failed send response
/// is never automatically replayed when the server might already have sent files.
struct FydeRelayClient: Sendable {
    enum ReplyError: Error {
        case http(Int, String?)
        case unreadable
    }

    let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.waitsForConnectivity = true
            configuration.timeoutIntervalForResource = 90
            self.session = URLSession(configuration: configuration)
        }
    }

    func data(from url: URL) async throws -> (Data, URLResponse) {
        try await data(for: URLRequest(url: url))
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error as URLError where Self.failedBeforeConnecting(error) {
            // These failures happen before an HTTP request reaches the relay.
            // Timeouts and dropped connections are deliberately not retried.
            try await Task.sleep(for: .milliseconds(300))
            return try await session.data(for: request)
        }
    }

    func chatReply(for request: URLRequest) async throws -> ChatMessage {
        let (data, response) = try await data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ReplyError.unreadable }
        guard http.statusCode == 200 else {
            struct ErrorBody: Decodable { let error: String? }
            let reason = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw ReplyError.http(http.statusCode, reason)
        }
        do {
            return try FydeJSON.makeDecoder().decode(ChatMessage.self, from: data)
        } catch {
            throw ReplyError.unreadable
        }
    }

    static func failedBeforeConnecting(_ error: URLError) -> Bool {
        [.cannotFindHost, .dnsLookupFailed, .cannotConnectToHost].contains(error.code)
    }

    static func failureMessage(for error: Error) -> String {
        if let replyError = error as? ReplyError {
            switch replyError {
            case .http(401, _):
                return "Your Fyde session has expired. Sign in again to continue."
            case .http(let status, let reason):
                return reason ?? "Fyde couldn't complete the request (\(status)). Try again shortly."
            case .unreadable:
                return "Fyde responded, but the app couldn't read the reply. Refresh Chat before sending again."
            }
        }
        if let networkError = error as? URLError {
            switch networkError.code {
            case .notConnectedToInternet:
                return "No internet connection. Reconnect, then try again."
            case .timedOut:
                return "Fyde is taking too long to reply. Refresh Chat or check Received before sending again."
            case .networkConnectionLost, .cancelled:
                return "The connection was interrupted. Refresh Chat or check Received before sending again."
            default:
                break
            }
        }
        return "Couldn't reach Fyde. Check your connection and try again."
    }
}
