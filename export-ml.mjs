import { transform } from './ml-features.mjs';
import { PrismaClient } from '@prisma/client';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { databaseUrl } from './db.js';

const dir = new URL('../ml/private/', import.meta.url);
mkdirSync(dir, { recursive: true });
const keyFile = new URL('export.key', dir);
try { writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
catch (e) { if (e.code !== 'EEXIST') throw e; }
const key = readFileSync(keyFile);
const pseudonym = id => createHmac('sha256', key).update(id).digest('hex');
const db = new PrismaClient({ datasourceUrl: databaseUrl() });
const owner = { select: { users: { select: { email: true } } } };
try {
  const [observations, attempts] = await db.$transaction([
    db.observations.findMany({ where: { instrument_version: 'workspace-v1', instrument_key: { in: ['game','questionnaire'] } },
      select: { participant_id: true, participants: owner, users: { select: { email: true } }, instrument_key: true, payload: true } }),
    db.assignment_attempts.findMany({ select: { answers: true, completed_at: true, assignments: { select: {
      kind: true, version: true, assessments: { select: { id: true, child_id: true, participants: owner, users: { select: { email: true } } } }
    } } } }),
  ], { isolationLevel: 'RepeatableRead' });
  const { rows, counts } = transform(observations, attempts, pseudonym);
  const tmp = new URL('export-'+process.pid+'.tmp', dir);
  writeFileSync(tmp, JSON.stringify({ counts, rows }, null, 2), { mode: 0o600 });
  renameSync(tmp, new URL('neura.json', dir));
  console.log('Завершённых записей Neura в выгрузке:', rows.length);
} catch (error) {
  console.error('Выгрузка Neura не выполнена.', error.code ?? error.name);
  process.exitCode = 1;
} finally { await db.$disconnect(); }
