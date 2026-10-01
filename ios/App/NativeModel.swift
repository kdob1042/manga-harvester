import Foundation
import Combine
import Network
import AVFoundation
import WebKit

@MainActor final class NativeModel: ObservableObject {
    @Published var authenticated = false
    @Published var status = ""
    @Published var pending: [NativeCapture] = []
    @Published var busy = false
    @Published var recording = false
    @Published var webReady = false
    @Published var recoveryAudio: URL?
    var client: APIClient?
    private let monitor = NWPathMonitor()
    private var syncing = false
    private var recorder: AVAudioRecorder?
    private var audioURL: URL?
    private var audioTimer: Timer?
    private var recordingNote = ""

    init() {
        if let string = CaptureStore.preferences.string(forKey: "origin"), let url = URL(string: string) { client = APIClient(origin: url) }
        refresh()
        authenticated = CaptureStore.preferences.bool(forKey: "device_authorized")
        if let path = CaptureStore.preferences.string(forKey: "audio_recovery"), FileManager.default.fileExists(atPath: path) { recoveryAudio = URL(fileURLWithPath: path) }
        monitor.pathUpdateHandler = { [weak self] path in
            if path.status == .satisfied { Task { @MainActor in await self?.sync() } }
        }
        monitor.start(queue: DispatchQueue(label: "manga.connectivity"))
    }
    func refresh() { do { pending = try CaptureStore.entries() } catch { status = error.localizedDescription } }
    func retry(_ capture: NativeCapture) async { do { var updated = capture; updated.error = nil; try CaptureStore.update(updated); refresh(); await sync() } catch { status = error.localizedDescription } }
    func connect(origin: String, password: String) async {
        busy = true; defer { busy = false }
        do {
            guard let url = URL(string: origin.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil else {
                throw CaptureFailure.message("アプリのHTTPS URLを入力してください。")
            }
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            let base = URL(string: "https://\(components.host!)\(components.port.map { ":\($0)" } ?? "")")!
            if pending.contains(where: { $0.origin != base.absoluteString }) { throw CaptureFailure.message("別の保存先への送信待ちがあります。先に書き出して整理してください。") }
            let api = APIClient(origin: base), instance = try await api.login(password: password)
            if pending.contains(where: { $0.instance_id != instance }) { throw CaptureFailure.message("この送信待ちは別の保存先のものです。先に書き出してください。") }
            CaptureStore.preferences.set(base.absoluteString, forKey: "origin")
            CaptureStore.preferences.set(instance, forKey: "instance_id")
            client = api; authenticated = true; CaptureStore.preferences.set(true, forKey: "device_authorized"); status = ""; await sync()
        } catch { status = error.localizedDescription }
    }
    @discardableResult func save(files: [(Data, String, String)] = [], text: String? = nil, note: String = "") async -> Bool {
        busy = true
        do { _ = try CaptureStore.stage(files: files, text: text, note: note); status = "端末内に保存しました。接続後に送信します。"; refresh() }
        catch { status = error.localizedDescription; busy = false; return false }
        busy = false; await sync(); return true
    }
    func sync() async {
        guard !syncing, let api = client else { return }; syncing = true; defer { syncing = false; refresh() }
        do {
            let instance = try await api.instance()
            if let stored = CaptureStore.preferences.string(forKey: "instance_id"), stored != instance, !pending.isEmpty { throw CaptureFailure.message("保存先が変わっています。送信待ちを自動で移しません。書き出して確認してください。") }
            authenticated = true
            CaptureStore.preferences.set(true, forKey: "device_authorized")
            CaptureStore.preferences.set(instance, forKey: "instance_id")
            for var entry in try CaptureStore.entries() {
                guard entry.instance_id == instance, entry.origin == api.origin.absoluteString, entry.error == nil, entry.draft != true else { continue }
                do { try await api.upload(entry); try CaptureStore.remove(entry); status = "サーバーへ保存しました。分析はあとで読めます。" }
                catch let error as ServerFailure {
                    if error.status == 401 { authenticated = false; CaptureStore.preferences.set(false, forKey: "device_authorized"); throw error }
                    if error.status >= 500 || error.status == 429 { throw error }
                    entry.error = error.localizedDescription; try CaptureStore.update(entry)
                }
            }
        } catch let error as ServerFailure {
            if error.status == 401 { authenticated = false; CaptureStore.preferences.set(false, forKey: "device_authorized") }
            status = error.localizedDescription
        } catch let error as CaptureFailure {
            status = error.localizedDescription
        } catch {
            status = pending.isEmpty ? "接続を確認してください。" : "端末内に保存済みです。接続後に送信します。"
        }
    }
    func openWeb() async {
        guard let client else { return }
        await client.copyCookiesToWeb(); webReady = true
    }
    func toggleAudio(note: String) async {
        if recording { await finishAudio(note: note); return }
        guard recoveryAudio == nil else { status = "保存できなかった音声を先に書き出すか、保存し直してください。"; return }
        let allowed = await withCheckedContinuation { continuation in AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) } }
        guard allowed else { status = "マイクが使えません。写真か文章で残してください。"; return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.record, mode: .default); try AVAudioSession.sharedInstance().setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
            let recording = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000])
            guard recording.record(forDuration: 120) else { throw CaptureFailure.message("録音を開始できませんでした。") }
            recorder = recording; audioURL = url; recordingNote = note; CaptureStore.preferences.set(url.path, forKey: "audio_recovery"); self.recording = true; status = "録音中 · 最長2分"
            audioTimer = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { [weak self] _ in Task { @MainActor in await self?.finishAudio(note: note) } }
        } catch { status = error.localizedDescription }
    }
    private func finishAudio(note: String) async {
        audioTimer?.invalidate(); audioTimer = nil; recorder?.stop(); recorder = nil; recording = false
        try? AVAudioSession.sharedInstance().setActive(false)
        guard let url = audioURL else { return }; audioURL = nil
        do {
            let data = try Data(contentsOf: url)
            if await save(files: [(data, "voice.m4a", "audio/mp4")], note: note) { try? FileManager.default.removeItem(at: url); CaptureStore.preferences.removeObject(forKey: "audio_recovery") }
            else { recoveryAudio = url; CaptureStore.preferences.set(url.path, forKey: "audio_recovery") }
        }
        catch { status = error.localizedDescription }
    }
    func recoverAudio(note: String) async {
        guard let url = recoveryAudio else { return }
        do { if await save(files: [(try Data(contentsOf: url), "voice.m4a", "audio/mp4")], note: note) {
            try? FileManager.default.removeItem(at: url); recoveryAudio = nil; CaptureStore.preferences.removeObject(forKey: "audio_recovery")
        } } catch { status = error.localizedDescription }
    }
    func suspendAudio() async { if recording { await finishAudio(note: recordingNote) } }
    func cancelAudio() {
        audioTimer?.invalidate(); audioTimer = nil; recorder?.stop(); recorder = nil; recording = false
        if let url = audioURL { try? FileManager.default.removeItem(at: url); CaptureStore.preferences.removeObject(forKey: "audio_recovery") }; audioURL = nil; try? AVAudioSession.sharedInstance().setActive(false)
    }
    func logout(discardPending: Bool = false) async {
        guard let client else { return }
        do {
            if !discardPending && (!pending.isEmpty || recoveryAudio != nil) { throw CaptureFailure.message("保存待ちの原資料があります。先に書き出すか、削除を選んでください。") }
            _ = try await client.send(path: "api/logout", method: "POST", body: Data("{}".utf8))
            if discardPending {
                for capture in try CaptureStore.entries() { try CaptureStore.remove(capture) }
                if let url = recoveryAudio { try? FileManager.default.removeItem(at: url) }
                recoveryAudio = nil; CaptureStore.preferences.removeObject(forKey: "audio_recovery")
            }
            for cookie in HTTPCookieStorage.shared.cookies(for: client.origin) ?? [] { HTTPCookieStorage.shared.deleteCookie(cookie) }
            let store = WKWebsiteDataStore.default().httpCookieStore
            for cookie in await store.allCookies() where cookie.domain == client.origin.host { await store.delete(cookie) }
            authenticated = false; webReady = false; cancelAudio(); CaptureStore.preferences.set(false, forKey: "device_authorized"); CaptureStore.preferences.removeObject(forKey: "instance_id"); refresh(); status = "閉じました。"
        } catch { status = "接続してから閉じてください。送信待ちは端末内に残っています。" }
    }
}
