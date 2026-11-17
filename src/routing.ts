import type { Config } from './config.js';

/** Slack の message イベントのうち、判定に使う最小限のフィールド */
export interface IncomingMessageEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel_type?: string;
}

/**
 * DMの message イベントを処理対象にするか判定する。
 * subtype 付き（編集・削除・bot_message・join等）は除外。ただし file_share は本文があれば対象。
 */
export function shouldHandleDmMessage(event: IncomingMessageEvent, botUserId: string): boolean {
  if (event.channel_type !== 'im') return false;
  if (event.subtype && event.subtype !== 'file_share') return false;
  if (event.bot_id) return false;
  if (!event.user) return false;
  if (botUserId && event.user === botUserId) return false;
  if (!event.text || event.text.trim().length === 0) return false;
  return true;
}

/** app_mention がDM内のものか（message イベント側で処理されるため無視する） */
export function isDmChannel(channelId: string, channelType?: string): boolean {
  return channelType === 'im' || channelId.startsWith('D');
}

/** メンション文字列 `<@...>` を除去して trim する */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

/**
 * DM経路の送信者チェック。allowedUsers が空なら誰も許可しない。
 */
export type DmAuth = 'allowed' | 'unconfigured' | 'denied';
export function checkDmUser(cfg: Config, userId: string | undefined): DmAuth {
  if (cfg.allowedUsers.length === 0) return 'unconfigured';
  if (!userId || !cfg.allowedUsers.includes(userId)) return 'denied';
  return 'allowed';
}

/**
 * 新しい会話で使うリポジトリ名を決める。
 * 明示指定 > defaultRepo > repos が1件ならその1件 > null（指定を促す）
 */
export function resolveDefaultRepoName(cfg: Config): string | null {
  if (cfg.defaultRepo && cfg.repos[cfg.defaultRepo]) return cfg.defaultRepo;
  const names = Object.keys(cfg.repos);
  if (names.length === 1) return names[0];
  return null;
}
