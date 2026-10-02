# Cloudflare本番配置

- URL: https://manga-harvester.mashstock.workers.dev
- 配置日: 2026-10-02（日本時間）
- アプリのソース: main（Web・PWA、ネイティブを除外）。本人限定Cloudflare Access対応を含む。
- Worker: `manga-harvester`
- D1: `manga-harvester` / `ca4175ce-3b7f-45af-9925-55015fbf5940`
- 非公開R2: `manga-harvester-originals`（r2.dev公開・カスタムドメインとも無効）
- Queue: `manga-harvester-harvest` / `1637dfbcfdc64bdaa610dc78c0099bad`
- Queue consumer: 同Worker、1件ずつ、最大並列1、再試行3回。
- Cron: `* * * * *`（永続ジョブの再送・再開）。
- マイグレーション: 0001〜0009を適用し、`d1_migrations`へ記録。
- 静的ファイル: Web画面・PDF/ZIP変換ライブラリ等212ファイルをWorkers Static Assetsへ配置。

## 認証とAI

本番はCloudflare AccessでWorker全体（静的画面、API、原資料、書き出し）を保護します。Cloudflareアカウント認証だけを使い、`kdob1042@gmail.com` とアカウントメンバー条件の両方を必須にしたallow policy一つだけを設定しています。アプリ内パスワードは不要で、本番の`APP_PASSWORD` secretは削除済みです。古い`mh_session` Cookieは本番の認証に使いません。

Access application: `1b88e5d9-428d-4b64-904b-1b62c93794d8`。Worker destination: `17412cb56ec143b3a653dbc4c58170e6`。本番変数`AUTH_MODE=cloudflare-access`、`ACCESS_AUD`、`ACCESS_TEAM_DOMAIN`、`ACCESS_OWNER_EMAIL`をwrangler.jsoncに記録しています。

Worker側は取得できる場合には`ctx.access`の対象アプリと本人メールを照合します。Workers Static Assetsの内部ルーターなどでruntime identityやassertionヘッダーが渡らない場合には、Cloudflareが自動設定する`CF_Authorization` Cookieも受け取り、RS256署名・issuer・audience・有効期限・本人メールをjoseで検証します。未設定や検証失敗は、静的画面を含めて拒否します。署名のないメールヘッダーは信用しません。ユーザーによるトークンのコピー・登録は不要です。

「閉じる」は端末データを消し、`/cdn-cgi/access/logout`へ移動します。これはCloudflare Accessの他アプリのセッションもログアウトする仕様です。セッション切れでは端末内の未送信メモを保持し、ログイン後に同期を再開します。

[WorkersのAccess仕様](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) / [Accessのログアウト仕様](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)

`OPENAI_API_KEY`は未設定です。原写真・音声・文章の保存は利用できます。AI分析・文字起こし・意味検索・外部調査は設定待ちです。以下のWorker設定で、変数名を `OPENAI_API_KEY`、種類をsecretとして登録して配置し直してください。

[CloudflareのWorker設定](https://dash.cloudflare.com/81561b1cc51a5329d489840ab20f0ca6/workers/services/view/manga-harvester/production/settings)

CLIで設定する場合:

```sh
npx wrangler secret put OPENAI_API_KEY --env production
```

設定後、保存済みの待機ジョブはCron／Queueから再開します。APIキーはブラウザへ配布しません。

## 再配置

本番リソースを再作成する必要はありません。mainのソースを取得し、Cloudflareへ認証した環境で `npm ci && npm run deploy` を実行します。マイグレーション履歴を参照し、既存のデータ・画像・secretを保持して更新します。

初回配置はCloudflareプラグインのAPIでD1／R2／Queue／Workerを作成し、同じmainのWorker dry-run成果物と静的ファイルを配置しました。

## 本番URLでの確認結果

2026-10-02に、認証前のAPI／書き出し拒否、ログイン、複数写真＋一言の保存、永続ジョブ、同一キー再送、非公開R2画像の取得、日本語検索、元ファイル付き書き出し、外部資料の版付き訂正・調査登録・キャンセル、削除後の古い再送拒否、ログアウトを実URLで確認しました。合成画像と検証用の文章だけを使用し、検証レコードは削除済みです。ブラウザでログイン画面の表示と、healthzの成功も確認しました。AIの実処理と実スマホの操作確認は未実施です。

## 本人限定認証への変更確認

未ログインの本番URLで、画面・app.js・API・書き出しがCloudflare Accessへ302で移動することを確認しました。署名付きテストでは本人の保存と書き出しを通し、別メール・別audience・別issuer・期限切れ・偽造署名・古いCookieを拒否しました。型検査、18件のテスト、ビルドを通過。実Cloudflareアカウントでの本人ログイン操作は未検証です。
