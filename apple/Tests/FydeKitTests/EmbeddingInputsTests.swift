import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import FydeKit

/// The JPEG preview and video keyframes uploads send for the relay's EmbeddingGemma 2 index.
final class EmbeddingInputsTests: XCTestCase {
    private func makeImage(width: Int, height: Int) -> CGImage {
        let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        ctx.setFillColor(CGColor(red: 0.1, green: 0.5, blue: 0.9, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.setFillColor(CGColor(red: 1, green: 0.8, blue: 0.2, alpha: 1))
        ctx.fillEllipse(in: CGRect(x: width / 4, y: height / 4, width: width / 2, height: height / 2))
        return ctx.makeImage()!
    }

    private func encode(_ image: CGImage, as type: UTType) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, nil)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    func testPreviewTurnsHEICIntoBoundedJPEG() throws {
        let original = makeImage(width: 4032, height: 3024)
        // HEIC is the iPhone default and Workers AI can't decode it; fall back to PNG where the
        // HEIC encoder is unavailable (some CI hosts).
        let data = try XCTUnwrap(encode(original, as: .heic) ?? encode(original, as: .png))

        let preview = try XCTUnwrap(OnDeviceMultimodalEmbedder.embeddingPreviewJPEG(from: data))
        XCTAssertEqual(Array(preview.prefix(3)), [0xFF, 0xD8, 0xFF], "preview must be a JPEG")

        let source = try XCTUnwrap(CGImageSourceCreateWithData(preview as CFData, nil))
        let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        let w = try XCTUnwrap(props[kCGImagePropertyPixelWidth] as? Int)
        let h = try XCTUnwrap(props[kCGImagePropertyPixelHeight] as? Int)
        XCTAssertEqual(max(w, h), 1536)
        XCTAssertEqual(Double(w) / Double(h), 4032.0 / 3024.0, accuracy: 0.01)
    }

    func testPreviewRejectsNonImageData() {
        XCTAssertNil(OnDeviceMultimodalEmbedder.embeddingPreviewJPEG(from: Data("not an image".utf8)))
    }

    /// Point FYDE_TEST_VIDEO at any .mov/.mp4 to check keyframe extraction on real footage.
    func testKeyframesFromRealVideo() async throws {
        guard let path = ProcessInfo.processInfo.environment["FYDE_TEST_VIDEO"] else {
            throw XCTSkip("Set FYDE_TEST_VIDEO to a video file to run this test")
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let (duration, frames) = await OnDeviceMultimodalEmbedder().extractVideoKeyframes(data: data)
        let total = try XCTUnwrap(duration)
        XCTAssertFalse(frames.isEmpty)
        XCTAssertLessThanOrEqual(frames.count, 24)
        for f in frames {
            XCTAssertEqual(Array(f.jpeg.prefix(3)), [0xFF, 0xD8, 0xFF])
            XCTAssertGreaterThanOrEqual(f.timestampSec, 0)
            XCTAssertLessThanOrEqual(f.timestampSec, total + 0.5)
        }
        print("keyframes:", frames.map { "\($0.timestampSec)s [\($0.label)] \($0.jpeg.count / 1024)KB" })
    }
}
