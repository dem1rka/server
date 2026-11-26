import { PrismaClient } from '@prisma/client';
import { databaseUrl } from './db.js';
const db = new PrismaClient({ datasourceUrl: databaseUrl() });
try {
  await db.users.findFirst({ select: { id: true } });
  console.log('Prisma подключена к PostgreSQL, таблица users доступна.');
} catch (err) {
  console.error('Проверка подключения не прошла', err.errorCode ?? err.code ?? err.name);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
