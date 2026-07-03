import { homedir } from 'os';
import { join } from 'path';

/**
 * 先頭の `~` をホームディレクトリに展開する。
 */
export function expandPath(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export interface ParsedMessage {
  repoName: string | null;
  task: string;
}

/**
 * `repo:name タスク` 形式のメッセージからリポジトリ名とタスクを抽出する。
 * `repo:` 指定がなければ repoName は null で、全文をタスクとして返す。
 */
export function parseMessage(text: string): ParsedMessage {
  const match = text.match(/^repo:\s*(\S+)(?:\s+([\s\S]+))?$/);
  if (match) {
    return { repoName: match[1], task: (match[2] ?? '').trim() };
  }
  return { repoName: null, task: text };
}

const FENCE = '```';

/**
 * 長いテキストを maxLength 以下のチャンクに分割する。
 * 分割位置がコードフェンス（```）の内側になる場合は、
 * チャンク末尾でフェンスを閉じ、次チャンク先頭で開き直して
 * Slack上のマークダウン表示が崩れないようにする。
 */
export function splitMessage(text: string, maxLength = 3900): string[] {
  if (text.length <= maxLength) {
    return text.length > 0 ? [text] : [];
  }

  const chunks: string[] = [];
  let remaining = text;
  let carriedFence: string | null = null; // 前チャンクから引き継いだ未クローズのフェンス言語

  while (remaining.length > 0) {
    const prefix = carriedFence !== null ? `${FENCE}${carriedFence}\n` : '';
    const budget = maxLength - prefix.length;

    if (prefix.length + remaining.length <= maxLength) {
      chunks.push(prefix + remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf('\n', budget);
    if (splitIndex === -1 || splitIndex < budget / 2) {
      splitIndex = budget;
    }

    let body = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex).replace(/^\n/, '');

    const combined = prefix + body;
    const openFence = detectOpenFence(combined);

    if (openFence !== null) {
      // コードブロックの途中で切れるので、明示的に閉じる
      chunks.push(`${combined}\n${FENCE}`);
      carriedFence = openFence;
    } else {
      chunks.push(combined);
      carriedFence = null;
    }
  }

  return chunks;
}

/**
 * テキスト内でコードフェンスが開いたままかどうかを判定する。
 * 開いたままなら、その言語指定（無ければ空文字列）を返す。閉じていれば null。
 */
function detectOpenFence(text: string): string | null {
  const lines = text.split('\n');
  let openLang: string | null = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(FENCE)) {
      if (openLang === null) {
        openLang = trimmed.slice(FENCE.length).trim();
      } else {
        openLang = null;
      }
    }
  }
  return openLang;
}
