import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  ensureEnvTextHasAdminAuthToken,
  generateAdminAuthToken,
  hasExplicitDevMode,
  logGeneratedAdminAuthToken,
  resolveAdminAuthToken,
  resolveUserConfigFile
} from '../src/config.js';

describe('配置模式判断', () => {
  it('daemon 简写 -d 不会触发开发模式', () => {
    expect(hasExplicitDevMode(['node', 'dist/cli.js', 'start', '-d'])).toBe(false);
    expect(hasExplicitDevMode(['node', 'dist/cli.js', 'start', '--daemon'])).toBe(false);
  });

  it('--dev 会显式触发开发模式', () => {
    expect(hasExplicitDevMode(['node', 'dist/cli.js', 'start', '--dev'])).toBe(true);
  });

  it('默认配置文件名与运行模式一致', () => {
    const root = path.resolve('ccop-root');
    expect(resolveUserConfigFile(root, true)).toBe(path.join(root, 'config.json'));
    expect(resolveUserConfigFile(root, false)).toBe(path.join(root, 'runtime_models.json'));
  });

  it('生产默认管理口令使用随机格式而不是固定弱口令', () => {
    const token = generateAdminAuthToken();
    expect(token).toMatch(/^ccop_[A-Za-z0-9_-]{32}$/);
    expect(token).not.toBe('admin123');
  });

  it('生产模式缺失管理口令时失败，开发模式才使用便捷默认值', () => {
    expect(resolveAdminAuthToken(undefined, false)).toBe('admin123');
    expect(() => resolveAdminAuthToken(undefined, true)).toThrow('生产模式必须配置 ADMIN_AUTH_TOKEN');
  });

  it('修复生产 .env 时只补齐缺失或空的管理口令', () => {
    expect(ensureEnvTextHasAdminAuthToken('PORT=8765\nADMIN_AUTH_TOKEN=kept\n', 'new-token')).toEqual({
      text: 'PORT=8765\nADMIN_AUTH_TOKEN=kept\n',
      changed: false
    });
    expect(ensureEnvTextHasAdminAuthToken('PORT=8765\nADMIN_AUTH_TOKEN=\n', 'new-token')).toEqual({
      text: 'PORT=8765\nADMIN_AUTH_TOKEN=new-token\n',
      changed: true
    });
    expect(ensureEnvTextHasAdminAuthToken('PORT=8765', 'new-token')).toEqual({
      text: 'PORT=8765\n\n# 管理后台密码（自动补齐，修改后需重启生效）\nADMIN_AUTH_TOKEN=new-token',
      changed: true
    });
  });

  it('首次生成随机管理口令时会把 token 打印到日志', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logGeneratedAdminAuthToken('/tmp/.ccop/.env', 'ccop_test_token');
      expect(spy).toHaveBeenCalledWith('[config] 随机管理口令已写入:', '/tmp/.ccop/.env');
      expect(spy).toHaveBeenCalledWith('[config] ADMIN_AUTH_TOKEN=ccop_test_token');
    } finally {
      spy.mockRestore();
    }
  });
});
