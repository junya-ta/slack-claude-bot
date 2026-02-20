import { spawn } from 'child_process';
import { config } from './config.js';

interface ClaudeResult {
  success: boolean;
  result?: string;
  sessionId?: string;
  error?: string;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  result?: string;
  message?: {
    type: string;
    content?: Array<{ type: string; text?: string }>;
  };
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
}

export interface ProgressCallback {
  (status: string): void;
}

export async function runClaude(
  task: string,
  repoPath: string,
  onProgress?: ProgressCallback
): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const args = [
      '-p', task,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--max-turns', String(config.maxTurns),
    ];

    console.log(`[Claude] Running in ${repoPath}`);
    console.log(`[Claude] Task: ${task}`);
    console.log(`[Claude] Args: ${args.join(' ')}`);

    const proc = spawn('claude', args, {
      cwd: repoPath,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    console.log(`[Claude] Process spawned, PID: ${proc.pid}`);

    let lastResult = '';
    let sessionId = '';
    let buffer = '';
    let turnCount = 0;

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      console.log(`[Claude][stdout] ${chunk.slice(0, 200)}`);
      buffer += chunk;

      // 改行で分割して各JSONを処理
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 最後の不完全な行を保持

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event: StreamEvent = JSON.parse(line);

          // セッションID取得
          if (event.session_id) {
            sessionId = event.session_id;
          }

          // ツール使用を検知
          if (event.type === 'tool_use') {
            turnCount++;
            const toolName = event.tool_name || 'unknown';
            let detail = '';

            if (event.tool_input) {
              if (toolName === 'Read' && event.tool_input.file_path) {
                detail = ` → ${event.tool_input.file_path}`;
              } else if (toolName === 'Grep' && event.tool_input.pattern) {
                detail = ` → "${event.tool_input.pattern}"`;
              } else if (toolName === 'Glob' && event.tool_input.pattern) {
                detail = ` → ${event.tool_input.pattern}`;
              } else if (toolName === 'Edit' && event.tool_input.file_path) {
                detail = ` → ${event.tool_input.file_path}`;
              } else if (toolName === 'Bash' && event.tool_input.command) {
                const cmd = String(event.tool_input.command);
                detail = ` → ${cmd.slice(0, 50)}${cmd.length > 50 ? '...' : ''}`;
              }
            }

            const status = `[${turnCount}/${config.maxTurns}] ${toolName}${detail}`;
            console.log(`[Claude] ${status}`);
            onProgress?.(status);
          }

          // アシスタントメッセージ
          if (event.type === 'assistant' && event.message?.content) {
            const textContent = event.message.content
              .filter(c => c.type === 'text' && c.text)
              .map(c => c.text)
              .join('\n');
            if (textContent) {
              lastResult = textContent;
            }
          }

          // result イベント（最終結果）
          if (event.type === 'result' && event.result) {
            lastResult = event.result;
          }

        } catch {
          // JSON解析失敗は無視
        }
      }
    });

    let stderr = '';
    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      console.log(`[Claude][stderr] ${chunk}`);
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        success: false,
        error: `Timeout after ${config.timeoutMs / 1000} seconds`,
      });
    }, config.timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);

      // 残りのバッファを処理
      if (buffer.trim()) {
        try {
          const event: StreamEvent = JSON.parse(buffer);
          if (event.type === 'result' && event.result) {
            lastResult = event.result;
          }
          if (event.session_id) {
            sessionId = event.session_id;
          }
        } catch {
          // 無視
        }
      }

      if (code !== 0 && !lastResult) {
        resolve({
          success: false,
          error: stderr || `Exit code: ${code}`,
        });
        return;
      }

      resolve({
        success: true,
        result: lastResult || '(応答なし)',
        sessionId,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        error: `Process error: ${err.message}`,
      });
    });
  });
}
