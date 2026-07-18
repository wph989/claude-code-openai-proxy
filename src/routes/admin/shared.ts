import type { FastifyInstance, FastifyReply } from 'fastify';
import { ConfigPreconditionError } from '../../errors.js';

export function parseConfigRevision(value: string | string[] | undefined): number {
  if (typeof value !== 'string') throw new ConfigPreconditionError();
  const normalized = value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const revision = Number(normalized);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new ConfigPreconditionError('If-Match 必须包含有效的配置 revision。');
  }
  return revision;
}

export function safeKeyExportFilename(providerId: string): string {
  // provider_id 来自用户配置；下载头只允许保守字符，避免异常字符污染响应头。
  const cleaned = String(providerId || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return `${cleaned || 'provider'}-keys.txt`;
}

export function setRevisionHeaders(app: FastifyInstance, reply: FastifyReply): void {
  void reply
    .header('etag', `"${app.runtimeConfigManager.getRevision()}"`)
    .header('cache-control', 'no-store');
}
