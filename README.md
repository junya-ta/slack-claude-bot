# Slack Claude Bot

SlackからClaude Code CLIを呼び出し、ローカルリポジトリに対してコード読解・編集・バグ修正などを実行できるボット。

ローカルPCでNodeサーバを起動し、Slackの専用チャンネル経由でAIによるコード操作を手軽に呼び出せる個人向けツールです。

## 特徴

- **DMで使える** — botとのDMにメンション不要でメッセージを送るだけ。通常メッセージで新規会話、そのスレッドへの返信で継続（`allowedUsers` 設定が必須）
- **メンション駆動（チャンネル）** — チャンネルでは `@bot` 付きメッセージにのみ反応。通常の会話を邪魔しない
- **既定リポジトリ** — `defaultRepo`（または repos が1件のみ）なら `repo:` 指定を省略可能
- **処理中メッセージのキュー** — 同一スレッドが処理中でもメッセージは破棄されず、順番に同じセッションで実行
- **マルチリポジトリ対応** — `config.json` に複数のリポジトリを登録し、メッセージで切り替え可能
- **スレッドでセッション継続** — 同一スレッド内のやり取りは同じClaude Codeセッションとして継続。文脈を保ったまま追加指示が可能
- **リアルタイム進捗表示** — Claude Codeのツール実行状況（ファイル読み込み、Grep、編集など）をSlack上にリアルタイムで表示。進捗とメッセージ更新は直列化・スロットルされ、表示崩れやレート制限を回避
- **アクセス制限** — 許可されたチャンネル／ユーザーでのみ動作するよう制御可能
- **同時実行の抑制** — 同一スレッドでの並行実行をロックで防止し、セッションの競合を回避（後続はキューで順次実行）
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
   - DM利用時: `im:history`（DMの読み取り）、必要なら `im:read`

### 4. Event Subscriptions設定

1. 左メニュー「Event Subscriptions」をクリック
2. 「Enable Events」をONに
3. 「Subscribe to bot events」で以下を追加:
   - `app_mention`
   - DM利用時: `message.im`
4. 「Save Changes」をクリック

### 4.5. DM利用の設定（任意）

1. 左メニュー「App Home」→「Show Tabs」で「Messages Tab」をON
2. 「Allow users to send Slash commands and messages from the messages tab」をON
3. 上記の `im:history`（必要なら `im:read`）と `message.im` を追加後、アプリを**再インストール**
4. `config.json` の `allowedUsers` を設定する。DMでは `allowedUsers` が空だと誰も実行できません。空のままbotにDMを送ると「allowedUsers に次のIDを追加してください: `U...`」と返るので、そのIDを `allowedUsers` に追加して再起動します

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
  "defaultRepo": "my-project",
  "maxTurns": 50,
  "timeoutMs": 1800000,
  "allowedTools": ["Read", "Bash", "Edit", "Write", "Glob", "Grep"],
  "skipPermissions": true
}
```

| キー              | 説明                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `allowedChannels` | 空配列なら全チャンネル許可。制限する場合はチャンネルIDを指定                                     |
| `allowedUsers`    | チャンネルでは空配列なら全ユーザー許可。**DMでは空だと誰も実行不可**（SlackユーザーIDを指定）    |
| `defaultRepo`     | 任意。`repo:` 省略時に使う `repos` のキー。省略時は repos が1件ならその1件                       |
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

### 10. 常駐させる（macOS / launchd・任意）

ログイン時に自動起動し、落ちても自動で再起動させる。実行中は `caffeinate` でアイドルスリープを防ぐ（ノートMacで蓋を閉じた場合のスリープは防げない）。

```bash
./scripts/launchd.sh install    # 登録・起動
./scripts/launchd.sh status     # 状態の確認
./scripts/launchd.sh restart    # config.json を変えたあと
./scripts/launchd.sh logs       # ~/Library/Logs/slack-claude-bot.log を追う
./scripts/launchd.sh uninstall  # 停止・登録解除
```

`npm start` で手動起動した分と同時に動かさないこと（二重に応答する）。

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

| コマンド                                   | 説明                                                      |
| ------------------------------------------ | --------------------------------------------------------- |
| `@bot repo:リポジトリ名 タスク`            | 新規セッション開始                                        |
| `@bot メッセージ`（スレッド内）            | 同じセッションで継続                                      |
| `@bot repos` / `@bot list`                 | 設定済みリポジトリ一覧を表示                              |
| `@bot reset`                               | スレッドのセッションをリセット                            |
| `@bot pc`（スレッド内）                    | PCでRemote Control付きで起動（tmux）しURLを返す           |
| `@bot pc stop`                             | PCで起動したセッションを閉じる                            |
| `@bot pc list`                             | 起動中のPCセッションを一覧（スレッドへのリンク・URL付き） |
| `@bot pc stop all`                         | 起動中のPCセッションをすべて閉じる                        |
| `@bot help`（`?` / `ヘルプ` / `コマンド`） | ヘルプを表示                                              |

DMではメンション（`@bot`）は不要。新しい会話の最初の返信の末尾に、PCで続けるには `pc` と送る旨が表示される。

#### `pc`（PCでRemote Control付きで起動）

- `pc` を送ると、botがtmuxセッション（`scb-<thread_ts>`）で `claude --resume <id> --remote-control` を起動し、Remote ControlのURLを返す。Claudeデスクトップアプリのサイドバーからも開ける。
- **tmuxが必要**（`brew install tmux`）。tmuxが無い・起動に失敗した場合は、手動用のコマンドを返す。
- 起動したセッションはbotを再起動しても残る。
- 起動中はSlackからそのスレッドへの通常メッセージ・`reset` は実行されない（`pc stop` で閉じてから送る）。
- 放置したセッションは `pc list` で確認し、`pc stop all` でまとめて閉じられる。手元からは `pc stop` か `tmux -L slack-claude-bot kill-session -t scb-...` で閉じる（bot専用のtmuxソケット `slack-claude-bot` を使う。一覧は `tmux -L slack-claude-bot ls`）。

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

### 「Failed to authenticate: OAuth session expired」で失敗する

- Claude Code CLI のログインが切れている。ターミナルで `claude auth login` を実行する
- Claude Code（デスクトップアプリ等）のセッション内から `npm start` した場合、親の環境変数を継承して同じエラーになることがあった。子プロセスへは親の `CLAUDE_CODE_*` 等を渡さないようにしてあるが、常駐させるなら launchd 経由で起動するのが確実

## ライセンス

[MIT](./LICENSE)
