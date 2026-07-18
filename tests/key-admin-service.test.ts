import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KeyAdminService,
  type KeyAdminGateway,
} from '../src/services/key-admin-service.js';

let gateway: KeyAdminGateway;
let service: KeyAdminService;

beforeEach(() => {
  gateway = {
    flushRuntimeStores: vi.fn(async () => undefined),
    getAdminKeyStates: vi.fn(() => []),
    exportKeys: vi.fn(() => []),
    resetAllKeys: vi.fn(async () => 0),
    addKeys: vi.fn(async () => ({ added: [], skipped: [] })),
    enableKey: vi.fn(async () => undefined),
    disableKey: vi.fn(async () => undefined),
    resetKey: vi.fn(async () => undefined),
    updateKeyState: vi.fn(async () => undefined),
    deleteKey: vi.fn(async () => undefined),
    resetKeyQuota: vi.fn(async () => undefined),
    updateKeyQuota: vi.fn(async () => undefined),
  };
  service = new KeyAdminService(gateway);
});

describe('KeyAdminService', () => {
  it('读取和导出前刷新运行态，避免返回尚未落盘的旧状态', async () => {
    vi.mocked(gateway.exportKeys).mockReturnValue(['secret-key']);

    await expect(service.listKeys('p1')).resolves.toEqual([]);
    await expect(service.exportKeys('p1')).resolves.toEqual(['secret-key']);

    expect(gateway.flushRuntimeStores).toHaveBeenCalledTimes(2);
    expect(gateway.getAdminKeyStates).toHaveBeenCalledWith('p1');
    expect(gateway.exportKeys).toHaveBeenCalledWith('p1');
  });

  it('批量新增仅返回计数和摘要，不向路由泄露 Key 字符串', async () => {
    vi.mocked(gateway.addKeys).mockResolvedValue({
      added: ['new-secret-key'],
      skipped: ['existing-secret-key'],
    });

    const result = await service.addKeys('p1', { keys: ['new-secret-key', 'existing-secret-key'] });

    expect(result).toEqual({
      message: '添加完成：新增 1 个，跳过 1 个（已存在）',
      addedCount: 1,
      skippedCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });

  it.each([
    undefined,
    {},
    { keys: [] },
    { keys: ['valid', 123] },
    { key: 123 },
  ])('拒绝无效的批量新增载荷：%j', async (input) => {
    await expect(service.addKeys('p1', input)).rejects.toThrow('至少需要一个有效的 Key 字符串');
    expect(gateway.addKeys).not.toHaveBeenCalled();
  });

  it('规范化备注并只向 Gateway 传递允许修改的字段', async () => {
    await service.updateNote('p1', 'key-1', { note: '  主账号  ', ignored: 'value' });

    expect(gateway.updateKeyState).toHaveBeenCalledWith('p1', 'key-1', { note: '主账号' });
  });

  it('在调用 Gateway 前校验配额边界', async () => {
    await expect(service.updateQuota('p1', 'key-1', {
      quota: { soft_stop_threshold: 1.2 },
    })).rejects.toThrow('soft_stop_threshold 必须在 (0, 1] 之间');
    expect(gateway.updateKeyQuota).not.toHaveBeenCalled();

    const quota = { max_requests: 100, max_tokens: 2000, soft_stop_threshold: 0.9 };
    await expect(service.updateQuota('p1', 'key-1', { quota })).resolves.toEqual(quota);
    expect(gateway.updateKeyQuota).toHaveBeenCalledWith('p1', 'key-1', quota);
  });
});
