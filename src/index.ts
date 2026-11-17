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
import { parseMessage, splitMessage, formatResumeCommand } from './utils.js';
import {
  shouldHandleDmMessage,
  isDmChannel,
  stripMentions,
  checkDmUser,
  resolveDefaultRepoName,
  type IncomingMessageEvent,
} from './routing.js';
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

const HELP_TEXT = [
  '*使い方（DM）:*',
  '• botとのDMに普通にメッセージを送る（メンション不要）→ 新しい会話を開始して実行',
  '• そのメッセージのスレッドに返信 → 同じセッションで継続',
  '• `repo:リポジトリ名 タスク` - リポジトリを明示して開始（省略時は既定リポジトリ）',
  '• `repos` / `list` - リポジトリ一覧を表示',
  '• `reset` - スレッドのセッションをリセット',
  '• `pc` - このスレッドの会話をPCのターミナルで続けるコマンドを表示',
  '• `help` - このヘルプを表示',
  '• 処理中に送ったメッセージはキューに積まれ、前の処理が終わり次第順に実行されます',
  '',
  '*チャンネルで使う場合:* `@bot メッセージ` のようにメンションします（`repo:` 指定は同様）。',
].join('\n');

type SayFn = (msg: { text: string; thread_ts?: string }) => Promise<{ ts?: string }>;

interface Job {
  text: string;
  channelId: string;
  threadKey: string;
  say: SayFn;
  client: App['client'];
}

// スレッドごとのFIFOキュー（メモリのみ。再起動で消える）
const threadQueues = new Map<string, Job[]>();
let shuttingDown = false;

/**
 * DM・チャンネル共通のメッセージ処理。認可チェックは呼び出し側で済ませておくこと。
 */
async function handleText(job: Job): Promise<void> {
  const { text, threadKey, say } = job;

  if (text === 'repos' || text === 'list') {
    const repoList = Object.entries(config.repos)
      .map(([name, path]) => `• \`${name}\` → ${path}${name === config.defaultRepo ? ' (既定)' : ''}`)
      .join('\n');
    await say({ text: `*設定済みリポジトリ一覧:*\n${repoList || '(なし)'}`, thread_ts: threadKey });
    return;
  }

  if (text === 'help') {
    await say({ text: HELP_TEXT, thread_ts: threadKey });
    return;
  }

  if (text === 'pc' || text === 'resume') {
    const ctx = loadThreadContext(threadKey);
    if (ctx?.sessionId) {
      await say({
        text: `PCで続けるには:\n\`\`\`\n${formatResumeCommand(ctx.repoPath, ctx.sessionId)}\n\`\`\``,
        thread_ts: threadKey,
      });
    } else {
      await say({ text: 'このスレッドにはまだセッションがありません。', thread_ts: threadKey });
    }
    return;
  }

  if (text === 'reset') {
    threadQueues.delete(threadKey);
    if (deleteThreadContext(threadKey)) {
      await say({
        text: 'セッションをリセットしました。新しいメッセージ（または `repo:リポジトリ名 タスク`）で開始できます。',
        thread_ts: threadKey,
      });
    } else {
      await say({ text: 'このスレッドにはアクティブなセッションがありません。', thread_ts: threadKey });
    }
    return;
  }

  // 同一スレッドで処理中なら破棄せずキューに積む
  if (busyThreads.has(threadKey)) {
    const queue = threadQueues.get(threadKey) ?? [];
    queue.push(job);
    threadQueues.set(threadKey, queue);
    await say({
      text: `:inbox_tray: 前の処理が終わったら続けて実行します（待ち ${queue.length} 件）。`,
      thread_ts: threadKey,
    });
    return;
  }

  busyThreads.add(threadKey);
  try {
    let next: Job | undefined = job;
    while (next) {
      await executeJob(next);
      if (shuttingDown) break;
      next = threadQueues.get(threadKey)?.shift();
      if (!next) threadQueues.delete(threadKey);
    }
  } finally {
    busyThreads.delete(threadKey);
  }
}

