import 'reflect-metadata';
import {researchState} from './research-schema.ts';
import { familyRoutes } from './family.ts';
import { provision, emailField } from './roles.js';
import { Controller, Get, Post, Req, Res, Body, Param, Inject, Module, HttpCode, UseGuards, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const credentials = z.object({ email: emailField,
  password: z.string().min(12).max(128) }).strict();
const observation = z.object({ kind: z.enum(['game', 'questionnaire','mri']),
  instrument_key: z.string().min(1).max(80), instrument_version: z.string().min(1).max(40),
  language: z.enum(['ru', 'kk', 'en']).default('ru'), payload: z.record(z.string().max(80), z.json()),
  age_months: z.number().int().min(0).max(1500).nullable().default(null),
  status: z.enum(['draft', 'completed']).default('draft') }).strict();
const digest = token => createHash('sha256').update(token).digest();
function fail(statusCode, message) { throw Object.assign(new Error(message), { statusCode }); }
async function audit(db, actor_id, action, resource_type, resource_id) {
  // The runtime role has INSERT-only access to the audit table.
  await db.audit_events.createMany({data:[{actor_id, action, resource_type, resource_id, outcome:'success'}]});
}
@Injectable()
class SessionGuard {
  constructor(@Inject('db') private db, @Inject('options') private options) {}
  async canActivate(ctx) {
    const req = ctx.switchToHttp().getRequest();
    const token = req.cookies[this.options.name];
    const childToken=typeof token==='string' && /^child\.([a-f0-9-]{36})\.[a-f0-9]{64}$/.exec(token);
    if (!token || (!childToken && !/^[a-f0-9]{64}$/.test(token))) fail(401,'Войдите в аккаунт');
    const session = await this.db.sessions.findFirst({ where: { token_hash:digest(token), revoked_at:null,
      expires_at:{gt:new Date()}, users:{disabled_at:null} }, include:{users:{select:{id:true,email:true,account_role:true}}} });
    if (!session) fail(401,'Сессия истекла');
    req.user = {id:session.users.id,email:session.users.email,role:session.users.account_role};
    if(childToken){
      const route=req.routeOptions.url, scope=childToken[1];
      const allowed=route==='/api/auth/me'||route==='/api/auth/logout'||route==='/api/research/predict'||
        (['/api/assignments/:id','/api/assignments/:id/steps','/api/assignments/:id/research'].includes(route)&&req.params.id===scope);
      if(!allowed)fail(403,'Доступ ограничен');
      req.user.scope=scope;
    }
    req.sessionId = session.id;
    return true;
  }
}
@Controller('api')
class AuthController {
  constructor(@Inject('db') private db, @Inject('options') private options) {}
  @Get('health') async health() { await this.db.$queryRaw`SELECT 1`; return {ok:true}; }
  @Get('research/srs-demo/:profile') @UseGuards(SessionGuard)
  async demo(@Req() req, @Param('profile') sample) {
    if (!['specialist','admin'].includes(req.user.role)) fail(403,'Доступ ограничен');
    const profile = z.enum(['A','B','C']).parse(sample);
    const ml = new URL('../ml/',import.meta.url);
    const python = fileURLToPath(new URL(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python', ml));
    try {
      const { stdout } = await promisify(execFile)(python, [fileURLToPath(new URL('score.py', ml)), '--demo', profile],
        {timeout:30000, windowsHide:true});
      return JSON.parse(stdout);
    } catch { fail(503,'Модель временно недоступна'); }
  }
  @Post('research/predict') @UseGuards(SessionGuard)
  async predict(@Req() req,@Body() body){
    const state=researchState.parse(body);
    if(state.records.length!==1)fail(400,'Нужна одна запись');
    if(state.records[0].protocolVersion==='neura-geode-short-v1')return {available:false,reason:'Сравнение с моделью доступно только для полного режима GEODE.'};
    const endpoint=process.env.MODEL_URL || (process.env.MODEL_HOSTPORT?'http://'+process.env.MODEL_HOSTPORT:'');
    if(!endpoint||!process.env.MODEL_API_KEY)fail(503,'Сервис модели не настроен');
    try{const response=await fetch(endpoint+'/predict',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.MODEL_API_KEY},body:JSON.stringify(state.records[0]),signal:AbortSignal.timeout(15000)});
      if(!response.ok)fail(503,'Модель временно недоступна');return await response.json();
    }catch{fail(503,'Модель временно недоступна');}
  }
  @Post('accounts') @UseGuards(SessionGuard)
  async createAccount(@Req() req,@Body() body){
    if(!['admin','specialist'].includes(req.user.role))fail(403,'Недостаточно прав');
    const v=z.object({email:emailField,role:z.enum(['specialist','patient','family']),child:z.uuid().optional()}).strict().parse(body);
    if(v.child&&v.role!=='family')fail(400,'Привязка ребёнка доступна только для семейного аккаунта');
    return this.db.$transaction(async tx=>{
      if(v.child){
        const child=await tx.participants.findFirst({where:{id:v.child,...(req.user.role==='specialist'?{owner_id:req.user.id}:{})},select:{id:true}});
        if(!child)fail(404,'Карточка ребёнка не найдена');
      }
      const account=await provision(tx,v.role,v.email,req.user.id);
      if(v.child)await tx.family_children.create({data:{family_id:account.id,child_id:v.child}});
      return account;
    });
  }
  @Post('auth/login') @HttpCode(200)
  async login(@Body() body,@Res({passthrough:true}) reply) {
    const {email,password} = credentials.parse(body);
    const token = randomBytes(32).toString('hex');
    await this.db.$transaction(async db => {
      const [user] = await db.$queryRaw`SELECT id,password_hash,disabled_at FROM neura.users WHERE email=${email} FOR UPDATE`;
      const valid = await verify(user?.password_hash || this.options.dummyHash,password);
      if (!user) fail(401,'Аккаунт с таким email не найден.');
      if (!valid || user.disabled_at) fail(401,'Неверный email или пароль');
      await db.sessions.create({data:{user_id:user.id,token_hash:digest(token),expires_at:new Date(Date.now()+28800000)}});
      await audit(db,user.id,'login','user',user.id);
    });
    reply.setCookie(this.options.name,token,{...this.options.cookie,maxAge:28800});
    return {ok:true};
  }
  @Get('auth/me') @UseGuards(SessionGuard)
  me(@Req() req) { return req.user; }
  @Post('auth/logout') @HttpCode(200) @UseGuards(SessionGuard)
  async logout(@Req() req,@Res({passthrough:true}) reply) {
    await this.db.sessions.update({where:{id:req.sessionId},data:{revoked_at:new Date()}});
    reply.clearCookie(this.options.name,this.options.cookie);
    return {ok:true};
  }
  @Post('auth/logout-all') @HttpCode(200) @UseGuards(SessionGuard)
  async logoutAll(@Req() req,@Res({passthrough:true}) reply) {
    await this.db.sessions.updateMany({where:{user_id:req.user.id,revoked_at:null},data:{revoked_at:new Date()}});
    reply.clearCookie(this.options.name,this.options.cookie);
    return {ok:true};
  }
}
function visible(user_id,write=false) {
  return {OR:[{owner_id:user_id},{participant_access:{some:{user_id,OR:[{expires_at:null},{expires_at:{gt:new Date()}}],
    ...(write ? {permission:'contribute'} : {})}}}]};
}
async function access(db,user,id,write=false) {
  const row = await db.participants.findFirst({where:{id:z.uuid().parse(id),...visible(user,write)},select:{id:true}});
  if (!row) fail(404,'Запись не найдена');
}
@Injectable()
class AdminGuard {
  canActivate(ctx) {
    if (ctx.switchToHttp().getRequest().user.role !== 'admin') fail(403,'Требуются права администратора');
    return true;
  }
}
@Controller('api/admin') @UseGuards(SessionGuard,AdminGuard)
class AdminController {
  constructor(@Inject('db') private db) {}
  @Get('users') async users() {
    const users = await this.db.users.findMany({select:{id:true,email:true,account_role:true,disabled_at:true},orderBy:{email:'asc'}});
    return users.map(({account_role,...u})=>({...u,role:account_role}));
  }
  @Post('users/:id/status') async status(@Param('id') id,@Body() body,@Req() req) {
    z.uuid().parse(id);
    if ((await this.db.users.findUnique({where:{id}}))?.account_role==='admin') fail(403,'Аккаунты администраторов управляются на сервере');
    const {disabled} = z.object({disabled:z.boolean()}).strict().parse(body);
    return this.db.$transaction(async tx => {
      const changed = await tx.users.updateMany({where:{id},data:{disabled_at:disabled?new Date():null}});
      if (!changed.count) fail(404,'Аккаунт не найден');
      if (disabled) await tx.sessions.updateMany({where:{user_id:id,revoked_at:null},data:{revoked_at:new Date()}});
      await audit(tx,req.user.id,disabled?'disable':'enable','user',id);
      return {ok:true};
    });
  }
}
@Injectable()
class LegacyGuard {
  canActivate(ctx){
    const req=ctx.switchToHttp().getRequest();
    if(req.user.role==='family' && !(req.routeOptions.url==='/api/participants/:id/workspace' && req.params.id===req.user.id))
      fail(403,'Доступ ограничен');
    return true;
  }
}
@Controller('api') @UseGuards(SessionGuard,LegacyGuard)
class RecordsController {
  constructor(@Inject('db') private db) {}
  @Get('participants') async list(@Req() req) {
    const rows = await this.db.participants.findMany({where:visible(req.user.id),select:{id:true,label:true,created_at:true,owner_id:true},orderBy:{created_at:'desc'},take:100});
    return rows.map(({owner_id,...card}) => ({...card,owned:owner_id===req.user.id}));
  }
  @Post('participants') create(@Req() req,@Body() body) {
    const {label} = z.object({label:z.string().trim().min(1).max(120)}).strict().parse(body);
    return this.db.$transaction(async db => {
      const row = await db.participants.create({data:{owner_id:req.user.id,label},select:{id:true,label:true}});
      await audit(db,req.user.id,'create','participant',row.id);
      return row;
    });
  }
  @Post('participants/:id/specialist') share(@Req() req,@Param('id') id,@Body() body) {
    const {email,grant} = z.object({email:emailField,grant:z.boolean()}).strict().parse(body);
    return this.db.$transaction(async tx => {
      const card = await tx.participants.findFirst({where:{id:z.uuid().parse(id),owner_id:req.user.id}});
      if (!card) fail(404,'Карточка не найдена');
      const user = await tx.users.findUnique({where:{email},select:{id:true,disabled_at:true,account_role:true}});
      if (!user || (grant && user.disabled_at) || user.account_role!=='specialist') fail(404,'Специалист не найден');
      const key={participant_id:id,user_id:user.id};
      if (grant) await tx.participant_access.upsert({where:{participant_id_user_id:key},
        create:{...key,granted_by:req.user.id,permission:'contribute'},update:{permission:'contribute',expires_at:null}});
      else await tx.participant_access.deleteMany({where:key});
      await audit(tx,req.user.id,grant?'grant_specialist':'revoke_specialist','participant',id);
      return {ok:true};
    });
  }
  @Get('participants/:id/observations') observations(@Req() req,@Param('id') id) {
    return this.db.$transaction(async db => {
      await access(db,req.user.id,id);
      const rows = await db.observations.findMany({where:{participant_id:id},orderBy:{started_at:'desc'},take:100,
        select:{id:true,kind:true,instrument_key:true,status:true,started_at:true,revision:true}});
      await audit(db,req.user.id,'list','participant',id);
      return rows;
    });
  }
  @Post('participants/:id/observations') save(@Req() req,@Param('id') id,@Body() body) {
    const data = observation.parse(body);
    if (data.instrument_version==='workspace-v1') fail(400,'Зарезервированная версия');
    return this.db.$transaction(async db => {
      await access(db,req.user.id,id,true);
      const now = new Date();
      const row = await db.observations.create({data:{...data,participant_id:id,author_id:req.user.id,started_at:now,
        completed_at:data.status==='completed'?now:null},select:{id:true,revision:true}});
      await audit(db,req.user.id,'create','observation',row.id);
      return row;
    });
  }
  @Get('participants/:id/workspace') workspace(@Req() req,@Param('id') id) {
    return this.db.$transaction(async db => {
      await access(db,req.user.id,id);
      const rows = await db.observations.findMany({where:{participant_id:id,instrument_version:'workspace-v1'},
        select:{instrument_key:true,payload:true}});
      await audit(db,req.user.id,'read','participant',id);
      return {user:req.user.id,values:Object.fromEntries(rows.map(row => [row.instrument_key,row.payload.value]))};
    });
  }
  @Post('participants/:id/workspace') @HttpCode(200)
  saveWorkspace(@Req() req,@Param('id') id,@Body() body) {
    const {user,key,value} = z.object({user:z.uuid(),key:z.enum(['game','questionnaire','mri','screening','party-scenario-v1','research-assessments-v1']),
      value:z.json()}).strict().parse(body);
    if(key==='research-assessments-v1')researchState.parse(value);
    if (user !== req.user.id) fail(403,'Сессия изменилась');
    return this.db.$transaction(async db => {
      await access(db,user,id,true);
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id + '/' + key},0))`;
      const where = {participant_id:id,instrument_key:key,instrument_version:'workspace-v1'};
      const existing = await db.observations.findFirst({where,select:{id:true}});
      const data = {author_id:user,payload:{value}};
      const row = existing ? await db.observations.update({where:{id:existing.id},data,select:{id:true}})
        : await db.observations.create({data:{...where,...data,kind:key==='mri'?'mri':
          ['game','party-scenario-v1'].includes(key)?'game':'questionnaire'},select:{id:true}});
      await audit(db,user,'save','observation',row.id);
      return {ok:true};
    });
  }
  @Get('observations/:id') detail(@Req() req,@Param('id') id) {
    return this.db.$transaction(async db => {
      const row = await db.observations.findUnique({where:{id:z.uuid().parse(id)}});
      if (!row) fail(404,'Запись не найдена');
      await access(db,req.user.id,row.participant_id);
      await audit(db,req.user.id,'read','observation',id);
      return row;
    });
  }
}
export async function buildApp({db, origin, production=false}) {
  if (production && !origin.startsWith('https://')) throw new Error('HTTPS origin required');
  const adapter = new FastifyAdapter({bodyLimit:256*1024});
  const server = adapter.getInstance();
  await server.register(cookie);
  await server.register(helmet);
  server.addHook('onRoute',route => {
    if (route.url === '/api/auth/login') {
      route.config = {...route.config,rateLimit:false};
    } else if (['/api/invitations/accept','/api/recovery/accept'].includes(route.url)) {
      route.config = {...route.config,rateLimit:{max:10,timeWindow:'15 minutes'}};
    }
  });
  await server.register(rateLimit,{max:120,timeWindow:'1 minute'});
  server.addHook('onRequest',async (req,reply) => {
    reply.header('Cache-Control','no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && (req.headers.origin!==origin || req.headers['x-neura-request']!=='1'))
      return reply.code(403).send({error:'Недопустимый источник запроса'});
  });
  const options = {name:production?'__Host-neura_session':'neura_session',
    cookie:{path:'/',httpOnly:true,secure:production,sameSite:'strict'},dummyHash:await hash(randomBytes(32))};
  @Module({controllers:[AuthController,RecordsController,AdminController,...familyRoutes(SessionGuard)],providers:[SessionGuard,LegacyGuard,AdminGuard,{provide:'db',useValue:db},{provide:'options',useValue:options}]})
  class AppModule {}
  const app = await NestFactory.create(AppModule,adapter,{logger:false,abortOnError:false});
  app.useGlobalFilters({catch(err,host) {
    const status = err instanceof z.ZodError ? 400 : err.getStatus?.() || err.statusCode || 500;
    host.switchToHttp().getResponse().code(status).send({error:status>=500?'Ошибка сервера':err instanceof z.ZodError?'Некорректные данные':err.message});
  }});
  await app.init();
  return app;
}
