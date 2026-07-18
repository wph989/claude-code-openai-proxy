import { appendFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { USER_CONFIG_DIR } from '../config.js';
import { nowBeijingIso, toBeijingDateStr } from './time.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  logLevel?: string;
  logFormat?: 'json' | 'text';
  logDetailed?: boolean;
  logFile?: string;
  logRotation?: 'none' | 'daily' | 'size';
  logMaxFiles?: number;
  logMaxSize?: number;
}

export interface LoggerOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_OUTPUT: LoggerOutput = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * 每个 Logger 实例独立持有配置、轮换状态和写入链。
 * 文件写入按调用顺序串行执行，避免并发请求同时触发轮换或覆盖大小计数。
 */
export class Logger {
  private currentLevel: LogLevel = 'info';
  private logFormat: 'json' | 'text' = 'json';
  private detailedLogging = false;
  private logFilePath = path.join(USER_CONFIG_DIR, 'logs', 'app.log');
  private logRotation: 'none' | 'daily' | 'size' = 'daily';
  private logMaxFiles = 30;
  private logMaxSize = 50 * 1024 * 1024;
  private currentLogPath: string | undefined;
  private currentLogDate: string | undefined;
  private currentLogSize = 0;
  private dirEnsured = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(config: LoggerConfig = {}, private readonly output: LoggerOutput = DEFAULT_OUTPUT) {
    this.configure(config);
  }

  configure(config: LoggerConfig): void {
    if (config.logLevel) {
      const lower = config.logLevel.toLowerCase() as LogLevel;
      if (lower in LEVEL_WEIGHT) this.currentLevel = lower;
    }
    if (config.logFormat === 'json' || config.logFormat === 'text') {
      this.logFormat = config.logFormat;
    }
    if (config.logDetailed !== undefined) {
      this.detailedLogging = config.logDetailed;
    }
    if (config.logFile && config.logFile !== this.logFilePath) {
      this.logFilePath = config.logFile;
      // 新路径必须重新初始化目录、大小和轮换日期，不能继承旧文件状态。
      this.currentLogPath = undefined;
      this.currentLogDate = undefined;
      this.currentLogSize = 0;
      this.dirEnsured = false;
    }
    if (config.logRotation) {
      this.logRotation = config.logRotation;
    }
    if (config.logMaxFiles !== undefined && config.logMaxFiles > 0) {
      this.logMaxFiles = config.logMaxFiles;
    }
    if (config.logMaxSize !== undefined && config.logMaxSize > 0) {
      this.logMaxSize = config.logMaxSize;
    }
  }

