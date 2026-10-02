# Cloudflare本番配置

- URL: https://manga-harvester.mashstock.workers.dev
- 配置日: 2026-10-02（日本時間）
- アプリのソース: mainの `13691357f3f7b90a0089451acfa318db1f910c20`（Web・PWA、ネイティブを除外）
- Worker: `manga-harvester`
- D1: `manga-harvester` / `ca4175ce-3b7f-45af-9925-55015fbf5940`
- 非公開R2: `manga-harvester-originals`（r2.dev公開・カスタムドメインとも無効）
- Queue: `manga-harvester-harvest` / `1637dfbcfdc64bdaa610dc78c0099bad`
- Queue consumer: 同Worker、1件ずつ、最大並列1、再試行3回。
- Cron: `* * * * *`（永続ジョブの再送・再開）。
- マイグレーション: 0001〜0009を適用し、`d1_migrations`へ記録。
- 静的ファイル: Web画面・PDF/ZIP変換ライブラリ等212ファイルをWorkers Static Assetsへ配置。

## 認証とAI

`APP_PASSWORD`はWorkerのsecretとして設定済みです。値はコード・公開ファイル・ドキュメントへ記録しません。

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
