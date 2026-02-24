import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { App, LogLevel } from '@slack/bolt';
import { config, getRepoPath, isChannelAllowed } from './config.js';
import { runClaude, type AssistantMessageCallback } from './claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THREAD_CONTEXT_DIR = join(__dirname, '..', 'tmp', 'threads');

let botUserId = '';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.INFO,
});

// Bolt doesn't expose SocketModeClient ping/pong options, so patch them before start()
const socketModeClient = (app as any).receiver?.client;
if (socketModeClient) {
  socketModeClient.pingPongLoggingEnabled = false;
  socketModeClient.clientPingTimeoutMS = 30000;
}

interface ThreadContext {
  repoName: string;
  repoPath: string;
  sessionId: string;
}

function threadContextPath(threadKey: string): string {
  return join(THREAD_CONTEXT_DIR, `${threadKey}.json`);
}

function loadThreadContext(threadKey: string): ThreadContext | undefined {
  const filePath = threadContextPath(threadKey);
  try {
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as ThreadContext;
  } catch (err) {
    console.error(`[ThreadContext] Failed to load ${threadKey}:`, err);
    return undefined;
  }
}

function saveThreadContext(threadKey: string, ctx: ThreadContext): void {
  try {
    mkdirSync(THREAD_CONTEXT_DIR, { recursive: true });
    writeFileSync(threadContextPath(threadKey), JSON.stringify(ctx, null, 2));
    console.log(`[ThreadContext] Saved ${threadKey}:`, ctx);
  } catch (err) {
    console.error(`[ThreadContext] Failed to save ${threadKey}:`, err);
  }
}

function deleteThreadContext(threadKey: string): boolean {
  const filePath = threadContextPath(threadKey);
  try {
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    console.log(`[ThreadContext] Deleted ${threadKey}`);
    return true;
  } catch (err) {
    console.error(`[ThreadContext] Failed to delete ${threadKey}:`, err);
    return false;
  }
}

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

