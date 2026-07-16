import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  // 每次写入使用独立临时文件，避免不同 Store 实例或进程争抢固定的 .tmp 路径。
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data), 'utf-8');
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
