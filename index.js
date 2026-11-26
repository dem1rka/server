import { PrismaClient } from '@prisma/client';
import { databaseUrl } from './db.js';
import { buildApp } from './app.ts';
const db = new PrismaClient({datasourceUrl:databaseUrl()});
try {
  await db.users.findFirst({select:{id:true}});
  const app = await buildApp({db, origin:process.env.APP_ORIGIN || 'http://localhost:5173',production:process.env.NODE_ENV==='production'});
  await app.listen(Number(process.env.PORT || 3001),'0.0.0.0');
  console.log('Neura API СЃР»СѓС€Р°РµС‚',await app.getUrl());
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal,async () => { await app.close(); await db.$disconnect(); });
} catch (err) {
  console.error('РћС€РёР±РєР° Р·Р°РїСѓСЃРєР°:',err.errorCode || err.code || err.name);
  await db.$disconnect();
  process.exitCode = 1;
}

