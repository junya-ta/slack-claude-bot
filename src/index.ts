import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { App, LogLevel } from '@slack/bolt';
import type { ChildProcess } from 'child_process';
import {
  loadConfig,
  requireEnv,
  getRepoPath,
  isChannelAllowed,
  isUserAllowed,
  type Config,
} from './config.js';
import { parseMessage, splitMessage } from './utils.js';
import { runClaude } from './claude.js';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THREAD_CONTEXT_DIR = join(__dirname, '..', 'tmp', 'threads');
const THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1日

// 起動前に設定・環境変数を検証（不備があれば分かりやすく落とす）
let config: Config;
try {
  requireEnv();
  config = loadConfig();
} catch (err) {
  logger.error(`[Startup] ${(err as Error).message}`);
  process.exit(1);
}

let botUserId = '';

// スレッド単位の実行ロック（同一スレッドの並行実行を防止）
const busyThreads = new Set<string>();
// 実行中の子プロセス（graceful shutdown 用）
const runningProcs = new Set<ChildProcess>();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.INFO,
});

// Bolt doesn't expose SocketModeClient ping/pong options, so patch them before start()
const socketModeClient = (app as unknown as { receiver?: { client?: Record<string, unknown> } }).receiver
  ?.client;
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
    logger.error(`[ThreadContext] Failed to load ${threadKey}:`, err);
    return undefined;
  }
}

function saveThreadContext(threadKey: string, ctx: ThreadContext): void {
  try {
    mkdirSync(THREAD_CONTEXT_DIR, { recursive: true });
    writeFileSync(threadContextPath(threadKey), JSON.stringify(ctx, null, 2));
    logger.debug(`[ThreadContext] Saved ${threadKey}`);
  } catch (err) {
    logger.error(`[ThreadContext] Failed to save ${threadKey}:`, err);
  }
}

function deleteThreadContext(threadKey: string): boolean {
  const filePath = threadContextPath(threadKey);
  try {
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    logger.debug(`[ThreadContext] Deleted ${threadKey}`);
    return true;
  } catch (err) {
    logger.error(`[ThreadContext] Failed to delete ${threadKey}:`, err);
    return false;
  }
}

/** TTLを過ぎた古いスレッドコンテキストを削除する。 */
function cleanupThreadContexts(): void {
  try {
    if (!existsSync(THREAD_CONTEXT_DIR)) return;
    const now = Date.now();
    let removed = 0;
    for (const file of readdirSync(THREAD_CONTEXT_DIR)) {
      if (!file.endsWith('.json')) continue;
      const filePath = join(THREAD_CONTEXT_DIR, file);
      try {
        if (now - statSync(filePath).mtimeMs > THREAD_TTL_MS) {
          unlinkSync(filePath);
          removed++;
        }
      } catch {
        // 個別ファイルのエラーは無視
      }
    }
    if (removed > 0) logger.info(`[Cleanup] Removed ${removed} stale thread context(s)`);
  } catch (err) {
    logger.error('[Cleanup] Failed:', err);
  }
}

/**
 * 進捗とアシスタントメッセージを1つのメッセージに集約し、
 * 更新を直列化＋スロットルして表示崩れ・レート制限を防ぐライブステータス。
 */
function createLiveStatus(client: App['client'], channelId: string, ts: string | undefined, header: string) {
  const UPDATE_INTERVAL = 1500;
  const progressLines: string[] = [];
  let assistantPreview = '';
  let chain: Promise<unknown> = Promise.resolve();
  let lastUpdate = 0;
  let timer: NodeJS.Timeout | undefined;

  function render(): string {
    const parts = [header];
    if (assistantPreview) parts.push(`\n:speech_balloon: ${assistantPreview}`);
    if (progressLines.length > 0) {
      parts.push(`\n\`\`\`\n${progressLines.slice(-5).join('\n')}\n\`\`\``);
    }
    return parts.join('');
  }

  function flush(): void {
    if (!ts) return;
    lastUpdate = Date.now();
    chain = chain.then(() => client.chat.update({ channel: channelId, ts, text: render() }).catch(() => {}));
  }

  function schedule(): void {
    const elapsed = Date.now() - lastUpdate;
    if (elapsed >= UPDATE_INTERVAL) {
      flush();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        flush();
      }, UPDATE_INTERVAL - elapsed);
    }
  }

  return {
    setProgress(line: string): void {
      progressLines.push(line);
      schedule();
    },
    setAssistant(text: string): void {
      assistantPreview = text.slice(0, 1500);
      schedule();
    },
    async done(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await chain;
    },
  };
}

