import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { sanitizeChildEnv } from './claude.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const URL_POLL_ATTEMPTS = 20;
const URL_POLL_INTERVAL_MS = 1000;

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
    await execFileAsync('tmux', ['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** capture-pane からURLを取り直す。取れなければ null。 */
export async function captureRemoteUrl(name: string): Promise<string | null> {
  try {
    // 折り返しでURLが分断されないよう -J で行結合
    const { stdout } = await execFileAsync('tmux', ['capture-pane', '-p', '-J', '-t', `=${name}:`]);
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
    await execFileAsync('tmux', ['kill-session', '-t', `=${name}`]);
    return true;
  } catch (err) {
    logger.error(`[PcSession] kill-session failed for ${name}:`, err);
    return false;
  }
}
