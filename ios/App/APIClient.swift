import Foundation
import WebKit

struct ServerFailure: LocalizedError { let status: Int; let message: String; var errorDescription: String? { message } }
private final class RedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@MainActor final class APIClient {
    let origin: URL
    let session: URLSession
    init(origin: URL) {
        self.origin = origin
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = .shared
        configuration.httpCookieAcceptPolicy = .always
        configuration.timeoutIntervalForRequest = 90
        session = URLSession(configuration: configuration, delegate: RedirectBlocker(), delegateQueue: nil)
    }
    func send(path: String, method: String = "GET", body: Data? = nil, type: String = "application/json", key: String? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: origin.appendingPathComponent(path))
        request.httpMethod = method; request.httpBody = body
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        if body != nil { request.setValue(type, forHTTPHeaderField: "Content-Type") }
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.url?.host == origin.host else { throw CaptureFailure.message("保存先から正しい応答を受け取れませんでした。") }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(http.statusCode) else { throw ServerFailure(status: http.statusCode, message: object["error"] as? String ?? "サーバーへ保存できませんでした。") }
        return object
    }
    func login(password: String) async throws -> String {
        _ = try await send(path: "api/login", method: "POST", body: JSONSerialization.data(withJSONObject: ["password": password]))
        return try await instance()
    }
    func instance() async throws -> String {
        let state = try await send(path: "api/state")
        guard let instance = state["instance_id"] as? String else { throw CaptureFailure.message("このサーバーは端末同期に対応していません。") }
        return instance
    }
    func upload(_ capture: NativeCapture) async throws {
        guard capture.origin == origin.absoluteString else { throw CaptureFailure.message("この送信待ちは別の保存先のものです。書き出してから設定を確認してください。") }
        if let url = capture.external_url {
            _ = try await send(path: "api/external-sources", method: "POST", body: JSONSerialization.data(withJSONObject: ["url": url, "quote": capture.text ?? "", "scope": capture.note.isEmpty ? "共有された公開資料。対象の文脈は未確認。" : capture.note]), key: capture.key)
        } else if capture.files.isEmpty {
            _ = try await send(path: "api/captures", method: "POST", body: JSONSerialization.data(withJSONObject: ["text": capture.text ?? "", "note": capture.note]), key: capture.key)
        } else {
            let boundary = "manga-\(capture.key)"; var body = Data()
            func append(_ text: String) { body.append(Data(text.utf8)) }
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\n\(capture.note)\r\n")
            for file in capture.files {
                append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(file.name)\"\r\nContent-Type: \(file.mime)\r\n\r\n")
                body.append(try Data(contentsOf: CaptureStore.directory(capture).appendingPathComponent(file.name))); append("\r\n")
            }
            append("--\(boundary)--\r\n")
            _ = try await send(path: "api/captures", method: "POST", body: body, type: "multipart/form-data; boundary=\(boundary)", key: capture.key)
        }
    }
    func copyCookiesToWeb() async {
        for cookie in HTTPCookieStorage.shared.cookies(for: origin) ?? [] {
            await WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie)
        }
    }
}
