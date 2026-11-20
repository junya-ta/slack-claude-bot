import { describe, it, expect } from 'vitest';
import {
  pcSessionName,
  shellQuote,
  buildClaudeShellCommand,
  buildTmuxNewSessionArgs,
  extractRemoteUrl,
} from '../src/pcSession.js';

describe('pcSessionName', () => {
  it('thread_ts の . を - にする', () => {
    expect(pcSessionName('1700000000.123456')).toBe('scb-1700000000-123456');
  });
  it(': も置換する', () => {
    expect(pcSessionName('a:b.c')).toBe('scb-a-b-c');
  });
});

describe('shellQuote', () => {
  it('安全な文字列はそのまま', () => {
    expect(shellQuote('/Users/me/repo')).toBe('/Users/me/repo');
  });
  it('空白を含めばクォート', () => {
    expect(shellQuote('/a b/c')).toBe(`'/a b/c'`);
  });
  it('単一引用符をエスケープ', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });
});

describe('buildClaudeShellCommand', () => {
  it('skipPermissions true で付与', () => {
    expect(buildClaudeShellCommand({ sessionId: 'abc-123', skipPermissions: true })).toBe(
      'claude --resume abc-123 --remote-control --dangerously-skip-permissions'
    );
  });
  it('skipPermissions false で付けない', () => {
    expect(buildClaudeShellCommand({ sessionId: 'abc-123', skipPermissions: false })).toBe(
      'claude --resume abc-123 --remote-control'
    );
  });
  it('sessionId をクォートする', () => {
    expect(buildClaudeShellCommand({ sessionId: 'x; rm -rf /', skipPermissions: false })).toContain(
      `'x; rm -rf /'`
    );
  });
});

describe('buildTmuxNewSessionArgs', () => {
  it('引数配列を組み立てる', () => {
    expect(
      buildTmuxNewSessionArgs('scb-1-2', '/my repo', { sessionId: 'sid', skipPermissions: false })
    ).toEqual([
      'new-session',
      '-d',
      '-s',
      'scb-1-2',
      '-x',
      '200',
      '-y',
      '50',
      '-c',
      '/my repo',
      'claude --resume sid --remote-control',
    ]);
  });
});

describe('extractRemoteUrl', () => {
  it('capture-pane 出力からURLを抽出', () => {
    const text =
      '/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_01Vo3J2gornkSTAWzXgTSjcy\n> ';
    expect(extractRemoteUrl(text)).toBe('https://claude.ai/code/session_01Vo3J2gornkSTAWzXgTSjcy');
  });
  it('無ければ null', () => {
    expect(extractRemoteUrl('hello')).toBeNull();
  });
});
