import { mkdir, writeFile } from 'node:fs/promises';

await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await writeFile(new URL('./dist/index.js', import.meta.url), 'export default 42;\n');

console.log('fixture build complete');
