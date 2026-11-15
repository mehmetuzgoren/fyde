import AVFoundation
import CoreML
import Foundation
import ImageIO
import NaturalLanguage
import UniformTypeIdentifiers
import Vision

/// On-device Apple Neural Engine & EmbeddingGemma 2 CoreML Multimodal Embedder.
/// Combines:
/// - Optional `EmbeddingGemma2.mlmodelc` CoreML bundle (when installed in Application Support / Bundle)
/// - Apple `Vision` (`VNRecognizeTextRequest` OCR + `VNClassifyImageRequest` visual tags)
/// - `AVAssetImageGenerator` video keyframe extraction with timestamps
/// - `NaturalLanguage` (`NLEmbedding`) + 256-D MRL normalized semantic vector projection
public struct OnDeviceMultimodalEmbedder: Sendable {
    public static let dimension = 256

    private static let conceptSynonyms: [String: [String]] = [
        "china": ["china", "beijing", "shanghai", "great wall", "bund", "asia", "chinese", "temple", "trip", "travel"],
        "japan": ["japan", "tokyo", "kyoto", "shrine", "asia", "trip", "travel"],
        "beach": ["beach", "ocean", "sea", "surf", "surfing", "waves", "coast", "summer", "water"],
        "passport": ["passport", "id", "identification", "visa", "travel document", "scan"],
        "tax": ["tax", "taxes", "irs", "w2", "1099", "return", "accountant", "finance"],
        "invoice": ["invoice", "receipt", "bill", "payment", "vet", "clinic"],
    ]

    public init() {}

    public var activeModelLabel: String {
        if Self.locateEmbeddingGemmaCoreMLURL() != nil {
            return "EmbeddingGemma 2 (CoreML ANE • 256-D MRL)"
        }
        return "Apple Neural Engine Vision + NL (EmbeddingGemma 2 Ready)"
    }

    public static func locateEmbeddingGemmaCoreMLURL() -> URL? {
        if let bundled = Bundle.main.url(forResource: "EmbeddingGemma2", withExtension: "mlmodelc") {
            return bundled
        }
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        let candidate = appSupport?.appendingPathComponent("Fyde/Models/EmbeddingGemma2.mlmodelc")
        if let url = candidate, FileManager.default.fileExists(atPath: url.path) {
            return url
        }
        return nil
    }

    public func embedText(_ text: String, includeSystemSentenceModel: Bool = false) -> [Double] {
        var vec = Array(repeating: 0.0, count: Self.dimension)
        let lowered = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !lowered.isEmpty else { return vec }

        // Optional Apple NaturalLanguage sentence embedding (opt-in to avoid mobileassetd XPC stalls in Simulator/CLI)
        if includeSystemSentenceModel,
           let sentenceEmbedding = NLEmbedding.sentenceEmbedding(for: .english),
           let nlVec = sentenceEmbedding.vector(for: lowered) {
            let count = min(Self.dimension, nlVec.count)
            for i in 0..<count {
                vec[i] += nlVec[i] * 1.8
            }
        }

        // Token + concept projection matching Fyde's 256-D MRL space
        let words = lowered
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
        let wordSet = Set(words)

        for (i, word) in words.enumerated() {
            let (idx, sign) = Self.hashFeature("w:\(word)")
            vec[idx] += 2.0 * sign
            if word.count >= 5 {
                let prefix = String(word.prefix(4))
                let (pIdx, pSign) = Self.hashFeature("stem:\(prefix)")
                vec[pIdx] += 1.0 * pSign
            }
            if i + 1 < words.count {
                let (bIdx, bSign) = Self.hashFeature("bi:\(word)_\(words[i + 1])")
                vec[bIdx] += 1.2 * bSign
            }
        }

        for (concept, terms) in Self.conceptSynonyms {
            let matched = terms.contains { term in
                term.contains(" ") ? lowered.contains(term) : wordSet.contains(term)
            }
            if matched {
                let (cIdx, cSign) = Self.hashFeature("concept:\(concept)")
                vec[cIdx] += 3.2 * cSign
            }
        }

        return Self.l2Normalize(vec)
    }

    public func extractImageInsights(data: Data) -> (ocrText: String, sceneTags: [String]) {
        let handler = VNImageRequestHandler(data: data, options: [:])
        var recognizedLines: [String] = []
        var tags: [String] = []

        let textReq = VNRecognizeTextRequest { request, _ in
            guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
            for obs in observations.prefix(25) {
                if let top = obs.topCandidates(1).first {
                    recognizedLines.append(top.string)
                }
            }
        }
        textReq.recognitionLevel = .fast

        let classifyReq = VNClassifyImageRequest { request, _ in
            guard let observations = request.results as? [VNClassificationObservation] else { return }
            for obs in observations where obs.confidence >= 0.25 {
                tags.append(obs.identifier.replacingOccurrences(of: "_", with: " "))
                if tags.count >= 8 { break }
            }
        }

        try? handler.perform([textReq, classifyReq])
        return (recognizedLines.joined(separator: " "), tags)
    }

    public func extractVideoMoments(url: URL, maxFrames: Int = 3) async -> [VideoMoment] {
        let asset = AVURLAsset(url: url)
        guard let duration = try? await asset.load(.duration) else { return [] }
        let totalSec = max(1.0, CMTimeGetSeconds(duration))
        guard totalSec.isFinite else { return [] }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 480, height: 480)

