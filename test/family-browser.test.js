import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {createRequire} from 'node:module';
const frontendRequire=createRequire(new URL('../../neura/package.json',import.meta.url));
const {chromium}=frontendRequire('playwright');
const {preview}=frontendRequire('vite');
import { buildApp } from '../app.ts';
import { provision } from '../roles.js';

async function runScenario(scenario) {
 const db=new PrismaClient({datasourceUrl:'postgresql://neura_app:test-only@127.0.0.1:55439/neura?schema=neura'});
 const origin='http://127.0.0.1:55174', rollback=new Error('rollback');
 try{
 await assert.rejects(db.$transaction(async tx=>{
 const scoped=new Proxy(tx,{get(target,key){return key==='$transaction'?work=>work(tx):target[key]}});
 const spec=await provision(tx,'specialist',randomUUID()+'@example.invalid');
 const admin=await provision(tx,'admin',randomUUID()+'@example.invalid');
 const familyEmail=randomUUID()+'@example.invalid',password=randomUUID();
 const app=await buildApp({db:scoped,origin});
 await app.listen(55173,'127.0.0.1');
 const ui=await preview({configFile:false,root:'../neura',preview:{host:'127.0.0.1',port:55174,strictPort:true,proxy:{'/api':'http://127.0.0.1:55173'}}});
 let browser;
 try {
 browser=await chromium.launch({channel:'msedge'});
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
 page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const headers={origin,'x-neura-request':'1'};
 const http=async(path,data)=>{const res=await page.request.post(origin+'/api'+path,{data,headers});assert.equal(res.ok(),true,path+' '+res.status());return res.json()};
 await scenario({page,browser,origin,tx,headers,http,spec,admin,familyEmail,password});
 assert.deepEqual(errors,[]);
 }finally{await browser?.close();await ui.close();await app.close();}
 throw rollback;
 },{timeout:145000}),e=>{if(e!==rollback)console.error(e);return e===rollback});
 }finally{await db.$disconnect();}
}

test('public pages and analysis links for all four roles',{timeout:150000},()=>runScenario(async ({page,browser,origin,tx,headers,spec,admin})=>{
 for(const path of ['/','/about','/evidence']){
   await page.goto(origin+path);
   await page.locator('h1').first().waitFor();
   assert.equal(new URL(page.url()).pathname,path);
 }
 const articles=await page.locator('a[href^="/api/materials/papers/"]').evaluateAll(links=>[...new Set(links.map(a=>a.href))]);
 assert.equal(articles.length,2);
 for(const link of articles){
   const pdf=await page.request.get(link);
   assert.equal(pdf.status(),200);
   assert.equal((await pdf.body()).subarray(0,4).toString(),'%PDF');
 }
 const accounts=[spec,admin,await provision(tx,'patient',randomUUID()+'@example.invalid'),await provision(tx,'family',randomUUID()+'@example.invalid')];
 for(const user of accounts){
   const context=await browser.newContext();
   try{
     const tab=await context.newPage();
     const login=await tab.request.post(origin+'/api/auth/login',{headers,data:{email:user.email,password:user.password}});
     assert.equal(login.status(),200);
     for(const path of ['/game','/questionnaire','/mri','/dashboard']){
       await tab.goto(origin+'/account/'+user.role);
       await tab.locator('.cabinet-tools a[href="'+path+'"]').click();
       await tab.locator('.route-'+path.slice(1)+' h1, .route-'+path.slice(1)+' h2').first().waitFor();
       assert.equal(new URL(tab.url()).pathname,path);
     }
     const card=await tx.participants.findUniqueOrThrow({where:{id:user.id}});
     assert.equal(card.owner_id,user.id);
   }finally{await context.close();}
 }
}));

