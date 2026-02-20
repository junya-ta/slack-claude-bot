import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import { config, getRepoPath, isChannelAllowed } from './config.js';
import { runClaude } from './claude.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.INFO,
});

// repo:name 形式でリポジトリ名を抽出
function parseMessage(text: string): { repoName: string | null; task: string } {
  const match = text.match(/^repo:(\S+)\s+(.+)$/s);
  if (match) {
    return { repoName: match[1], task: match[2].trim() };
  }
  return { repoName: null, task: text };
}

// 長いテキストを分割
function splitMessage(text: string, maxLength = 3900): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // 改行で区切れる位置を探す
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

app.message(async ({ message, say, client }) => {
  // bot自身のメッセージは無視
  if (message.subtype === 'bot_message') return;
  if (!('text' in message) || !message.text) return;
  if (!('channel' in message)) return;

  const channelId = message.channel;
  const threadTs = message.ts;

  // チャンネル制限チェック
  if (!isChannelAllowed(channelId)) {
    console.log(`[Skip] Channel ${channelId} is not allowed`);
    return;
  }

  const text = message.text.trim();

  // repos コマンド: 設定済みリポジトリ一覧を表示
  if (text === 'repos' || text === 'list') {
    const repoList = Object.entries(config.repos)
      .map(([name, path]) => `• \`${name}\` → ${path}`)
      .join('\n');
    await say({
      text: `*設定済みリポジトリ一覧:*\n${repoList || '(なし)'}`,
      thread_ts: threadTs,
    });
    return;
  }

  // help コマンド
  if (text === 'help') {
    await say({
      text: [
        '*使い方:*',
        '• `repo:リポジトリ名 タスク` - Claude Codeを実行',
        '• `repos` または `list` - リポジトリ一覧を表示',
        '• `help` - このヘルプを表示',
        '',
        '*例:*',
        '`repo:my-project このバグを修正して`',
      ].join('\n'),
      thread_ts: threadTs,
    });
    return;
  }

  const { repoName, task } = parseMessage(text);

  if (!repoName) {
    await say({
      text: '`repo:リポジトリ名` を指定してください。\n例: `repo:my-project このバグを修正して`',
      thread_ts: threadTs,
    });
    return;
  }

  const repoPath = getRepoPath(repoName);
  if (!repoPath) {
    const availableRepos = Object.keys(config.repos).join(', ');
    await say({
      text: `リポジトリ \`${repoName}\` が見つかりません。\n利用可能: ${availableRepos || '(なし)'}`,
      thread_ts: threadTs,
    });
    return;
  }

  // 処理中メッセージ
  const processingMsg = await say({
    text: `:hourglass_flowing_sand: Claude Code を実行中... (repo: ${repoName})\n_開始中..._`,
    thread_ts: threadTs,
  });

  const progressLines: string[] = [];
  let lastUpdateTime = 0;
  const UPDATE_INTERVAL = 2000; // 2秒ごとに更新

  const updateProgress = async (status: string) => {
    progressLines.push(status);
    // 最新5件のみ表示
    const recentLines = progressLines.slice(-5);

    const now = Date.now();
    if (now - lastUpdateTime < UPDATE_INTERVAL) return;
    lastUpdateTime = now;

    if (processingMsg.ts) {
      await client.chat.update({
        channel: channelId,
        ts: processingMsg.ts,
        text: `:hourglass_flowing_sand: Claude Code を実行中... (repo: ${repoName})\n\`\`\`\n${recentLines.join('\n')}\n\`\`\``,
      }).catch(() => {});
    }
  };

  try {
    const result = await runClaude(task, repoPath, updateProgress);

    // 処理中メッセージを削除
    if (processingMsg.ts) {
      await client.chat.delete({
        channel: channelId,
        ts: processingMsg.ts,
      }).catch(() => {});
    }

    if (!result.success) {
      await say({
        text: `:x: エラー\n\`\`\`\n${result.error}\n\`\`\``,
        thread_ts: threadTs,
      });
      return;
    }

    const responseText = result.result || '(応答なし)';
    const chunks = splitMessage(responseText);

    for (const chunk of chunks) {
      await say({
        text: chunk,
        thread_ts: threadTs,
      });
    }

    if (result.sessionId) {
      await say({
        text: `_Session: ${result.sessionId}_`,
        thread_ts: threadTs,
      });
    }
  } catch (err) {
    await say({
      text: `:x: 予期しないエラー: ${err instanceof Error ? err.message : String(err)}`,
      thread_ts: threadTs,
    });
  }
});

(async () => {
  await app.start();
  console.log('Slack Claude Bot is running!');
  console.log('Configured repos:', Object.keys(config.repos).join(', ') || '(none)');
  console.log('Allowed channels:', config.allowedChannels.length > 0 ? config.allowedChannels.join(', ') : '(all)');
})();
