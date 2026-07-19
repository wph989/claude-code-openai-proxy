import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const html = readFileSync(path.join(root, 'src/static/index.html'), 'utf8');
const script = readFileSync(path.join(root, 'src/static/admin.js'), 'utf8');

describe('管理端桌面信息架构', () => {
  it('保留五个独立工作视图并从概览视图启动', () => {
    for (const view of ['overview', 'providers', 'models', 'policy', 'activity']) {
      expect(html).toContain(`id="view-${view}"`);
      expect(html).toContain(`id="tab-${view}"`);
    }
    expect(script).toContain("let currentTab = 'overview';");
    expect(script).toContain('const tableSlots = {');
    expect(html).toContain('class="github-link"');
    expect(html).toContain('href="https://github.com/wph989/claude-code-openai-proxy"');
  });

  it('管理端页面不再包含旧 JSON 用量持久化字段', () => {
    expect(html).not.toMatch(/antiBanQuota|persist_every_n_requests|persist_critical_threshold|runtime_usage\.json/);
    expect(script).not.toMatch(/antiBanQuota|persist_every_n_requests|persist_critical_threshold|usage_file/);
  });
});