app.event('app_mention', async ({ event, say, client }) => {
  if (!event.text) return;

  const channelId = event.channel;
  const threadKey = event.thread_ts || event.ts;

  // チャンネル制限チェック
  if (!isChannelAllowed(channelId)) {
    console.log(`[Skip] Channel ${channelId} is not allowed`);
    return;
  }

  // メンション部分（<@U...>）を除去
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  // repos コマンド: 設定済みリポジトリ一覧を表示
  if (text === 'repos' || text === 'list') {
    const repoList = Object.entries(config.repos)
      .map(([name, path]) => `• \`${name}\` → ${path}`)
      .join('\n');
    await say({
      text: `*設定済みリポジトリ一覧:*\n${repoList || '(なし)'}`,
      thread_ts: threadKey,
    });
    return;
  }

  // help コマンド
  if (text === 'help') {
    const mention = botUserId ? `<@${botUserId}>` : '@bot';
    await say({
      text: [
        '*使い方:*',
        `• \`${mention} repo:リポジトリ名 タスク\` - 新規セッション開始`,
        `• スレッド内で \`${mention} メッセージ\` → 同じセッションで継続`,
        `• \`${mention} repos\` または \`${mention} list\` - リポジトリ一覧を表示`,
        `• \`${mention} reset\` - スレッドのセッションをリセット`,
        `• \`${mention} help\` - このヘルプを表示`,
        '',
        '*例:*',
        `\`${mention} repo:my-project このバグを修正して\``,
        `(スレッド内で) \`${mention} 他にも似たバグがないか探して\``,
        '',
        '_※ このボットはメンション付きメッセージにのみ反応します_',
      ].join('\n'),
      thread_ts: threadKey,
    });
    return;
  }

  // reset コマンド: スレッドのセッションをリセット
  if (text === 'reset') {
    if (deleteThreadContext(threadKey)) {
      await say({
        text: 'セッションをリセットしました。`repo:リポジトリ名` で新しいセッションを開始してください。',
        thread_ts: threadKey,
      });
    } else {
      await say({
        text: 'このスレッドにはアクティブなセッションがありません。',
        thread_ts: threadKey,
      });
    }
    return;
  }

  // 既存のスレッドコンテキストを確認
  const existingContext = loadThreadContext(threadKey);
  console.log(`[ThreadContext] threadKey=${threadKey}, existingContext=`, existingContext);

  const { repoName, task } = parseMessage(text);

  let currentRepoName: string;
  let currentRepoPath: string;
  let resumeSessionId: string | undefined;

  if (repoName) {
    // 新しいリポジトリ指定がある場合
    const repoPath = getRepoPath(repoName);
    if (!repoPath) {
      const availableRepos = Object.keys(config.repos).join(', ');
      await say({
        text: `リポジトリ \`${repoName}\` が見つかりません。\n利用可能: ${availableRepos || '(なし)'}`,
        thread_ts: threadKey,
      });
      return;
    }
    currentRepoName = repoName;
    currentRepoPath = repoPath;
    // 新しいリポジトリなのでセッションはリセット
  } else if (existingContext) {
    // スレッド内で既存コンテキストを継続
    currentRepoName = existingContext.repoName;
    currentRepoPath = existingContext.repoPath;
    resumeSessionId = existingContext.sessionId || undefined;
  } else {
    // コンテキストがなく、リポジトリ指定もない
    await say({
      text: '`repo:リポジトリ名` を指定してください。\n例: `repo:my-project このバグを修正して`',
      thread_ts: threadKey,
    });
    return;
  }

  const taskText = repoName ? task : text;

  // 処理中メッセージ
  const statusPrefix = resumeSessionId ? '(継続)' : '(新規)';
  const processingMsg = await say({
    text: `:hourglass_flowing_sand: ${statusPrefix} Claude Code を実行中... (repo: ${currentRepoName})\n_開始中..._`,
    thread_ts: threadKey,
  });

  const progressLines: string[] = [];
  let lastUpdateTime = 0;
  const UPDATE_INTERVAL = 2000;

  const updateProgress = async (status: string) => {
    progressLines.push(status);
    const recentLines = progressLines.slice(-5);

    const now = Date.now();
    if (now - lastUpdateTime < UPDATE_INTERVAL) return;
    lastUpdateTime = now;

    if (processingMsg.ts) {
      await client.chat.update({
        channel: channelId,
        ts: processingMsg.ts,
        text: `:hourglass_flowing_sand: ${statusPrefix} Claude Code を実行中... (repo: ${currentRepoName})\n\`\`\`\n${recentLines.join('\n')}\n\`\`\``,
      }).catch(() => {});
    }
  };

  const onAssistantMessage: AssistantMessageCallback = (text) => {
    if (!processingMsg.ts) return;
    const preview = text.slice(0, 3000);
    const content = `:speech_balloon: ${preview}${text.length > 3000 ? '\n_...（続き）_' : ''}`;

    client.chat.update({
      channel: channelId,
      ts: processingMsg.ts,
      text: content,
    }).catch(() => {});
  };

  try {
    const result = await runClaude(taskText, currentRepoPath, updateProgress, resumeSessionId, onAssistantMessage);

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
        thread_ts: threadKey,
      });
      return;
    }

    // セッションIDを保存（sessionIdが取れなくてもrepo情報は保存）
    const sessionId = result.sessionId || '';
    console.log(`[ThreadContext] sessionId from Claude: "${sessionId}"`);
    saveThreadContext(threadKey, {
      repoName: currentRepoName,
      repoPath: currentRepoPath,
      sessionId,
    });

    const responseText = result.result || '(応答なし)';
    const chunks = splitMessage(responseText);

    for (const chunk of chunks) {
      await say({
        text: chunk,
        thread_ts: threadKey,
      });
    }

    if (!resumeSessionId) {
      await say({
        text: `_スレッド内で継続可能 | repo: ${currentRepoName}${sessionId ? ` | session: ${sessionId.slice(0, 12)}...` : ''}_`,
        thread_ts: threadKey,
      });
    }
  } catch (err) {
    await say({
      text: `:x: 予期しないエラー: ${err instanceof Error ? err.message : String(err)}`,
      thread_ts: threadKey,
    });
  }
});

(async () => {
  await app.start();

  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id ?? '';
  console.log(`Slack Claude Bot is running! (bot user: <@${botUserId}>)`);
  console.log('Configured repos:', Object.keys(config.repos).join(', ') || '(none)');
  console.log('Allowed channels:', config.allowedChannels.length > 0 ? config.allowedChannels.join(', ') : '(all)');
})();
