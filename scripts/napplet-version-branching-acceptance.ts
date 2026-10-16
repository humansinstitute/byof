import {chromium,expect,type Page,type Route} from '@playwright/test';
import {existsSync,mkdirSync} from 'node:fs';

const chrome=process.env.FREEDOM_BROWSER||(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':Bun.which('chromium')||Bun.which('google-chrome'));
if(!chrome)throw Error('Chrome is required');
const origin='https://version-branch.fixture',workshop='workshop-1',projectId='project-1',owner='a'.repeat(64),out='tmp/docs/handoffs/napplet-version-branching';
mkdirSync(out,{recursive:true});
const revisions:any[]=[
 {id:'revision-1',number:1,parent_id:null,source:'v1'},
 {id:'revision-2',number:2,parent_id:'revision-1',source:'v2'},
 {id:'revision-3',number:3,parent_id:'revision-2',source:'v3'},
];
let active='revision-3',shared:string|null='revision-3';const requests:any[]=[];
const actor={pubkey:owner,name:'Owner',host:true,admin:false,identity_type:'extension',state:'admitted'};
function lineage(){const ancestors=new Set<string>();for(let row=revisions.find(r=>r.id===active);row&&!ancestors.has(row.id);row=revisions.find(r=>r.id===row.parent_id))ancestors.add(row.id);return [...revisions].sort((a,b)=>b.number-a.number).map(r=>({...r,project_id:projectId,source_hash:r.source,author:owner,created_at:r.number,lineage_status:r.id===active?'active':ancestors.has(r.id)?'ancestor':'abandoned',restored_from:null,appVersionUrl:null}));}
function detail(){return {agentName:'Builder',selectedBuilderEngine:{revision:1,runtime:{agent:'codex'}},project:{id:projectId,owner,title:'Branching Napplet',description:'Fixture',conversation_id:'conversation',current_revision:active,shared_revision:shared,appVersionUrl:null},artifacts:[],builder:{generation:0,state:'active'},builderDeletion:null,revisions:lineage(),builderPromptRevision:1,requests,consent:[],execution:null,nativeDeletionAvailable:false,generationAvailable:true,storageReady:true,generationReason:null};}
function room(){const p={...detail().project,authorPubkey:owner};return {room:{id:workshop,title:'Version Canvas',introduction:'Fixture',lightning:'',support_label:'Support',paused:0,admission:'open'},member:actor,donationQr:null,projects:[p],gallery:[],starters:[],additionalProjectsAvailable:true,board:{version:1,objects:[{id:projectId,kind:'napplet',projectId,x:24,y:24,width:440,height:424,groupId:null}],napplets:[p]}};}
const appSource=await Bun.file('public/app.js').text(),bootstrap="try { const result = await api('me'); setMember(result.member); csrf = result.csrf; await enterAfterSignIn(); } catch { screen = 'start'; render(); }";
async function fulfillStatic(route:Route,mode:'builder'|'canvas'){
 const url=new URL(route.request().url()),path=url.pathname;
 if(path==='/api/v1/browser-origin'){await route.fulfill({json:{origin}});return;}
 if(path==='/app.js'){
  const replacement=mode==='builder'?`setMember(${JSON.stringify(actor)});csrf='fixture';selectedWorkshop='${workshop}';await openProject('${projectId}');`:`setMember(${JSON.stringify(actor)});csrf='fixture';selectedWorkshop='${workshop}';state=await api('room');screen='page';render();`;
  await route.fulfill({contentType:'text/javascript',body:appSource.replace(bootstrap,replacement)});return;
 }
 if(path===`/api/v1/projects/${projectId}`&&route.request().method()==='GET'){await route.fulfill({json:detail()});return;}
 if(path===`/api/v1/projects/${projectId}/activate`){const body=route.request().postDataJSON();if(body.expectedRevisionId!==active){await route.fulfill({status:409,json:{error:'Project changed; reload before activating this version'}});return;}if(!revisions.some(r=>r.id===body.revisionId)){await route.fulfill({status:404,json:{error:'Revision not found'}});return;}active=body.revisionId;await route.fulfill({json:detail()});return;}
 if(path===`/api/v1/projects/${projectId}/requests`){const body=route.request().postDataJSON();if(body.expectedRevisionId!==active){await route.fulfill({status:409,json:{error:'Project changed'}});return;}const parent=active,number=Math.max(...revisions.map(r=>r.number))+1,id=`revision-${number}`;revisions.push({id,number,parent_id:parent,source:`v${number}-from-${revisions.find(r=>r.id===parent).source}`});active=id;requests.push({id:body.requestId,prompt:body.prompt,status:'succeeded',response:`Built v${number} from ${parent}`,mode:'build',created_at:number,attachments:[],activity:[]});await route.fulfill({json:{request:requests.at(-1),generationAvailable:true}});return;}
 if(path===`/api/v1/projects/${projectId}/preview`){const revision=url.searchParams.get('revision'),row=revisions.find(r=>r.id===revision);await route.fulfill({contentType:'text/html',body:`<!doctype html><title>${row?.source}</title><main data-version="${row?.number}">${row?.source}</main>`});return;}
 if(path==='/api/v1/room'){await route.fulfill({json:room()});return;}
 if(path.startsWith('/api/v1/')){await route.fulfill({status:404,json:{error:'Unexpected fixture API '+path}});return;}
 const file=Bun.file(path==='/'?'public/index.html':'public'+path);await route.fulfill({contentType:path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'text/html',body:await file.text()});
}
async function install(page:Page,mode:'builder'|'canvas'){await page.route('**/*',route=>fulfillStatic(route,mode));await page.goto(origin);}

const browser=await chromium.launch({executablePath:chrome,headless:true});
try{
 const builder=await browser.newPage({viewport:{width:1280,height:900}}),canvas=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];for(const page of [builder,canvas])page.on('pageerror',error=>errors.push(error.message));
 await install(builder,'builder');await install(canvas,'canvas');
 const builderFrame=builder.locator('#builder-preview iframe'),canvasFrame=canvas.locator(`[data-project-id="${projectId}"] iframe`);
 await expect(builderFrame).toHaveAttribute('src',/revision=revision-3/);await expect(canvasFrame).toHaveAttribute('src',/revision=revision-3/);
 await builder.getByRole('button',{name:/v2 · Active lineage/}).click();await expect(builderFrame).toHaveAttribute('src',/revision=revision-2/);await expect(canvasFrame).toHaveAttribute('src',/revision=revision-3/);await expect(builder.getByText('Preview only · the Canvas is still on v3.')).toBeVisible();
 await builder.getByRole('button',{name:'Push v2 to Canvas'}).click();await expect(builder.getByText('v2 · Active on Canvas')).toBeVisible();await expect(canvasFrame).toHaveAttribute('src',/revision=revision-2/,{timeout:6000});await canvas.reload();await expect(canvasFrame).toHaveAttribute('src',/revision=revision-2/);
 await builder.locator('#prompt').fill('Continue from the active v2');await builder.locator('#instruction-form').evaluate((form:HTMLFormElement)=>form.requestSubmit());await builder.reload();await expect(builder.getByText('v4 · Active on Canvas')).toBeVisible();await expect(builder.getByText('v3 · Abandoned branch')).toBeVisible();expect(revisions.find(r=>r.id==='revision-4').parent_id).toBe('revision-2');
 await builder.getByRole('button',{name:/v3 · Abandoned branch/}).click();await expect(builderFrame).toHaveAttribute('src',/revision=revision-3/);await builder.getByRole('button',{name:'Push v3 to Canvas'}).click();await expect(canvasFrame).toHaveAttribute('src',/revision=revision-3/,{timeout:6000});
 await builder.locator('#prompt').fill('Continue from v3 instead');await builder.locator('#instruction-form').evaluate((form:HTMLFormElement)=>form.requestSubmit());await builder.reload();await expect(builder.getByText('v5 · Active on Canvas')).toBeVisible();await expect(builder.getByText('v4 · Abandoned branch')).toBeVisible();expect(revisions.find(r=>r.id==='revision-5').parent_id).toBe('revision-3');
 await builder.screenshot({path:out+'/builder.png',fullPage:true});await canvas.screenshot({path:out+'/canvas.png',fullPage:true});expect(errors).toEqual([]);
 console.log(JSON.stringify({selectedPreviewDidNotMoveCanvas:true,canvasRefreshAndReload:true,v4Parent:'revision-2',v3Reactivated:true,v5Parent:'revision-3',abandonedBranchesRemainSelectable:true,errors}));
}finally{await browser.close();}