  log(level: LogLevel, message: string, extra: Record<string, unknown> = {}): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.currentLevel]) return;

    let filteredExtra = extra;
    if (!this.detailedLogging) {
      const { request_body, response_body, request, response, ...rest } = extra;
      filteredExtra = rest;
    }

    const text = this.logFormat === 'json'
      ? JSON.stringify({ ts: nowBeijingIso(), level, message, ...filteredExtra }, ensureReplacer)
      : formatTextLog(level, message, filteredExtra);

    // 日志失败不能打断代理请求；错误在链尾吞掉，同时保留后续写入顺序。
    this.writeChain = this.writeChain
      .then(() => this.writeToFile(text))
      .catch(() => undefined);

    if (level === 'error') {
      this.output.stderr(`${text}\n`);
    } else {
      this.output.stdout(`${text}\n`);
    }
  }

  logDetailed(level: LogLevel, message: string, extra: Record<string, unknown> = {}): void {
    if (!this.detailedLogging) return;
    this.log(level, message, extra);
  }

  isDetailedEnabled(): boolean {
    return this.detailedLogging;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async ensureLogDir(): Promise<void> {
    if (!this.logFilePath || this.dirEnsured) return;
    try {
      await mkdir(path.dirname(this.logFilePath), { recursive: true });
      this.dirEnsured = true;
    } catch {
      // 日志目录不可写时保持控制台输出，不能让代理请求失败。
    }
  }

  private async writeToFile(text: string): Promise<void> {
    if (!this.logFilePath) return;
    await this.ensureLogDir();

    if (!this.currentLogPath) {
      this.currentLogPath = this.logFilePath;
      try {
        this.currentLogSize = (await stat(this.currentLogPath)).size;
      } catch {
        this.currentLogSize = 0;
      }
      if (this.logRotation === 'daily') {
        await this.rotateDaily();
        this.currentLogDate = this.getBeijingDate();
      }
    }

    await this.rotateIfNeeded();
    const line = `${text}\n`;
    this.currentLogSize += Buffer.byteLength(line, 'utf8');
    await appendFile(this.currentLogPath, line, 'utf8');
  }

  private async rotateIfNeeded(): Promise<void> {
    if (!this.currentLogPath) return;
    const today = this.getBeijingDate();
    const needsRotation =
      this.logRotation === 'daily' && this.currentLogDate !== today ||
      this.logRotation === 'size' && this.currentLogSize >= this.logMaxSize;
    if (!needsRotation) return;

    if (this.logRotation === 'daily') {
      await this.rotateDaily();
    } else {
      await this.rotateBySize();
    }
    this.currentLogSize = 0;
    this.currentLogDate = today;
  }

  private async rotateDaily(): Promise<void> {
    if (!this.currentLogPath) return;
    const { dir, ext, name } = parseLogPath(this.currentLogPath);
    let modifiedAt: Date;
    try {
      modifiedAt = (await stat(this.currentLogPath)).mtime;
    } catch {
      return;
    }

    const modifiedDate = toBeijingDateStr(modifiedAt);
    if (modifiedDate >= this.getBeijingDate()) return;
    try {
      await rename(this.currentLogPath, path.join(dir, `${name}-${modifiedDate}${ext}`));
    } catch {
      return;
    }
    await writeFile(this.currentLogPath, '', 'utf8');
    this.currentLogSize = 0;
    await this.cleanupOldLogs(dir, name, ext);
  }

  private async rotateBySize(): Promise<void> {
    if (!this.currentLogPath) return;
    const { dir, ext, name } = parseLogPath(this.currentLogPath);
    let counter = 1;
    let archivePath = path.join(dir, `${name}.${counter}${ext}`);
    while (true) {
      try {
        await stat(archivePath);
        counter += 1;
        archivePath = path.join(dir, `${name}.${counter}${ext}`);
      } catch {
        break;
      }
    }
    try {
      await rename(this.currentLogPath, archivePath);
    } catch {
      // 首次达到阈值时文件可能尚不存在，后续 append 会创建。
    }
    await this.cleanupOldLogs(dir, name, ext);
  }

  private async cleanupOldLogs(dir: string, name: string, ext: string): Promise<void> {
    if (this.logMaxFiles <= 0) return;
    try {
      const files = await readdir(dir);
      const candidates = files
        .filter((file) => file.startsWith(name) && file.endsWith(ext) && file !== path.basename(this.logFilePath))
        .map((file) => ({ name: file, path: path.join(dir, file) }));
      if (candidates.length <= this.logMaxFiles) return;

      const stats = await Promise.all(candidates.map(async (file) => {
        try {
          return { ...file, mtime: (await stat(file.path)).mtime };
        } catch {
          return { ...file, mtime: new Date(0) };
        }
      }));
      stats.sort((left, right) => left.mtime.getTime() - right.mtime.getTime());
      const oldFiles = stats.slice(0, stats.length - this.logMaxFiles);
      await Promise.all(oldFiles.map((file) => unlink(file.path).catch(() => undefined)));
    } catch {
      // 清理失败不影响当前日志继续写入。
    }
  }

  private getBeijingDate(): string {
    return toBeijingDateStr(new Date());
  }
}

function parseLogPath(filePath: string) {
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const ext = path.extname(baseName);
  const name = baseName.slice(0, -ext.length) || baseName;
  return { dir, ext, name };
}

function formatTextLog(level: LogLevel, message: string, extra: Record<string, unknown>): string {
  const fields = Object.keys(extra).map((key) => `${key}=${JSON.stringify(extra[key])}`);
  const suffix = fields.length > 0 ? ` {${fields.join(' ')}}` : '';
  return `[${nowBeijingIso()}] ${level.toUpperCase()}: ${message}${suffix}`;
}

function ensureReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
