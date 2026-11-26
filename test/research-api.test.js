import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {buildApp} from '../app.ts';
import {provision} from '../roles.js';
test('research assignments: ownership, child scope, paired IDs, stored results, invalid completion',{timeout:60000},async()=>{
 const prisma=new PrismaClient({datasourceUrl:'postgresql://neura_app:test-only@127.0.0.1:55439/neura?schema=neura'}),rollback=new Error('rollback');
 try{await assert.rejects(prisma.$transaction(async tx=>{
  const db=new Proxy(tx,{get(t,k){return k==='$transaction'?fn=>fn(tx):t[k]}});
  const spec=await provision(tx,'specialist',randomUUID()+'@example.invalid');
  const parent=await provision(tx,'family',randomUUID()+'@example.invalid');
  const outsider=await provision(tx,'family',randomUUID()+'@example.invalid');
  const child=await tx.participants.create({data:{owner_id:spec.id,label:'Research test'}});
  await tx.family_children.create({data:{family_id:parent.id,child_id:child.id}});
  const app=await buildApp({db,origin:'http://localhost:5173'});
  const headers={origin:'http://localhost:5173','x-neura-request':'1'};
  const call=(cookie,method,url,payload)=>app.inject({method,url,headers:{...headers,...(cookie?{cookie:'neura_session='+cookie}:{})},...(payload?{payload}:{})});
  const login=async user=>(await call(null,'POST','/api/auth/login',{email:user.email,password:user.password})).cookies[0].value;
  try{
   const sc=await login(spec),pc=await login(parent),oc=await login(outsider);
   const assigned=await call(sc,'POST',`/api/children/${child.id}/assessments`,{kinds:['game','questionnaire'],ageMonths:156});assert.equal(assigned.statusCode,201);
   const overview=(await call(sc,'GET',`/api/children/${child.id}/assessments`)).json()[0];
   const game=overview.assignments.find(x=>x.kind==='game'),q=overview.assignments.find(x=>x.kind==='questionnaire');
   assert.equal(game.research.assessmentId,q.research.assessmentId);
   assert.equal((await call(oc,'GET',`/api/assignments/${q.id}`)).statusCode,404);
   assert.equal((await call(sc,'POST',`/api/children/${child.id}/assessments`,{kinds:['game']})).statusCode,400);
   const legacy=await tx.assessments.create({data:{child_id:child.id,specialist_id:spec.id,assignments:{create:[{kind:'game',version:'1'},{kind:'questionnaire',version:'1'}]}},include:{assignments:true}});
   const old=legacy.assignments.find(a=>a.kind==='questionnaire');
   await tx.assignment_attempts.create({data:{assignment_id:old.id,answers:[0,1,2],revision:3,started_at:new Date(Date.now()-1000),completed_at:new Date()}});
   assert.equal((await call(oc,'POST',`/api/assignments/${old.id}/upgrade`,{ageMonths:96})).statusCode,404);
   assert.equal((await call(pc,'POST',`/api/assignments/${old.id}/upgrade`,{ageMonths:96})).statusCode,201);
   assert.equal((await call(pc,'POST',`/api/assignments/${old.id}/upgrade`,{ageMonths:96})).statusCode,201);
   const upgraded=(await call(pc,'GET',`/api/assignments/${old.id}`)).json();
   assert.equal(upgraded.version,'research-v1');assert.equal(upgraded.assignment_attempts,null);assert.deepEqual(upgraded.research.records,[]);
   const archives=await tx.observations.findMany({where:{instrument_key:'legacy-assignment-'+old.id}});
   assert.equal(archives.length,1);assert.deepEqual(archives[0].payload.answers,[0,1,2]);
   for(const a of legacy.assignments)assert.equal((await call(pc,'GET',`/api/assignments/${a.id}`)).json().research.ageMonths,96);
   const state=(await call(pc,'GET',`/api/assignments/${q.id}`)).json().research;
   const record={schemaVersion:1,id:randomUUID(),assessmentId:state.assessmentId,ageMonths:156,createdAt:new Date().toISOString(),kind:'questionnaire',instrument:'aq10-adolescent',protocolVersion:'ARC-2012-English-v1',status:'completed',completedAt:new Date().toISOString(),aqVersion:'adolescent',answers:Array(10).fill(0),respondent:'parent',language:'en',noLearningDisability:true};
   assert.equal((await call(pc,'POST',`/api/assignments/${q.id}/research`,{...state,records:[record]})).statusCode,201);
   assert.equal((await call(pc,'GET',`/api/assignments/${q.id}`)).json().assignment_attempts.completed_at!==null,true);
   const reordered=Object.fromEntries(Object.entries({...state,records:[record]}).reverse());
   assert.equal((await call(pc,'POST',`/api/assignments/${q.id}/research`,reordered)).statusCode,201);
   assert.equal((await call(pc,'POST',`/api/assignments/${q.id}/research`,{...state,records:[]})).statusCode,409);
   const nextOverview=(await call(sc,'GET',`/api/children/${child.id}/assessments`)).json().find(a=>a.id===overview.id);
   assert.equal(nextOverview.assignments.find(x=>x.id===q.id).research.records[0].instrument,'aq10-adolescent');
   assert.equal((await call(pc,'POST',`/api/assignments/${game.id}/research`,game.research)).statusCode,403);
   const entered=await call(pc,'POST',`/api/assignments/${game.id}/enter`,{});assert.equal(entered.statusCode,201);const cc=entered.cookies[0].value;
   assert.equal((await call(cc,'GET',`/api/assignments/${q.id}`)).statusCode,403);
   assert.equal((await call(cc,'POST',`/api/assignments/${game.id}/research`,game.research)).statusCode,201);
   assert.equal((await call(cc,'POST',`/api/assignments/${game.id}/steps`,{revision:0,answer:0})).statusCode,410);
   assert.equal((await call(cc,'POST',`/api/assignments/${game.id}/research`,{...game.research,records:[{...record,kind:'game',instrument:'geode-neura'}]})).statusCode,400);
  }finally{await app.close();}
  throw rollback;
 },{timeout:55000}),e=>{if(e!==rollback)console.error(e);return e===rollback});}finally{await prisma.$disconnect();}
});
