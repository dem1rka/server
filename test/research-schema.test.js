import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {researchState} from '../research-schema.ts';
test('research payload: age, form, missing answers, forged completion and trial scores',()=>{
 const assessmentId=randomUUID();
 const r={schemaVersion:1,id:randomUUID(),assessmentId,ageMonths:96,createdAt:new Date().toISOString(),kind:'questionnaire',instrument:'aq10-child',protocolVersion:'ARC-2012-English-v1',status:'completed',completedAt:new Date().toISOString(),aqVersion:'child',answers:Array(10).fill(0),respondent:'parent',language:'en',noLearningDisability:true};
 const check=record=>researchState.safeParse({schemaVersion:1,assessmentId,ageMonths:record.ageMonths,records:[record]}).success;
 assert.equal(check(r),true);
 assert.equal(check({...r,answers:Array(10).fill(null)}),false);
 assert.equal(check({...r,ageMonths:144}),false);
 assert.equal(check({...r,kind:'game'}),false);
 assert.equal(check({...r,completedAt:undefined}),false);
 const game={schemaVersion:1,id:randomUUID(),assessmentId,ageMonths:156,createdAt:new Date().toISOString(),kind:'game',instrument:'geode-neura',protocolVersion:'neura-2026-11-v1',status:'completed',completedAt:new Date().toISOString(),trials:Array.from({length:200},(_,i)=>({trial:i+1,left:Array(10).fill(1),right:Array(10).fill(0),choice:0,correct:true,rt:200,presentedAt:Array.from({length:10},(_,j)=>j*260),timingValid:true}))};
 assert.equal(check(game),true);assert.equal(check({...game,trials:game.trials.slice(1)}),false);
 assert.equal(check({...game,trials:game.trials.map(t=>({...t,correct:false}))}),false);
});
