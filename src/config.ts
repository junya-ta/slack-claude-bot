import { readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export function expandPath(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Config {
  allowedChannels: string[];
  repos: Record<string, string>;
  maxTurns: number;
  timeoutMs: number;
  allowedTools: string[];
}

const configPath = join(__dirname, '..', 'config.json');
export const config: Config = JSON.parse(readFileSync(configPath, 'utf-8'));

export function getRepoPath(repoName: string): string | null {
  const path = config.repos[repoName];
  if (!path) return null;
  return expandPath(path);
}

export function isChannelAllowed(channelId: string): boolean {
  // 空の場合は全チャンネル許可
  if (config.allowedChannels.length === 0) return true;
  return config.allowedChannels.includes(channelId);
}
