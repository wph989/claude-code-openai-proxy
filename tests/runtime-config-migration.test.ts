import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeConfigManager } from '../src/services/runtime-config.js';
import { createApp } from '../src/server.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'rcm-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function writeConfig(p: string, body: unknown) {
  writeFileSync(p, JSON.stringify(body), 'utf-8');
}

describe('RuntimeConfigManager — id 化 + state 文件', () => {
  it('为缺失 id 的旧配置补 id 并重写 runtime_models.json', async () => {
    const cfgPath = path.join(tmp, 'runtime_models.json');
    writeConfig(cfgPath, {
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        api_key: [
          { key: 'sk-1', enabled: true },
          { key: 'sk-2', enabled: true }
        ],
        timeout_seconds: 300,
        enabled: true,
        headers: {}
      }],
      models: [],
      default_client_model: null
    });

    const mgr = new RuntimeConfigManager(cfgPath);
    await mgr.init();

    const cleaned = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const persistedKeys = cleaned.providers[0].api_key;
    expect(persistedKeys[0].id).toMatch(/^[0-9A-Z]{10}$/);
    expect(persistedKeys[1].id).toMatch(/^[0-9A-Z]{10}$/);
    expect(persistedKeys[0].id).not.toBe(persistedKeys[1].id);
    expect(persistedKeys[0]).toEqual({ id: persistedKeys[0].id, key: 'sk-1' });
    expect(persistedKeys[0].error_count).toBeUndefined();
    expect(persistedKeys[0].last_error_message).toBeUndefined();

    await mgr.shutdown();
  });

  it('忽略 v1 旧 runtime_state.json，全部重置为空', async () => {
    const cfgPath = path.join(tmp, 'runtime_models.json');
    writeConfig(cfgPath, {
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        api_key: [{ id: 'AAAAAAAAAA', key: 'sk-1' }],
        timeout_seconds: 300,
        enabled: true,
        headers: {}
      }],
      models: [],
      default_client_model: null
    });

    const statePath = path.join(tmp, 'runtime_state.json');
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      updated_at: 1700000000,
      states: {
        'p1:sk-1': { error_count: 9, last_error_message: '老格式应被丢弃' }
      }
    }), 'utf-8');

    const mgr = new RuntimeConfigManager(cfgPath);
    await mgr.init();
    const states = mgr.getKeyStates('p1');
    expect(states[0].error_count).toBe(0);
    expect(states[0].last_error_message).toBeNull();
    expect(states[0].enabled).toBe(true);

    await mgr.shutdown();
  });

  it('v2 state 文件按 providerId:id 索引可以正常 rehydrate', async () => {
    const cfgPath = path.join(tmp, 'runtime_models.json');
    writeConfig(cfgPath, {
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        api_key: [{ id: 'BBBBBBBBBB', key: 'sk-1' }],
        timeout_seconds: 300,
        enabled: true,
        headers: {}
      }],
      models: [],
      default_client_model: null
    });

    const statePath = path.join(tmp, 'runtime_state.json');
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      updated_at: 1700000000,
      states: {
        'p1:BBBBBBBBBB': { error_count: 4, auto_disabled_at: 1700000000000, last_error_message: 'quota' }
      }
    }), 'utf-8');

    const mgr = new RuntimeConfigManager(cfgPath);
    await mgr.init();
    const states = mgr.getKeyStates('p1');
    const k = states[0];
    expect(k.error_count).toBe(4);
    expect(k.last_error_message).toBe('quota');
    expect(k.enabled).toBe(false);
    expect(k.auto_disabled_at).toBe(1700000000000);

    await mgr.shutdown();
  });

  it('saveConfig 写出的 runtime_models.json 不含运行态字段', async () => {
    const cfgPath = path.join(tmp, 'runtime_models.json');
    writeConfig(cfgPath, {
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        api_key: [{ id: 'CCCCCCCCCC', key: 'sk-1' }],
        timeout_seconds: 300,
        enabled: true,
        headers: {}
      }],
      models: [],
      default_client_model: null
    });

    const mgr = new RuntimeConfigManager(cfgPath);
    await mgr.init();

    await mgr.saveConfig({
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        api_key: [{
          id: 'CCCCCCCCCC',
          key: 'sk-1',
          enabled: true,
          error_count: 99,
          disabled_at: null,
          last_error_at: null,
          last_error_message: 'bad',
          auto_disabled_at: null,
          note: 'hello'
        }],
        timeout_seconds: 300,
        enabled: true,
        headers: {}
      }],
      models: [],
      default_client_model: null
    });

    const cleaned = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const persisted = cleaned.providers[0].api_key[0];
    expect(persisted.id).toBe('CCCCCCCCCC');
    expect(persisted.key).toBe('sk-1');
    expect(persisted.note).toBe('hello');
    expect(persisted.error_count).toBeUndefined();
    expect(persisted.last_error_message).toBeUndefined();

    await mgr.shutdown();
  });

  it('启动时自动把 state / usage 文件对齐到当前 config 全量 key', async () => {
    const cfgPath = path.join(tmp, 'runtime_models.json');
    writeConfig(cfgPath, {
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        api_key: [
          { id: 'NEW0000001', key: 'sk-1' },
          { id: 'NEW0000002', key: 'sk-2' }
        ],
        timeout_seconds: 300,
        enabled: true,
        headers: {}
      }],
      models: [],
      default_client_model: null
    });

    // state 文件预存一个已不存在的 key（应被清掉），并漏掉新增的两个（应被补上）。
    const statePath = path.join(tmp, 'runtime_state.json');
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      updated_at: 1700000000,
      states: { 'p1:STALE00000': { error_count: 99 } }
    }), 'utf-8');

    const mgr = new RuntimeConfigManager(cfgPath);
    await mgr.init();
    await mgr.shutdown();

    const stateAfter = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(stateAfter.states['p1:STALE00000']).toBeUndefined();
    expect(stateAfter.states['p1:NEW0000001']).toEqual({
      error_count: 0, disabled_at: null, last_error_at: null, last_error_message: null, auto_disabled_at: null
    });
    expect(stateAfter.states['p1:NEW0000002']).toEqual({
      error_count: 0, disabled_at: null, last_error_at: null, last_error_message: null, auto_disabled_at: null
    });

    const usagePath = path.join(tmp, 'runtime_usage.json');
    expect(existsSync(usagePath)).toBe(true);
    const usageAfter = JSON.parse(readFileSync(usagePath, 'utf-8'));
    expect(usageAfter.usage['p1:NEW0000001']).toEqual({ requests_used: 0, tokens_used: 0 });
    expect(usageAfter.usage['p1:NEW0000002']).toEqual({ requests_used: 0, tokens_used: 0 });
  });

  it('改 key 字面量但保留 id 可以保留历史', async () => {
    const cfgPath = path.join(tmp, 'runtime_models.json');
    writeConfig(cfgPath, {
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        api_key: [{ id: 'DDDDDDDDDD', key: 'sk-old' }],
        timeout_seconds: 300,
        enabled: true,
        headers: {}
      }],
      models: [],
      default_client_model: null
    });

    const statePath = path.join(tmp, 'runtime_state.json');
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      updated_at: 1700000000,
      states: {
        'p1:DDDDDDDDDD': { error_count: 7, last_error_message: 'pre-rotate' }
      }
    }), 'utf-8');

    const mgr = new RuntimeConfigManager(cfgPath);
    await mgr.init();

    await mgr.saveConfig({
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        api_key: [{ id: 'DDDDDDDDDD', key: 'sk-new', enabled: true } as any],
        timeout_seconds: 300,
        enabled: true,
        headers: {}
      }],
      models: [],
      default_client_model: null
    });

    const states = mgr.getKeyStates('p1');
    expect(states[0].key).toBe('sk-new');
    expect(states[0].error_count).toBe(7);
    expect(states[0].last_error_message).toBe('pre-rotate');

    await mgr.shutdown();
  });

  it('供应商级 quota 作为默认值，key 级 quota 优先覆盖', async () => {
    const cfgPath = path.join(tmp, 'runtime_models.json');
    writeConfig(cfgPath, {
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        quota: { max_requests: 100, max_tokens: 1000, soft_stop_threshold: 0.8 },
        api_key: [
          { id: 'DEFAULT001', key: 'sk-default' },
          { id: 'OVERRIDE01', key: 'sk-override', quota: { max_requests: 5, max_tokens: null, soft_stop_threshold: 1 } },
          { id: 'NOQUOTA001', key: 'sk-noquota', quota: null }
        ],
        timeout_seconds: 300,
        enabled: true,
        headers: {}
      }],
      models: [],
      default_client_model: null
    });

    const mgr = new RuntimeConfigManager(cfgPath);
    await mgr.init();
    const states = mgr.getKeyStates('p1');

    expect(states[0].quota).toEqual({ max_requests: 100, max_tokens: 1000, soft_stop_threshold: 0.8 });
    expect(states[1].quota).toEqual({ max_requests: 5, max_tokens: null, soft_stop_threshold: 1 });
    expect(states[2].quota).toBeNull();

    await mgr.shutdown();
  });

  it('resetKey 同时清零该 key 的配额用量并写入 usage 文件', async () => {
    const cfgPath = path.join(tmp, 'runtime_models.json');
    writeConfig(cfgPath, {
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        api_key: [{ id: 'RESET00001', key: 'sk-1', quota: { max_requests: 10, max_tokens: null, soft_stop_threshold: 1 } }],
        timeout_seconds: 300,
        enabled: true,
        headers: {}
      }],
      models: [{ client_model: 'm', provider_id: 'p1', upstream_model: 'u', enabled: true }],
      default_client_model: 'm'
    });

    const mgr = new RuntimeConfigManager(cfgPath);
    await mgr.init();
    const { rotator } = mgr.resolveModel('m');
    rotator.recordUsage('sk-1', 3, 12);
    await mgr.shutdown();

    await mgr.resetKey('p1', 0);
    await mgr.shutdown();

    const usagePath = path.join(tmp, 'runtime_usage.json');
    const usageAfter = JSON.parse(readFileSync(usagePath, 'utf-8'));
    expect(usageAfter.usage['p1:RESET00001']).toEqual({ requests_used: 0, tokens_used: 0 });
  });

  it('resetAllKeys 重建 rotator 后不会把旧配额用量重新显示出来', async () => {
    const cfgPath = path.join(tmp, 'runtime_models.json');
    writeConfig(cfgPath, {
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        api_key: [{ id: 'RESETALL01', key: 'sk-1', quota: { max_requests: 10, max_tokens: null, soft_stop_threshold: 1 } }],
        timeout_seconds: 300,
        enabled: true,
        headers: {}
      }],
      models: [{ client_model: 'm', provider_id: 'p1', upstream_model: 'u', enabled: true }],
      default_client_model: 'm'
    });
    writeFileSync(path.join(tmp, 'runtime_usage.json'), JSON.stringify({
      version: 2,
      updated_at: 1700000000,
      usage: {
        'p1:RESETALL01': { requests_used: 4, tokens_used: 21 }
      }
    }), 'utf-8');

    const mgr = new RuntimeConfigManager(cfgPath);
    await mgr.init();
    expect(mgr.getKeyStates('p1')[0].usage).toEqual({ requests_used: 4, tokens_used: 21 });

    await mgr.resetAllKeys('p1');

    const [state] = mgr.getKeyStates('p1');
    expect(state.usage).toEqual({ requests_used: 0, tokens_used: 0 });

    await mgr.shutdown();
    const usageAfter = JSON.parse(readFileSync(path.join(tmp, 'runtime_usage.json'), 'utf-8'));
    expect(usageAfter.usage['p1:RESETALL01']).toEqual({ requests_used: 0, tokens_used: 0 });
  });

  it('resetAllKeys 会覆盖旧 runtime_state，后续保存配置不会恢复禁用状态', async () => {
    const cfgPath = path.join(tmp, 'runtime_models.json');
    writeConfig(cfgPath, {
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        api_key: [{ id: 'STATEALL01', key: 'sk-1' }],
        timeout_seconds: 300,
        enabled: true,
        headers: {}
      }],
      models: [],
      default_client_model: null
    });
    writeFileSync(path.join(tmp, 'runtime_state.json'), JSON.stringify({
      version: 2,
      updated_at: 1700000000,
      states: {
        'p1:STATEALL01': {
          error_count: 9,
          auto_disabled_at: 1700000000000,
          last_error_at: 1700000000000,
          last_error_message: 'old quota'
        }
      }
    }), 'utf-8');

    const mgr = new RuntimeConfigManager(cfgPath);
    await mgr.init();
    expect(mgr.getKeyStates('p1')[0].enabled).toBe(false);

    await mgr.resetAllKeys('p1');
    await mgr.saveConfig(mgr.getConfig());

    const [state] = mgr.getKeyStates('p1');
    expect(state.enabled).toBe(true);
    expect(state.error_count).toBe(0);
    expect(state.auto_disabled_at).toBeNull();
    expect(state.last_error_message).toBeNull();

    await mgr.shutdown();
    const stateAfter = JSON.parse(readFileSync(path.join(tmp, 'runtime_state.json'), 'utf-8'));
    expect(stateAfter.states['p1:STATEALL01']).toEqual({
      error_count: 0,
      disabled_at: null,
      last_error_at: null,
      last_error_message: null,
      auto_disabled_at: null
    });
  });

  it('OpenAI 非流式 2xx 响应会按 usage 写入配额用量', async () => {
    const cfgPath = path.join(tmp, 'runtime_models.json');
    writeConfig(cfgPath, {
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com/v1',
        api_key: [{ id: 'CHATUSE001', key: 'sk-1', quota: { max_requests: 10, max_tokens: 1000, soft_stop_threshold: 1 } }],
        timeout_seconds: 300,
        enabled: true,
        headers: {},
        anti_ban: { min_interval_ms: 0, retry: { max_attempts: 1 } }
      }],
      models: [{ client_model: 'm', provider_id: 'p1', upstream_model: 'u', enabled: true }],
      default_client_model: 'm'
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: 'u',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 }
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const app = await createApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
      });
      expect(response.statusCode).toBe(200);
      await app.runtimeConfigManager.shutdown();
    } finally {
      await app.close();
      globalThis.fetch = originalFetch;
    }

    const usageAfter = JSON.parse(readFileSync(path.join(tmp, 'runtime_usage.json'), 'utf-8'));
    expect(usageAfter.usage['p1:CHATUSE001']).toEqual({ requests_used: 1, tokens_used: 18 });
  });

  it('Anthropic 非流式透传成功后释放 key lease 并记录 usage', async () => {
    const cfgPath = path.join(tmp, 'runtime_models.json');
    writeConfig(cfgPath, {
      providers: [{
        provider_id: 'p1',
        provider_type: 'anthropic',
        base_url: 'https://example.com/v1',
        api_key: [{ id: 'ANTHUSE001', key: 'sk-1', quota: { max_requests: 10, max_tokens: 1000, soft_stop_threshold: 1 } }],
        timeout_seconds: 300,
        enabled: true,
        headers: {},
        anti_ban: { min_interval_ms: 0, retry: { max_attempts: 1 } }
      }],
      models: [{ client_model: 'm', provider_id: 'p1', upstream_model: 'u', enabled: true }],
      default_client_model: 'm'
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'msg-1',
      type: 'message',
      role: 'assistant',
      model: 'u',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 7 }
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const app = await createApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 }
      });
      expect(response.statusCode).toBe(200);
      expect(app.runtimeConfigManager.getKeyStates('p1')[0].active_requests).toBe(0);
      await app.runtimeConfigManager.shutdown();
    } finally {
      await app.close();
      globalThis.fetch = originalFetch;
    }

    const usageAfter = JSON.parse(readFileSync(path.join(tmp, 'runtime_usage.json'), 'utf-8'));
    expect(usageAfter.usage['p1:ANTHUSE001']).toEqual({ requests_used: 1, tokens_used: 12 });
  });
});
