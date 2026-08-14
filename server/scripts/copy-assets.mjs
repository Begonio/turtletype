import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tsc only emits JavaScript, so schema.sql has to be carried into dist/ by
// hand or a production image (which ships dist/ only) cannot migrate.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await mkdir(path.join(root, 'dist/db'), { recursive: true });
await copyFile(path.join(root, 'src/db/schema.sql'), path.join(root, 'dist/db/schema.sql'));

console.log('[build] copied schema.sql into dist/db');
