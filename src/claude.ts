import { spawn, type ChildProcess } from 'child_process';
import type { Config } from './config.js';
import { expandPath } from './utils.js';
import { logger } from './logger.js';

export interface ClaudeResult {
  success: boolean;
  result?: string;
  sessionId?: string;
  error?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  result?: string;
  message?: {
    type: string;
    content?: ContentBlock[];
  };
  session_id?: string;
}

export interface ProgressCallback {
  (status: string): void;
}

export interface AssistantMessageCallback {
  (text: string): void;
}

export interface RunClaudeOptions {
  task: string;
  repoPath: string;
  config: Config;
  onProgress?: ProgressCallback;
  onAssistantMessage?: AssistantMessageCallback;
  resumeSessionId?: string;
  /** 起動された子プロセスを受け取るコールバック（graceful shutdown 用） */
  onSpawn?: (proc: ChildProcess) => void;
}

/**
 * ツール使用ブロックから進捗表示用の詳細文字列を組み立てる。
 */
function toolDetail(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  if ((name === 'Read' || name === 'Edit' || name === 'Write') && typeof input.file_path === 'string') {
    return ` → ${input.file_path}`;
  }
  if ((name === 'Grep' || name === 'Glob') && typeof input.pattern === 'string') {
    return ` → ${name === 'Grep' ? `"${input.pattern}"` : input.pattern}`;
  }
  if (name === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command;
    return ` → ${cmd.slice(0, 50)}${cmd.length > 50 ? '...' : ''}`;
  }
  return '';
}

export async function runClaude(options: RunClaudeOptions): Promise<ClaudeResult> {
  const { task, repoPath, config, onProgress, onAssistantMessage, resumeSessionId, onSpawn } = options;

  return new Promise((resolve) => {
    const args = [
      '-p',
      task,
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      String(config.maxTurns),
    ];

    if (config.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else if (config.allowedTools.length > 0) {
      args.push('--allowedTools', config.allowedTools.join(','));
    }

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }

    const cwd = expandPath(repoPath);

    logger.info(`[Claude] Running in ${cwd}`);
    logger.debug(`[Claude] Task: ${task}`);
    logger.debug(`[Claude] Resume: ${resumeSessionId || 'new session'}`);
    logger.debug(`[Claude] Args: ${args.join(' ')}`);

    let proc: ChildProcess;
    try {
      proc = spawn('claude', args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ success: false, error: `Failed to spawn claude: ${(err as Error).message}` });
      return;
    }

    onSpawn?.(proc);
    logger.debug(`[Claude] Process spawned, PID: ${proc.pid}`);

    let lastResult = '';
    let sessionId = '';
    let buffer = '';
    let turnCount = 0;
    let settled = false;

    const finish = (result: ClaudeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const handleEvent = (event: StreamEvent) => {
      if (event.session_id && !sessionId) {
        sessionId = event.session_id;
        logger.debug(`[Claude] session_id captured: ${sessionId}`);
      }

      if (event.type === 'assistant' && event.message?.content) {
        const textParts: string[] = [];
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            turnCount++;
            const toolName = block.name || 'unknown';
            const status = `[${turnCount}/${config.maxTurns}] ${toolName}${toolDetail(toolName, block.input)}`;
            logger.debug(`[Claude] ${status}`);
            onProgress?.(status);
          }
        }
        const textContent = textParts.join('\n');
        if (textContent) {
          lastResult = textContent;
          onAssistantMessage?.(textContent);
        }
      }

      if (event.type === 'result' && event.result) {
        lastResult = event.result;
      }
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        handleEvent(JSON.parse(line) as StreamEvent);
      } catch {
        // JSON解析失敗は無視（不完全な行や非JSON出力）
      }
    };

    proc.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      logger.debug(`[Claude][stdout] ${chunk.slice(0, 200)}`);
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    });

    let stderr = '';
    proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      logger.debug(`[Claude][stderr] ${chunk}`);
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      finish({ success: false, error: `Timeout after ${config.timeoutMs / 1000} seconds` });
    }, config.timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);

      if (buffer.trim()) processLine(buffer);

      logger.info(`[Claude] Process exited with code ${code}, sessionId="${sessionId}"`);

      if (code !== 0 && !lastResult) {
        finish({ success: false, error: stderr.trim() || `Exit code: ${code}` });
        return;
      }

      finish({ success: true, result: lastResult || '(応答なし)', sessionId });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      finish({ success: false, error: `Process error: ${err.message}` });
    });
  });
}
