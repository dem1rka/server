import test from 'node:test';
import { hash } from '@node-rs/argon2';
import { provision } from '../roles.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../app.ts';

test('PostgreSQL: session, CSRF, ownership, shared access revocation; all test writes rolled back', async () => {
  // Dedicated disposable cluster only; never load the real application's .env.
  const prisma = new PrismaClient({datasourceUrl:'postgresql://neura_app:test-only@127.0.0.1:55439/neura?schema=neura'});

  const rollback = new Error('rollback fixture');
  try {
    await assert.rejects(prisma.$transaction(async client => {
    const db = new Proxy(client, {get(target,key) {
      if (key === '$transaction') return async work => work(client);
      return target[key];
    }});
    const app = await buildApp({db,origin:'http://localhost:5173'});
    try {
    const headers = { origin: 'http://localhost:5173', 'x-neura-request': '1' };
    const password = 'Test-only-' + randomUUID();
    const emails = [0, 1].map(() => `test-${randomUUID()}@example.invalid`);
    const cookies = [];
    for (const email of emails) {
      await client.users.create({data:{email,password_hash:await hash(password)}});
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { email, password } });
      assert.equal(login.statusCode, 200);
      assert.match(login.headers['set-cookie'], /HttpOnly/);
      assert.match(login.headers['set-cookie'], /SameSite=Strict/);
      cookies.push(login.cookies[0].value);
    }
    const duplicate = await app.inject({method:'POST',url:'/api/auth/register',headers,
      payload:{email:' '+emails[0].toUpperCase()+' ',password:randomUUID()}});
    assert.equal(duplicate.statusCode,404);
    const unknown = await app.inject({method:'POST',url:'/api/auth/login',headers,
      payload:{email:randomUUID()+'@example.invalid',password}});
    assert.equal(unknown.statusCode,401);
    assert.match(unknown.json().error,/не найден/);
    assert.equal(unknown.headers['set-cookie'],undefined);
    const request = (index, method, url, payload) => app.inject({ method, url,
      headers: { ...headers, cookie: `neura_session=${cookies[index]}` }, ...(payload ? { payload } : {}) });
    assert.equal((await app.inject({ method: 'GET', url: '/api/participants' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/participants',
      headers: { ...headers, origin: 'https://attacker.invalid', cookie: `neura_session=${cookies[0]}` }, payload: { label: 'x' } })).statusCode, 403);
    assert.equal((await request(0,'GET','/api/admin/users')).statusCode,403);
    assert.equal((await request(0,'POST','/api/invitations',{email:emails[1],role:'specialist'})).statusCode,403);
    assert.equal((await request(0,'GET','/api/auth/me')).json().role,'patient');
    assert.equal((await app.inject({method:'POST',url:'/api/auth/register',headers,
      payload:{email:randomUUID()+'@example.invalid',password,role:'admin'}})).statusCode,404);
    const created = await request(0, 'POST', '/api/participants', { label: 'SECURITY TEST' });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;
    const endpoint = `/api/participants/${id}/observations`;
    const entry = { kind: 'game', instrument_key: 'test', instrument_version: '1', payload: { answers: [] } };
    const saved = await request(0, 'POST', endpoint, entry);
    assert.equal(saved.statusCode, 201);
    assert.equal((await request(1, 'GET', endpoint)).statusCode, 404);
    assert.equal((await request(1, 'POST', endpoint, entry)).statusCode, 404);
    const recordUrl = `/api/observations/${saved.json().id}`;
    assert.equal((await request(1, 'GET', recordUrl)).statusCode, 404);
    assert.equal((await request(0, 'GET', recordUrl)).statusCode, 200);
    assert.deepEqual((await request(1, 'GET', '/api/participants')).json(), []);
    const users = await client.users.findMany({where:{email:{in:emails}}});
    const ids = emails.map(email => users.find(u => u.email === email).id);
    await client.participant_access.create({data:{participant_id:id,user_id:ids[1],permission:'read',granted_by:ids[0]}});
    assert.equal((await request(1, 'GET', recordUrl)).statusCode, 200);
    assert.equal((await request(1, 'POST', endpoint, entry)).statusCode, 404);
    await client.participant_access.deleteMany({where:{participant_id:id}});
    assert.equal((await request(1, 'GET', recordUrl)).statusCode, 404);
    assert.equal((await request(0, 'POST', endpoint, { ...entry, author_id: ids[1] })).statusCode, 400);
    const hashes = users.find(user => user.id === ids[0]);
    assert.match(hashes.password_hash, /^\$argon2id\$/);
    const workspace = '/api/participants/' + id + '/workspace';
    const data = {user:ids[0],key:'game',value:{answers:[]}};
    assert.equal((await request(0,'POST',workspace,data)).statusCode,200);
    assert.equal((await request(0,'POST',workspace,{...data,value:{answers:[1]}})).statusCode,200);
    assert.deepEqual((await request(0,'GET',workspace)).json().values.game,{answers:[1]});
    assert.equal((await request(1,'GET',workspace)).statusCode,404);
    const admin = await provision(client,'admin',randomUUID()+'@example.invalid');

    const loginAs = async account => {
      const result = await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.'+(cookies.length+20),headers,payload:{email:account.email,password:account.password}});
      assert.equal(result.statusCode,200);
      cookies.push(result.cookies[0].value);
      return cookies.length-1;
    };
    const adminIndex=await loginAs(admin);
    assert.equal((await request(adminIndex,'GET',recordUrl)).statusCode,404);
    const email=randomUUID()+'@example.invalid';
    const issued=await request(adminIndex,'POST','/api/invitations',{email,role:'specialist'});
    assert.equal(issued.statusCode,201);
    const accept=token=>app.inject({method:'POST',url:'/api/invitations/accept',headers,payload:{token,password}});
    assert.equal((await accept(issued.json().token)).statusCode,201);
    assert.equal((await accept(issued.json().token)).statusCode,404);
    const specialist={...await client.users.findUniqueOrThrow({where:{email}}),password};
    const specIndex=await loginAs(specialist);
    assert.equal((await request(specIndex,'GET','/api/auth/me')).json().role,'specialist');
    assert.equal((await request(specIndex,'GET','/api/admin/users')).statusCode,403);
    assert.equal((await request(specIndex,'GET',recordUrl)).statusCode,404);
    const accessUrl='/api/participants/'+id+'/specialist';
    assert.equal((await request(0,'POST',accessUrl,{email:specialist.email,grant:true})).statusCode,201);
    assert.equal((await request(specIndex,'GET',recordUrl)).statusCode,200);
    assert.equal((await request(0,'POST',accessUrl,{email:specialist.email,grant:false})).statusCode,201);
    assert.equal((await request(specIndex,'GET',recordUrl)).statusCode,404);
    const child=(await request(specIndex,'POST','/api/participants',{label:'Test child'})).json();
    const familyEmail=randomUUID()+'@example.invalid';
    const invite=(await request(specIndex,'POST','/api/invitations',{email:familyEmail,role:'family',child:child.id})).json();
    assert.equal((await accept(invite.token)).statusCode,201);
    const familyIndex=await loginAs({email:familyEmail,password});
    assert.equal((await request(familyIndex,'GET',recordUrl)).statusCode,403);
    assert.equal((await request(familyIndex,'GET','/api/family/children')).json().length,1);
    assert.equal((await request(specIndex,'POST','/api/children/'+child.id+'/assessments',{kinds:['game','questionnaire'],ageMonths:156})).statusCode,201);
    const task=(await request(familyIndex,'GET','/api/family/children')).json()[0].assessments[0].assignments.find(t=>t.kind==='questionnaire');
    const path='/api/assignments/'+task.id;
    const stranger=await provision(client,'family',randomUUID()+'@example.invalid');
    const foreign=await loginAs(stranger);
    assert.deepEqual((await request(foreign,'GET','/api/family/children')).json(),[]);
    assert.equal((await request(foreign,'GET',path)).statusCode,404);
    assert.equal((await request(foreign,'POST',path+'/steps',{revision:0,answer:0})).statusCode,404);
    assert.equal((await request(familyIndex,'POST','/api/invitations',{email:familyEmail,role:'specialist'})).statusCode,403);
    for(const creator of [specIndex,adminIndex])for(const role of ['specialist','patient','family']){
      const email=randomUUID()+'@example.invalid';
      const created=await request(creator,'POST','/api/accounts',{email,role,...(role==='family'?{child:child.id}:{})});
      assert.equal(created.statusCode,201);assert.equal(created.json().role,role);
      const login=await loginAs(created.json());assert.equal((await request(login,'GET','/api/auth/me')).json().role,role);
      if(role==='family')assert.equal((await request(login,'GET','/api/family/children')).json()[0].id,child.id);
      assert.equal((await request(creator,'POST','/api/accounts',{email,role})).statusCode,409);
    }
    assert.equal((await request(familyIndex,'POST','/api/accounts',{email:randomUUID()+'@example.invalid',role:'specialist'})).statusCode,403);
    assert.equal((await request(0,'POST','/api/accounts',{email:randomUUID()+'@example.invalid',role:'patient'})).statusCode,403);
    assert.equal((await request(specIndex,'POST','/api/accounts',{email:randomUUID()+'@example.invalid',role:'admin'})).statusCode,400);
    assert.equal((await request(specIndex,'POST','/api/accounts',{email:randomUUID()+'@example.invalid',role:'family',child:id})).statusCode,404);
    const expired=(await request(specIndex,'POST','/api/invitations',{email:familyEmail,role:'family',child:child.id})).json();
    await client.invitations.updateMany({where:{email:familyEmail,consumed_at:null},data:{expires_at:new Date(0)}});
    assert.equal((await accept(expired.token)).statusCode,404);
    assert.equal((await request(0,'GET',path)).statusCode,403);
    assert.equal((await request(familyIndex,'POST',path+'/steps',{revision:0,answer:0})).statusCode,410);
    assert.equal((await request(familyIndex,'GET',path)).json().research.ageMonths,156);
    assert.equal((await app.inject({method:'GET',url:'/api/materials/demo/mprage.nii.gz'})).statusCode,401);
    assert.equal((await request(adminIndex,'POST','/api/admin/users/'+specialist.id+'/status',{disabled:true})).statusCode,201);
    assert.equal((await request(specIndex,'GET','/api/auth/me')).statusCode,401);
    assert.equal((await request(0, 'POST', '/api/auth/logout-all', {})).statusCode, 200);
    assert.equal((await request(0, 'GET', '/api/auth/me')).statusCode, 401);
    } finally { await app.close(); }
    throw rollback;
    },{timeout:60000}), error => error === rollback);
  } finally { await prisma.$disconnect(); }
});
