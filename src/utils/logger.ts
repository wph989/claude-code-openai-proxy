import {
  Logger,
  type LoggerConfig,
  type LoggerOutput,
  type LogLevel,
} from './logger-core.js';

export { Logger };
export type { LoggerConfig, LoggerOutput, LogLevel };

const defaultLogger = new Logger();

/** 旧的函数式 API 统一代理到默认实例，现有模块可以渐进迁移到构造器注入。 */
export function getDefaultLogger(): Logger {
  return defaultLogger;
}

export function configureLogger(config: LoggerConfig): void {
  defaultLogger.configure(config);
}

export function log(level: LogLevel, message: string, extra: Record<string, unknown> = {}): void {
  defaultLogger.log(level, message, extra);
}

export function logDetailed(level: LogLevel, message: string, extra: Record<string, unknown> = {}): void {
  defaultLogger.logDetailed(level, message, extra);
}

export function isLogDetailedEnabled(): boolean {
  return defaultLogger.isDetailedEnabled();
}

export async function flushLogs(): Promise<void> {
  await defaultLogger.flush();
}

export function compactPreview(value: unknown, maxChars: number): string {
  let text = '';
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...(已截断, 原长度=${text.length})`;
}
