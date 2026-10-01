import Foundation
import UIKit
import ImageIO

enum CaptureFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

struct LocalFile: Codable { let name: String; let mime: String; let size: Int }
struct NativeCapture: Codable, Identifiable {
    let format: String
    let id: String
    let key: String
    let instance_id: String
    let origin: String
    let created_at: Double
    var files: [LocalFile]
    let text: String?
    let note: String
    let external_url: String?
    var error: String?
    var draft: Bool?
}

enum CaptureStore {
    static var group: String { Bundle.main.object(forInfoDictionaryKey: "MHAppGroup") as? String ?? "group.com.example.mangaharvester" }
    static var preferences: UserDefaults { UserDefaults(suiteName: group)! }
    static func root() throws -> URL {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw CaptureFailure.message("App Groupの設定を確認してください。端末へ保存できません。")
        }
        let root = container.appendingPathComponent("CaptureOutbox", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var secured = root; var values = URLResourceValues(); values.isExcludedFromBackup = true; try secured.setResourceValues(values)
        return root
    }
    static func entries() throws -> [NativeCapture] {
        try FileManager.default.contentsOfDirectory(at: root(), includingPropertiesForKeys: nil).compactMap { directory in
            try? JSONDecoder().decode(NativeCapture.self, from: Data(contentsOf: directory.appendingPathComponent("record.json")))
        }.sorted { $0.created_at < $1.created_at }
    }
    static func directory(_ capture: NativeCapture) throws -> URL { try root().appendingPathComponent(capture.id, isDirectory: true) }
    static func update(_ capture: NativeCapture) throws {
        try JSONEncoder().encode(capture).write(to: directory(capture).appendingPathComponent("record.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    static func remove(_ capture: NativeCapture) throws { try FileManager.default.removeItem(at: directory(capture)) }
    static func stage(files: [(Data, String, String)] = [], text: String? = nil, note: String = "", externalURL: String? = nil, draft: Bool = false) throws -> NativeCapture {
        guard preferences.bool(forKey: "device_authorized"), let instance = preferences.string(forKey: "instance_id"), let origin = preferences.string(forKey: "origin"), !instance.isEmpty else {
            throw CaptureFailure.message("アプリで一度ログインしてから、撮影・共有してください。")
        }
        guard files.count <= 8, note.count <= 20_000, (text?.count ?? 0) <= 20_000, files.allSatisfy({ !$0.0.isEmpty && $0.0.count <= 8 * 1024 * 1024 }), files.reduce(0, { $0 + $1.0.count }) <= 20 * 1024 * 1024 else {
            throw CaptureFailure.message("写真・音声は8点、1点8MB・合計20MBまでです。")
        }
        let pending = try entries()
        guard pending.count < 100, pending.flatMap(\.files).reduce(0, { $0 + $1.size }) + files.reduce(0, { $0 + $1.0.count }) <= 80 * 1024 * 1024 else {
            throw CaptureFailure.message("端末内の送信待ちは100件・80MBまでです。先に同期か書き出しをしてください。")
        }
        let key = UUID().uuidString.lowercased()
        let capture = NativeCapture(format: "manga-capture-outbox/v1", id: key, key: key, instance_id: instance, origin: origin, created_at: Date().timeIntervalSince1970 * 1000,
            files: files.map { LocalFile(name: $0.1, mime: $0.2, size: $0.0.count) }, text: text, note: note, external_url: externalURL, error: nil, draft: draft)
        let folder = try directory(capture)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        do {
            for file in files { try file.0.write(to: folder.appendingPathComponent(file.1), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
            // Manifest last: an interrupted copy never looks like a complete entry.
            try update(capture)
            return capture
        } catch { try? FileManager.default.removeItem(at: folder); throw error }
    }
    static func appendDraft(_ capture: NativeCapture, file: (Data, String, String)) throws -> NativeCapture {
        guard capture.draft == true, capture.files.count < 8, file.0.count <= 8 * 1024 * 1024, capture.files.reduce(0, { $0 + $1.size }) + file.0.count <= 20 * 1024 * 1024,
              try entries().flatMap(\.files).reduce(0, { $0 + $1.size }) + file.0.count <= 80 * 1024 * 1024 else { throw CaptureFailure.message("撮影は8枚・合計20MBまで、端末内は80MBまでです。いまの写真群を残してください。") }
        var updated = capture; updated.files.append(LocalFile(name: file.1, mime: file.2, size: file.0.count))
        try file.0.write(to: directory(capture).appendingPathComponent(file.1), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); try update(updated); return updated
    }
    static func finishDraft(_ capture: NativeCapture) throws { var complete = capture; complete.draft = false; try update(complete) }
    static func image(_ data: Data, index: Int) throws -> (Data, String, String) {
        guard data.count <= 25 * 1024 * 1024, let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
              Double(width) * Double(height) <= 50_000_000 else { throw CaptureFailure.message("画像が大きすぎるか、読み取れませんでした。") }
        let signature = [UInt8](data.prefix(12))
        if data.count <= 8 * 1024 * 1024 {
            if signature.prefix(3).elementsEqual([255, 216, 255]) { return (data, "photo-\(index).jpg", "image/jpeg") }
            if signature.prefix(8).elementsEqual([137,80,78,71,13,10,26,10]) { return (data, "photo-\(index).png", "image/png") }
            if String(bytes: signature.prefix(4), encoding: .ascii) == "RIFF", String(bytes: signature.suffix(4), encoding: .ascii) == "WEBP" { return (data, "photo-\(index).webp", "image/webp") }
        }
        // HEIC and oversized camera images become a supported JPEG locally.
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 2800, kCGImageSourceCreateThumbnailWithTransform: true]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary), let jpeg = UIImage(cgImage: image).jpegData(compressionQuality: 0.88), jpeg.count <= 8 * 1024 * 1024 else { throw CaptureFailure.message("JPEGへ変換できませんでした。") }
        return (jpeg, "photo-\(index).jpg", "image/jpeg")
    }
    static func export(_ capture: NativeCapture) throws -> URL {
        let encoded = try JSONEncoder().encode(capture)
        var object = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        object["files"] = try capture.files.map { file in ["name": file.name, "mime": file.mime, "size": file.size, "base64": try Data(contentsOf: directory(capture).appendingPathComponent(file.name)).base64EncodedString()] as [String: Any] }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("manga-device-\(capture.id).json")
        try JSONSerialization.data(withJSONObject: object).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); return url
    }
}
