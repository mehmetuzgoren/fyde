import Foundation
import Photos

#if os(iOS)
import MessageUI
import SwiftUI
import UIKit
#elseif os(macOS)
import AppKit
#endif

public enum PlatformMediaBridge {
    public static var currentPlatform: String {
        #if os(iOS)
        return "ios"
        #elseif os(macOS)
        return "macos"
        #else
        return "web"
        #endif
    }

    public static var deviceDisplayName: String {
        #if os(iOS)
        return "Fyde iPhone"
        #elseif os(macOS)
        return Host.current().localizedName ?? "Fyde Mac"
        #else
        return "Fyde Device"
        #endif
    }

    /// AirDrop-like Direct-to-Photos saving via PhotoKit (`PHPhotoLibrary`).
    /// Downloads bundle items and writes photos & videos directly into an Apple Photos custom album.
    public static func saveBundleItemsToApplePhotos(
        items: [(item: BundleItem, localFileURL: URL)],
        albumTitle: String
    ) async throws -> Int {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else {
            throw NSError(
                domain: "FydePhotoKit",
                code: 403,
                userInfo: [NSLocalizedDescriptionKey: "Photos permission not granted. Enable Photos access in Settings."]
            )
        }

        let mediaItems = items.filter { $0.item.mediaType == .photo || $0.item.mediaType == .video }
        guard !mediaItems.isEmpty else { return 0 }

        // Find or create target PHAssetCollection album
        let targetAlbum = try await findOrCreateAlbum(named: albumTitle)

        try await PHPhotoLibrary.shared().performChanges {
            var placeholders: [PHObjectPlaceholder] = []
            for entry in mediaItems {
                let creationReq = PHAssetCreationRequest.forAsset()
                if entry.item.mediaType == .video {
                    creationReq.addResource(with: .video, fileURL: entry.localFileURL, options: nil)
                } else {
                    creationReq.addResource(with: .photo, fileURL: entry.localFileURL, options: nil)
                }
                if let placeholder = creationReq.placeholderForCreatedAsset {
                    placeholders.append(placeholder)
                }
            }
            if let album = targetAlbum,
               let albumChangeReq = PHAssetCollectionChangeRequest(for: album),
               !placeholders.isEmpty {
                albumChangeReq.addAssets(placeholders as NSFastEnumeration)
            }
        }
        return mediaItems.count
    }

    private static func findOrCreateAlbum(named title: String) async throws -> PHAssetCollection? {
        let fetchOptions = PHFetchOptions()
        fetchOptions.predicate = NSPredicate(format: "title = %@", title)
        let existing = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: fetchOptions)
        if let first = existing.firstObject {
            return first
        }

        final class Box: @unchecked Sendable {
            var localIdentifier: String?
        }
        let box = Box()
        try await PHPhotoLibrary.shared().performChanges {
            let req = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: title)
            box.localIdentifier = req.placeholderForCreatedAssetCollection.localIdentifier
        }
        guard let id = box.localIdentifier else { return nil }
        return PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil).firstObject
    }

    /// Saves received bundle files into local `Documents/FydeReceived/<folderName>/`
    public static func saveBundleItemsToLocalFiles(
        items: [(item: BundleItem, data: Data)],
        folderName: String
    ) throws -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let safeFolder = folderName.replacingOccurrences(of: "/", with: "-")
        let dir = docs.appendingPathComponent("FydeReceived", isDirectory: true)
            .appendingPathComponent(safeFolder, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for entry in items {
            let fileURL = dir.appendingPathComponent(entry.item.filename)
            try entry.data.write(to: fileURL, options: .atomic)
        }
        return dir
    }

    #if os(macOS)
    /// Automatic background iMessage sending on macOS when the user enables Live Mac Messages Bridge.
    public static func sendMacOSiMessage(
        recipientHandle: String,
        message: String,
        attachmentURLs: [URL]
    ) -> Result<String, Error> {
        let escHandle = recipientHandle.replacingOccurrences(of: "\"", with: "\\\"")
        let escMsg = message.replacingOccurrences(of: "\"", with: "\\\"")
        var scriptLines = [
            "tell application \"Messages\"",
            "    set targetService to 1st account whose service type = iMessage",
            "    set targetBuddy to participant \"\(escHandle)\" of targetService",
            "    send \"\(escMsg)\" to targetBuddy"
        ]
        for url in attachmentURLs {
            let escPath = url.path.replacingOccurrences(of: "\"", with: "\\\"")
            scriptLines.append("    send POSIX file \"\(escPath)\" to targetBuddy")
        }
        scriptLines.append("end tell")
        let source = scriptLines.joined(separator: "\n")

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-e", source]
        let errPipe = Pipe()
        proc.standardError = errPipe
        do {
            try proc.run()
            proc.waitUntilExit()
            if proc.terminationStatus == 0 {
                return .success("Sent via macOS Messages.app to \(recipientHandle)")
            }
            let errText = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "AppleScript error"
            return .failure(NSError(domain: "FydeMessages", code: Int(proc.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errText]))
        } catch {
            return .failure(error)
        }
    }
    #endif
}

#if os(iOS)
public struct IOSMessageComposerSheet: UIViewControllerRepresentable {
    public let recipients: [String]
    public let body: String
    public let attachmentDataList: [(data: Data, uti: String, filename: String)]
    public let onFinish: () -> Void

    public init(
        recipients: [String],
        body: String,
        attachmentDataList: [(data: Data, uti: String, filename: String)] = [],
        onFinish: @escaping () -> Void
    ) {
        self.recipients = recipients
        self.body = body
        self.attachmentDataList = attachmentDataList
        self.onFinish = onFinish
    }

    public static var canSendMessages: Bool {
        MFMessageComposeViewController.canSendText()
    }

    public func makeUIViewController(context: Context) -> MFMessageComposeViewController {
        let vc = MFMessageComposeViewController()
        vc.messageComposeDelegate = context.coordinator
        vc.recipients = recipients
        vc.body = body
        for att in attachmentDataList {
            vc.addAttachmentData(att.data, typeIdentifier: att.uti, filename: att.filename)
        }
        return vc
    }

    public func updateUIViewController(_ uiViewController: MFMessageComposeViewController, context: Context) {}

    public func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish)
    }

    public final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate {
        let onFinish: () -> Void
        init(onFinish: @escaping () -> Void) { self.onFinish = onFinish }

        public func messageComposeViewController(
            _ controller: MFMessageComposeViewController,
            didFinishWith result: MessageComposeResult
        ) {
            controller.dismiss(animated: true)
            onFinish()
        }
    }
}
#endif
