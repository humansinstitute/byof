import { chromium, expect as baseExpect } from "@playwright/test";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { autopilotRepository } from "./autopilot-runtime.ts";
const expect = baseExpect.configure({timeout:45000});
const mainUrl = process.env.FREEDOM_ACCEPTANCE_URL || "https://soft-pod-shed.rick.runwingman.com";
const evidence = resolve("tmp/docs/handoffs/browser"); mkdirSync(evidence, {recursive:true});
const browser = await chromium.launch({ executablePath: process.env.FREEDOM_BROWSER || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless:true });
const errors: string[] = [], checks: string[] = [], previewEvidence: any[] = [];
function track(page: any) { page.on("pageerror",(error: Error)=>errors.push(error.message));page.on('response',async(response:any)=>{if(response.url().includes('/preview?'))previewEvidence.push({url:response.url(),status:response.status(),headers:await response.allHeaders()});}); }
try {
  const context = await browser.newContext({viewport:{width:1440,height:1000}}), page = await context.newPage(); track(page);
  await page.goto(mainUrl,{waitUntil:"domcontentloaded",timeout:60000}); await expect(page.getByRole("heading",{name:"I’m taking part"})).toBeVisible();
  await page.screenshot({path:evidence+"/live-desktop-landing.png",fullPage:true});
  const reference = await context.newPage();
  const referenceHtml = process.env.FREEDOM_REFERENCE_HTML;
  if (!referenceHtml) throw new Error("FREEDOM_REFERENCE_HTML must point to the workshop reference HTML");
  await reference.setContent(await Bun.file(referenceHtml).text());
  await reference.screenshot({path:evidence+"/mock-desktop-landing.png",fullPage:true});
  for (const p of [page,reference]) { await p.setViewportSize({width:390,height:844}); }
  await page.screenshot({path:evidence+"/live-mobile-landing.png",fullPage:true}); await reference.screenshot({path:evidence+"/mock-mobile-landing.png",fullPage:true});
  await page.getByRole("button",{name:"Log in as a user"}).click(); await page.getByLabel("Display name").fill("Browser participant A"); await page.getByRole("button",{name:"Get Started"}).click();
  await expect(page.getByRole("heading",{name:"Waiting for host admission"})).toBeVisible();
  const identityA = await page.evaluate(async()=>{ const response=await fetch('/api/v1/me'); return (await response.json()).member; });
  await page.reload({waitUntil:"domcontentloaded",timeout:60000}); await expect(page.getByRole("heading",{name:"Waiting for host admission"})).toBeVisible();
  expect(await page.evaluate(async()=> (await (await fetch('/api/v1/me')).json()).member.pubkey)).toBe(identityA.pubkey);
  const secondContext = await browser.newContext(), second = await secondContext.newPage(); track(second);
  await second.goto(mainUrl,{waitUntil:"domcontentloaded",timeout:60000}); await second.getByRole("button",{name:"Log in as a user"}).click(); await second.getByLabel("Display name").fill("Browser participant B"); await second.getByRole("button",{name:"Get Started"}).click(); await expect(second.getByRole("heading",{name:"Waiting for host admission"})).toBeVisible();
  expect(await second.evaluate(async()=> (await (await fetch('/api/v1/me')).json()).member.pubkey)).not.toBe(identityA.pubkey);
  checks.push("Main deployment: two independent browser-generated identities, challenge login and reload persistence; invitation/host admission enforced");
  await context.close(); await secondContext.close();
  // Independent managed fixture uses a newly generated test host. Pete's live identity/configuration is untouched.
  const secret = generateSecretKey(), root = resolve("tmp/docs/handoffs/managed-browser-fixture"); mkdirSync(root,{recursive:true});
  writeFileSync(root+"/package.json",JSON.stringify({name:"freedomtools-browser-fixture",scripts:{start:`bun ${resolve('src/server.ts')}`}}));
  async function appctl(args: string[]) { const p = Bun.spawn(["bun","clis/appctl.ts",...args,"--json"],{cwd:autopilotRepository,stdout:"pipe",stderr:"pipe"}); const output=await new Response(p.stdout).text(), error=await new Response(p.stderr).text(); if(await p.exited!==0) throw new Error(error+output); return JSON.parse(output); }
  const priorFixture = Bun.file(evidence+"/managed-fixture.json");
  const registered = await priorFixture.exists() ? await appctl(["status",(await priorFixture.json()).id]) : await appctl(["register","freedomtools-browser-fixture","--directory",root,"--web-app"]), id = registered.app.id, fixtureUrl = registered.app.primaryUrl;
  writeFileSync(root+"/.env",`FREEDOM_HOST_NPUB=${getPublicKey(secret)}\nFREEDOM_ORIGIN=${fixtureUrl}\nFREEDOM_DATA_DIR=${root}/data-${Date.now()}\nFREEDOM_VERSION=0.1.0-browser-fixture\n`);
  const start = await appctl([registered.app.status?.running ? "restart" : "start",id]); writeFileSync(evidence+"/managed-fixture.json",JSON.stringify({id,url:fixtureUrl,port:start.app.webAppPort,status:start.app.status},null,2));
  const hostContext = await browser.newContext({viewport:{width:1440,height:1000}}), host = await hostContext.newPage(); track(host);
  await host.exposeFunction("testHostSign",(event:any)=>finalizeEvent(event,secret));
  await host.addInitScript(()=>{ (window as any).nostr={signEvent:(event:any)=>(window as any).testHostSign(event)}; });
  await host.goto(fixtureUrl,{waitUntil:"domcontentloaded",timeout:60000}); await host.getByRole("button",{name:"Log in as admin"}).click(); await host.getByLabel("Display name").fill("Fixture host"); await host.getByRole("button",{name:"Log in with browser extension"}).click(); await expect(host.getByRole("button",{name:"Open identity menu"})).toBeVisible();
  await host.getByRole("button",{name:"Open identity menu"}).click(); await host.getByRole("button",{name:"Edit page & donations"}).click(); await host.getByLabel("Workshop heading").fill("Fixture workshop"); await host.getByLabel("Lightning address").fill("hello@getalby.com"); await host.getByRole("button",{name:"Save page"}).click(); await expect(host.getByRole("heading",{name:"Fixture workshop"})).toBeVisible();
  const contexts = [await browser.newContext({viewport:{width:1440,height:1000}}),await browser.newContext({viewport:{width:390,height:844}})], participants = await Promise.all(contexts.map(c=>c.newPage()));
  for (let i=0;i<2;i++) {
    const participant=participants[i]!;track(participant);await participant.goto(fixtureUrl,{waitUntil:"domcontentloaded",timeout:60000});await participant.getByRole("button",{name:"Log in as a user"}).click();await participant.getByLabel("Display name").fill(`Fixture participant ${i+1}`);await participant.getByRole("button",{name:"Get Started"}).click();await expect(participant.getByRole("heading",{name:"Waiting for host admission"})).toBeVisible();
  }
  await host.getByRole("button",{name:"Open identity menu"}).click();await host.getByRole("button",{name:"Manage room"}).click();
  for(let i=0;i<2;i++) { const row=host.locator('.row').filter({has:host.getByText(`Fixture participant ${i+1}`,{exact:true})}); await row.getByRole('button',{name:'Admit',exact:true}).click(); await expect(row.getByRole('button',{name:'Admit',exact:true})).toHaveCount(0); }
  for(let i=0;i<2;i++) {
    const p=participants[i]!;await p.getByRole('button',{name:'Check admission'}).click();await p.getByRole('button',{name:'Make your mark',exact:false}).first().click();await p.getByRole('button',{name:'Use this starter'}).nth(i).click();await expect(p.getByRole('heading',{name:'Build with your agent'})).toBeVisible();
    if(i===0) {await p.frameLocator('iframe').getByRole('button',{name:'Catch!'}).click();await expect(p.frameLocator('iframe').locator('#score')).toHaveText('1');}
    else {await p.frameLocator('iframe').getByLabel('New task').fill('Actual todo');await p.frameLocator('iframe').getByRole('button',{name:'Add task'}).click();await expect(p.frameLocator('iframe').getByText('Actual todo')).toBeVisible();}
    await p.getByLabel('Your next instruction').fill(`Private instruction from ${i+1}`);await p.getByRole('button',{name:'Save instruction'}).click();await expect(p.locator('.message.user').filter({hasText:`Private instruction from ${i+1}`})).toBeVisible();
    await expect(p.frameLocator('iframe').getByRole('heading',{name:i?'Your checklist':'Catch an idea'})).toBeVisible();
    await p.screenshot({path:evidence+`/fixture-${i?'mobile':'desktop'}-builder.png`,fullPage:true});await p.reload({waitUntil:"domcontentloaded",timeout:60000});await p.getByRole('button',{name:i?'Todo app':'Small game',exact:true}).click();await expect(p.locator('.message.user').filter({hasText:`Private instruction from ${i+1}`})).toBeVisible();
    await p.getByRole('button',{name:'Add to workshop page'}).click();await p.getByRole('button',{name:'Add this version'}).click();await p.getByLabel('I agree to public publication').check();
  }
  await expect(participants[0]!.locator('#public-consent')).toBeChecked();
  const ids = await Promise.all(participants.map(p=>p.evaluate(async()=>{ const room=await (await fetch('/api/v1/room')).json();return room.projects[0].id; })));
  const denied = await participants[1]!.evaluate(async id=>(await fetch('/api/v1/projects/'+id)).status,ids[0]); expect(denied).toBe(404);
  await participants[1]!.getByRole('button',{name:'Workshop page',exact:false}).first().click();
  await participants[1]!.locator('.gallery .card').filter({has:participants[1]!.getByRole('heading',{name:'Small game',exact:true})}).getByRole('button',{name:'Fork',exact:true}).click();
  await expect(participants[1]!.getByRole('heading',{name:'Small game fork'})).toBeVisible();expect(await participants[1]!.locator('.message.user').filter({hasText:'Private instruction from 1'}).count()).toBe(0);
  const restoreStatus = await participants[0]!.evaluate(async id=>{
    const me=await (await fetch('/api/v1/me')).json(), detail=await (await fetch('/api/v1/projects/'+id)).json();
    return (await fetch('/api/v1/projects/'+id+'/restore',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':me.csrf},body:JSON.stringify({revisionId:detail.project.current_revision,expectedRevisionId:detail.project.current_revision})})).status;
  },ids[0]); expect(restoreStatus).toBe(200);
  await participants[0]!.reload({waitUntil:'domcontentloaded',timeout:60000});await participants[0]!.getByRole('button',{name:'Small game',exact:true}).click();
  await participants[0]!.getByRole('button',{name:'Restore as new'}).click();await expect(participants[0]!.getByText('Version 3',{exact:true})).toBeVisible();
  const measurements=await Promise.all(participants.map((p,i)=>p.evaluate(async id=>{
    const me=await (await fetch('/api/v1/me')).json(), detail=await (await fetch('/api/v1/projects/'+id)).json(), start=performance.now();
    const receipts=await Promise.all(Array.from({length:25},async(_,n)=>{const t=performance.now(),r=await fetch('/api/v1/projects/'+id+'/requests',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':me.csrf},body:JSON.stringify({requestId:crypto.randomUUID(),expectedRevisionId:detail.project.current_revision,prompt:'Concurrent capacity receipt '+n})});return {status:r.status,body:await r.json(),ms:performance.now()-t};}));return {elapsedMs:performance.now()-start,receipts};
  },ids[i])));for(const result of measurements) for(const receipt of result.receipts){expect(receipt.status).toBe(200);expect(receipt.body.request.status).toBe('unavailable');}
  writeFileSync(evidence+'/concurrent-submissions.json',JSON.stringify({count:50,participants:2,buildersInvoked:0,measurements},null,2));
  await host.getByRole('button',{name:'Open identity menu'}).click();await host.getByRole('button',{name:'Publish workshop',exact:true}).click();await expect(host.getByText('Publication unavailable:',{exact:false})).toBeVisible();expect(await host.getByRole('button',{name:'Publish nsite + Napplets'}).isDisabled()).toBe(true);
  await host.getByRole('button',{name:'Open identity menu'}).click();await host.getByRole('button',{name:'Manage room',exact:true}).click();
  await host.getByRole('button',{name:'Pause room building',exact:true}).click();await expect(host.getByRole('button',{name:'Resume building',exact:true})).toBeVisible();
  const paused=await participants[0]!.evaluate(async id=>{const me=await(await fetch('/api/v1/me')).json(),d=await(await fetch('/api/v1/projects/'+id)).json();return(await fetch('/api/v1/projects/'+id+'/requests',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':me.csrf},body:JSON.stringify({requestId:crypto.randomUUID(),expectedRevisionId:d.project.current_revision,prompt:'Paused submission denial'})})).status;},ids[0]);expect(paused).toBe(403);
  await host.getByRole('button',{name:'Resume building',exact:true}).click();await expect(host.getByRole('button',{name:'Pause room building',exact:true})).toBeVisible();
  const appRow=host.locator('.row').filter({has:host.getByText('Small game',{exact:true})});await appRow.getByRole('button',{name:'Inspect',exact:true}).click();await expect(host.getByText('Host inspection is read only.',{exact:true})).toBeVisible();expect(await host.getByRole('button',{name:'Save instruction'}).count()).toBe(0);
  await host.getByRole('button',{name:'Workshop page',exact:false}).first().click();await host.getByRole('button',{name:'Support this workshop',exact:true}).click();await expect(host.getByRole('link',{name:'Open in wallet',exact:true})).toHaveAttribute('href','lightning:hello@getalby.com');
  await host.getByRole('button',{name:'Open identity menu'}).click();await host.getByRole('button',{name:'Manage room',exact:true}).click();
  const visibilityRow=host.locator('.row').filter({has:host.getByText('Small game',{exact:true})});await visibilityRow.getByRole('button',{name:'Hide',exact:true}).click();await expect(visibilityRow.getByRole('button',{name:'Show',exact:true})).toBeVisible();await visibilityRow.getByRole('button',{name:'Show',exact:true}).click();await expect(visibilityRow.getByRole('button',{name:'Hide',exact:true})).toBeVisible();
  await host.getByRole('button',{name:'Create invitation',exact:true}).click();await expect(host.locator('dialog pre')).toBeVisible();const invite=await host.locator('dialog pre').innerText();await host.locator('dialog').getByRole('button',{name:'Close',exact:true}).click();
  const invitedContext=await browser.newContext(),invited=await invitedContext.newPage();await invited.goto(fixtureUrl,{waitUntil:'domcontentloaded',timeout:60000});await invited.getByRole('button',{name:'Log in as a user',exact:false}).click();await invited.getByLabel('Display name').fill('Invited fixture participant');await invited.getByLabel('Invitation code (if provided)').fill(invite);await invited.getByRole('button',{name:'Get Started',exact:false}).click();await expect(invited.getByRole('heading',{name:'Your projects',exact:true})).toBeVisible();await invitedContext.close();
  const allowanceRow=host.locator('.row').filter({has:host.getByText('Fixture participant 1',{exact:true})});await allowanceRow.getByRole('button',{name:'Set allowance',exact:true}).click();await host.getByLabel('Instructions allowed (0–100)').fill('12');await host.getByRole('button',{name:'Save allowance',exact:true}).click();await expect(allowanceRow.getByText('admitted · 12 instructions allowed',{exact:true})).toBeVisible();
  const row=host.locator('.row').filter({has:host.getByText('Fixture participant 1',{exact:true})});await row.getByRole('button',{name:'Remove & ban',exact:true}).click();await host.locator('dialog').getByRole('button',{name:'Remove & ban',exact:true}).click();
  await participants[0]!.reload({waitUntil:"domcontentloaded",timeout:60000});await expect(participants[0]!.getByRole('heading',{name:'Access removed for this room'})).toBeVisible();
  const banned=host.locator('.row').filter({has:host.getByText('Fixture participant 1',{exact:true})});await banned.getByRole('button',{name:'Unban',exact:true}).click();await participants[0]!.getByRole('button',{name:'Check admission'}).click();await expect(participants[0]!.getByRole('heading',{name:'Your projects'})).toBeVisible();
  writeFileSync(evidence+'/preview-headers.json',JSON.stringify(previewEvidence,null,2));
  checks.push('Managed fixture: real signed host account, host admission, settings/donation link, two participant starters, private saved instructions/reload, source fork with independent history, ownership denial, exact consent, publication gate, specific ban/unban, invitation admission, pause denial/resume, allowance, read-only host inspect and hide/show');
  for(const p of participants) expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]); writeFileSync(evidence+'/results.json',JSON.stringify({mainUrl,fixtureUrl,checks,errors,publication:'unavailable',generation:'unavailable',peteHostBrowser:'not performed; fixture host only'},null,2));console.log(JSON.stringify({checks,errors,fixtureUrl,evidence}));
  for(const c of [...contexts,hostContext]) await c.close();
} catch (error) { for(const [i,context] of browser.contexts().entries()) for(const [j,page] of context.pages().entries()) { await page.screenshot({path:evidence+`/failure-${i}-${j}.png`,fullPage:true}).catch(()=>{}); await Bun.write(evidence+`/failure-${i}-${j}.txt`,await page.locator("body").innerText().catch(()=>"")); } throw error; } finally { await browser.close(); }
