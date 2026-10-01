# iOSの取り込み入口

SwiftUIのアプリと共有拡張です。分析・比較・漫画観の採用は既存Web画面をWKWebViewで開きます。OpenAIのキーは端末に置きません。

## ビルド

1. macOSでXcodeとXcodeGenを用意します。`brew install xcodegen`。
2. `project.yml` のアプリ／拡張のBundle ID、`MH_APP_GROUP`を自分のIDへ変更し、両ターゲットで同じApp Groupを登録します。
3. `xcodegen generate`でプロジェクトを作り、Xcodeで開いてSigning Teamを設定します。
4. iOS 17以上の端末に実行します。最初にデプロイ済みアプリのHTTPS URLとパスワードを入力します。

署名なしのコンパイル確認：

```sh
xcodegen generate
xcodebuild -project MangaHarvester.xcodeproj -scheme MangaHarvester -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

## 保存・同期

- 写真選択／撮影後、任意の一言とともにApp Group内へ保存します。対応する元JPEG・PNG・WebPを保持し、HEICと大きな画像は端末内でJPEGへ変換します。
- 録音終了後、元M4Aを端末へ保存します。カメラ・マイクの許可拒否は写真選択・文章入力へ戻れます。
- 共有拡張は、共有元が実際に提供した写真・文章・公開URLだけを保存します。共有元の隠れた写真や本文を取得しません。URLは外部資料レコードへ送ります。
- 非公開原資料はApp Groupの`CaptureOutbox/<UUID>/`に保存し、ファイルを保存した後で`record.json`をatomicに書きます。端末の最初のロック解除前は読み出せません。iCloudバックアップ対象から除外します。
- ネットワーク復帰・アプリ再開時に順番に送信します。OSに停止されている間の送信完了は保証しません。
- 各記録のUUIDを`Idempotency-Key`として固定します。サーバー応答が失われても同じキーを再送します。Webと同じサーバーの重複防止・削除済みキー拒否を利用します。
- 送信前にサーバーの`instance_id`と保存時のoriginを照合します。保存先の変更や認証切れで別の場所へ送信しません。パスワードは保持しません。CookieはURLSessionで管理し、読む画面へだけ転送します。
- 「端末内保存」「サーバー保存」を分けます。解析完了はWeb画面のサーバー状態で確認します。送信待ちの原ファイルは書き出せます。削除／ログアウト時の破棄は明示操作です。

## API契約

`record.json`のformatは`manga-capture-outbox/v1`。`key`、`instance_id`、`origin`、`created_at`、`files`（name/mime/size）、`text`、`note`を保存します。写真・音声は通常の`POST /api/captures` multipart、文章は同じAPIのJSON、公開URLは`POST /api/external-sources`のJSONです。native側の並行編集は実装せず、読む／訂正する操作はWebの版確認を使います。

## 未確認

署名、App Groupの実機共有、カメラ・写真権限、実マイク録音、共有元ごとのNSItemProvider形式、OSによる中断・復帰、実サーバーへのCookie連携、端末の容量不足を実機で確認する必要があります。App Store提出は行っていません。
