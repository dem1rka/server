import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { databaseUrl } from './db.js';
import { resolve, dirname } from 'node:path';
const require = createRequire(import.meta.url);
const cli = resolve(dirname(require.resolve('prisma/package.json')), require('prisma/package.json').bin.prisma);
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: databaseUrl() }
});
process.exitCode = result.status ?? 1;

