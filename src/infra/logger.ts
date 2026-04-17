/**
 * Pipeline logger — pretty stdout for humans + structured stderr for machines.
 *
 * Stdout gets colored, human-readable progress lines (what the demo shows).
 * Stderr gets NDJSON for machine ingestion (log shippers, CI parsing).
 * Both are driven by the same log calls — no duplication.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// ANSI color codes for terminal output
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';

export class Logger {
  private minLevel: number;

  constructor(level: LogLevel = 'info') {
    this.minLevel = LEVEL_PRIORITY[level];
  }

  // Core log method — writes to both stdout (pretty) and stderr (JSON).
  private log(level: LogLevel, tag: string, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < this.minLevel) return;

    // Pretty stdout — what the human sees during the demo
    const color = COLORS[level];
    const prefix = level === 'info' ? `${GREEN}[${tag}]${RESET}` : `${color}[${level.toUpperCase()} ${tag}]${RESET}`;
    process.stdout.write(`${prefix} ${message}\n`);

    // Structured stderr — machine-readable NDJSON
    const entry = { ts: new Date().toISOString(), lvl: level, tag, msg: message, ...data };
    process.stderr.write(JSON.stringify(entry) + '\n');
  }

  debug(tag: string, msg: string, data?: Record<string, unknown>): void {
    this.log('debug', tag, msg, data);
  }
  info(tag: string, msg: string, data?: Record<string, unknown>): void {
    this.log('info', tag, msg, data);
  }
  warn(tag: string, msg: string, data?: Record<string, unknown>): void {
    this.log('warn', tag, msg, data);
  }
  error(tag: string, msg: string, data?: Record<string, unknown>): void {
    this.log('error', tag, msg, data);
  }

  // Convenience: success checkmark for completed steps
  success(tag: string, msg: string): void {
    process.stdout.write(`${GREEN}${BOLD}  \u2713${RESET} ${GREEN}${tag}:${RESET} ${msg}\n`);
  }

  // Convenience: pipeline header
  header(text: string): void {
    process.stdout.write(`\n${BOLD}${text}${RESET}\n`);
  }

  // Convenience: summary line at end of run
  summary(text: string): void {
    process.stdout.write(`\n${BOLD}${GREEN}${text}${RESET}\n`);
  }
}
