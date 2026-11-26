import { readdir,readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { databaseUrl } from './db.js';
import { z } from 'zod';
const db=new PrismaClient({datasourceUrl:databaseUrl()});
const dir=new URL('./.role-grants/',import.meta.url);
try {
 const names=await readdir(dir);
 await db.$transaction(async tx=>{
   for(const name of names){
     const id=z.uuid().parse(name), role=z.enum(['admin','specialist']).parse(await readFile(new URL(name,dir),'utf8'));
     await tx.$executeRaw`UPDATE neura.users SET account_role=${role} WHERE id=${id}::uuid AND account_role='patient'`;
   }
 });
 console.log('Legacy grants imported');
} finally {await db.$disconnect();}
