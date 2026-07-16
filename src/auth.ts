import type { FastifyReply, FastifyRequest } from 'fastify';
import { settings } from './config.js';
import { createId } from './utils/id.js';

/**
 * 鉴权失败时抛出此错误，由 Fastify errorHandler 统一返回 401。
 */
export class AuthError extends Error {
  public readonly statusCode = 401;
  public readonly body: unknown;
  constructor(body: unknown) {
    super('Authentication failed');
    this.body = body;
  }
}

// 运行时代理 Token，由 RuntimeConfigManager 设置
let runtimeProxyToken: string | null = null;

export function setRuntimeProxyToken(token: string | null): void {
  runtimeProxyToken = token;
}

export function getExpectedProxyToken(): string | null {
  // 优先使用运行时配置，其次使用环境变量
  return runtimeProxyToken ?? settings.proxyAuthToken ?? null;
}

export function isProxyTokenRequired(): boolean {
  return Boolean(getExpectedProxyToken());
}

export function getExpectedAdminToken(): string {
  return settings.adminAuthToken;
}

export function isValidAdminToken(token: string | undefined): boolean {
  return Boolean(token) && token === settings.adminAuthToken;
}

export function readProxyToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  const xApiKey = request.headers['x-api-key'];
  if (typeof xApiKey === 'string') {
    return xApiKey.trim();
  }
  return undefined;
}

/**
 * Fastify preHandler hook：代理鉴权。失败时抛出 AuthError，由 errorHandler 返回 401。
 */
export async function proxyAuthHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const expectedToken = getExpectedProxyToken();
  if (!expectedToken) return;
  const token = readProxyToken(request);
  if (token === expectedToken) return;
  throw new AuthError({
    type: 'error',
    error: { type: 'authentication_error', message: '代理鉴权失败。' },
    request_id: request.requestId || createId('req')
  });
}

/**
 * Fastify preHandler hook：管理后台鉴权。失败时抛出 AuthError，由 errorHandler 返回 401。
 */
export async function adminAuthHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = request.cookies?.[settings.adminCookieName];
  if (isValidAdminToken(token)) return;
  throw new AuthError({ message: '未登录或会话已失效。' });
}
