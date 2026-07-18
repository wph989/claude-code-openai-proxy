import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { settings } from '../src/config.js';
import { createApp } from '../src/server.js';
import { isSensitiveHeaderName } from '../src/services/admin-config.js';

let tempDir: string;
const authCookies = { [settings.adminCookieName]: settings.adminAuthToken };

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'admin-security-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('管理端敏感信息边界', () => {
  it('未登录不能读取配置，登录接口设置 HttpOnly 管理会话', async () => {
    const secrets = writeSensitiveConfig('runtime_models.json');
    const app = await createApp(secrets.configPath);
    try {
      const denied = await app.inject({ method: 'GET', url: '/api/config' });
      expect(denied.statusCode).toBe(401);
      for (const secret of secrets.values) expect(denied.body).not.toContain(secret);

      const wrong = await app.inject({
        method: 'POST',
        url: '/api/admin/login',
        payload: { token: 'wrong-admin-token' },
      });
      expect(wrong.statusCode).toBe(401);

      const loggedIn = await app.inject({
        method: 'POST',
        url: '/api/admin/login',
        payload: { token: settings.adminAuthToken },
      });
      expect(loggedIn.statusCode).toBe(200);
      expect(loggedIn.headers['set-cookie']).toContain('HttpOnly');
      expect(loggedIn.headers['set-cookie']).toContain('SameSite=Lax');

      const apiClient = await app.inject({ method: 'GET', url: '/api-client.js' });
      expect(apiClient.statusCode).toBe(200);
      expect(apiClient.body).toContain('export const AdminApi');
      const providerForm = await app.inject({ method: 'GET', url: '/forms/provider-form.js' });
      expect(providerForm.statusCode).toBe(200);
      expect(providerForm.headers['content-type']).toContain('application/javascript');
      const keyPanelView = await app.inject({ method: 'GET', url: '/views/key-panel.js' });
      expect(keyPanelView.statusCode).toBe(200);
    } finally {
      await closeApp(app);
    }
  });

  it('普通配置和 Key 查询不返回秘密，主动导出仍返回完整 Key', async () => {
    const secrets = writeSensitiveConfig('runtime_models.json');
    const app = await createApp(secrets.configPath);
    try {
      const { rotator } = app.runtimeConfigManager.resolveModel('client-model');
      rotator.markError(secrets.key, `Bearer ${secrets.diagnosticBearer} echoed ${secrets.key}`);
      const configResponse = await app.inject({ method: 'GET', url: '/api/config', cookies: authCookies });
      expect(configResponse.statusCode).toBe(200);
      expect(configResponse.headers.etag).toBe('"7"');
      expect(configResponse.headers['cache-control']).toBe('no-store');
      for (const secret of secrets.values) expect(configResponse.body).not.toContain(secret);

      const body = configResponse.json();
      expect(body.proxy_auth_token_configured).toBe(true);
      expect(body.config).not.toHaveProperty('proxy_auth_token');
      expect(body.config.providers[0].api_key[0]).toMatchObject({
        id: 'KEYADMIN01',
        key_mask: '********7890',
      });
      expect(body.config.providers[0].api_key[0]).not.toHaveProperty('key');
      expect(body.config.providers[0].headers).toEqual({
        Authorization: null,
        'x-api-key': null,
        'x-service-secret': null,
        'api-version': '2026-07-17',
      });
      expect(body.config.providers[0].circuit_status).toMatchObject({
        state: 'closed',
        consecutive_failures: 0,
        open_until: null,
      });

      const keysResponse = await app.inject({ method: 'GET', url: '/api/keys/provider-a', cookies: authCookies });
      expect(keysResponse.statusCode).toBe(200);
      for (const secret of secrets.values) expect(keysResponse.body).not.toContain(secret);
      expect(keysResponse.json().keys[0]).not.toHaveProperty('key');

      const exportResponse = await app.inject({
        method: 'GET',
        url: '/api/keys/provider-a/export',
        cookies: authCookies,
      });
      expect(exportResponse.statusCode).toBe(200);
      expect(exportResponse.headers['cache-control']).toBe('no-store');
      expect(exportResponse.body).toBe(secrets.key);
    } finally {
      await closeApp(app);
    }
  });

  it('脱敏配置可预览和保存，同时保留服务端 Key、Token 与敏感 Header', async () => {
    const secrets = writeSensitiveConfig('runtime_models.json');
    const app = await createApp(secrets.configPath);
    try {
      const loaded = await app.inject({ method: 'GET', url: '/api/config', cookies: authCookies });
      const payload = loaded.json().config;
      payload.providers[0].description = '已更新';

      const preview = await app.inject({
        method: 'POST',
        url: '/api/config/preview',
        cookies: authCookies,
        headers: { 'if-match': loaded.headers.etag as string },
        payload,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ has_changes: true });
      for (const secret of secrets.values) expect(preview.body).not.toContain(secret);

      const saved = await app.inject({
        method: 'PUT',
        url: '/api/config',
        cookies: authCookies,
        headers: { 'if-match': loaded.headers.etag as string },
        payload,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.headers.etag).toBe('"8"');
      for (const secret of secrets.values) expect(saved.body).not.toContain(secret);

      const persisted = JSON.parse(readFileSync(secrets.configPath, 'utf-8'));
      expect(persisted.revision).toBe(8);
      expect(persisted.providers[0].api_key[0].key).toBe(secrets.key);
      expect(persisted.proxy_auth_token).toBe(secrets.proxyToken);
      expect(persisted.providers[0].headers.Authorization).toBe(secrets.authorization);
      expect(persisted.providers[0].headers['x-api-key']).toBe(secrets.headerKey);
      expect(persisted.providers[0].description).toBe('已更新');

      const stale = await app.inject({
        method: 'PUT',
        url: '/api/config',
        cookies: authCookies,
        headers: { 'if-match': '"7"' },
        payload,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ revision: 8 });

      const missingPrecondition = await app.inject({
        method: 'PUT',
        url: '/api/config',
        cookies: authCookies,
        payload,
      });
      expect(missingPrecondition.statusCode).toBe(428);
    } finally {
      await closeApp(app);
    }
  });

  it('Token 通过独立接口轮换和移除，响应不回显新值', async () => {
    const secrets = writeSensitiveConfig('runtime_models.json');
    const app = await createApp(secrets.configPath);
    const replacement = 'proxy-token-replacement-unique';
    try {
      const rotated = await app.inject({
        method: 'PUT',
        url: '/api/config/proxy-token',
        cookies: authCookies,
        headers: { 'if-match': '"7"' },
        payload: { token: replacement },
      });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.body).not.toContain(replacement);
      expect(rotated.json()).toMatchObject({ revision: 8, proxy_auth_token_configured: true });
      expect(JSON.parse(readFileSync(secrets.configPath, 'utf-8')).proxy_auth_token).toBe(replacement);

      const cleared = await app.inject({
        method: 'PUT',
        url: '/api/config/proxy-token',
        cookies: authCookies,
        headers: { 'if-match': '"8"' },
        payload: { token: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(JSON.parse(readFileSync(secrets.configPath, 'utf-8')).proxy_auth_token).toBeNull();
    } finally {
      await closeApp(app);
    }
  });

  it('资源级 Provider 与路由接口使用 revision，并保留引用完整性', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    const headerSecret = 'resource-header-secret';
    const ignoredKey = 'resource-key-must-not-be-added';
    writeFileSync(configPath, JSON.stringify({
      revision: 1,
      providers: [],
      models: [],
      default_client_model: null,
    }), 'utf-8');
    const app = await createApp(configPath);
    try {
      const createdProvider = await app.inject({
        method: 'POST',
        url: '/api/providers',
        cookies: authCookies,
        headers: { 'if-match': '"1"' },
        payload: {
          provider_id: 'resource-provider',
          provider_type: 'openai_compatible',
          base_url: 'https://example.com/v1',
          api_key: [{ key: ignoredKey }],
          enabled: true,
          headers: { Authorization: headerSecret },
        },
      });
      expect(createdProvider.statusCode).toBe(200);
      expect(createdProvider.headers.etag).toBe('"2"');
      expect(createdProvider.body).not.toContain(headerSecret);
      expect(createdProvider.body).not.toContain(ignoredKey);

      const patchedProvider = await app.inject({
        method: 'PATCH',
        url: '/api/providers/resource-provider',
        cookies: authCookies,
        headers: { 'if-match': '"2"' },
        payload: { description: '资源级更新', headers: { Authorization: null } },
      });
      expect(patchedProvider.statusCode).toBe(200);
      expect(patchedProvider.body).not.toContain(headerSecret);
      expect(JSON.parse(readFileSync(configPath, 'utf-8')).providers[0].headers.Authorization).toBe(headerSecret);

      const createdRoute = await app.inject({
        method: 'POST',
        url: '/api/routes',
        cookies: authCookies,
        headers: { 'if-match': '"3"' },
        payload: {
          client_model: 'resource-model',
          provider_id: 'resource-provider',
          upstream_model: 'upstream-a',
          enabled: true,
        },
      });
      expect(createdRoute.statusCode).toBe(200);
      const routeId = createdRoute.json().route_id;
      expect(routeId).toMatch(/^[0-9A-Z]{10}$/);

      const patchedRoute = await app.inject({
        method: 'PATCH',
        url: `/api/routes/${routeId}`,
        cookies: authCookies,
        headers: { 'if-match': '"4"' },
        payload: { upstream_model: 'upstream-b' },
      });
      expect(patchedRoute.statusCode).toBe(200);
      expect(patchedRoute.json().config.models[0]).toMatchObject({
        route_id: routeId,
        upstream_model: 'upstream-b',
      });

      const referencedDelete = await app.inject({
        method: 'DELETE',
        url: '/api/providers/resource-provider',
        cookies: authCookies,
        headers: { 'if-match': '"5"' },
      });
      expect(referencedDelete.statusCode).toBe(400);
      expect(referencedDelete.json().message).toContain('仍被 1 条模型路由引用');

      const deletedRoute = await app.inject({
        method: 'DELETE',
        url: `/api/routes/${routeId}`,
        cookies: authCookies,
        headers: { 'if-match': '"5"' },
      });
      expect(deletedRoute.statusCode).toBe(200);
      const deletedProvider = await app.inject({
        method: 'DELETE',
        url: '/api/providers/resource-provider',
        cookies: authCookies,
        headers: { 'if-match': '"6"' },
      });
      expect(deletedProvider.statusCode).toBe(200);
      expect(deletedProvider.json().config.providers).toEqual([]);

      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(persisted.revision).toBe(7);
      expect(JSON.stringify(persisted)).not.toContain(ignoredKey);
    } finally {
      await closeApp(app);
    }
  });

  it('稳定 Key ID 在列表重排后仍操作原资源，并标记旧索引请求已弃用', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    writeFileSync(configPath, JSON.stringify({
      revision: 3,
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com/v1',
        api_key: [
          { id: 'KEYSTABLE1', key: 'stable-secret-a' },
          { id: 'KEYSTABLE2', key: 'stable-secret-b' },
        ],
        enabled: true,
        headers: {},
      }],
      models: [],
      default_client_model: null,
    }), 'utf-8');
    const app = await createApp(configPath);
    try {
      const loaded = await app.inject({ method: 'GET', url: '/api/config', cookies: authCookies });
      const payload = loaded.json().config;
      payload.providers[0].api_key.reverse();
      const reordered = await app.inject({
        method: 'PUT',
        url: '/api/config',
        cookies: authCookies,
        headers: { 'if-match': '"3"' },
        payload,
      });
      expect(reordered.statusCode).toBe(200);

      const disabled = await app.inject({
        method: 'PUT',
        url: '/api/keys/p1/KEYSTABLE1/disable',
        cookies: authCookies,
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json().key_id).toBe('KEYSTABLE1');
      const states = app.runtimeConfigManager.getKeyStates('p1');
      expect(states.find((key) => key.id === 'KEYSTABLE1')?.enabled).toBe(false);
      expect(states.find((key) => key.id === 'KEYSTABLE2')?.enabled).toBe(true);

      const legacy = await app.inject({
        method: 'PUT',
        url: '/api/keys/p1/0/enable',
        cookies: authCookies,
      });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.headers.deprecation).toBe('true');
      expect(legacy.json().key_id).toBe('KEYSTABLE2');
    } finally {
      await closeApp(app);
    }
  });

  it('环境变量 Key 只存在于运行时，不会被普通查询返回或保存到 JSON', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    const envName = 'CCOP_ADMIN_SECURITY_ENV_KEY';
    const envSecret = 'environment-key-secret-unique';
    process.env[envName] = envSecret;
    writeFileSync(configPath, JSON.stringify({
      revision: 2,
      providers: [{
        provider_id: 'env-provider',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com/v1',
        api_key: null,
        api_key_env: envName,
        enabled: true,
        headers: {},
      }],
      models: [],
      default_client_model: null,
    }), 'utf-8');
    const app = await createApp(configPath);
    try {
      const loaded = await app.inject({ method: 'GET', url: '/api/config', cookies: authCookies });
      expect(loaded.body).not.toContain(envSecret);
      expect(loaded.json().config.providers[0].api_key).toEqual([]);
      expect(loaded.json().key_states['env-provider'][0].key_mask).toBe('********ique');
      expect(loaded.json().key_states['env-provider'][0]).toMatchObject({
        id: `env:${envName}`,
        source: 'environment',
      });

      const saved = await app.inject({
        method: 'PUT',
        url: '/api/config',
        cookies: authCookies,
        headers: { 'if-match': '"2"' },
        payload: loaded.json().config,
      });
      expect(saved.statusCode).toBe(200);
      expect(readFileSync(configPath, 'utf-8')).not.toContain(envSecret);
      expect(saved.json().key_states['env-provider'][0].id).toBe(`env:${envName}`);

      const exported = await app.inject({
        method: 'GET',
        url: '/api/keys/env-provider/export',
        cookies: authCookies,
      });
      expect(exported.body).toBe(envSecret);
    } finally {
      delete process.env[envName];
      await closeApp(app);
    }
  });

  it('敏感 Header 名称识别覆盖常见凭证字段', () => {
    expect(isSensitiveHeaderName('Authorization')).toBe(true);
    expect(isSensitiveHeaderName('X-API-Key')).toBe(true);
    expect(isSensitiveHeaderName('x-auth-token')).toBe(true);
    expect(isSensitiveHeaderName('client_secret')).toBe(true);
    expect(isSensitiveHeaderName('api-version')).toBe(false);
  });
});

