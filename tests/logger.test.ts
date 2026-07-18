import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Logger, type LoggerOutput } from '../src/utils/logger.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'logger-instance-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Logger 实例隔离', () => {
  it('不同实例独立持有级别、格式、文件和输出', async () => {
    const outputA = captureOutput();
    const outputB = captureOutput();
    const fileA = path.join(tempDir, 'a.log');
    const fileB = path.join(tempDir, 'b.log');
    const loggerA = new Logger({
      logFile: fileA,
      logLevel: 'debug',
      logFormat: 'text',
      logRotation: 'none',
    }, outputA.sink);
    const loggerB = new Logger({
      logFile: fileB,
      logLevel: 'error',
      logFormat: 'json',
      logRotation: 'none',
    }, outputB.sink);

    loggerA.log('info', '实例 A');
    loggerB.log('info', '应被过滤');
    loggerB.log('error', '实例 B');
    await Promise.all([loggerA.flush(), loggerB.flush()]);

    expect(readFileSync(fileA, 'utf8')).toContain('INFO: 实例 A');
    expect(readFileSync(fileB, 'utf8')).toContain('"message":"实例 B"');
    expect(readFileSync(fileB, 'utf8')).not.toContain('应被过滤');
    expect(outputA.stdout.join('')).toContain('实例 A');
    expect(outputB.stderr.join('')).toContain('实例 B');
  });

  it('串行写入并在 flush 后保留调用顺序', async () => {
    const file = path.join(tempDir, 'ordered.log');
    const logger = new Logger({
      logFile: file,
      logLevel: 'debug',
      logFormat: 'json',
      logRotation: 'none',
    }, captureOutput().sink);

    for (let index = 0; index < 20; index += 1) {
      logger.log('info', `event-${index}`, { index });
    }
    await logger.flush();

    const entries = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(entries).toHaveLength(20);
    expect(entries.map((entry) => entry.index)).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it('默认过滤正文类字段，详细模式仅由当前实例控制', async () => {
    const file = path.join(tempDir, 'detail.log');
    const logger = new Logger({
      logFile: file,
      logFormat: 'json',
      logRotation: 'none',
      logDetailed: false,
    }, captureOutput().sink);

    logger.log('info', '普通日志', { request_body: 'secret-body', request_id: 'req-1' });
    logger.logDetailed('info', '不会输出', { response_body: 'secret-response' });
    logger.configure({ logDetailed: true });
    logger.logDetailed('info', '详细日志', { request_body: 'allowed-detail' });
    await logger.flush();

    const content = readFileSync(file, 'utf8');
    expect(content).toContain('req-1');
    expect(content).not.toContain('secret-body');
    expect(content).not.toContain('secret-response');
    expect(content).toContain('allowed-detail');
  });
});

function captureOutput(): { sink: LoggerOutput; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    sink: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}
