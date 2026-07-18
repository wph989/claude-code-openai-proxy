import { describe, expect, it } from 'vitest';
import { createAdminStore } from '../src/static/store.js';

describe('管理端状态仓库', () => {
  it('原子应用服务端视图并保留运行设置默认值', () => {
    const store = createAdminStore();
    store.applyServerView({
      revision: 4,
      config: { providers: [], models: [], default_client_model: null },
      proxy_auth_token_configured: true,
      key_states: { p1: [{ id: 'K1' }] },
      runtime_settings: { key_max_errors: 9 },
    }, 5);

    expect(store.revision).toBe(5);
    expect(store.proxyTokenConfigured).toBe(true);
    expect(store.runtimeSettings).toEqual({ key_auto_disable: true, key_max_errors: 9 });
    expect(store.keyStates.p1).toEqual([{ id: 'K1' }]);
  });

  it('按 Provider 更新 Key 状态而不替换其他 Provider', () => {
    const store = createAdminStore();
    store.keyStates = { p1: [{ id: 'K1' }], p2: [{ id: 'K2' }] };
    store.setProviderKeys('p1', [{ id: 'K3' }]);
    expect(store.keyStates).toEqual({ p1: [{ id: 'K3' }], p2: [{ id: 'K2' }] });
  });

  it('活动记录按 ID 去重并限制为最近 200 条', () => {
    const store = createAdminStore();
    for (let id = 1; id <= 205; id += 1) {
      store.addActivity({ id, type: 'request.completed', timestamp: '', data: {} });
    }
    store.addActivity({ id: 205, type: 'request.completed', timestamp: '', data: {} });

    expect(store.activities).toHaveLength(200);
    expect(store.activities[0].id).toBe(205);
    expect(store.activities.at(-1).id).toBe(6);
    store.clearActivities();
    expect(store.activities).toEqual([]);
  });
});
