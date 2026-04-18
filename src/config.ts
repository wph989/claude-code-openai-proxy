import dotenv from 'dotenv';

dotenv.config();

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
  maxRequestBodyChars: number;
  maxResponseBodyChars: number;
  logLevel: string;
  logFormat: 'json' | 'text';
  logDetailed: boolean;
  logFile?: string;
  logRotation: LogRotation;
  logMaxFiles: number;
  logMaxSize?: number;
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

export const settings: AppSettings = {
  host: process.env.HOST?.trim() || '0.0.0.0',
  port: toNumber(process.env.PORT, 8765),
  proxyAuthToken: process.env.PROXY_AUTH_TOKEN?.trim() || 'replace-with-your-proxy-token',
  adminAuthToken: process.env.ADMIN_AUTH_TOKEN?.trim() || 'replace-with-your-admin-token',
  adminCookieName: 'ccgp_admin_session',
  adminCookieMaxAgeSeconds: 60 * 60 * 12,
  configFile: process.env.CONFIG_FILE?.trim() || './runtime_models.json',
  requestTimeoutMs: toNumber(process.env.REQUEST_TIMEOUT_MS, 300000),
  maxRequestBodyChars: toNumber(process.env.MAX_REQUEST_BODY_CHARS, 4000),
  maxResponseBodyChars: toNumber(process.env.MAX_RESPONSE_BODY_CHARS, 4000),
  logLevel: process.env.LOG_LEVEL?.trim() || 'info',
  logFormat: validLogFormat(process.env.LOG_FORMAT),
  logDetailed: toBoolean(process.env.LOG_DETAILED, false),
  logFile: process.env.LOG_FILE?.trim() || undefined,
  logRotation: validLogRotation(process.env.LOG_ROTATION),
  logMaxFiles: toNumber(process.env.LOG_MAX_FILES, 30),
  logMaxSize: toNumber(process.env.LOG_MAX_SIZE, 50 * 1024 * 1024)
};
