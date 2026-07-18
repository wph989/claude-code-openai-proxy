import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// TypeScript 不会删除已移除源码对应的旧产物，发布前必须清空输出目录。
await rm(path.join(root, 'dist'), { recursive: true, force: true });
