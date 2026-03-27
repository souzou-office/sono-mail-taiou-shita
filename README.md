# そのメール対応した？

未対応メールチェッカー。毎朝Gmailをスキャンして、返信が必要なのに返信していないメールをリストアップ。返信したら自動で消える。

## セットアップ

### 1. GAS（バックエンド）

1. [Google Apps Script](https://script.google.com/) で新規プロジェクト作成
2. `gas/Code.gs` の内容を貼り付け
3. スクリプトプロパティに `ANTHROPIC_API_KEY` を設定
4. エディタで `setupTriggers` を実行（トリガー自動設定）
5. デプロイ → ウェブアプリ → アクセス: 自分のみ → デプロイ
6. URLをコピー

### 2. フロント

```bash
cp .env.example .env
# .env の VITE_GAS_URL にGASのURLを設定
npm install
npm run dev
```

### 3. デプロイ（GitHub Pages）

```bash
npm run deploy
```

### 4. PWA

スマホ: ブラウザで開いて「ホーム画面に追加」
PC: Chromeで開いて「インストール」

## 仕組み

- 毎朝7時: 過去48時間の未返信メールをHaiku (Claude) で2段判定
- 3時間おき: 返信済みチェック → 返信してたら消える、相手から再返信が来たら再判定
- 週1: 古いアイテム掃除
