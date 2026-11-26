import {z} from 'zod';
const finite=z.number().finite();
const bin=z.array(z.number().int().min(0).max(1)).length(10);
const trial=z.object({trial:z.number().int().min(1).max(200),left:bin,right:bin,choice:z.union([z.literal(0),z.literal(1)]),correct:z.boolean(),rt:finite.nonnegative(),presentedAt:z.array(finite).length(10),timingValid:z.boolean()}).strict();
const touch=z.object({t:finite.nonnegative(),x:finite,y:finite,targetX:finite,targetY:finite,lane:z.number().int().min(0).max(4),hit:z.boolean(),duration:finite.nonnegative(),distance:finite.nonnegative(),pointer:z.enum(['mouse','touch','pen','']),cancelled:z.boolean()}).strict();
const record=z.object({sex:z.enum(['male','female','unspecified']).optional(),schemaVersion:z.literal(1),id:z.uuid(),assessmentId:z.uuid(),ageMonths:z.number().int().min(48).max(215),createdAt:z.iso.datetime(),
 kind:z.enum(['game','questionnaire']),instrument:z.enum(['bubbles-neura','geode-neura','aq10-child','aq10-adolescent','aq10-adult']),protocolVersion:z.enum(['neura-2026-11-v1','ARC-2012-English-v1','neura-aq10-i18n-v1']),
 status:z.enum(['draft','completed','interrupted']),completedAt:z.iso.datetime().optional(),answers:z.array(z.number().int().min(0).max(3).nullable()).length(10).optional(),aqVersion:z.enum(['child','adolescent','adult']).optional(),noLearningDisability:z.boolean().optional(),respondent:z.enum(['parent','self']).optional(),language:z.enum(['en','ru','kk']).optional(),answerLanguages:z.array(z.enum(['en','ru','kk']).nullable()).length(10).optional(),
 trials:z.array(trial).max(200).optional(),touches:z.array(touch).max(10000).optional(),durationMs:finite.min(0).max(20000).optional(),device:z.object({width:finite.positive(),height:finite.positive(),pixelRatio:finite.positive(),touchPoints:z.number().int().nonnegative()}).strict().optional(),
}).strict().superRefine((r,ctx)=>{
 const invalid=(message:string)=>ctx.addIssue({code:'custom',message});
 if(r.status==='completed'&&!r.completedAt)invalid('Missing completion timestamp');
 if(r.kind==='questionnaire'){
  const expected=r.ageMonths<144?'child':r.ageMonths<192?'adolescent':'adult';
  if(r.aqVersion!==expected||r.instrument!==`aq10-${expected}`||!['ARC-2012-English-v1','neura-aq10-i18n-v1'].includes(r.protocolVersion)||!r.answers||!r.language||r.respondent!==(expected==='adult'?'self':'parent'))invalid('Invalid AQ form');
  if(r.trials||r.touches)invalid('Unexpected game data');
  if(r.status==='completed'&&r.answers?.some(x=>x===null))invalid('Incomplete questionnaire');
 }else{
  if(r.protocolVersion!=='neura-2026-11-v1'||r.answers)invalid('Invalid game protocol');
  if(r.instrument==='bubbles-neura'){
   if(r.ageMonths>=132||r.trials)invalid('Invalid bubbles age or data');
   if(r.status==='completed'&&(!r.touches||r.durationMs!==20000||!r.device))invalid('Incomplete bubbles');
  }else if(r.instrument==='geode-neura'){
   if(r.ageMonths<132||r.touches)invalid('Invalid GEODE age or data');
   if(r.status==='completed'&&r.trials?.length!==200)invalid('Incomplete GEODE');
   r.trials?.forEach((t,i)=>{
    const l=t.left.reduce((a,b)=>a+b,0),rr=t.right.reduce((a,b)=>a+b,0);
    if(t.trial!==i+1||t.correct!==(t.choice===0?l>rr:rr>l))invalid('Invalid GEODE result');
   });
  }else invalid('Unknown game');
 }
});
export const researchState=z.object({sex:z.enum(['male','female','unspecified']).optional(),schemaVersion:z.literal(1),assessmentId:z.uuid(),ageMonths:z.number().int().refine(x=>x===0||(x>=48&&x<=215)),records:z.array(record).max(100)}).strict().superRefine((s,ctx)=>{
 if(new Set(s.records.map(r=>r.id)).size!==s.records.length)ctx.addIssue({code:'custom',message:'Duplicate records'});
 if(s.records.some(r=>r.assessmentId===s.assessmentId&&r.ageMonths!==s.ageMonths))ctx.addIssue({code:'custom',message:'Assessment age mismatch'});
});
