type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (raw in LEVELS) return raw as Level;
  return 'info';
}

let currentLevel = resolveLevel();

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

function enabled(level: Level): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

export const logger = {
  debug(...args: unknown[]): void {
    if (enabled('debug')) console.debug(...args);
  },
  info(...args: unknown[]): void {
    if (enabled('info')) console.info(...args);
  },
  warn(...args: unknown[]): void {
    if (enabled('warn')) console.warn(...args);
  },
  error(...args: unknown[]): void {
    if (enabled('error')) console.error(...args);
  },
};