/** 1件のタスクを実行する（例外は内部で処理し投げない）。busyThreads の管理は呼び出し側。 */
async function executeJob(job: Job): Promise<void> {
  const { text, channelId, threadKey, say, client } = job;
  try {
    // 実行直前に読み直す（キュー待ち中に前の実行でsessionIdが保存されている）
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
          text: `セッションを開始しました (repo: \`${currentRepoName}\`)。\nこのスレッドでタスクを送ってください。`,
          thread_ts: threadKey,
        });
        return;
      }
    } else if (existingContext) {
      currentRepoName = existingContext.repoName;
      currentRepoPath = existingContext.repoPath;
      resumeSessionId = existingContext.sessionId || undefined;
    } else {
      const defaultName = resolveDefaultRepoName(config);
      const defaultPath = defaultName ? getRepoPath(config, defaultName) : null;
      if (!defaultName || !defaultPath) {
        await say({
          text: '`repo:リポジトリ名` を指定してください。\n例: `repo:my-project このバグを修正して`',
          thread_ts: threadKey,
        });
        return;
      }
      currentRepoName = defaultName;
      currentRepoPath = defaultPath;
    }

    const taskText = repoName ? task : text;

    // Claude起動前にrepoを保存（sessionIdは取得次第すぐ更新する）。失敗してもこのスレッドで続けられる
    let savedSessionId = resumeSessionId ?? '';
    saveThreadContext(threadKey, {
      repoName: currentRepoName,
      repoPath: currentRepoPath,
      sessionId: savedSessionId,
    });

    const statusPrefix = resumeSessionId ? '(継続)' : '(新規)';
    const header = `:hourglass_flowing_sand: ${statusPrefix} Claude Code を実行中... (repo: ${currentRepoName})`;

    const processingMsg = await say({ text: `${header}\n_開始中..._`, thread_ts: threadKey });
    const live = createLiveStatus(client, channelId, processingMsg.ts, header);

    const persistSessionId = (id: string) => {
      if (!id || id === savedSessionId) return;
      savedSessionId = id;
      saveThreadContext(threadKey, {
        repoName: currentRepoName,
        repoPath: currentRepoPath,
        sessionId: id,
      });
    };

    try {
      const result = await runClaude({
        task: taskText,
        repoPath: currentRepoPath,
        config,
        onProgress: (status) => live.setProgress(status),
        onAssistantMessage: (msg) => live.setAssistant(msg),
        resumeSessionId,
        onSessionId: persistSessionId,
        onSpawn: (proc) => {
          runningProcs.add(proc);
          proc.on('close', () => runningProcs.delete(proc));
        },
      });

      await live.done();

      if (processingMsg.ts) {
        await client.chat.delete({ channel: channelId, ts: processingMsg.ts }).catch(() => {});
      }

      // resume時に別のsession IDが返ってきたら新しい方で上書き
      if (result.sessionId) persistSessionId(result.sessionId);

      if (!result.success) {
        await say({ text: `:x: エラー\n\`\`\`\n${result.error}\n\`\`\``, thread_ts: threadKey });
        return;
      }

      const chunks = splitMessage(result.result || '(応答なし)');
      for (const chunk of chunks) {
        await say({ text: chunk, thread_ts: threadKey });
      }

      if (!resumeSessionId) {
        const resumeHint = savedSessionId
          ? `\nPCで続けるには:\n\`\`\`\n${formatResumeCommand(currentRepoPath, savedSessionId)}\n\`\`\``
          : '';
        await say({
          text: `_スレッドに返信で継続 | repo: ${currentRepoName}_${resumeHint}`,
          thread_ts: threadKey,
        });
      }
    } catch (err) {
      await live.done().catch(() => {});
      await say({
        text: `:x: 予期しないエラー: ${err instanceof Error ? err.message : String(err)}`,
        thread_ts: threadKey,
      });
    }
  } catch (err) {
    logger.error(`[Job] Unexpected failure in thread ${threadKey}:`, err);
    await say({
      text: `:x: 予期しないエラー: ${err instanceof Error ? err.message : String(err)}`,
      thread_ts: threadKey,
    }).catch(() => {});
  }
}

// チャンネルでのメンション（互換）
app.event('app_mention', async ({ event, say, client }) => {
  if (!event.text) return;

  const channelId = event.channel;
  // DM内のメンションは message イベント側で処理する（二重実行防止）
  if (isDmChannel(channelId, (event as { channel_type?: string }).channel_type)) return;

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

  await handleText({ text: stripMentions(event.text), channelId, threadKey, say, client });
});

// botとのDM（メンション不要）
app.event('message', async ({ event, say, client }) => {
  const ev = event as unknown as IncomingMessageEvent & { channel: string; ts: string; thread_ts?: string };
  if (!shouldHandleDmMessage(ev, botUserId)) return;

  const threadKey = ev.thread_ts || ev.ts;
  const userId = ev.user as string;

  const auth = checkDmUser(config, userId);
  if (auth === 'unconfigured') {
    await say({
      text: `DMを使うには config.json の allowedUsers に次のIDを追加してください: \`${userId}\``,
      thread_ts: threadKey,
    });
    return;
  }
  if (auth === 'denied') {
    logger.debug(`[Skip] DM user ${userId} is not allowed`);
    await say({ text: 'このボットを使用する権限がありません。', thread_ts: threadKey });
    return;
  }

  const text = stripMentions(ev.text as string);
  if (!text) return;
  await handleText({ text, channelId: ev.channel, threadKey, say: say as SayFn, client });
});

let cleanupTimer: NodeJS.Timeout | undefined;

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
  logger.info(
    `Allowed users: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(', ') : '(none: チャンネルは全員許可 / DMは無効)'}`
  );
})();
