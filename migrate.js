import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { databaseUrl } from './db.js';

const connection = new URL(databaseUrl());
connection.searchParams.delete('schema');

const statements = [
  'SELECT pg_advisory_xact_lock(78140391);',
  'CREATE TABLE IF NOT EXISTS public.neura_migrations (name text PRIMARY KEY);',
];
for (const name of ['001_initial.sql', '003_family.sql']) {
  const sql = await readFile(new URL('./database/' + name, import.meta.url), 'utf8');
  statements.push(
    "SELECT NOT EXISTS (SELECT FROM public.neura_migrations WHERE name = '" + name + "') AS apply_migration \\gset",
    '\\if :apply_migration',
    sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, ''),
    "INSERT INTO public.neura_migrations (name) VALUES ('" + name + "');",
    '\\endif',
  );
}

execFileSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-'], {
  input: statements.join('\n') + '\n',
  env: {
    ...process.env,
    PGHOST: connection.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: connection.port || '5432',
    PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGSSLMODE: connection.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer',
  },
  stdio: ['pipe', 'inherit', 'inherit'],
});
