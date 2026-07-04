# Slack Claude Bot

SlackからClaude Code CLIを呼び出し、ローカルリポジトリに対してコード読解・編集・バグ修正などを実行できるボット。

ローカルPCでNodeサーバを起動し、Slackの専用チャンネル経由でAIによるコード操作を手軽に呼び出せる個人向けツールです。

## 特徴

- **メンション駆動** — `@bot` 付きメッセージにのみ反応。通常の会話を邪魔しない
- **マルチリポジトリ対応** — `config.json` に複数のリポジトリを登録し、メッセージで切り替え可能
- **スレッドでセッション継続** — 同一スレッド内のやり取りは同じClaude Codeセッションとして継続。文脈を保ったまま追加指示が可能
- **リアルタイム進捗表示** — Claude Codeのツール実行状況（ファイル読み込み、Grep、編集など）をSlack上にリアルタイムで表示。進捗とメッセージ更新は直列化・スロットルされ、表示崩れやレート制限を回避
- **アクセス制限** — 許可されたチャンネル／ユーザーでのみ動作するよう制御可能
- **同時実行の抑制** — 同一スレッドでの並行実行をロックで防止し、セッションの競合を回避
- **安全な終了** — `SIGINT`/`SIGTERM` で実行中のClaudeプロセスを片付けてから終了

## アーキテクチャ

```
Slack ──(Socket Mode)──▶ Node.js (Bolt) ──(子プロセス)──▶ Claude Code CLI
                              │                                  │
                              │  進捗・結果をSlackへ投稿          │  ローカルリポジトリを操作
                              ◀──────────────────────────────────┘
```

| コンポーネント | 技術                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| Slack連携      | [Slack Bolt for JavaScript](https://slack.dev/bolt-js/) / Socket Mode                                      |
| AI実行         | [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview) (`--output-format stream-json`) |
| ランタイム     | Node.js (ESM / TypeScript)                                                                                 |
| セッション管理 | ファイルベース (`tmp/threads/`)                                                                            |

## 前提条件

| 必要なもの              | バージョン / 詳細                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Node.js**             | v18 以上（ES2022 / ESM を使用）                                                                                          |
| **npm**                 | Node.js に同梱のもので可                                                                                                 |
| **Claude Code CLI**     | `claude` コマンドがPATH上で実行できること（[インストール手順](https://docs.anthropic.com/en/docs/claude-code/overview)） |
| **Anthropic APIキー**   | Claude Code CLI の認証が完了していること（`claude` を一度実行してログイン）                                              |
| **Slackワークスペース** | Slack App を作成・インストールできる管理者権限                                                                           |

> **注意**: このボットは `claude` コマンドを子プロセスとして起動し、`--dangerously-skip-permissions` フラグ付きで実行します。信頼できるネットワーク・チャンネルでのみ使用してください。

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
   - `app_mentions:read` - メンションの読み取り
   - `chat:write` - メッセージ送信

### 4. Event Subscriptions設定

1. 左メニュー「Event Subscriptions」をクリック
2. 「Enable Events」をONに
3. 「Subscribe to bot events」で以下を追加:
   - `app_mention`
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
# 任意: debug | info | warn | error （デフォルト: info）
LOG_LEVEL=info
```

`SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` は必須です。未設定の場合、起動時にエラーで停止します。

### 7. リポジトリ設定

```bash
cp config.json.example config.json
```

`config.json` を編集して、操作したいリポジトリを登録:

```json
{
  "$schema": "./config.schema.json",
  "allowedChannels": [],
  "allowedUsers": [],
  "repos": {
    "my-project": "/Users/your-name/works/my-project",
    "another-repo": "~/works/another-repo"
  },
  "maxTurns": 10,
  "timeoutMs": 600000,
  "allowedTools": ["Read", "Bash", "Edit", "Write", "Glob", "Grep"],
  "skipPermissions": true
}
```

| キー              | 説明                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `allowedChannels` | 空配列なら全チャンネル許可。制限する場合はチャンネルIDを指定                                     |
| `allowedUsers`    | 空配列なら全ユーザー許可。制限する場合はSlackユーザーIDを指定                                    |
| `repos`           | `名前: パス` の形式でリポジトリを登録（`~` はホームに展開されます）                              |
| `maxTurns`        | Claude Codeの最大ターン数                                                                        |
| `timeoutMs`       | タイムアウト（ミリ秒）                                                                           |
| `allowedTools`    | `skipPermissions` が `false` のとき Claude に渡す許可ツール一覧                                  |
| `skipPermissions` | `true` で `--dangerously-skip-permissions`（全ツール許可）。`false` で `allowedTools` のみに制限 |

> `config.json` は `.gitignore` 済みでローカル専用です。編集の雛形と各項目のスキーマは
> `config.json.example` / `config.schema.json` を参照してください（対応エディタでは
> `$schema` により入力補完・検証が効きます）。

必須項目やJSONに不備がある場合は、起動時に分かりやすいメッセージを表示して終了します。

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

Slackチャンネルで **ボットをメンション** してメッセージを送信:

```
@Claude Code Bot repo:リポジトリ名 やりたいこと
```

> ボットはメンション付きメッセージにのみ反応します。チャンネル内の通常メッセージには反応しません。

### 例

```
@Claude Code Bot repo:my-project このバグを修正して: TypeError in auth.ts

@Claude Code Bot repo:my-project src/utils.ts のコードを説明して

@Claude Code Bot repo:my-project ユーザー認証のテストを追加して
```

### スレッド内での継続

スレッド内でもメンション付きでメッセージを送ると、同じセッションで会話を継続できます:

```
@Claude Code Bot 他にも似たバグがないか探して
```

### コマンド一覧

| コマンド                        | 説明                           |
| ------------------------------- | ------------------------------ |
| `@bot repo:リポジトリ名 タスク` | 新規セッション開始             |
| `@bot メッセージ`（スレッド内） | 同じセッションで継続           |
| `@bot repos` / `@bot list`      | 設定済みリポジトリ一覧を表示   |
| `@bot reset`                    | スレッドのセッションをリセット |
| `@bot help`                     | ヘルプを表示                   |

## 開発

```bash
npm run typecheck   # 型チェック
npm run lint        # ESLint
npm run format      # Prettier で整形（format:check で確認のみ）
npm test            # Vitest でユニットテスト
```

- `src/utils.ts`（`parseMessage` / `splitMessage` / `expandPath`）と `src/config.ts`
  （設定検証・アクセス制御）のロジックは `test/` に単体テストがあります。
- `scripts/manual-claude-test.ts` は `claude` CLI 連携を手動確認するためのスクリプトです。
- GitHub Actions（`.github/workflows/ci.yml`）で Node 18/20/22 に対して
  フォーマット・Lint・型チェック・テストを自動実行します。

## トラブルシューティング

### 「リポジトリが見つかりません」

`config.json` の `repos` に正しいパスが設定されているか確認

### Botが反応しない

1. メッセージに `@ボット名` のメンションが含まれているか確認
2. Botがチャンネルに招待されているか確認
3. `npm run dev` でサーバーが起動しているか確認
4. `.env` のトークンが正しいか確認
5. Socket Modeが有効になっているか確認
6. Event Subscriptionsで `app_mention` が登録されているか確認

### タイムアウトする

`config.json` の `timeoutMs` を増やす（デフォルト: 10分）

### 起動直後にエラーで落ちる

`SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` の未設定、または `config.json` の記述ミスの可能性があります。
起動ログのエラーメッセージ（どの環境変数・設定項目が問題か）を確認してください。

## ライセンス

[MIT](./LICENSE)
