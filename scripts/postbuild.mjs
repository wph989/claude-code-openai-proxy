import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

await mkdir(path.join(root, 'dist', 'static'), { recursive: true });
await cp(path.join(root, 'src', 'static'), path.join(root, 'dist', 'static'), { recursive: true });