function writeSensitiveConfig(filename: string) {
  const configPath = path.join(tempDir, filename);
  const key = 'provider-key-secret-1234567890';
  const proxyToken = 'proxy-auth-secret-1234567890';
  const authorization = 'Bearer header-authorization-secret';
  const headerKey = 'header-api-key-secret';
  const customSecret = 'custom-header-secret';
  const diagnosticBearer = 'diagnostic-bearer-secret-1234';
  writeFileSync(configPath, JSON.stringify({
    revision: 7,
    providers: [{
      provider_id: 'provider-a',
      provider_type: 'openai_compatible',
      base_url: 'https://example.com/v1',
      api_key: [{ id: 'KEYADMIN01', key, note: '主 Key' }],
      enabled: true,
      headers: {
        Authorization: authorization,
        'x-api-key': headerKey,
        'x-service-secret': customSecret,
        'api-version': '2026-07-17',
      },
      description: '原说明',
    }],
    models: [{
      route_id: 'ROUTEADMIN1',
      client_model: 'client-model',
      provider_id: 'provider-a',
      upstream_model: 'upstream-model',
      enabled: true,
    }],
    default_client_model: 'client-model',
    proxy_auth_token: proxyToken,
  }), 'utf-8');
  return {
    configPath,
    key,
    proxyToken,
    authorization,
    headerKey,
    diagnosticBearer,
    values: [key, proxyToken, authorization, headerKey, customSecret, diagnosticBearer],
  };
}

async function closeApp(app: FastifyInstance): Promise<void> {
  await app.runtimeConfigManager.shutdown();
  await app.close();
}