app.event('app_mention', async ({ event, say, client }) => {
  if (!event.text) return;

  const channelId = event.channel;
  const threadKey = event.thread_ts || event.ts;
  const userId = event.user;

  if (!isChannelAllowed(config, channelId)) {
    logger.debug(`[Skip] Channel ${channelId} is not allowed`);
    return;
  }

  if (!isUserAllowed(config, userId)) {
    logger.debug(`[Skip] User ${userId} is not allowed`);
    await say({ text: 'このボットを使用する権限がありません。', thread_ts: threadKey });
    return;
  }

  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (text === 'repos' || text === 'list') {
    const repoList = Object.entries(config.repos)
      .map(([name, path]) => `• \`${name}\` → ${path}`)
      .join('\n');
    await say({ text: `*設定済みリポジトリ一覧:*\n${repoList || '(なし)'}`, thread_ts: threadKey });
    return;
  }

  if (text === 'help') {
    const mention = botUserId ? `<@${botUserId}>` : '@bot';
    await say({
      text: [
        '*使い方:*',
        `• \`${mention} repo:リポジトリ名\` - セッション開始（タスクは後からでも可）`,
        `• \`${mention} repo:リポジトリ名 タスク\` - セッション開始＋即実行`,
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

  if (text === 'reset') {
    if (deleteThreadContext(threadKey)) {
      await say({
        text: 'セッションをリセットしました。`repo:リポジトリ名` で新しいセッションを開始してください。',
        thread_ts: threadKey,
      });
    } else {
      await say({ text: 'このスレッドにはアクティブなセッションがありません。', thread_ts: threadKey });
    }
    return;
  }

  // 同一スレッドで既に処理中なら並行実行を避ける
  if (busyThreads.has(threadKey)) {
    await say({
      text: ':warning: このスレッドは現在処理中です。完了までお待ちください。',
      thread_ts: threadKey,
    });
    return;
  }

  const existingContext = loadThreadContext(threadKey);
  const { repoName, task } = parseMessage(text);
  logger.debug(`[ParseMessage] repoName=${repoName ?? 'null'}, task="${task}"`);

  let currentRepoName: string;
  let currentRepoPath: string;
  let resumeSessionId: string | undefined;

  if (repoName) {
    const repoPath = getRepoPath(config, repoName);
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
    if (!task) {
      saveThreadContext(threadKey, { repoName: currentRepoName, repoPath: currentRepoPath, sessionId: '' });
      await say({
        text: `セッションを開始しました (repo: \`${currentRepoName}\`)。\nこのスレッドでメンションしてタスクを送ってください。`,
        thread_ts: threadKey,
      });
      return;
    }
  } else if (existingContext) {
    currentRepoName = existingContext.repoName;
    currentRepoPath = existingContext.repoPath;
    resumeSessionId = existingContext.sessionId || undefined;
  } else {
    await say({
      text: '`repo:リポジトリ名` を指定してください。\n例: `repo:my-project このバグを修正して`',
      thread_ts: threadKey,
    });
    return;
  }

  const taskText = repoName ? task : text;

  busyThreads.add(threadKey);
  const statusPrefix = resumeSessionId ? '(継続)' : '(新規)';
  const header = `:hourglass_flowing_sand: ${statusPrefix} Claude Code を実行中... (repo: ${currentRepoName})`;

  const processingMsg = await say({ text: `${header}\n_開始中..._`, thread_ts: threadKey });
  const live = createLiveStatus(client, channelId, processingMsg.ts, header);

  try {
    const result = await runClaude({
      task: taskText,
      repoPath: currentRepoPath,
      config,
      onProgress: (status) => live.setProgress(status),
      onAssistantMessage: (msg) => live.setAssistant(msg),
      resumeSessionId,
      onSpawn: (proc) => {
        runningProcs.add(proc);
        proc.on('close', () => runningProcs.delete(proc));
      },
    });

    await live.done();

    if (processingMsg.ts) {
      await client.chat.delete({ channel: channelId, ts: processingMsg.ts }).catch(() => {});
    }

    if (!result.success) {
      await say({ text: `:x: エラー\n\`\`\`\n${result.error}\n\`\`\``, thread_ts: threadKey });
      return;
    }

    const sessionId = result.sessionId || '';
    saveThreadContext(threadKey, {
      repoName: currentRepoName,
      repoPath: currentRepoPath,
      sessionId,
    });

    const chunks = splitMessage(result.result || '(応答なし)');
    for (const chunk of chunks) {
      await say({ text: chunk, thread_ts: threadKey });
    }

    if (!resumeSessionId) {
      await say({
        text: `_スレッド内で継続可能 | repo: ${currentRepoName}${sessionId ? ` | session: ${sessionId.slice(0, 12)}...` : ''}_`,
        thread_ts: threadKey,
      });
    }
  } catch (err) {
    await live.done().catch(() => {});
    await say({
      text: `:x: 予期しないエラー: ${err instanceof Error ? err.message : String(err)}`,
      thread_ts: threadKey,
    });
  } finally {
    busyThreads.delete(threadKey);
  }
});

let cleanupTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[Shutdown] Received ${signal}, cleaning up...`);

  if (cleanupTimer) clearInterval(cleanupTimer);

  for (const proc of runningProcs) {
    try {
      proc.kill('SIGTERM');
    } catch {
      // 無視
    }
  }

  try {
    await app.stop();
  } catch (err) {
    logger.error('[Shutdown] Error stopping app:', err);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

(async () => {
  await app.start();

  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id ?? '';

  cleanupThreadContexts();
  cleanupTimer = setInterval(cleanupThreadContexts, CLEANUP_INTERVAL_MS);

  logger.info(`Slack Claude Bot is running! (bot user: <@${botUserId}>)`);
  logger.info(`Configured repos: ${Object.keys(config.repos).join(', ') || '(none)'}`);
  logger.info(
    `Allowed channels: ${config.allowedChannels.length > 0 ? config.allowedChannels.join(', ') : '(all)'}`
  );
  logger.info(`Allowed users: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(', ') : '(all)'}`);
})();
