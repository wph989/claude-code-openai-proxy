import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/static/admin-ui.js';

describe('管理页安全转义', () => {
  it('escapes tag, attribute and textarea breakout characters', () => {
    expect(escapeHtml('</textarea><img src=x onerror="alert(1)">\'')).toBe(
      '&lt;/textarea&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;'
    );
  });

  it('keeps numeric zero visible', () => {
    expect(escapeHtml(0)).toBe('0');
  });
});
