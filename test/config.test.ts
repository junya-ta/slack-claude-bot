import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  requireEnv,
  getRepoPath,
  isChannelAllowed,
  isUserAllowed,
  type Config,
} from '../src/config.js';

const baseRaw = { repos: { app: '/path/app' } };

describe('validateConfig', () => {
  it('最小構成でデフォルト値を補完する', () => {
    const cfg = validateConfig(baseRaw);
    expect(cfg.maxTurns).toBe(10);
    expect(cfg.timeoutMs).toBe(600_000);
    expect(cfg.allowedChannels).toEqual([]);
    expect(cfg.allowedUsers).toEqual([]);
    expect(cfg.allowedTools).toContain('Read');
    expect(cfg.skipPermissions).toBe(true);
  });

  it('repos が無いと例外', () => {
    expect(() => validateConfig({})).toThrow(/repos/);
  });

  it('repos の値が空文字だと例外', () => {
    expect(() => validateConfig({ repos: { app: '' } })).toThrow(/repos/);
  });

  it('maxTurns が負だと例外', () => {
    expect(() => validateConfig({ ...baseRaw, maxTurns: -1 })).toThrow(/maxTurns/);
  });

  it('allowedChannels が文字列配列でないと例外', () => {
    expect(() => validateConfig({ ...baseRaw, allowedChannels: [1, 2] })).toThrow(/allowedChannels/);
  });

  it('非オブジェクトは例外', () => {
    expect(() => validateConfig(null)).toThrow();
    expect(() => validateConfig('x')).toThrow();
  });
});

describe('requireEnv', () => {
  it('両トークンがあれば返す', () => {
    expect(requireEnv({ SLACK_BOT_TOKEN: 'xoxb', SLACK_APP_TOKEN: 'xapp' })).toEqual({
      botToken: 'xoxb',
      appToken: 'xapp',
    });
  });

  it('欠けていると欠落名を含む例外', () => {
    expect(() => requireEnv({})).toThrow(/SLACK_BOT_TOKEN.*SLACK_APP_TOKEN/);
    expect(() => requireEnv({ SLACK_BOT_TOKEN: 'x' })).toThrow(/SLACK_APP_TOKEN/);
  });
});

describe('access helpers', () => {
  const cfg: Config = validateConfig({
    repos: { app: '~/app' },
    allowedChannels: ['C1'],
    allowedUsers: ['U1'],
  });

  it('getRepoPath は存在すれば展開して返す', () => {
    expect(getRepoPath(cfg, 'app')).toMatch(/\/app$/);
    expect(getRepoPath(cfg, 'missing')).toBeNull();
  });

  it('isChannelAllowed は許可リストに従う', () => {
    expect(isChannelAllowed(cfg, 'C1')).toBe(true);
    expect(isChannelAllowed(cfg, 'C2')).toBe(false);
  });

  it('allowedChannels 空なら全許可', () => {
    const open = validateConfig(baseRaw);
    expect(isChannelAllowed(open, 'anything')).toBe(true);
  });

  it('isUserAllowed は許可リストに従う', () => {
    expect(isUserAllowed(cfg, 'U1')).toBe(true);
    expect(isUserAllowed(cfg, 'U2')).toBe(false);
    expect(isUserAllowed(cfg, undefined)).toBe(false);
  });

  it('allowedUsers 空なら全許可', () => {
    const open = validateConfig(baseRaw);
    expect(isUserAllowed(open, undefined)).toBe(true);
  });
});
