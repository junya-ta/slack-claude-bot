import { describe, it, expect } from 'vitest';
import { sanitizeChildEnv } from '../src/claude.js';

describe('sanitizeChildEnv', () => {
  it('親のClaude Code由来の変数を除き、それ以外は残す', () => {
    const out = sanitizeChildEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      ANTHROPIC_API_KEY: 'k',
      CLAUDECODE: '1',
      ANTHROPIC_BASE_URL: 'http://localhost',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
      CLAUDE_AGENT_SDK_VERSION: '1',
      CLAUDE_PID: '123',
    });
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/Users/x', ANTHROPIC_API_KEY: 'k' });
  });
});
