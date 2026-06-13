import dotenv from 'dotenv';
import { homedir } from 'node:os';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);

export function hasExplicitDevMode(argv: readonly string[]): boolean {
  // 只把 --dev 视为开发模式；-d 是 CLI 的 daemon 简写，不能改变配置目录。
  return argv.includes('--dev');
}

export function resolveUserConfigFile(configRoot: string, isProdMode: boolean): string {
  return join(configRoot, isProdMode ? 'config.json' : 'runtime_models.json');
}

export function generateAdminAuthToken(): string {
  // 首次生产安装不能使用固定默认口令；随机值写入 .env，用户可自行修改。
  return `ccop_${randomBytes(24).toString('base64url')}`;
}

export function logGeneratedAdminAuthToken(envFile: string, token: string): void {
  // 只在实际生成随机口令时打印，避免用户首次启动后不知道管理后台密码。
  console.log('[config] 随机管理口令已写入:', envFile);
  console.log(`[config] ADMIN_AUTH_TOKEN=${token}`);
}

export function resolveAdminAuthToken(raw: string | undefined, isProdMode: boolean): string {
  const token = raw?.trim();
  if (token) return token;
  if (isProdMode) {
    // 生产模式如果已有 .env 却漏配管理口令，继续启动会暴露管理后台。
    throw new Error('生产模式必须配置 ADMIN_AUTH_TOKEN；可删除 ~/.ccop/.env 后让程序重新生成随机口令。');
  }
  return 'admin123';
}

export function ensureEnvTextHasAdminAuthToken(text: string, token: string): { text: string; changed: boolean } {
  const lines = text.split(/\r?\n/);
  let found = false;
  let changed = false;
  const next = lines.map((line) => {
    if (/^\s*#/.test(line)) return line;
    const match = line.match(/^\s*ADMIN_AUTH_TOKEN\s*=(.*)$/);
    if (!match) return line;
    found = true;
    if (match[1].trim()) return line;
    changed = true;
    return `ADMIN_AUTH_TOKEN=${token}`;
  });

  if (!found) {
    // 已有 .env 可能来自旧版本或手工创建，只补必要口令，不改动其他配置。
    if (next.length > 0 && next[next.length - 1] !== '') next.push('');
    next.push('# 管理后台密码（自动补齐，修改后需重启生效）');
    next.push(`ADMIN_AUTH_TOKEN=${token}`);
    changed = true;
  }

  return { text: next.join('\n'), changed };
}

// 模式检测（优先级：--dev > NODE_ENV > 目录检测）
const hasDevFlag = hasExplicitDevMode(process.argv);
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
export const USER_CONFIG_FILE = resolveUserConfigFile(CONFIG_ROOT, IS_PROD_MODE);
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
    const adminAuthToken = generateAdminAuthToken();
    const defaultEnv = `# CCOP 配置文件
# 首次运行时自动生成，可手动修改

# 服务器配置
HOST=0.0.0.0
PORT=8765

# 配置文件路径（指向运行时配置 JSON）
CONFIG_FILE=${USER_CONFIG_FILE}

# 管理后台密码（首次运行随机生成，修改后需重启生效）
ADMIN_AUTH_TOKEN=${adminAuthToken}

# 日志配置
LOG_LEVEL=info
LOG_FORMAT=json
LOG_DETAILED=false

# API Key 错误自动禁用（累计错误达到 KEY_MAX_ERRORS 次后自动禁用，true=启用，false=禁用此功能）
# 部分供应商不稳定时可设为 false，或在 config.json 的 provider 中设置 auto_disable_on_error: false
KEY_AUTO_DISABLE=true
KEY_MAX_ERRORS=5

# 连接池配置（上游请求的连接池参数）
MAX_SOCKETS=100
KEEP_ALIVE_TIMEOUT=60000

# 限流配置（保护服务不被过多请求压垮）
RATE_LIMIT_MAX=100
RATE_LIMIT_TIME_WINDOW=60000

# 集群配置（多进程模式，0=自动检测 CPU 核心数）
CLUSTER_WORKERS=0
`;
    writeFileSync(USER_ENV_FILE, defaultEnv, 'utf-8');
    logGeneratedAdminAuthToken(USER_ENV_FILE, adminAuthToken);
  } else {
    const currentEnv = readFileSync(USER_ENV_FILE, 'utf-8');
    const adminAuthToken = generateAdminAuthToken();
    const repaired = ensureEnvTextHasAdminAuthToken(currentEnv, adminAuthToken);
    if (repaired.changed) {
      writeFileSync(USER_ENV_FILE, repaired.text.endsWith('\n') ? repaired.text : `${repaired.text}\n`, 'utf-8');
      logGeneratedAdminAuthToken(USER_ENV_FILE, adminAuthToken);
    }
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
  maxSockets: number;
  keepAliveTimeout: number;
  forceIdentityAcceptEncoding: boolean;
  rateLimitMax: number;
  rateLimitTimeWindow: number;
  clusterWorkers: number;
  keyMaxErrors: number;
  keyAutoDisable: boolean;
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
  adminAuthToken: resolveAdminAuthToken(process.env.ADMIN_AUTH_TOKEN, IS_PROD_MODE),
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
  maxSockets: toNumber(process.env.MAX_SOCKETS, 100),
  keepAliveTimeout: toNumber(process.env.KEEP_ALIVE_TIMEOUT, 60000),
  // 强制上游返回未压缩（identity）响应；一些 OpenAI 兼容网关会回 br/gzip，需要在
  // 某些解压环境里手动关掉避免 Node fetch 解码歧义。默认关。
  forceIdentityAcceptEncoding: toBoolean(process.env.FORCE_IDENTITY_ACCEPT_ENCODING, false),
  rateLimitMax: toNumber(process.env.RATE_LIMIT_MAX, 100),
  rateLimitTimeWindow: toNumber(process.env.RATE_LIMIT_TIME_WINDOW, 60000),
  clusterWorkers: (() => { const v = Number(process.env.CLUSTER_WORKERS); return Number.isFinite(v) && v >= 0 ? v : 0; })(),
  keyMaxErrors: toNumber(process.env.KEY_MAX_ERRORS, 5),
  keyAutoDisable: toBoolean(process.env.KEY_AUTO_DISABLE, true)
};