test('closed family workflow in Edge, mobile layouts, languages and appearance',{timeout:150000},()=>runScenario(async ({page,origin,tx,headers,http,spec,admin,familyEmail,password})=>{
 for(const path of ['/dashboard','/game','/questionnaire','/mri','/assignments/'+randomUUID()]){
 await page.goto(origin+path);await page.locator('#auth-password').waitFor();
 assert.equal(await page.locator('button[type=submit]').count(),1);
 }
 assert.equal((await page.request.get(origin+'/api/materials/demo/mprage.nii.gz')).status(),401);
 const oldFile=await page.request.get(origin+'/demo/mprage.nii.gz');assert.ok((await oldFile.body()).length<10000);
 await http('/auth/login',{email:spec.email,password:spec.password});
 const children=[];const tokens=[];
 for(const label of ['Алия','Тимур']){
 const child=await http('/participants',{label});children.push(child.id);
 await http('/children/'+child.id+'/assessments',{kinds:['game','questionnaire'],ageMonths:156});
 tokens.push((await http('/invitations',{email:familyEmail,role:'family',child:child.id})).token);
 }
 await http('/auth/logout',{});
 for(const token of tokens){
 await page.goto(origin+'/invite#'+token);await page.locator('input[name=password]').fill(password);
 await page.locator('form button').click();await page.locator('main a[href="/account"]').waitFor();
 }
 await page.goto(origin+'/account');await page.locator('#auth-email').fill(familyEmail);await page.locator('#auth-password').fill(password);
 await page.locator('button[type=submit]').click();await page.waitForURL('**/account/family');
 for (const [lang,heading] of [['en','My children'],['kk','Менің балаларым'],['ru','Мои дети']]){
   await page.locator('.preferences-controls select:visible').selectOption(lang);
   await page.getByRole('heading',{name:heading}).waitFor();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
 await page.screenshot({path:'../neura/test-results/family-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Тимур',exact:true}).click();await page.getByRole('heading',{name:/Тимур/}).waitFor();
 await page.locator('.family-row').filter({hasText:'Исследовательская игра'}).click();
 await page.getByRole('button',{name:'Начать игру',exact:true}).click();
 await page.getByLabel('Полных лет').waitFor();
 assert.equal((await page.request.get(origin+'/api/family/children')).status(),403);
 await page.getByRole('button',{name:'Начать игру',exact:true}).click();
 await page.getByRole('button',{name:'Завершить раньше'}).click();
 await page.getByText('Запись сохранена',{exact:true}).waitFor();
 for(const width of [320,390,768,1440]){
 await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow '+width);
 }
 await page.screenshot({path:'../neura/test-results/assigned-result-mobile.png',fullPage:true});
 await page.goto(origin+'/game/report');await page.waitForURL('**/assignments/*');
 await page.getByRole('button',{name:'Вход для родителя'}).click();
 await page.locator('#auth-password').waitFor();await http('/auth/login',{email:familyEmail,password});
 await page.goto(origin+'/account');await page.waitForURL('**/account/family');
 const list=await (await page.request.get(origin+'/api/family/children')).json();
 const other=list.find(c=>c.label==='Алия');assert.ok(other.assessments[0].assignments.every(a=>!a.assignment_attempts));
 await page.locator('.family-row').filter({hasText:'Анкета'}).click();
 await page.getByLabel('У участника нет интеллектуальных').check();await page.getByLabel('Я понимаю вопросы').check();
 await page.getByRole('button',{name:'Начать анкету',exact:true}).click();
 for(let i=0;i<10;i++)await page.locator(`input[name="aq-${i}"]`).first().check();
 await page.getByRole('button',{name:'Завершить анкету',exact:true}).click();
 await page.getByText('Результат сохранён',{exact:true}).waitFor();
 await page.reload();await page.locator('.protocol-score').waitFor();
 await http('/auth/logout',{});await http('/auth/login',{email:admin.email,password:admin.password});
 const user=await tx.users.findUniqueOrThrow({where:{email:familyEmail}});
 const recovery=await http('/recovery/issue',{id:user.id});await http('/auth/logout',{});
 await page.goto(origin+'/recover#'+recovery.token);await page.locator('input[name=password]').fill(password+'new');
 await page.locator('form button').click();await page.locator('main a[href="/account"]').waitFor();
 await http('/auth/login',{email:familyEmail,password:password+'new'});
}));
