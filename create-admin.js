import { PrismaClient } from '@prisma/client';
import { databaseUrl } from './db.js';
import { provision } from './roles.js';
const db = new PrismaClient({datasourceUrl:databaseUrl()});
try {
  const email = process.argv[2];
  if (!email) throw new Error('Укажите email нового администратора');
  console.log(await db.$transaction(tx => provision(tx,'admin',email)));
} finally { await db.$disconnect(); }
