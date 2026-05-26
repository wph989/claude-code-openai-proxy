import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { nowBeijingIso } from './time.js';
import { isProduction, USER_CONFIG_DIR } from '../config.js';

// 用户日志目录
const USER_LOG_DIR = path.join(USER_CONFIG_DIR, 'logs');

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

let currentLevel: LogLevel = (process.env.LOG_LEVEL?.toLowerCase() as LogLevel) || 'info';
if (!(currentLevel in LEVEL_WEIGHT)) {
  currentLevel = 'info';
}

let logFormat: 'json' | 'text' = (process.env.LOG_FORMAT?.toLowerCase() as 'json' | 'text') || 'json';
if (logFormat !== 'json' && logFormat !== 'text') {
  logFormat = 'json';
}

let detailedLogging = process.env.LOG_DETAILED?.toLowerCase().trim() === 'true';

// 自动设置日志路径（如果未从环境变量指定）
function getDefaultLogFilePath(): string {
  return path.join(USER_LOG_DIR, 'app.log');
}

let logFilePath: string | undefined = process.env.LOG_FILE?.trim() || getDefaultLogFilePath();
let logRotation: 'none' | 'daily' | 'size' = 'daily';
let logMaxFiles = 30;
let logMaxSize = 50 * 1024 * 1024;

// 解析日志轮转配置
const rawRotation = process.env.LOG_ROTATION?.toLowerCase();
if (rawRotation === 'none' || rawRotation === 'daily' || rawRotation === 'size') {
  logRotation = rawRotation;
}

// 解析最大文件数
const maxFiles = parseInt(process.env.LOG_MAX_FILES || '', 10);
if (!isNaN(maxFiles) && maxFiles > 0) {
  logMaxFiles = maxFiles;
}

// 解析单个文件大小
const maxSize = parseInt(process.env.LOG_MAX_SIZE || '', 10);
if (!isNaN(maxSize) && maxSize > 0) {
  logMaxSize = maxSize;
}

let currentLogFile: string | undefined;
let currentLogPath: string | undefined;
let currentLogDate: string | undefined;
let currentLogSize = 0;

export function setLogLevel(level: string | undefined): void {
  if (!level) return;
  const lower = level.toLowerCase() as LogLevel;
  if (lower in LEVEL_WEIGHT) {
    currentLevel = lower;
  }
}

export function setLogFormat(format: string | undefined): void {
  if (!format) return;
  const lower = format.toLowerCase() as 'json' | 'text';
  if (lower === 'json' || lower === 'text') {
    logFormat = lower;
  }
}

export function setLogDetailed(enabled: boolean): void {
  detailedLogging = enabled;
}

function getBeijingDate(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

async function ensureLogDir(): Promise<void> {
  if (!logFilePath) return;
  const dir = path.dirname(logFilePath);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // ignore
  }
}

async function rotateLogIfNeeded(): Promise<void> {
  if (!currentLogPath) return;

  const today = getBeijingDate();
  const needsRotation =
    logRotation === 'daily' && currentLogDate !== today ||
    logRotation === 'size' && currentLogSize >= logMaxSize;

  if (needsRotation) {
    await rotateLogFiles();
    currentLogSize = 0;
    currentLogDate = today;
  }
}

async function rotateLogFiles(): Promise<void> {
  if (!logFilePath) return;

  const dir = path.dirname(logFilePath);
  const baseName = path.basename(logFilePath);
  const ext = path.extname(baseName);
  const name = baseName.slice(0, -ext.length) || baseName;

  // 按日期轮转: app.log -> app-2025-01-15.log
  // 按大小轮转: app.log -> app.1.log
  const today = getBeijingDate();
  const newName = logRotation === 'daily'
    ? `${name}-${today}${ext}`
    : `${name}.1${ext}`;
  const newPath = path.join(dir, newName);

  // 如果目标文件已存在，添加序号
  let finalPath = newPath;
  let counter = 1;
  while (true) {
    try {
      await stat(finalPath);
      counter++;
      const base = logRotation === 'daily' ? `${name}-${today}` : `${name}.${counter}`;
      finalPath = path.join(dir, `${base}${ext}`);
    } catch {
      break;
    }
  }

  try {
    await rename(currentLogPath!, finalPath);
  } catch {
    // 文件可能不存在
  }

  // 清理旧日志文件
  await cleanupOldLogs(dir, name, ext);
}

async function cleanupOldLogs(dir: string, name: string, ext: string): Promise<void> {
  if (logMaxFiles <= 0) return;

  try {
    const files = await readdir(dir);
    const logFiles = files
      .filter(f => f.startsWith(name) && f.endsWith(ext) && f !== path.basename(logFilePath!))
      .map(f => ({ name: f, path: path.join(dir, f) }));

    if (logFiles.length <= logMaxFiles) return;

    // 按修改时间排序，删除最旧的
    const stats = await Promise.all(
      logFiles.map(async (f) => {
        try {
          const s = await stat(f.path);
          return { ...f, mtime: s.mtime };
        } catch {
          return { ...f, mtime: new Date(0) };
        }
      })
    );

    stats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
    const toDelete = stats.slice(0, stats.length - logMaxFiles);

    await Promise.all(toDelete.map(f => unlink(f.path).catch(() => {})));
  } catch {
    // ignore
  }
}

async function writeToFile(text: string): Promise<void> {
  if (!logFilePath) return;

  await ensureLogDir();

  // 首次写入时先初始化状态，确保 rotateLogIfNeeded 能正确检测日期变化
  if (!currentLogPath) {
    currentLogPath = logFilePath;
    try {
      const s = await stat(currentLogPath);
      currentLogSize = s.size;
    } catch {
      currentLogSize = 0;
    }
  }

  await rotateLogIfNeeded();

  const today = getBeijingDate();
  if (currentLogDate !== today) {
    currentLogDate = today;
  }

  const line = text + '\n';
  currentLogSize += Buffer.byteLength(line, 'utf8');
  await appendFile(currentLogPath, line, 'utf8');
}

function formatTextLog(level: LogLevel, message: string, extra: Record<string, unknown>): string {
  const extraKeys = Object.keys(extra);
  if (extraKeys.length === 0) {
    return `[${nowBeijingIso()}] ${level.toUpperCase()}: ${message}`;
  }
  const extraStr = extraKeys
    .map(k => `${k}=${JSON.stringify(extra[k])}`)
    .join(' ');
  return `[${nowBeijingIso()}] ${level.toUpperCase()}: ${message} {${extraStr}}`;
}

export function log(level: LogLevel, message: string, extra: Record<string, unknown> = {}): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) {
    return;
  }

  // 详细日志控制：如果不是详细模式，过滤掉 request_body/response_body/request/response
  let filteredExtra = extra;
  if (!detailedLogging) {
    const { request_body, response_body, request, response, ...rest } = extra;
    filteredExtra = rest;
  }

  const isJson = logFormat === 'json';
  let text: string;
  if (isJson) {
    const payload = {
      ts: nowBeijingIso(),
      level,
      message,
      ...filteredExtra
    };
    text = JSON.stringify(payload, ensureReplacer, 0);
  } else {
    text = formatTextLog(level, message, filteredExtra);
  }

  // 写入文件
  void writeToFile(text);

  // 输出到控制台
  if (level === 'error') {
    process.stderr.write(`${text}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

export function logDetailed(level: LogLevel, message: string, extra: Record<string, unknown> = {}): void {
  if (!detailedLogging) return;
  log(level, message, extra);
}

export function compactPreview(value: unknown, maxChars: number): string {
  let text = '';
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...(已截断, 原长度=${text.length})`;
}

function ensureReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  return value;
}
