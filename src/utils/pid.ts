import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './logger.js';

const getPidFilePath = (port: number): string => {
  const tmpDir = process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp';
  return join(tmpDir, `ccnp-${port}.pid`);
};

export async function writePidFile(port: number): Promise<void> {
  const pidFile = getPidFilePath(port);
  await writeFile(pidFile, String(process.pid), 'utf-8');
  log('info', 'PID 文件已写入', { pid_file: pidFile, pid: process.pid });
}

export async function removePidFile(port: number): Promise<void> {
  const pidFile = getPidFilePath(port);
  try {
    await unlink(pidFile);
    log('info', 'PID 文件已删除', { pid_file: pidFile });
  } catch {
    // ignore if not exists
  }
}

export async function checkExistingProcess(port: number): Promise<number | null> {
  const pidFile = getPidFilePath(port);
  try {
    const pidStr = await readFile(pidFile, 'utf-8');
    const pid = parseInt(pidStr.trim(), 10);
    if (isNaN(pid)) return null;

    // check if process is still running
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // process not running, clean up stale pid file
      await removePidFile(port);
      return null;
    }
  } catch {
    return null;
  }
}

export async function stopProcess(port: number): Promise<string> {
  const pid = await checkExistingProcess(port);
  if (!pid) {
    return '没有运行中的服务';
  }
  try {
    process.kill(pid, 'SIGTERM');
    await removePidFile(port);
    return `已停止 PID ${pid}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`停止进程失败: ${msg}`);
  }
}

export function getStatus(port: number): { running: boolean, port: number, pid: number | null } {
  const pidFile = getPidFilePath(port);
  try {
    const pidStr = require('node:fs').readFileSync(pidFile, 'utf-8');
    const pid = parseInt(pidStr.trim(), 10);
    try {
      process.kill(pid, 0);
      return { running: true, port, pid };
    } catch {
      return { running: false, port, pid: null };
    }
  } catch {
    return { running: false, port, pid: null };
  }
}
