import type { FastifyReply, FastifyRequest } from 'fastify';
import { settings } from './config.js';
import { createId } from './utils/id.js';

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

export async function verifyProxyAuth(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const expectedToken = getExpectedProxyToken();

  // 如果未配置任何代理 Token，则允许匿名访问
  if (!expectedToken) {
    return true;
  }

  const token = readProxyToken(request);
  if (token === expectedToken) {
    return true;
  }

  void reply.code(401).send({
    type: 'error',
    error: { type: 'authentication_error', message: '代理鉴权失败。' },
    request_id: request.requestId || createId('req')
  });
  return false;
}

export async function verifyAdminAuth(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const token = request.cookies?.[settings.adminCookieName];
  if (isValidAdminToken(token)) {
    return true;
  }
  void reply.code(401).send({ message: '未登录或会话已失效。' });
  return false;
}
