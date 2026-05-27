import dotenv from 'dotenv';
import { homedir } from 'node:os';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);

// 模式检测（优先级：--dev > NODE_ENV > 目录检测）
const hasDevFlag = process.argv.includes('--dev') || process.argv.includes('-d');
const nodeEnv = process.env.NODE_ENV;
const isRunningFromDist = basename(currentDir) === 'dist' || currentDir.includes('node_modules');

// 开发模式：显式指定（--dev 或 NODE_ENV=development）或从源码运行
export const IS_DEV_MODE = hasDevFlag ||
  nodeEnv === 'development' ||
  (!isRunningFromDist && nodeEnv !== 'production');

export const IS_PROD_MODE = !IS_DEV_MODE;

// 配置根目录（根据模式动态选择）
export const CONFIG_ROOT = IS_PROD_MODE ? join(homedir(), '.ccop') : process.cwd();

// 动态路径配置
export const USER_CONFIG_DIR = CONFIG_ROOT;
export const USER_CONFIG_FILE = join(CONFIG_ROOT, IS_PROD_MODE ? 'config.json' : 'runtime_models.json');
export const USER_ENV_FILE = join(CONFIG_ROOT, '.env');
export const USER_LOG_DIR = join(CONFIG_ROOT, 'logs');
export const USER_PID_DIR = join(CONFIG_ROOT, 'pids');

// 导出别名供其他模块使用
export { USER_CONFIG_FILE as CONFIG_FILE, IS_PROD_MODE as isProduction };

// 生产模式：初始化用户配置目录
function ensureUserConfig(): void {
  if (!existsSync(USER_CONFIG_DIR)) {
    mkdirSync(USER_CONFIG_DIR, { recursive: true });
  }
  if (!existsSync(USER_LOG_DIR)) {
    mkdirSync(USER_LOG_DIR, { recursive: true });
  }
  if (!existsSync(USER_PID_DIR)) {
    mkdirSync(USER_PID_DIR, { recursive: true });
  }

  // 创建默认 .env 文件（如果不存在，不覆盖）
  if (!existsSync(USER_ENV_FILE)) {
    const defaultEnv = `# CCOP 配置文件
# 首次运行时自动生成，可手动修改

# 服务器配置
HOST=0.0.0.0
PORT=8765

# 配置文件路径（指向运行时配置 JSON）
CONFIG_FILE=${USER_CONFIG_FILE}

# 管理后台密码（修改后需重启生效）
ADMIN_AUTH_TOKEN=admin123

# 日志配置
LOG_LEVEL=info
LOG_FORMAT=json
LOG_DETAILED=false
`;
    writeFileSync(USER_ENV_FILE, defaultEnv, 'utf-8');
  }
}

// 生产模式自动初始化（不覆盖已有配置）
if (IS_PROD_MODE) {
  console.log('[config] 生产模式，使用用户目录:', CONFIG_ROOT);
  ensureUserConfig();
} else {
  console.log('[config] 开发模式，使用本地目录:', CONFIG_ROOT);
}

// 加载环境变量
dotenv.config({ path: IS_PROD_MODE ? USER_ENV_FILE : join(process.cwd(), '.env') });

export type LogRotation = 'none' | 'daily' | 'size';

export interface AppSettings {
  host: string;
  port: number;
  proxyAuthToken: string;
  adminAuthToken: string;
  adminCookieName: string;
  adminCookieMaxAgeSeconds: number;
  configFile: string;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxRequestBodyChars: number;
  maxResponseBodyChars: number;
  logLevel: string;
  logFormat: 'json' | 'text';
  logDetailed: boolean;
  logFile?: string;
  logRotation: LogRotation;
  logMaxFiles: number;
  logMaxSize?: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  maxSockets: number;
  keepAliveTimeout: number;
}

function toNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const validLogFormat = (raw: string | undefined): 'json' | 'text' => {
  if (raw?.toLowerCase() === 'text') return 'text';
  return 'json';
};

const validLogRotation = (raw: string | undefined): LogRotation => {
  const lower = raw?.toLowerCase();
  if (lower === 'none' || lower === 'daily' || lower === 'size') return lower;
  return 'daily';
};

const toBoolean = (raw: string | undefined, fallback: boolean): boolean => {
  if (!raw) return fallback;
  const lower = raw.toLowerCase().trim();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return fallback;
};

// 配置文件路径（优先环境变量，否则按模式选择）
const configFilePath = process.env.CONFIG_FILE?.trim()
  || (IS_PROD_MODE ? USER_CONFIG_FILE : join(process.cwd(), 'runtime_models.json'));

export const settings: AppSettings = {
  host: process.env.HOST?.trim() || '0.0.0.0',
  port: toNumber(process.env.PORT, 8765),
  proxyAuthToken: '', // 从 config.json 的 proxy_auth_token 读取，不从这里配置
  adminAuthToken: process.env.ADMIN_AUTH_TOKEN?.trim() || 'admin123',
  adminCookieName: 'ccgp_admin_session',
  adminCookieMaxAgeSeconds: 60 * 60 * 12,
  configFile: configFilePath,
  requestTimeoutMs: toNumber(process.env.REQUEST_TIMEOUT_MS, 300000),
  streamIdleTimeoutMs: toNumber(process.env.REQUEST_STREAM_IDLE_TIMEOUT_MS, 120000),
  maxRequestBodyChars: toNumber(process.env.MAX_REQUEST_BODY_CHARS, 4000),
  maxResponseBodyChars: toNumber(process.env.MAX_RESPONSE_BODY_CHARS, 4000),
  logLevel: process.env.LOG_LEVEL?.trim() || 'info',
  logFormat: validLogFormat(process.env.LOG_FORMAT),
  logDetailed: toBoolean(process.env.LOG_DETAILED, false),
  logFile: process.env.LOG_FILE?.trim() || join(USER_LOG_DIR, 'app.log'),
  logRotation: validLogRotation(process.env.LOG_ROTATION),
  logMaxFiles: toNumber(process.env.LOG_MAX_FILES, 30),
  logMaxSize: toNumber(process.env.LOG_MAX_SIZE, 50 * 1024 * 1024),
  maxRetries: toNumber(process.env.MAX_RETRIES, 3),
  retryBaseDelayMs: toNumber(process.env.RETRY_BASE_DELAY_MS, 1000),
  maxSockets: toNumber(process.env.MAX_SOCKETS, 100),
  keepAliveTimeout: toNumber(process.env.KEEP_ALIVE_TIMEOUT, 60000)
};
