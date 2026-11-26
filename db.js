export function databaseUrl(env = process.env) {
  if (env.DATABASE_URL) { const url=new URL(env.DATABASE_URL);url.searchParams.set('schema','neura');return url.toString(); }
  if (!env.PGPASSWORD) throw new Error('Задайте DATABASE_URL или параметры PG в server/.env');
  const host = env.PGHOST || 'localhost';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Для удалённой БД задайте DATABASE_URL с TLS');
  const url = new URL('postgresql://localhost');
  url.hostname = host === '::1' ? '[::1]' : host;
  url.port = env.PGPORT || '5432';
  url.username = encodeURIComponent(env.PGUSER || 'neura_app');
  url.password = encodeURIComponent(env.PGPASSWORD);
  url.pathname = '/' + encodeURIComponent(env.PGDATABASE || 'neura');
  url.searchParams.set('schema', 'neura');
  return url.toString();
}
