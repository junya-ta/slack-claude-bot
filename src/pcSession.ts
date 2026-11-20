import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { sanitizeChildEnv } from './claude.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const URL_POLL_ATTEMPTS = 20;

/**
 * bot専用のtmuxソケット名。ユーザが別の環境（Claude Codeのセッション内など）で起動したtmuxサーバの
 * 環境変数を新しいセッションが引き継がないよう、サーバを分ける。
 */
export const TMUX_SOCKET = 'slack-claude-bot';
const T = ['-L', TMUX_SOCKET];
const URL_POLL_INTERVAL_MS = 1000;

/** 手元のターミナルからセッションを覗くコマンド。 */
export function tmuxAttachCommand(name: string): string {
  return `tmux -L ${TMUX_SOCKET} attach -t ${name}`;
}

/** スレッドごとに一意なtmuxセッション名。tmuxの名前に使えない `.` `:` は `-` にする。 */
export function pcSessionName(threadKey: string): string {
  return `scb-${threadKey.replace(/[.:]/g, '-')}`;
}

/** シェル文字列に埋め込むための単一引用符クォート。安全な文字だけならそのまま返す。 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./~@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface PcClaudeOptions {
  sessionId: string;
  skipPermissions: boolean;
}

/** tmuxにシェルコマンドとして渡す claude 起動コマンド。 */
export function buildClaudeShellCommand({ sessionId, skipPermissions }: PcClaudeOptions): string {
  const parts = ['claude', '--resume', shellQuote(sessionId), '--remote-control'];
  if (skipPermissions) parts.push('--dangerously-skip-permissions');
  return parts.join(' ');
}

/** `tmux new-session` の引数配列（execFile用）。 */
export function buildTmuxNewSessionArgs(name: string, repoPath: string, opts: PcClaudeOptions): string[] {
  return [
    ...T,
    'new-session',
    '-d',
    '-s',
    name,
    '-x',
    '200',
    '-y',
    '50',
    '-c',
    repoPath,
    buildClaudeShellCommand(opts),
  ];
}

/** capture-pane の出力から Remote Control のセッションURLを抽出する。無ければ null。 */
export function extractRemoteUrl(text: string): string | null {
  const m = text.match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

/** tmuxセッションが存在するか。tmux未インストール・サーバ未起動は false。 */
export async function hasPcSession(name: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', [...T, 'has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** capture-pane からURLを取り直す。取れなければ null。 */
export async function captureRemoteUrl(name: string): Promise<string | null> {
  try {
    // 折り返しでURLが分断されないよう -J で行結合
    const { stdout } = await execFileAsync('tmux', [...T, 'capture-pane', '-p', '-J', '-t', `=${name}:`]);
    return extractRemoteUrl(stdout);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** URLが出るまで最大 attempts 回、1秒間隔で待つ。 */
export async function waitForRemoteUrl(
  name: string,
  attempts = URL_POLL_ATTEMPTS,
  intervalMs = URL_POLL_INTERVAL_MS
): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    const url = await captureRemoteUrl(name);
    if (url) return url;
    if (!(await hasPcSession(name))) return null; // 起動直後に終了した
  }
  return null;
}

/** tmuxセッションを起動する。失敗時は例外（tmux無し等）。環境はサニタイズして渡す。 */
export function startPcSession(
  name: string,
  repoPath: string,
  opts: PcClaudeOptions,
  baseEnv: NodeJS.ProcessEnv = process.env
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tmux', buildTmuxNewSessionArgs(name, repoPath, opts), {
      cwd: repoPath,
      env: sanitizeChildEnv(baseEnv),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tmux new-session exited with ${code}: ${stderr.trim()}`));
    });
  });
}

/** tmuxセッションを終了する。存在して kill できたら true。 */
export async function stopPcSession(name: string): Promise<boolean> {
  if (!(await hasPcSession(name))) return false;
  try {
    await execFileAsync('tmux', [...T, 'kill-session', '-t', `=${name}`]);
    return true;
  } catch (err) {
    logger.error(`[PcSession] kill-session failed for ${name}:`, err);
    return false;
  }
}

export interface PcSessionInfo {
  name: string;
  threadKey: string;
  createdAt: Date;
  channelId?: string;
}

/** `scb-1794901909-809699` → `1794901909.809699`（pcSessionName の逆変換）。scb- 以外は null。 */
export function threadKeyFromSessionName(name: string): string | null {
  const m = name.match(/^scb-(\d+)-(\d+)$/);
  return m ? `${m[1]}.${m[2]}` : null;
}

// tmuxは -F の出力中のタブ等の制御文字を _ に置き換えるので、区切りは | にする
const LIST_FORMAT = '#{session_name}|#{session_created}|#{@scb_channel}';

/** `tmux list-sessions -F LIST_FORMAT` の出力を解釈する。bot以外の名前は除外。 */
export function parseSessionList(stdout: string): PcSessionInfo[] {
  const result: PcSessionInfo[] = [];
  for (const line of stdout.split('\n')) {
    const [name, created, channelId] = line.split('|');
    const threadKey = name ? threadKeyFromSessionName(name) : null;
    if (!name || !threadKey) continue;
    result.push({
      name,
      threadKey,
      createdAt: new Date(Number(created) * 1000),
      ...(channelId ? { channelId } : {}),
    });
  }
  return result;
}

/** 起動中のPCセッション一覧（古い順）。tmux未インストール・サーバ未起動は空配列。 */
export async function listPcSessions(): Promise<PcSessionInfo[]> {
  try {
    const { stdout } = await execFileAsync('tmux', [...T, 'list-sessions', '-F', LIST_FORMAT]);
    return parseSessionList(stdout).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  } catch {
    return [];
  }
}

/** 起動したスレッドのチャンネルをtmuxのユーザーオプションに記録する（一覧でスレッドへのリンクを出すため）。 */
export async function tagPcSessionChannel(name: string, channelId: string): Promise<void> {
  try {
    await execFileAsync('tmux', [...T, 'set-option', '-t', `=${name}:`, '@scb_channel', channelId]);
  } catch (err) {
    logger.warn(`[PcSession] set-option failed for ${name}:`, err);
  }
}

/** 起動中のPCセッションをすべて閉じる。閉じた数を返す。 */
export async function stopAllPcSessions(): Promise<number> {
  let count = 0;
  for (const s of await listPcSessions()) {
    if (await stopPcSession(s.name)) count++;
  }
  return count;
}
