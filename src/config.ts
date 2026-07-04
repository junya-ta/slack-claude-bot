import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { expandPath } from './utils.js';

export { expandPath };

export interface Config {
  allowedChannels: string[];
  allowedUsers: string[];
  repos: Record<string, string>;
  maxTurns: number;
  timeoutMs: number;
  allowedTools: string[];
  skipPermissions: boolean;
}

const DEFAULT_CONFIG: Omit<Config, 'repos'> = {
  allowedChannels: [],
  allowedUsers: [],
  maxTurns: 10,
  timeoutMs: 600_000,
  allowedTools: ['Read', 'Bash', 'Edit', 'Write', 'Glob', 'Grep'],
  skipPermissions: true,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, '..', 'config.json');

/**
 * config.json を読み込み、検証・デフォルト値の補完を行う。
 * 不正な場合は分かりやすいメッセージで例外を投げる。
 */
export function loadConfig(path: string = configPath): Config {
  if (!existsSync(path)) {
    throw new Error(
      `設定ファイルが見つかりません: ${path}\n` +
        '`cp config.json.example config.json` を実行して作成してください。'
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`config.json のJSON解析に失敗しました: ${(err as Error).message}`);
  }

  return validateConfig(raw);
}

export function validateConfig(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config.json はオブジェクトである必要があります。');
  }
  const obj = raw as Record<string, unknown>;

  const repos = obj.repos;
  if (typeof repos !== 'object' || repos === null || Array.isArray(repos)) {
    throw new Error('config.json の `repos` は { 名前: パス } 形式のオブジェクトである必要があります。');
  }
  const repoEntries = Object.entries(repos);
  for (const [name, p] of repoEntries) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error(`config.json の repos["${name}"] は空でない文字列である必要があります。`);
    }
  }

  return {
    allowedChannels: asStringArray(obj.allowedChannels, 'allowedChannels', DEFAULT_CONFIG.allowedChannels),
    allowedUsers: asStringArray(obj.allowedUsers, 'allowedUsers', DEFAULT_CONFIG.allowedUsers),
    repos: Object.fromEntries(repoEntries as [string, string][]),
    maxTurns: asPositiveInt(obj.maxTurns, 'maxTurns', DEFAULT_CONFIG.maxTurns),
    timeoutMs: asPositiveInt(obj.timeoutMs, 'timeoutMs', DEFAULT_CONFIG.timeoutMs),
    allowedTools: asStringArray(obj.allowedTools, 'allowedTools', DEFAULT_CONFIG.allowedTools),
    skipPermissions:
      typeof obj.skipPermissions === 'boolean' ? obj.skipPermissions : DEFAULT_CONFIG.skipPermissions,
  };
}

function asStringArray(value: unknown, key: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`config.json の \`${key}\` は文字列の配列である必要があります。`);
  }
  return value as string[];
}

function asPositiveInt(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`config.json の \`${key}\` は正の数である必要があります。`);
  }
  return value;
}

/**
 * 起動に必須の環境変数が揃っているか検証する。
 */
export function requireEnv(env: NodeJS.ProcessEnv = process.env): {
  botToken: string;
  appToken: string;
} {
  const missing: string[] = [];
  const botToken = env.SLACK_BOT_TOKEN;
  const appToken = env.SLACK_APP_TOKEN;
  if (!botToken) missing.push('SLACK_BOT_TOKEN');
  if (!appToken) missing.push('SLACK_APP_TOKEN');
  if (missing.length > 0) {
    throw new Error(
      `必須の環境変数が設定されていません: ${missing.join(', ')}\n` +
        '`.env` ファイル（`.env.example` を参照）に設定してください。'
    );
  }
  return { botToken: botToken!, appToken: appToken! };
}

export function getRepoPath(cfg: Config, repoName: string): string | null {
  const path = cfg.repos[repoName];
  if (!path) return null;
  return expandPath(path);
}

export function isChannelAllowed(cfg: Config, channelId: string): boolean {
  if (cfg.allowedChannels.length === 0) return true;
  return cfg.allowedChannels.includes(channelId);
}

export function isUserAllowed(cfg: Config, userId: string | undefined): boolean {
  if (cfg.allowedUsers.length === 0) return true;
  if (!userId) return false;
  return cfg.allowedUsers.includes(userId);
}