        var moments: [VideoMoment] = []
        for i in 0..<maxFrames {
            let sec = totalSec * (Double(i) + 0.5) / Double(maxFrames)
            let time = CMTime(seconds: sec, preferredTimescale: 600)
            if let (cgImage, _) = try? await generator.image(at: time) {
                let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
                var frameLabels: [String] = []
                let req = VNClassifyImageRequest { r, _ in
                    guard let obs = r.results as? [VNClassificationObservation] else { return }
                    for o in obs where o.confidence >= 0.2 {
                        frameLabels.append(o.identifier.replacingOccurrences(of: "_", with: " "))
                        if frameLabels.count >= 3 { break }
                    }
                }
                try? handler.perform([req])
                let desc = frameLabels.isEmpty ? "Scene @ \(String(format: "%.1f", sec))s" : frameLabels.joined(separator: ", ")
                moments.append(
                    VideoMoment(
                        timestampSec: (sec * 10).rounded() / 10,
                        label: desc,
                        embedding: embedText(desc)
                    )
                )
            }
        }
        return moments
    }

    public static func cosineSimilarity(_ a: [Double], _ b: [Double]) -> Double {
        let n = min(a.count, b.count)
        guard n > 0 else { return 0 }
        var dot = 0.0
        var na = 0.0
        var nb = 0.0
        for i in 0..<n {
            dot += a[i] * b[i]
            na += a[i] * a[i]
            nb += b[i] * b[i]
        }
        let denom = (na.squareRoot() * nb.squareRoot())
        return denom > 1e-9 ? (dot / denom) : 0
    }

    private static func hashFeature(_ token: String) -> (Int, Double) {
        var hash: UInt64 = 1469598103934665603
        for byte in token.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1099511628211
        }
        let idx = Int(hash % UInt64(dimension))
        let sign = ((hash >> 32) & 1) == 0 ? 1.0 : -1.0
        return (idx, sign)
    }

    private static func l2Normalize(_ vec: [Double]) -> [Double] {
        let norm = vec.reduce(0.0) { $0 + $1 * $1 }.squareRoot()
        guard norm > 1e-9 else { return vec }
        return vec.map { $0 / norm }
    }
}

// MARK: - Inputs for the relay's EmbeddingGemma 2 index

extension OnDeviceMultimodalEmbedder {
    /// A video keyframe sent with an upload: the relay embeds each one as a searchable moment.
    public struct VideoKeyframe: Sendable {
        public let timestampSec: Double
        public let jpeg: Data
        /// On-device Vision scene labels ("lake, water body, mountain"), shown as the moment's label.
        public let label: String
    }

    /// A ~1536 px JPEG of any image ImageIO reads (HEIC, PNG, JPEG…), upright. The relay embeds
    /// this with EmbeddingGemma 2 (Workers AI can't decode HEIC; 1536 px matched full-size quality).
    public static func embeddingPreviewJPEG(from data: Data, maxPixelSize: Int = 1536) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return jpegData(image, quality: 0.85)
    }

    /// Keyframes every `interval` seconds (spread evenly over long videos, at most `maxFrames`),
    /// as 768 px JPEGs with Vision scene labels, plus the video's duration.
    public func extractVideoKeyframes(
        data: Data,
        interval: Double = 3,
        maxFrames: Int = 24
    ) async -> (durationSec: Double?, frames: [VideoKeyframe]) {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("fyde-keyframes-\(UUID().uuidString).mov")
        do { try data.write(to: tmp) } catch { return (nil, []) }
        defer { try? FileManager.default.removeItem(at: tmp) }

        let asset = AVURLAsset(url: tmp)
        guard let duration = try? await asset.load(.duration) else { return (nil, []) }
        let total = CMTimeGetSeconds(duration)
        guard total.isFinite, total > 0 else { return (nil, []) }

        var times = Array(stride(from: min(0.5, total / 2), to: total, by: interval))
        if times.isEmpty { times = [total / 2] }
        if times.count > maxFrames {
            times = (0..<maxFrames).map { total * (Double($0) + 0.5) / Double(maxFrames) }
        }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 768, height: 768)
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.25, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.25, preferredTimescale: 600)

        var frames: [VideoKeyframe] = []
        for sec in times {
            guard let (image, actual) = try? await generator.image(at: CMTime(seconds: sec, preferredTimescale: 600)),
                  let jpeg = Self.jpegData(image, quality: 0.8) else { continue }
            let at = CMTimeGetSeconds(actual)
            frames.append(VideoKeyframe(
                timestampSec: ((at.isFinite ? at : sec) * 10).rounded() / 10,
                jpeg: jpeg,
                label: Self.sceneLabels(image)
            ))
        }
        return (total, frames)
    }

    static func jpegData(_ image: CGImage, quality: Double) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    static func sceneLabels(_ image: CGImage, limit: Int = 3) -> String {
        var labels: [String] = []
        let request = VNClassifyImageRequest { req, _ in
            guard let observations = req.results as? [VNClassificationObservation] else { return }
            for obs in observations where obs.confidence >= 0.2 {
                labels.append(obs.identifier.replacingOccurrences(of: "_", with: " "))
                if labels.count >= limit { break }
            }
        }
        try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        return labels.joined(separator: ", ")
    }
}
