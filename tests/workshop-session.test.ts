import { test, expect } from 'bun:test';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { application } from '../src/application.ts';
import type { Config, FollowupConfig } from '../src/config.ts';
import { storeWorkshopBuildCandidate } from '../src/pipeline/workshop-storage.ts';
import { sha256 } from '../src/assets.ts';
import { prepareWorkshopFollowup } from '../src/pipeline/workshop-prepare.ts';

test('admin board → invite join → first dispatch; existing boards resume; nonmembers stay isolated', async () => {
  const dir=mkdtempSync('/private/tmp/freedom-session-'), origin='https://workshop.test';
  const adminKey=generateSecretKey(), appKey=generateSecretKey();
  const config:Config={dataDir:dir,origin,hostPubkey:getPublicKey(adminKey),version:'test'};
  let app=application(config);
  type Account={cookie:string;csrf:string;member:any};
  async function call(path:string,body:any=undefined,a?:Account,workshop='') {
    const response=await app.handle(new Request(origin+'/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{origin,...(a?{cookie:a.cookie,'x-csrf-token':a.csrf}:{}),...(workshop?{'x-workshop-id':workshop}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    return {status:response.status,data:await response.json()};
  }
  async function login(key=generateSecretKey()):Promise<Account> {
    const challenge=(await call('challenge',{})).data;
    const response=await app.handle(new Request(origin+'/api/v1/login',{method:'POST',headers:{origin},body:JSON.stringify({challengeId:challenge.id,event:finalizeEvent(challenge.event,key),identityType:'extension'})}));
    const data=await response.json();expect(response.status).toBe(200);
    return {cookie:response.headers.get('set-cookie')!.split(';')[0]!,csrf:data.csrf,member:data.member};
  }
  const originalFetch=globalThis.fetch;
  const inputs:any[]=[];
  try {
    const admin=await login(adminKey), user=await login(), outsider=await login();
    const existing=(await call('site/workshops',{title:'Existing board'},admin)).data;
    async function inviteJoin(id:string) {
      const invitation=await call('host/invitations',{uses:2,shortCode:true},admin,id);
      expect(invitation.status).toBe(200);
      const joined=await call('workshops/redeem-code',{code:invitation.data.code},user);
      expect(joined.status).toBe(200);expect(joined.data.member.state).toBe('admitted');
    }
    await inviteJoin(existing.id);
    const oldProject=(await call('projects',{starterId:'todo'},user,existing.id)).data.project;
    const oldConversation=oldProject.conversation_id;
    const oldRequest=crypto.randomUUID();
    expect((await call(`projects/${oldProject.id}/requests`,{requestId:oldRequest,prompt:'Build a counter',mode:'build',expectedRevisionId:oldProject.current_revision},user,existing.id)).data.generationAvailable).toBe(false);
    const scope={ownerPubkey:admin.member.pubkey,builderRoot:dir+'/napplets',workshopId:app.site.legacy(),fileVersions:true,legacy:{projectId:crypto.randomUUID(),ownerPubkey:admin.member.pubkey,conversationKey:crypto.randomUUID(),directory:dir+'/legacy'},dataDir:dir};
    const credential=dir+'/broker.cap';writeFileSync(credential,'a'.repeat(43),{mode:0o600});
    config.followup={...scope.legacy,workshopId:scope.workshopId,fileVersions:true,replacementEnabled:true,builderRoot:scope.builderRoot,brokerUrl:'http://127.0.0.1:3256/api/internal/wapps/pipelines',credentialFile:credential,origin,definitionId:'member-builder',callbackUrl:origin+'/api/v1/pipeline/callback',appPubkey:getPublicKey(appKey),approvedRequestId:''} as FollowupConfig;
    app.db.close();app=application(config);
    globalThis.fetch=(async (url:any,init:any)=>{
      expect(String(url)).toBe(config.followup!.brokerUrl);
      const envelope=JSON.parse(init.body), payload=JSON.parse(envelope.serializedBody), input=payload.input;
      const prepared=prepareWorkshopFollowup(input,scope);inputs.push(input);
      expect(prepared.directory).toBe(`${scope.builderRoot}/${input.workshopId}/${input.projectId}`);
      const target=new URL(envelope.path,origin).href, bodyHash=sha256(envelope.serializedBody);
      const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',target],['method','POST'],['payload',bodyHash]]},appKey);
      return Response.json({httpStatus:200,response:{runId:crypto.randomUUID()},receipt:{url:target,method:'POST',bodyHash,event}});
    }) as typeof fetch;
    const resumed=await call(`projects/${oldProject.id}/requests/${oldRequest}/resume`,{},user,existing.id);
    expect(resumed.status).toBe(202);expect(resumed.data.request.status).toBe('building');
    expect((await call(`projects/${oldProject.id}`,undefined,user,existing.id)).data.project.conversation_id).toBe(oldConversation);
    const tower=(await call('site/towers',{label:'Optional Tower',origin:'https://tower.test'},admin)).data.towers[0];
    config.storageTemplates=[{installationId:'test-installation',appPubkey:getPublicKey(appKey),appNpub:'test-app',towerOrigin:'https://tower.test',workshopId:app.site.legacy(),localRoot:dir+'/remote',pipeline:config.followup}];
    const selected=(await call('site/workshops',{title:'Selected Tower needs authorization',towerId:tower.id},admin)).data;
    const selectedStorage=(await call('host/storage',undefined,admin,selected.id)).data;expect(selectedStorage.state).toBe('needs_authorization');
    const board=(await call('site/workshops',{title:'New board'},admin)).data;
    expect((await call('projects',{starterId:'todo'},outsider,board.id)).status).toBe(403);
    expect((await call('workshops/redeem-code',{code:'000000'},outsider)).status).toBe(403);
    await inviteJoin(board.id);
    const created=await call('projects',{starterId:'todo'},user,board.id);
    expect(created.status).toBe(201);expect(created.data.generationAvailable).toBe(true);
    const project=created.data.project;
    expect((await call('projects',{starterId:'game'},user,board.id)).status).toBe(201);
    expect((await call(`projects/${project.id}`,undefined,outsider,board.id)).status).toBe(403);
    expect((await call(`projects/${project.id}`,undefined,user,existing.id)).status).toBe(404);
    const body={requestId:crypto.randomUUID(),prompt:'Build a counter',mode:'build',expectedRevisionId:project.current_revision};
    expect((await call(`projects/${project.id}/requests`,body,outsider,board.id)).status).toBe(403);
    const dispatched=await call(`projects/${project.id}/requests`,body,user,board.id);
    expect(dispatched.status).toBe(202);expect(dispatched.data.request.status).toBe('building');expect(inputs).toHaveLength(2);
    const input=inputs[1];
    const candidate={action:'build_completed',version:1};
    const storageInput={requestId:body.requestId,projectId:project.id,candidate};
    let remoteCalls=0;
    const store=async(_:any,scope:any)=>{remoteCalls++;expect(scope.workshopId).toBe(board.id);expect(scope.installationWorkshops).toBe(true);return candidate;};
    expect(await storeWorkshopBuildCandidate(storageInput,{} as any,dir,store)).toBe(candidate);expect(remoteCalls).toBe(0);
    app.db.run('UPDATE local_builds SET storage_required=1 WHERE request_id=?',[body.requestId]);
    expect(await storeWorkshopBuildCandidate(storageInput,{} as any,dir,store)).toBe(candidate);expect(remoteCalls).toBe(1);
    await expect(storeWorkshopBuildCandidate({...storageInput,projectId:oldProject.id},{} as any,dir,store)).rejects.toThrow('workshop_allocation_denied');
    expect(()=>prepareWorkshopFollowup({...input,ownerPubkey:outsider.member.pubkey},scope)).toThrow('workshop_membership_denied');
    expect(()=>prepareWorkshopFollowup({...input,workshopId:existing.id},scope)).toThrow('workshop_membership_denied');
    expect(()=>prepareWorkshopFollowup({...input,generation:1},scope)).toThrow('workshop_membership_denied');
    app.db.run('UPDATE workshop_members SET allowance=0 WHERE workshop_id=? AND pubkey=?',[board.id,user.member.pubkey]);
    expect(()=>prepareWorkshopFollowup(input,scope)).toThrow('workshop_membership_denied');
    app.db.run('UPDATE workshop_members SET allowance=20 WHERE workshop_id=? AND pubkey=?',[board.id,user.member.pubkey]);
    app.db.run('UPDATE workshops SET paused=1 WHERE id=?',[board.id]);
    expect(()=>prepareWorkshopFollowup(input,scope)).toThrow('workshop_membership_denied');
    app.db.run('UPDATE workshops SET paused=0 WHERE id=?',[board.id]);
    expect((await call(`host/members/${user.member.pubkey}`,{state:'banned',allowance:0},admin,board.id)).status).toBe(200);
    expect(()=>prepareWorkshopFollowup(input,scope)).toThrow('workshop_membership_denied');
    expect((await call(`projects/${project.id}/requests/${body.requestId}/resume`,{},user,board.id)).status).toBe(403);
    expect((await call(`projects/${oldProject.id}`,undefined,user,existing.id)).status).toBe(200);
    expect(inputs).toHaveLength(2);
  } finally { globalThis.fetch=originalFetch;app.db.close();rmSync(dir,{recursive:true,force:true}); }
});
