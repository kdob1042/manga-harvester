import UIKit
import Social
import UniformTypeIdentifiers

final class ShareController: SLComposeServiceViewController {
    override func isContentValid() -> Bool { (contentText ?? "").count <= 20_000 }
    override func didSelectPost() {
        view.isUserInteractionEnabled = false
        Task { @MainActor in
            do {
                let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
                var photos: [(Data, String, String)] = [], texts: [String] = [], urls: [String] = []
                for provider in items.flatMap({ $0.attachments ?? [] }) {
                    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                        let data = try await loadData(provider, type: UTType.image.identifier)
                        photos.append(try CaptureStore.image(data, index: photos.count + 1))
                    } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                        let item = try await loadItem(provider, type: UTType.url.identifier)
                        if let url = item as? URL { urls.append(url.absoluteString) }
                        else if let string = item as? String { urls.append(string) }
                    } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                        let item = try await loadItem(provider, type: UTType.plainText.identifier)
                        if let string = item as? String { texts.append(string) }
                        else if let data = item as? Data, let string = String(data: data, encoding: .utf8) { texts.append(string) }
                    }
                }
                let note = [contentText ?? "", texts.joined(separator: "\n")].filter { !$0.isEmpty }.joined(separator: "\n")
                if !photos.isEmpty {
                    // Save exactly the images supplied by the host. Never fetch
                    // hidden images or scrape a site behind the share URL.
                    _ = try CaptureStore.stage(files: photos, note: [note, urls.joined(separator: "\n")].filter { !$0.isEmpty }.joined(separator: "\n"))
                } else if let first = urls.first {
                    guard let url = URL(string: first), url.scheme == "https", url.user == nil, url.password == nil else { throw CaptureFailure.message("公開資料のHTTPS URLを共有してください。") }
                    _ = try CaptureStore.stage(text: texts.joined(separator: "\n"), note: contentText ?? "", externalURL: first)
                } else if !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    _ = try CaptureStore.stage(text: note)
                } else { throw CaptureFailure.message("共有された写真・文章・URLがありません。") }
                extensionContext?.completeRequest(returningItems: nil)
            } catch {
                view.isUserInteractionEnabled = true
                let alert = UIAlertController(title: "端末へ保存できませんでした", message: error.localizedDescription, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "戻る", style: .cancel)); present(alert, animated: true)
            }
        }
    }
    private func loadData(_ provider: NSItemProvider, type: String) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type) { data, error in
                if let data { continuation.resume(returning: data) }
                else { continuation.resume(throwing: error ?? CaptureFailure.message("共有画像を読み取れませんでした。")) }
            }
        }
    }
    private func loadItem(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
                if let item { continuation.resume(returning: item) }
                else { continuation.resume(throwing: error ?? CaptureFailure.message("共有内容を読み取れませんでした。")) }
            }
        }
    }
}
