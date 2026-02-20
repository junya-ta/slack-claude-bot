# Slack Claude Bot

SlackからClaude Codeを呼び出してローカルリポジトリを操作するボット。

## セットアップ手順

### 1. Slack App作成

1. https://api.slack.com/apps で「Create New App」→「From scratch」
2. App名（例: `Claude Code Bot`）を入力
3. ワークスペースを選択して作成

### 2. Socket Mode有効化

1. 左メニュー「Socket Mode」をクリック
2. 「Enable Socket Mode」をONに
3. 「Generate」をクリックしてApp-Level Token作成
   - Token Name: 任意（例: `socket-token`）
   - Scope: `connections:write` を追加
4. 生成されたトークン（`xapp-...`）をコピーして保存

### 3. Bot権限設定

1. 左メニュー「OAuth & Permissions」をクリック
2. 「Bot Token Scopes」セクションで以下を追加:
   - `channels:history` - チャンネルメッセージ読み取り
   - `chat:write` - メッセージ送信

### 4. Event Subscriptions設定

1. 左メニュー「Event Subscriptions」をクリック
2. 「Enable Events」をONに
3. 「Subscribe to bot events」で以下を追加:
   - `message.channels`
4. 「Save Changes」をクリック

### 5. Appインストール

1. 左メニュー「Install App」をクリック
2. 「Install to Workspace」をクリック
3. 権限を確認して「許可する」
4. Bot User OAuth Token（`xoxb-...`）をコピーして保存

### 6. 環境変数設定

```bash
cp .env.example .env
```

`.env` を編集:
```
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here
```

### 7. リポジトリ設定

```bash
cp config.json.example config.json
```

`config.json` を編集して、操作したいリポジトリを登録:
```json
{
  "allowedChannels": [],
  "repos": {
    "my-project": "/Users/your-name/works/my-project",
    "another-repo": "/Users/your-name/works/another-repo"
  },
  "maxTurns": 10,
  "timeoutMs": 600000,
  "allowedTools": ["Read", "Bash", "Edit", "Write", "Glob", "Grep"]
}
```

- `allowedChannels`: 空配列なら全チャンネル許可。制限する場合はチャンネルIDを指定
- `repos`: `名前: パス` の形式でリポジトリを登録
- `maxTurns`: Claude Codeの最大ターン数
- `timeoutMs`: タイムアウト（ミリ秒）
- `allowedTools`: 許可するツール

### 8. Botをチャンネルに招待

Slackで使いたいチャンネルを開き:
```
/invite @Claude Code Bot
```

### 9. 起動

```bash
# 開発モード（ファイル変更で自動再起動）
npm run dev

# 通常起動
npm run start
```

## 使い方

Slackチャンネルで以下の形式でメッセージを送信:

```
repo:リポジトリ名 やりたいこと
```

### 例

```
repo:my-project このバグを修正して: TypeError in auth.ts

repo:my-project src/utils.ts のコードを説明して

repo:my-project ユーザー認証のテストを追加して
```

## トラブルシューティング

### 「リポジトリが見つかりません」

`config.json` の `repos` に正しいパスが設定されているか確認

### Botが反応しない

1. Botがチャンネルに招待されているか確認
2. `npm run dev` でサーバーが起動しているか確認
3. `.env` のトークンが正しいか確認
4. Socket Modeが有効になっているか確認

### タイムアウトする

`config.json` の `timeoutMs` を増やす（デフォルト: 10分）
