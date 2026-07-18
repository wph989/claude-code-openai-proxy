import { describe, expect, it } from 'vitest';
import { parseConfigRevision, safeKeyExportFilename } from '../src/routes/admin.js';

describe('admin route utils', () => {
  it('导出 Key 时清理 providerId 中不适合响应头文件名的字符', () => {
    expect(safeKeyExportFilename('provider-1')).toBe('provider-1-keys.txt');
    expect(safeKeyExportFilename('  weird "name"\r\n../x  ')).toBe('weird_name_.._x-keys.txt');
    expect(safeKeyExportFilename('')).toBe('provider-keys.txt');
  });
});

describe('admin config revision', () => {
  it('解析强弱 ETag，并拒绝缺失或非法 If-Match', () => {
    expect(parseConfigRevision('"12"')).toBe(12);
    expect(parseConfigRevision('W/"12"')).toBe(12);
    expect(() => parseConfigRevision(undefined)).toThrow('If-Match');
    expect(() => parseConfigRevision('*')).toThrow('If-Match');
  });
});
