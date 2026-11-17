import { describe, it, expect } from 'vitest';
import {
  shouldHandleDmMessage,
  isDmChannel,
  stripMentions,
  checkDmUser,
  resolveDefaultRepoName,
} from '../src/routing.js';
import type { Config } from '../src/config.js';

const cfg = (over: Partial<Config> = {}): Config => ({
  allowedChannels: [],
  allowedUsers: [],
  repos: { a: '/a' },
  maxTurns: 50,
  timeoutMs: 1,
  allowedTools: [],
  skipPermissions: true,
  ...over,
});

const dm = { channel_type: 'im', user: 'U1', text: 'hello' };

describe('shouldHandleDmMessage', () => {
  it('通常のDMは対象', () => {
    expect(shouldHandleDmMessage(dm, 'UBOT')).toBe(true);
  });
  it('file_share は本文があれば対象', () => {
    expect(shouldHandleDmMessage({ ...dm, subtype: 'file_share' }, 'UBOT')).toBe(true);
  });
  it('他の subtype は除外', () => {
    for (const subtype of ['message_changed', 'message_deleted', 'bot_message', 'channel_join']) {
      expect(shouldHandleDmMessage({ ...dm, subtype }, 'UBOT')).toBe(false);
    }
  });
  it('bot_id・bot自身・本文空・user無しは除外', () => {
    expect(shouldHandleDmMessage({ ...dm, bot_id: 'B1' }, 'UBOT')).toBe(false);
    expect(shouldHandleDmMessage({ ...dm, user: 'UBOT' }, 'UBOT')).toBe(false);
    expect(shouldHandleDmMessage({ ...dm, text: '  ' }, 'UBOT')).toBe(false);
    expect(shouldHandleDmMessage({ ...dm, text: undefined }, 'UBOT')).toBe(false);
    expect(shouldHandleDmMessage({ ...dm, user: undefined }, 'UBOT')).toBe(false);
  });
  it('DM以外のチャンネルは除外', () => {
    expect(shouldHandleDmMessage({ ...dm, channel_type: 'channel' }, 'UBOT')).toBe(false);
  });
});

describe('isDmChannel / stripMentions', () => {
  it('imまたはD始まりをDMと判定', () => {
    expect(isDmChannel('D123', undefined)).toBe(true);
    expect(isDmChannel('C123', 'im')).toBe(true);
    expect(isDmChannel('C123', 'channel')).toBe(false);
  });
  it('メンションを除去', () => {
    expect(stripMentions('<@UBOT> repo:a hi')).toBe('repo:a hi');
  });
});

describe('checkDmUser', () => {
  it('allowedUsers が空なら unconfigured', () => {
    expect(checkDmUser(cfg(), 'U1')).toBe('unconfigured');
  });
  it('含まれれば allowed、含まれなければ denied', () => {
    expect(checkDmUser(cfg({ allowedUsers: ['U1'] }), 'U1')).toBe('allowed');
    expect(checkDmUser(cfg({ allowedUsers: ['U1'] }), 'U2')).toBe('denied');
    expect(checkDmUser(cfg({ allowedUsers: ['U1'] }), undefined)).toBe('denied');
  });
});

describe('resolveDefaultRepoName', () => {
  it('defaultRepo を優先', () => {
    expect(resolveDefaultRepoName(cfg({ repos: { a: '/a', b: '/b' }, defaultRepo: 'b' }))).toBe('b');
  });
  it('1件だけならその1件', () => {
    expect(resolveDefaultRepoName(cfg())).toBe('a');
  });
  it('複数かつ defaultRepo 無しなら null', () => {
    expect(resolveDefaultRepoName(cfg({ repos: { a: '/a', b: '/b' } }))).toBeNull();
  });
});
