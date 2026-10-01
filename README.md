# Manga Harvester

写真を貼り、「どこがどう面白い」と一言書く／話す。AIが面白さを言語化し、過去のメモとの共通点や違いを見つけ、自分の漫画観の案を育てる個人用Webアプリ。

**保存単位は写真のまとまりと本人の発言。ページ・巻話・コマ・読み順の専用モデルはありません。** 作品登録・タグ付け・概念入力・解析開始操作は不要です。漫画制作ツールへの接続はありません。

## 初期実装

- ホームの主操作は「取り込む」一つ。貼り付け、ドロップ、複数写真選択、録音、音声ファイル、一言に対応します。
- 写真選択／録音終了で保存。任意の一言は先に添えるか、後から同じ記録に追加します。原資料の保存確認後に戻り、分析はバックグラウンドで続きます。
- 原資料／AIの観察・解釈・条件付き仮説／本人の明示反応を分離します。知見・概念・仕組み・問い・関係は自動保存します。
- 過去の記録と仕組みを比較し、価値ある比較を最大3件表示。どちらの原写真にも戻れます。
- 漫画観の案は自動生成し、本人の明示的な採用／編集時だけ現行版を更新します。本文・理由・根拠の改訂履歴を保持します。
- パスワード認証、非公開画像／音声、日本語検索、原ファイルと知見グラフを含むJSON書き出し、訂正・補足・削除を用意しています。
- 再送の重複防止、入力の版、ジョブのリース、上限付き再試行、日次API回数上限を実装。古い解析結果や漫画観案で本人編集を上書きしません。

## 構成

TypeScriptのCloudflare Worker＋静的HTML/CSS/JavaScript。SQLはD1、元写真・音声は非公開R2、非同期処理はQueues。SQL outboxと毎分Cronでキュー送信・中断ジョブを回復します。外部へのAPI呼び出しはサーバーだけで行います。

book-harvesterの保存・認証・ジョブの基本パターンを参照しましたが、依存やデータ共有はありません。ChatGPT Sitesのプロジェクトではありません。

| データ | 内容 |
|---|---|
| Capture / Asset / CaptureRevision | 写真・音声・本人文・訂正・入力の版。Assetのupload_indexは表示用の添付順のみ |
| Harvest / Job / AiCall | 根拠付き分析、生成契約、入力版・モデル・状態・利用量 |
| Generation / Node / Concept | 観察・解釈・概念・条件付き仕組み・問い。同名でも意味が違えば別Concept |
| Relation / Comparison / Reaction | 型付き関係、両側根拠付き比較、本人の明示発言 |
| Proposal / View / ViewRevision | AI案と本人が採用した漫画観、その改訂。base_revisionで競合防止 |
| Override | 本人の訂正をAIの再生成から独立して保持 |

## ローカル起動

Node.js 24以上。

```sh
npm ci
cp .dev.vars.example .dev.vars
# .dev.varsへ16文字以上のAPP_PASSWORDとOPENAI_API_KEYを設定
npm run types
npm run migrate
npm run dev
```

http://localhost:8791 を開きます。APIキーなしでも原資料保存は可能ですが、分析は「AI設定待ち」になります。**キーなしの動作をMVP完了とは扱いません。** 設定後は待機ジョブが自動復帰します。

初期モデルは画像入力と構造化出力に対応する `gpt-4.1-mini`、音声は `gpt-4o-mini-transcribe`。サーバー設定で交換できます。専用OCRは前段に置きません。

### 外部AIへ送る範囲・上限

対象の写真／音声／本人文に加え、比較用の直近24記録の知見、現行Concept最大40件、漫画観最大12件を送信します。過去の原写真一式は送りません。Responsesは `store:false`。プロバイダー側の取扱いは契約とアカウント設定に従います。

1記録8ファイル、1ファイル8MB、合計20MB。画像はJPEG／PNG／WebP。HEICはJPEGへ変換してください。音声はMP3／M4A／WAV／WebM／Ogg。ブラウザ録音は2分まで。

日次上限はUTCで60回、出力上限は6500トークン。音声は文字起こしと理解で複数回使います。**回数上限は金額上限ではありません。** モデルの利用料はOpenAI API側で発生します。

## 検証

```sh
npm run check
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:browser
```

`npm test` はSQLiteで実際の保存・ジョブ・グラフ更新・採用・競合・削除を通し、プロバイダー境界だけを注入します。`test:browser` は実HTMLとAPIを操作してPC／スマホ・複数写真＋一言・貼り付け・再訪・比較・採用／編集／履歴・マイク拒否の復帰を確認します。スクリーンショットは `artifacts/` に出力します。検証画像は自作素材です。

実workerd/D1/R2/Queueを使う保存経路の検証:

```sh
# 別ターミナルでnpm run devを起動
TEST_APP_PASSWORD='<dev password>' npm run test:integration
```

実モデルの画像理解／文字起こしは別の確認です。APIキーを設定し、自作の無言の描写・前後不足・批判的感想・異なる記録の比較・漫画観更新案を入力して確認してください。完了を確認するまでIssue #1／#2は閉じません。

## デプロイ準備

`wrangler.jsonc` はdev／productionでD1・R2・Queueを分離しています。現在のD1 IDとproduction originはプレースホルダーです。実リソースを作成して置換します。

```sh
npx wrangler d1 create manga-harvester
npx wrangler r2 bucket create manga-harvester-originals
npx wrangler queues create manga-harvester-harvest
npx wrangler secret put APP_PASSWORD --env production
npx wrangler secret put OPENAI_API_KEY --env production
# wrangler.jsoncのproduction DB ID / APP_ORIGINを実値へ変更
npm run deploy
```

devも別名のリソースとsecretを設定します。R2 public bucketを有効にする必要はありません。API、元ファイル、書き出しはアプリの認証を通ります。`deploy` はproductionのプレースホルダーが残っていれば停止します。リポジトリに秘密情報や商業漫画の画像を入れないでください。

## 再構成・削除

```sh
APP_ORIGIN='https://your-app' APP_PASSWORD='<password>' node scripts/rebuild.mjs <capture UUID> [more UUIDs]
```

指定記録の版を進めて通常の永続ジョブへ登録します。旧版の分析は更新前と明示して表示し、新しい分析の失敗時にも残します。現在のグラフと比較候補には入力版が一致するものだけを使います。過去24件より古い知見への高度な検索は後続Issueの対象です。

記録の削除時は写真・音声・分析・関連グラフを削除します。採用済みの本人の漫画観と改訂履歴は残し、原資料が削除されたことを表示します。履歴に採用当時の分析文が残る仕様です。

## 残りの完了条件

実OpenAI APIでの品質確認、実Cloudflare環境へのデプロイ、実端末での録音を含む最終確認が未実施です。追加Issue #3〜#8（振り返り、取り込み拡張、外部資料、高度検索／グラフUI、オフライン、ネイティブ）は未実装です。
