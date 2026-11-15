import Foundation

/// Streams raw Vexo 16 kHz mono 20 ms Opus packets directly to Deepgram Nova-3 (`mip_opt_out=true`),
/// matching `vexo-open-kit/docs/deepgram.md` and `examples/python/speech.py`.
/// Never logs, persists, or exposes the API key.
@MainActor
public final class VexoDeepgramClient {
    public static let privacyNotice =
        "Note: while listening, everything Vexo-HACK-69's microphone hears is sent over the internet to Deepgram (deepgram.com, mip_opt_out=true). Tell people near the band."

    private static let listenURLString =
        "wss://api.deepgram.com/v1/listen?model=nova-3&language=en&encoding=opus&sample_rate=16000&channels=1&interim_results=true&smart_format=true&endpointing=100&mip_opt_out=true"

    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var keepAliveTask: Task<Void, Never>?
    private var lastSentAt: Date = Date()
    private var isStopping: Bool = false

    private var currentSentenceParts: [String] = []
    private var finalSentences: [String] = []
    private var latestInterimPiece: String = ""

    public var onTranscriptUpdate: ((_ fullPreview: String, _ isFinalSentence: Bool) -> Void)?
    public var onError: ((_ friendlyMessage: String) -> Void)?

    public init() {}

    public static func validateKey(_ rawKey: String) -> Result<String, VexoSpeechError> {
        let trimmed = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return .failure(VexoSpeechError(
                "Transcription needs a Deepgram key: paste your team's key in the Vexo #69 panel (kept in memory only) or set DEEPGRAM_API_KEY in your environment."
            ))
        }
        let validASCII = trimmed.unicodeScalars.allSatisfy { $0.isASCII && $0.value >= 0x21 && $0.value <= 0x7E }
        guard validASCII else {
            return .failure(VexoSpeechError(
                "The Deepgram key has a space or invalid character. Copy the whole key again with no spaces or quotes."
            ))
        }
        return .success(trimmed)
    }

    public func start(apiKey: String) throws {
        cancelImmediately()
        let validKey = try Self.validateKey(apiKey).get()
        guard let url = URL(string: Self.listenURLString) else {
            throw VexoSpeechError("Invalid Deepgram endpoint configuration.")
        }

        var request = URLRequest(url: url)
        request.setValue("Token \(validKey)", forHTTPHeaderField: "Authorization")

        currentSentenceParts = []
        finalSentences = []
        latestInterimPiece = ""
        isStopping = false
        lastSentAt = Date()

        let ws = URLSession.shared.webSocketTask(with: request)
        self.webSocketTask = ws
        ws.resume()

        receiveTask = Task { [weak self] in
            await self?.receiveLoop(ws: ws)
        }

        keepAliveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self, !self.isStopping, let activeWS = self.webSocketTask else { break }
                if Date().timeIntervalSince(self.lastSentAt) >= 4.0 {
                    self.lastSentAt = Date()
                    activeWS.send(.string("{\"type\":\"KeepAlive\"}")) { _ in }
                }
            }
        }
    }

    public func feedOpusPacket(_ opus: Data) {
        guard !opus.isEmpty, !isStopping, let ws = webSocketTask else { return }
        lastSentAt = Date()
        ws.send(.data(opus)) { _ in }
    }

    public func stopAndCollectFinalTranscript() async -> String {
        guard let ws = webSocketTask else {
            return assembledTranscript(includeInterim: true)
        }
        isStopping = true
        keepAliveTask?.cancel()
        keepAliveTask = nil

        try? await ws.send(.string("{\"type\":\"CloseStream\"}"))

        // Wait up to 2.2s for Deepgram to flush remaining Results and close cleanly
        if let rxTask = receiveTask {
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    await rxTask.value
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 2_200_000_000)
                }
                await group.next()
                group.cancelAll()
            }
        }

        flushPendingSentenceParts()
        let result = assembledTranscript(includeInterim: true)
        cancelImmediately()
        return result
    }

    public func cancelImmediately() {
        isStopping = true
        keepAliveTask?.cancel()
        keepAliveTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
    }

    // MARK: - Internal Receive & Parsing

    private func receiveLoop(ws: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let msg = try await ws.receive()
                if case .string(let text) = msg,
                   let data = text.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    handleMessage(json)
                }
            } catch {
                if !isStopping {
                    let status = (ws.response as? HTTPURLResponse)?.statusCode
                    let friendly = Self.describeConnectionError(statusCode: status)
                    onError?(friendly)
                }
                break
            }
        }
        flushPendingSentenceParts()
    }

    private func handleMessage(_ json: [String: Any]) {
        guard let kind = json["type"] as? String else { return }
        if kind == "Results" {
            let channel = json["channel"] as? [String: Any]
            let alts = channel?["alternatives"] as? [[String: Any]]
            let piece = ((alts?.first?["transcript"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let isFinal = (json["is_final"] as? Bool) ?? false
            let speechFinal = (json["speech_final"] as? Bool) ?? false

            if !isFinal {
                latestInterimPiece = piece
                onTranscriptUpdate?(assembledTranscript(includeInterim: true), false)
                return
            }

            latestInterimPiece = ""
            if !piece.isEmpty {
                currentSentenceParts.append(piece)
            }
            if speechFinal {
                flushPendingSentenceParts()
                onTranscriptUpdate?(assembledTranscript(includeInterim: false), true)
            } else if !piece.isEmpty {
                onTranscriptUpdate?(assembledTranscript(includeInterim: false), false)
            }
        } else if kind == "Error" {
            if !isStopping {
                onError?("Deepgram reported a stream error.")
            }
        }
    }

    private func flushPendingSentenceParts() {
        guard !currentSentenceParts.isEmpty else { return }
        let sentence = currentSentenceParts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        currentSentenceParts.removeAll()
        if !sentence.isEmpty {
            finalSentences.append(sentence)
        }
    }

    private func assembledTranscript(includeInterim: Bool) -> String {
        var pieces = finalSentences
        if !currentSentenceParts.isEmpty {
            pieces.append(currentSentenceParts.joined(separator: " "))
        }
        if includeInterim, !latestInterimPiece.isEmpty {
            pieces.append(latestInterimPiece)
        }
        return pieces.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func describeConnectionError(statusCode: Int?) -> String {
        guard let code = statusCode else {
            return "Could not reach api.deepgram.com. Check your iPhone/Mac internet connection or try a hotspot."
        }
        switch code {
        case 400:
            return "Deepgram rejected stream parameters (status 400)."
        case 401:
            return "Deepgram did not accept the API key (status 401). Re-copy your team's key with no spaces."
        case 402:
            return "Deepgram key has no credit left (status 402). Tell an organiser."
        case 403:
            return "Deepgram key is not permitted for this model/setting (status 403)."
        case 429:
            return "Too many concurrent Deepgram connections with this key (status 429). Close other tabs/programs and retry."
        default:
            return "Deepgram refused the connection (status \(code))."
        }
    }
}

public struct VexoSpeechError: LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}
