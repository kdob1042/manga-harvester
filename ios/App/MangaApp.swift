import SwiftUI
import PhotosUI
import WebKit

@main struct MangaApp: App {
    @StateObject private var model = NativeModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup { CaptureScreen(model: model).onChange(of: phase) { _, phase in
            if phase == .active { model.refresh(); Task { await model.sync() } }
            else { Task { await model.suspendAudio() } }
        } }
    }
}
struct CaptureScreen: View {
    @ObservedObject var model: NativeModel
    @State private var origin = CaptureStore.preferences.string(forKey: "origin") ?? ""
    @State private var password = ""
    @State private var mode = "image"
    @State private var note = ""
    @State private var text = ""
    @State private var photoChoices = false
    @State private var camera = false
    @State private var picker = false
    @State private var selected: [PhotosPickerItem] = []
    @State private var web = false
    @State private var deleting: NativeCapture?
    @State private var closing = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("面白さのメモ。").font(.largeTitle.bold())
                    if !model.authenticated {
                        TextField("アプリのHTTPS URL", text: $origin).textInputAutocapitalization(.never).keyboardType(.URL)
                        SecureField("パスワード", text: $password)
                        Button("開く") { Task { await model.connect(origin: origin, password: password); password = "" } }.buttonStyle(.borderedProminent).disabled(model.busy)
                        if CaptureStore.preferences.string(forKey: "instance_id") != nil { Text("圏外でも、以前の保存先へ新しいメモを残せます。ログインできると送信します。").font(.caption) }
                    }
                }
                if model.authenticated || CaptureStore.preferences.bool(forKey: "device_authorized") {
                    Section {
                        Picker("残し方", selection: $mode) { Text("写真").tag("image"); Text("音声").tag("audio"); Text("一言").tag("text") }.onChange(of: mode) { _, _ in model.cancelAudio() }
                        if mode != "text" { TextField("どこがどう面白い？（任意）", text: $note, axis: .vertical) }
                        if mode == "image" {
                            Button("写真を貼る・撮る") { photoChoices = true }.buttonStyle(.borderedProminent).disabled(model.busy)
                        } else if mode == "audio" {
                            Button(model.recording ? "話し終わる" : "一言、話す") { Task { await model.toggleAudio(note: note) } }.buttonStyle(.borderedProminent).disabled(model.busy)
                        } else {
                            TextField("どこがどう面白かった？", text: $text, axis: .vertical)
                            Button("残す") { Task { if await model.save(text: text) { text = "" } } }.buttonStyle(.borderedProminent).disabled(model.busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                    if !model.status.isEmpty { Section { Text(model.status).font(.callout) } }
                    Section {
                        Button("保存した知見・漫画観を読む") { Task { await model.openWeb(); web = model.webReady } }.disabled(!model.authenticated)
                    }
                } else if !model.status.isEmpty { Section { Text(model.status) } }
                if let url = model.recoveryAudio { Section("保存できなかった音声") { ShareLink("元の音声を書き出す", item: url); Button("端末へ保存し直す") { Task { await model.recoverAudio(note: note) } } } }
                if !model.pending.isEmpty {
                    Section("端末内に保存・接続後に送信") {
                        ForEach(model.pending) { capture in
                            VStack(alignment: .leading) {
                                Text(capture.note.isEmpty ? capture.text ?? "写真・音声" : capture.note)
                                if capture.draft == true { Text("撮影途中 · \(capture.files.count)枚").font(.caption); Button("この写真群を残す") { do { try CaptureStore.finishDraft(capture); model.refresh(); Task { await model.sync() } } catch { model.status = error.localizedDescription } } }
                                if let error = capture.error { Text(error).font(.caption).foregroundStyle(.secondary); Button("送信条件を確認して再試行") { Task { await model.retry(capture) } } }
                                HStack {
                                    if let url = try? CaptureStore.export(capture) { ShareLink("原資料を書き出す", item: url) }
                                    Button("端末から削除", role: .destructive) { deleting = capture }
                                }.font(.caption)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Manga Harvester").navigationBarTitleDisplayMode(.inline)
            .toolbar { if model.authenticated { ToolbarItem { Button("閉じる") { if model.pending.isEmpty && model.recoveryAudio == nil { Task { await model.logout() } } else { closing = true } } } } }
            .confirmationDialog("送信待ちを削除して閉じますか？必要なら先に原資料を書き出してください。", isPresented: $closing) {
                Button("端末の送信待ちを削除して閉じる", role: .destructive) { Task { await model.logout(discardPending: true) } }
                Button("書き出すため戻る", role: .cancel) {}
            }
            .confirmationDialog("写真を残す", isPresented: $photoChoices) {
                Button("カメラで撮る") { if UIImagePickerController.isSourceTypeAvailable(.camera) { camera = true } else { model.status = "カメラが使えません。写真から選んでください。" } }
                Button("写真から選ぶ") { picker = true }
            }
            .photosPicker(isPresented: $picker, selection: $selected, maxSelectionCount: 8, matching: .images)
            .onChange(of: selected) { _, items in
                if !items.isEmpty { Task {
                    do { var files: [(Data, String, String)] = []
                        for item in items { guard let data = try await item.loadTransferable(type: Data.self) else { throw CaptureFailure.message("写真を読み取れませんでした。") }; files.append(try CaptureStore.image(data, index: files.count + 1)) }
                        if await model.save(files: files, note: note) { note = ""; selected = [] }
                    } catch { model.status = error.localizedDescription }
                } }
            }
            .sheet(isPresented: $camera, onDismiss: { model.refresh() }) { CameraCapture(note: note) { camera = false; note = ""; model.refresh(); Task { await model.sync() } } }
            .sheet(isPresented: $web) { if let client = model.client { NavigationStack { ReadWeb(origin: client.origin).toolbar { ToolbarItem { Button("戻る") { web = false; Task { await model.sync() } } } } } } }
            .alert("この端末の原資料を削除しますか？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                Button("削除", role: .destructive) { if let capture = deleting { do { try CaptureStore.remove(capture); model.refresh() } catch { model.status = error.localizedDescription } }; deleting = nil }
                Button("戻る", role: .cancel) { deleting = nil }
            } message: { Text("まだサーバーへ送っていない写真・音声・文章も削除します。必要なら先に書き出してください。") }
        }
    }
}
struct CameraCapture: UIViewControllerRepresentable {
    let note: String
    let saved: () -> Void
    @Environment(\.dismiss) private var dismiss
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController(); picker.sourceType = .camera; picker.showsCameraControls = false; picker.delegate = context.coordinator
        context.coordinator.picker = picker; picker.cameraOverlayView = context.coordinator.controls(); return picker
    }
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraCapture; init(_ parent: CameraCapture) { self.parent = parent }
        weak var picker: UIImagePickerController?
        private var draft: NativeCapture?
        private let count = UILabel()
        private let shutter = UIButton(type: .system)
        private let finish = UIButton(type: .system)
        func controls() -> UIView {
            let overlay = UIView(frame: UIScreen.main.bounds), stack = UIStackView(); stack.axis = .vertical; stack.spacing = 10; stack.translatesAutoresizingMaskIntoConstraints = false
            count.text = "写真を撮る · 8枚まで"; count.textAlignment = .center; count.textColor = .white
            shutter.setTitle("撮る", for: .normal); shutter.backgroundColor = .systemBlue; shutter.setTitleColor(.white, for: .normal); shutter.layer.cornerRadius = 12; shutter.addTarget(self, action: #selector(shoot), for: .touchUpInside)
            finish.setTitle("この写真群を残す", for: .normal); finish.isEnabled = false; finish.backgroundColor = .white; finish.layer.cornerRadius = 12; finish.addTarget(self, action: #selector(done), for: .touchUpInside)
            let back = UIButton(type: .system); back.setTitle("中断して戻る", for: .normal); back.setTitleColor(.white, for: .normal); back.addTarget(self, action: #selector(pause), for: .touchUpInside)
            [count, shutter, finish, back].forEach { stack.addArrangedSubview($0) }; overlay.addSubview(stack)
            NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: overlay.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: overlay.trailingAnchor, constant: -24), stack.bottomAnchor.constraint(equalTo: overlay.bottomAnchor, constant: -50), shutter.heightAnchor.constraint(equalToConstant: 52), finish.heightAnchor.constraint(equalToConstant: 44)])
            return overlay
        }
        @objc private func shoot() { shutter.isEnabled = false; picker?.takePicture() }
        @objc private func pause() { parent.dismiss() } // Durable draft remains recoverable in the record list.
        @objc private func done() { do { if let draft { try CaptureStore.finishDraft(draft); parent.saved() } } catch { show(error) } }
        private func show(_ error: Error) { let alert = UIAlertController(title: "写真を保存できませんでした", message: error.localizedDescription, preferredStyle: .alert); alert.addAction(UIAlertAction(title: "戻る", style: .cancel)); picker?.present(alert, animated: true) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            defer { shutter.isEnabled = (draft?.files.count ?? 0) < 8 }
            do {
                guard let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) else { throw CaptureFailure.message("写真を読み取れませんでした。") }
                let file = try CaptureStore.image(data, index: (draft?.files.count ?? 0) + 1)
                if let existing = draft { draft = try CaptureStore.appendDraft(existing, file: file) }
                else { draft = try CaptureStore.stage(files: [file], note: parent.note, draft: true) }
                count.text = "端末内に保存 · \(draft!.files.count)枚"; finish.isEnabled = true
            } catch { show(error) }
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
struct ReadWeb: UIViewRepresentable {
    let origin: URL
    func makeCoordinator() -> Coordinator { Coordinator(origin: origin) }
    func makeUIView(context: Context) -> WKWebView { let view = WKWebView(); view.navigationDelegate = context.coordinator; view.load(URLRequest(url: origin)); return view }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    final class Coordinator: NSObject, WKNavigationDelegate {
        let origin: URL; init(origin: URL) { self.origin = origin }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if url.scheme == "https", url.host == origin.host, url.port == origin.port { decisionHandler(.allow) }
            else { decisionHandler(.cancel); if url.scheme == "https" { UIApplication.shared.open(url) } }
        }
    }
}
