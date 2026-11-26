import { Controller, Get, Post, Req, Res, Param, Body, Inject, UseGuards, StreamableFile } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { hash, verify } from '@node-rs/argon2';
import { emailField } from './roles.js';
import {researchState} from './research-schema.ts';

function deny(code=403){throw Object.assign(new Error(code===404?'Запись не найдена':'Доступ ограничен'),{statusCode:code});}
const digest=(token:string)=>createHash('sha256').update(token).digest();
const uuid=z.uuid();
async function owned(db,user,id){
  if(user.role!=='specialist') deny();
  if(!await db.participants.findFirst({where:{id:uuid.parse(id),owner_id:user.id}})) deny(404);
}
const assets = new Set(['demo/mprage.nii.gz','demo/nyu-rest-demo.nii.gz','papers/s12880-026-02514-w.pdf','papers/s41398-024-03024-5.pdf']);
export function familyRoutes(guard){
 @Controller('api')
 class Invitations {
  constructor(@Inject('db') private db){}
  @Get('materials/papers/:name') paper(@Param('name') name){
    const key='papers/'+name;
    if(!assets.has(key)) deny(404);
    return new StreamableFile(createReadStream(new URL('./materials/'+key,import.meta.url)),{type:'application/pdf'});
  }
  @Post('invitations') @UseGuards(guard)
  async issue(@Req() req,@Body() body){
    const v=z.object({email:emailField,role:z.enum(['patient','specialist','family']),child:z.uuid().optional()}).strict().parse(body);
    if(v.role==='family') await owned(this.db,req.user,v.child);
    else if(req.user.role!=='admin'||v.child) deny();
    const token=randomBytes(32).toString('hex');
    await this.db.invitations.create({data:{email:v.email,role:v.role,issuer:req.user.id,child_id:v.child,token_hash:digest(token),expires_at:new Date(Date.now()+48*3600000)}});
    return {token};
  }
  @Post('recovery/issue') @UseGuards(guard) async recoveryLink(@Req() req,@Body() body){
    if(req.user.role!=='admin') deny();
    const {id}=z.object({id:z.uuid()}).strict().parse(body);
    const target=await this.db.users.findUnique({where:{id}});
    if(!target||target.disabled_at||target.account_role==='admin')deny();
    const token=randomBytes(32).toString('hex');
    await this.db.auth_tokens.create({data:{user_id:id,purpose:'reset_password',token_hash:digest(token),expires_at:new Date(Date.now()+3600000)}});
    return {token};
  }
  @Post('recovery/accept') async reset(@Body() body){
    const {token,password}=z.object({token:z.string().regex(/^[a-f0-9]{64}$/),password:z.string().min(12).max(128)}).strict().parse(body);
    return this.db.$transaction(async tx=>{
      const key={token_hash:digest(token)};
      const ticket=await tx.auth_tokens.findUnique({where:key});
      if(!ticket)deny(404);
      await tx.$queryRaw`SELECT id FROM neura.users WHERE id=${ticket.user_id}::uuid FOR UPDATE`;
      const changed=await tx.auth_tokens.updateMany({where:{...key,purpose:'reset_password',consumed_at:null,expires_at:{gt:new Date()},users:{disabled_at:null,account_role:{not:'admin'}}},data:{consumed_at:new Date()}});
      if(!changed.count)deny(404);
      await tx.users.update({where:{id:ticket.user_id},data:{password_hash:await hash(password)}});
      await tx.auth_tokens.updateMany({where:{user_id:ticket.user_id,purpose:'reset_password',consumed_at:null},data:{consumed_at:new Date()}});
      await tx.sessions.updateMany({where:{user_id:ticket.user_id,revoked_at:null},data:{revoked_at:new Date()}});
      return {ok:true};
    });
  }
  @Post('invitations/accept') async accept(@Body() body){
    const {token,password}=z.object({token:z.string().regex(/^[a-f0-9]{64}$/),password:z.string().min(12).max(128)}).strict().parse(body);
    return this.db.$transaction(async tx=>{
      const key={token_hash:digest(token)};
      const changed=await tx.invitations.updateMany({where:{...key,consumed_at:null,expires_at:{gt:new Date()}},data:{consumed_at:new Date()}});
      if(!changed.count) deny(404);
      const inv=await tx.invitations.findUniqueOrThrow({where:key});
      const issuer=await tx.users.findUniqueOrThrow({where:{id:inv.issuer}});
      if(issuer.disabled_at) deny();
      if(inv.role==='family') await owned(tx,{id:issuer.id,role:issuer.account_role},inv.child_id);
      else if(issuer.account_role!=='admin') deny();
      let user=await tx.users.findUnique({where:{email:inv.email}});
      if(user){
        if(user.account_role!==inv.role||user.disabled_at||!await verify(user.password_hash,password)) deny();
      } else {
        user=await tx.users.create({data:{email:inv.email,account_role:inv.role,password_hash:await hash(password)}});
      }
      if(inv.child_id){
        const link={family_id:user.id,child_id:inv.child_id};
        await tx.family_children.upsert({where:{family_id_child_id:link},create:link,update:{}});
      }
      return {email:inv.email};
    });
  }
 }
 @Controller('api') @UseGuards(guard)
 class Family {
  constructor(@Inject('db') private db,@Inject('options') private options){}
  @Get('materials/demo/:name') material(@Param('name') name){
    const key='demo/'+name;if(!assets.has(key)) deny(404);
    return new StreamableFile(createReadStream(new URL('./materials/'+key,import.meta.url)),{type:'application/octet-stream'});
  }
  @Post('personal-card') async personalCard(@Req() req){
    const id=req.user.id;
    const card=await this.db.participants.upsert({where:{id},create:{id,owner_id:id,label:req.user.email},update:{},select:{id:true,owner_id:true}});
    if(card.owner_id!==id)deny();
    return {id:card.id};
  }
  @Post('children/:id/assessments') async assign(@Req() req,@Param('id') id,@Body() body){
    await owned(this.db,req.user,id);
    const {kinds,ageMonths,sex}=z.object({sex:z.enum(['male','female','unspecified']).optional(),kinds:z.array(z.enum(['questionnaire','game'])).min(1).max(2),ageMonths:z.number().int().min(48).max(215)}).strict().parse(body);
    return this.db.$transaction(async tx=>{
      const a=await tx.assessments.create({data:{child_id:id,specialist_id:req.user.id,assignments:{create:[...new Set(kinds)].map(kind=>({kind,version:'research-v1'}))}},include:{assignments:true}});
      for(const task of a.assignments)await tx.observations.create({data:{participant_id:id,author_id:req.user.id,kind:task.kind,instrument_key:'research-assignment-'+task.id,instrument_version:'research-v1',age_months:ageMonths,payload:{schemaVersion:1,assessmentId:a.id,ageMonths,...(sex?{sex}:{}),records:[]}}});
      return {id:a.id};
    });
  }
  @Get('children/:id/assessments') async overview(@Req() req,@Param('id') id){
    await owned(this.db,req.user,id);
    const assessments=await this.db.assessments.findMany({where:{child_id:id},orderBy:{created_at:'desc'},include:{assignments:{include:{assignment_attempts:{select:{completed_at:true,revision:true,answers:true}}}}}});
    const rows=await this.db.observations.findMany({where:{participant_id:id,instrument_version:'research-v1'},select:{instrument_key:true,payload:true}});
    return assessments.map(a=>({...a,assignments:a.assignments.map(task=>({...task,research:rows.find(r=>r.instrument_key==='research-assignment-'+task.id)?.payload??null}))}));
  }
  @Get('family/children') children(@Req() req){
    if(req.user.role!=='family') deny();
    return this.db.participants.findMany({where:{family_children:{some:{family_id:req.user.id}}},orderBy:{label:'asc'},select:{id:true,label:true,assessments:{orderBy:{created_at:'desc'},select:{id:true,created_at:true,assignments:{select:{id:true,kind:true,version:true,assignment_attempts:{select:{completed_at:true,revision:true}}}}}}}});
  }
  async task(db,user,id){
    if(user.role!=='family') deny();
    const row=await db.assignments.findFirst({where:{id:uuid.parse(id),assessments:{participants:{family_children:{some:{family_id:user.id}}}}},include:{assignment_attempts:true,assessments:{select:{participants:{select:{label:true}}}}}});
    if(!row) deny(404);
    return row;
  }
  @Post('assignments/:id/enter') async enter(@Req() req,@Param('id') id,@Res({passthrough:true}) reply){
    const token='child.'+uuid.parse(id)+'.'+randomBytes(32).toString('hex');
    await this.db.$transaction(async tx=>{
      const row=await this.task(tx,req.user,id);
      if(row.kind!=='game'||row.version!=='research-v1'||row.assignment_attempts?.completed_at)deny();
      const closed=await tx.sessions.updateMany({where:{id:req.sessionId,revoked_at:null},data:{revoked_at:new Date()}});
      if(!closed.count)deny(401);
      await tx.sessions.create({data:{user_id:req.user.id,token_hash:digest(token),expires_at:new Date(Date.now()+2*3600000)}});
    });
    reply.setCookie(this.options.name,token,{...this.options.cookie,maxAge:7200});
    return {ok:true};
  }
  @Get('assignments/:id') async read(@Req() req,@Param('id') id){
    const task=await this.task(this.db,req.user,id);
    const research=task.version==='research-v1'?await this.db.observations.findFirst({where:{instrument_key:'research-assignment-'+id,instrument_version:'research-v1'},select:{payload:true}}):null;
    return {...task,research:research?.payload??null,child_mode:req.user.scope===id};
  }
  @Post('assignments/:id/research') saveResearch(@Req() req,@Param('id') id,@Body() body){
    const state=researchState.parse(body);
    return this.db.$transaction(async tx=>{
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${uuid.parse(id)},0))`;
      const task=await this.task(tx,req.user,id);
      if(task.version!=='research-v1'||(task.kind==='game'&&req.user.scope!==id))deny();
      const row=await tx.observations.findFirst({where:{instrument_key:'research-assignment-'+id,instrument_version:'research-v1'}});
      if(!row)deny(404);
      if(state.assessmentId!==task.assessment_id||state.ageMonths!==row.age_months||state.records.some(r=>r.kind!==task.kind||r.assessmentId!==task.assessment_id||r.ageMonths!==row.age_months))deny(400);
      if(row.status==='completed'){
        if(isDeepStrictEqual(row.payload,state))return {ok:true};
        deny(409);
      }
      const done=state.records.some(r=>r.status==='completed');
      await tx.observations.update({where:{id:row.id},data:{payload:state,status:done?'completed':'draft',completed_at:done?new Date():null,revision:{increment:1}}});
      const data={revision:done?1:0,completed_at:done?new Date():null};
      await tx.assignment_attempts.upsert({where:{assignment_id:id},create:{assignment_id:id,...data},update:data});
      return {ok:true};
    });
  }
  // Old records keep their original answers. Upgrade explicitly from the parent session.
  @Post('assignments/:id/upgrade') async upgrade(@Req() req,@Param('id') id,@Body() body){
    if(req.user.scope)deny();
    const {ageMonths}=z.object({ageMonths:z.number().int().min(48).max(215)}).strict().parse(body);
    return this.db.$transaction(async tx=>{
      const original=await this.task(tx,req.user,id);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${original.assessment_id},0))`;
      const task=await this.task(tx,req.user,id);
      if(task.version==='research-v1')return {ok:true};
      if(task.version!=='1')deny(400);
      const assessment=await tx.assessments.findUnique({where:{id:task.assessment_id},include:{assignments:{include:{assignment_attempts:true}}}});
      const siblings=await tx.observations.findMany({where:{instrument_key:{in:assessment.assignments.map(a=>'research-assignment-'+a.id)},instrument_version:'research-v1'}});
      if(siblings.some(r=>r.age_months!==ageMonths))deny(409);
      for(const old of assessment.assignments.filter(a=>a.version==='1')){
        if(old.assignment_attempts){
          const attempt=old.assignment_attempts;
          await tx.observations.create({data:{participant_id:assessment.child_id,author_id:assessment.specialist_id,kind:old.kind,instrument_key:'legacy-assignment-'+old.id,instrument_version:'1',status:attempt.completed_at?'completed':'draft',started_at:attempt.started_at,completed_at:attempt.completed_at,payload:{assignmentId:old.id,answers:attempt.answers,revision:attempt.revision,startedAt:attempt.started_at?.toISOString(),completedAt:attempt.completed_at?.toISOString()??null}}});
          await tx.assignment_attempts.delete({where:{assignment_id:old.id}});
        }
        await tx.assignments.update({where:{id:old.id},data:{version:'research-v1'}});
        await tx.observations.create({data:{participant_id:assessment.child_id,author_id:assessment.specialist_id,kind:old.kind,instrument_key:'research-assignment-'+old.id,instrument_version:'research-v1',age_months:ageMonths,payload:{schemaVersion:1,assessmentId:assessment.id,ageMonths,records:[]}}});
      }
      return {ok:true};
    });
  }
  @Post('assignments/:id/steps') async advance(@Req() req,@Param('id') id){await this.task(this.db,req.user,id);deny(410);}
 }
 return [Invitations,Family];
}
