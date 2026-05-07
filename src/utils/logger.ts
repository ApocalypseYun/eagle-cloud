// ============================================================
// Simple structured logger with level filtering
// ============================================================

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly logFilePath?: string;
  readonly prefix?: string;
}

export interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly prefix: string;
  readonly message: string;
  readonly data?: unknown;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly logFilePath: string | undefined;
  private readonly prefix: string;

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.logFilePath = options.logFilePath;
    this.prefix = options.prefix ?? 'eagle-sync';
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }

  child(prefix: string): Logger {
    return new Logger({
      level: this.level,
      logFilePath: this.logFilePath,
      prefix: `${this.prefix}:${prefix}`,
    });
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.level]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      prefix: this.prefix,
      message,
      data,
    };

    this.writeToConsole(entry);
    this.writeToFile(entry);
  }

  private writeToConsole(entry: LogEntry): void {
    const formatted = formatEntry(entry);

    switch (entry.level) {
      case 'debug':
        console.debug(formatted);
        break;
      case 'info':
        console.info(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'error':
        console.error(formatted);
        break;
    }
  }

  private writeToFile(entry: LogEntry): void {
    if (!this.logFilePath) {
      return;
    }

    const line = `${formatEntry(entry)}\n`;

    // Fire-and-forget file write to avoid blocking the caller.
    // Errors in log writing should not crash the application.
    void (async () => {
      try {
        await mkdir(dirname(this.logFilePath!), { recursive: true });
        await appendFile(this.logFilePath!, line, 'utf-8');
      } catch {
        // Silently ignore file write errors for logging
      }
    })();
  }
}

// --- Helpers ---

function formatEntry(entry: LogEntry): string {
  const base = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.prefix}] ${entry.message}`;
  if (entry.data === undefined) {
    return base;
  }
  return `${base} ${JSON.stringify(entry.data)}`;
}
