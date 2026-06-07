import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf-8');
  await rename(tmp, filePath);
}
