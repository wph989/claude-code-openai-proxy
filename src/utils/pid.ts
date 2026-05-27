import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './logger.js';
import { USER_CONFIG_DIR } from '../config.js';

const USER_PID_DIR = join(USER_CONFIG_DIR, 'pids');
const PID_FILE = join(USER_PID_DIR, 'ccop.pid');
const PORT_FILE = join(USER_PID_DIR, 'ccop.port');

interface ProcessInfo {
  pid: number;
  port: number;
  host: string;
}

async function ensurePidDir(): Promise<void> {
  try {
    await mkdir(USER_PID_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

export async function writeProcessInfo(info: ProcessInfo): Promise<void> {
  await ensurePidDir();
  await writeFile(PID_FILE, String(info.pid), 'utf-8');
  await writeFile(PORT_FILE, JSON.stringify({ port: info.port, host: info.host }), 'utf-8');
  log('info', '进程信息已写入', { pid_file: PID_FILE, port: info.port, host: info.host });
}

export async function removeProcessInfo(): Promise<void> {
  try { await unlink(PID_FILE); } catch { }
  try { await unlink(PORT_FILE); } catch { }
  log('info', '进程信息已删除');
}

export async function readProcessInfo(): Promise<ProcessInfo | null> {
  try {
    const pidStr = await readFile(PID_FILE, 'utf-8');
    const portData = await readFile(PORT_FILE, 'utf-8');
    const pid = parseInt(pidStr.trim(), 10);
    const { port, host } = JSON.parse(portData) as { port: number; host: string };

    // check if process is still running
    try {
      process.kill(pid, 0);
      return { pid, port, host };
    } catch {
      // process not running, clean up stale files
      await removeProcessInfo();
      return null;
    }
  } catch {
    return null;
  }
}

export async function checkExistingProcess(port?: number): Promise<ProcessInfo | null> {
  // if port specified, check specific port
  if (port !== undefined) {
    const pidFile = join(USER_PID_DIR, `ccop-${port}.pid`);
    try {
      const pidStr = await readFile(pidFile, 'utf-8');
      const pid = parseInt(pidStr.trim(), 10);
      try {
        process.kill(pid, 0);
        return { pid, port, host: '0.0.0.0' };
      } catch {
        await unlink(pidFile).catch(() => {});
        return null;
      }
    } catch {
      return null;
    }
  }
  // otherwise check default process info
  return readProcessInfo();
}

export async function stopProcess(port?: number): Promise<string> {
  const info = await checkExistingProcess(port);
  if (!info) {
    if (port) {
      return `端口 ${port} 没有运行中的服务`;
    }
    // try to read port from file
    const portData = await readFile(PORT_FILE, 'utf-8').catch(() => null);
    if (portData) {
      const { port: savedPort } = JSON.parse(portData) as { port: number };
      await removeProcessInfo();
      return `服务已停止 (Port: ${savedPort})`;
    }
    return '没有运行中的服务';
  }

  try {
    process.kill(info.pid, 'SIGTERM');

    // 等待进程真正退出（最多等 5 秒），避免 PID 文件被过早清理
    const waitForExit = async (): Promise<void> => {
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(info.pid, 0);
          await new Promise(r => setTimeout(r, 100));
        } catch {
          return; // 进程已退出
        }
      }
    };
    await waitForExit();
    await removeProcessInfo();

    // also clean up port-specific file if exists
    const portSpecificFile = join(USER_PID_DIR, `ccop-${info.port}.pid`);
    try { await unlink(portSpecificFile); } catch { }

    return `已停止服务 (PID: ${info.pid}, Port: ${info.port})`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`停止进程失败: ${msg}`);
  }
}

export async function getStatus(port?: number): Promise<{ running: boolean; port?: number; pid?: number; host?: string }> {
  const info = await checkExistingProcess(port);
  if (info) {
    return { running: true, port: info.port, pid: info.pid, host: info.host };
  }
  return { running: false };
}

export async function openAdminUI(): Promise<string> {
  const info = await checkExistingProcess();
  if (!info) {
    throw new Error('服务未运行，请先运行: ccop start');
  }
  const protocol = 'http';
  const host = info.host === '0.0.0.0' ? '127.0.0.1' : info.host;
  const url = `${protocol}://${host}:${info.port}/admin`;
  return url;
}
