import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { expandPath, parseMessage, splitMessage, formatResumeCommand, toSlackMrkdwn } from '../src/utils.js';

describe('expandPath', () => {
  it('展開: ~ をホームに', () => {
    expect(expandPath('~')).toBe(homedir());
  });

  it('展開: ~/ 始まりをホーム配下に', () => {
    expect(expandPath('~/works/repo')).toBe(join(homedir(), 'works/repo'));
  });

  it('絶対パスはそのまま', () => {
    expect(expandPath('/Users/me/repo')).toBe('/Users/me/repo');
  });

  it('~ を含んでも先頭でなければ展開しない', () => {
    expect(expandPath('/path/~/x')).toBe('/path/~/x');
  });
});

describe('parseMessage', () => {
  it('repo:名 タスク を分解', () => {
    expect(parseMessage('repo:my-project バグを直して')).toEqual({
      repoName: 'my-project',
      task: 'バグを直して',
    });
  });

  it('コロン後の空白を許容', () => {
    expect(parseMessage('repo: my-project  タスク')).toEqual({
      repoName: 'my-project',
      task: 'タスク',
    });
  });

  it('タスクなしの repo 指定', () => {
    expect(parseMessage('repo:my-project')).toEqual({ repoName: 'my-project', task: '' });
  });

  it('repo 指定なしは全文をタスクに', () => {
    expect(parseMessage('似たバグを探して')).toEqual({ repoName: null, task: '似たバグを探して' });
  });

  it('複数行タスクを保持', () => {
    const r = parseMessage('repo:x 行1\n行2');
    expect(r.repoName).toBe('x');
    expect(r.task).toBe('行1\n行2');
  });
});

describe('splitMessage', () => {
  it('短いテキストはそのまま1チャンク', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('空文字は空配列', () => {
    expect(splitMessage('')).toEqual([]);
  });

  it('maxLength を超えないよう分割', () => {
    const text = 'a\n'.repeat(3000); // 6000文字
    const chunks = splitMessage(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1000);
    }
  });

  it('全チャンクを結合すると内容が保たれる（空白除去後）', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const chunks = splitMessage(text, 200);
    const rejoined = chunks.join('\n').replace(/\s+/g, ' ').trim();
    const original = text.replace(/\s+/g, ' ').trim();
    expect(rejoined).toBe(original);
  });

  it('コードブロックの途中で切れる場合はフェンスを閉じ、次で開き直す', () => {
    const code = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`).join('\n');
    const text = '```ts\n' + code + '\n```';
    const chunks = splitMessage(text, 300);
    expect(chunks.length).toBeGreaterThan(1);
    // 各チャンクでフェンス（```）の数が偶数（=閉じている）であること
    for (const c of chunks) {
      const fences = (c.match(/```/g) || []).length;
      expect(fences % 2).toBe(0);
    }
    // 中間チャンクは言語付きフェンスで開き直している
    expect(chunks[1].startsWith('```ts')).toBe(true);
  });
});

describe('formatResumeCommand', () => {
  it('通常のパスはそのまま使う', () => {
    expect(formatResumeCommand('/Users/x/works/ob-ops-base', 'abc-123')).toBe(
      'cd /Users/x/works/ob-ops-base && claude --resume abc-123'
    );
  });
  it('空白やクォートを含むパスはシングルクォートで囲む', () => {
    expect(formatResumeCommand("/Users/x/my repo's", 'id')).toBe(
      "cd '/Users/x/my repo'\\''s' && claude --resume id"
    );
  });
});

describe('toSlackMrkdwn', () => {
  it('太字・見出し・リンクをSlack記法にする', () => {
    expect(toSlackMrkdwn('**重要** です')).toBe('*重要* です');
    expect(toSlackMrkdwn('## 決定事項')).toBe('*決定事項*');
    expect(toSlackMrkdwn('## **太字の見出し**')).toBe('*太字の見出し*');
    expect(toSlackMrkdwn('[公式](https://example.com/a)')).toBe('<https://example.com/a|公式>');
  });
  it('コードブロックとインラインコードの中は変換しない', () => {
    const src = '`**x**` と\n```\n## not heading\n**y**\n```';
    expect(toSlackMrkdwn(src)).toBe(src);
  });
  it('snake_case や __dunder__ は壊さない', () => {
    expect(toSlackMrkdwn('go_to_market.md と __init__')).toBe('go_to_market.md と __init__');
  });
});
