import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {createFreedomServer} from '../src/server.ts';
import {bindRun} from '../src/delivery-store.ts';
import {bindActivityAuthority} from '../src/activity-store.ts';
import type {Config,OperatorBuildConfig} from '../src/config.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
test('real authenticated WebSocket restores progress after reconnect, isolates participants and receives full final without resubmission',async()=>{
 const root=mkdtempSync('/tmp/freedom-socket-'),key=generateSecretKey();
 const config:Config={dataDir:root,origin:null,hostPubkey:null,version:'test',callbackSignerPubkey:getPublicKey(key)};
 const runtime=createFreedomServer(config,0),{app,server}=runtime;config.origin=`http://127.0.0.1:${server.port}`;
 const sockets:WebSocket[]=[];
 try{
  const owner=getPublicKey(generateSecretKey()),other=getPublicKey(generateSecretKey());
  for(const pub of [owner,other])app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[pub,'Participant','temporary','admitted',20,1]);
  const member=app.auth.member(owner),project=app.workshop.create(member,'dice').project,requestId='question';
  const v2=app.workshop.addRevision(app.workshop.project(member,project.id),app.workshop.assets.put('<html><body>v2</body></html>'),owner);
  const v3=app.workshop.addRevision(app.workshop.project(member,project.id),app.workshop.assets.put('<html><body>v3</body></html>'),owner);project.current_revision=v3;
  app.workshop.request(member,project.id,{requestId,prompt:'What next?',expectedRevisionId:project.current_revision},true);bindRun(app.db,requestId,'run');
  bindActivityAuthority(app.db,requestId,'run',{requestId,projectId:project.id,workshopId:app.workshop.id,nativeRequestId:requestId,activityGeneration:'0'},{definitionId:'def',activityWebhookUrl:config.origin+'/api/v1/pipeline/activity'} as OperatorBuildConfig);
  app.db.run("UPDATE requests SET status='building' WHERE id=?",[requestId]);
  function session(pub:string,token:string){app.db.run('INSERT INTO sessions(hash,pubkey,csrf,expires_at,identity_type) VALUES(?,?,?,?,?)',[hash(token),pub,'csrf',Math.floor(Date.now()/1000)+3600,'temporary']);}
  session(owner,'owner');session(other,'other');
  const seen:any[]=[];
  function connect(token:string){const ws=new WebSocket(config.origin!.replace('http','ws')+'/api/v1/events?workshop='+app.workshop.id,{headers:{origin:config.origin!,cookie:'lf_session='+token}} as any);sockets.push(ws);ws.addEventListener('message',e=>{seen.push({ws,...JSON.parse(e.data as string)});});return ws;}
  async function waitUntil(check:()=>boolean){const until=Date.now()+3000;while(!check()){if(Date.now()>until)throw Error('Socket evidence timed out');await Bun.sleep(10);}}
  const ws=connect('owner');await waitUntil(()=>ws.readyState===WebSocket.OPEN);ws.send(JSON.stringify({type:'subscribe',projectId:project.id,requestId}));
  await waitUntil(()=>seen.some(e=>e.ws===ws&&e.type==='request'));
  async function activate(revisionId:string,expectedRevisionId:string){return fetch(`${config.origin}/api/v1/projects/${project.id}/activate`,{method:'POST',headers:{origin:config.origin!,cookie:'lf_session=owner','x-csrf-token':'csrf','content-type':'application/json','x-workshop-id':app.workshop.id},body:JSON.stringify({revisionId,expectedRevisionId})});}
  expect((await activate(v2,v3)).status).toBe(200);await waitUntil(()=>seen.some(e=>e.ws===ws&&e.type==='request'&&e.currentRevision===v2));
  const room=await fetch(`${config.origin}/api/v1/room`,{headers:{origin:config.origin!,cookie:'lf_session=owner','x-workshop-id':app.workshop.id}}).then(response=>response.json());expect(room.board.napplets[0].current_revision).toBe(v2);
  expect((await activate(v3,v2)).status).toBe(200);await waitUntil(()=>seen.some(e=>e.ws===ws&&e.type==='request'&&e.currentRevision===v3));
  async function signedPost(path:string,body:any,activity=false){
   const raw=JSON.stringify(body),url=config.origin+path,tags=[['u',url],['method','POST'],['payload',hash(raw)],['run',body.runId]];
   if(activity)tags.push(['event',body.eventId]);else tags.push(['delivery',body.deliveryId],['attempt','1']);
   const auth=finalizeEvent({kind:27235,content:'',created_at:Math.floor(Date.now()/1000),tags},key);
   return fetch(url,{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(auth)).toString('base64'),'x-wingman-run-id':body.runId,[activity?'x-wingman-event-id':'x-wingman-delivery-id']:activity?body.eventId:body.deliveryId},body:raw});
  }
  const activity={version:1,eventId:hash('commentary'),sequence:1,runId:'run',stepId:'step',sessionId:'native-session',turnId:'receipt',correlation:{requestId,projectId:project.id,workshopId:app.workshop.id,nativeRequestId:requestId,generation:'0'},timestamp:new Date().toISOString(),type:'commentary',content:'Public progress persists'};
  expect((await signedPost('/api/v1/pipeline/activity',activity,true)).status).toBe(200);
  await waitUntil(()=>seen.some(e=>e.ws===ws&&e.type==='request'&&e.data.activity?.length===1));
  ws.close();await waitUntil(()=>ws.readyState===WebSocket.CLOSED);
  const resumed=connect('owner');await waitUntil(()=>resumed.readyState===WebSocket.OPEN);resumed.send(JSON.stringify({type:'subscribe',projectId:project.id,requestId}));
  await waitUntil(()=>seen.some(e=>e.ws===resumed&&e.type==='request'&&e.data.activity?.[0]?.content===activity.content));
  expect(app.db.query('SELECT * FROM dispatch_receipts').all()).toHaveLength(0);expect(app.db.query('SELECT * FROM requests').all()).toHaveLength(1);
  const intruder=connect('other');await waitUntil(()=>intruder.readyState===WebSocket.OPEN);intruder.send(JSON.stringify({type:'subscribe',projectId:project.id,requestId}));await waitUntil(()=>intruder.readyState===WebSocket.CLOSED);expect(seen.filter(e=>e.ws===intruder&&e.type==='request')).toHaveLength(0);
  const response='A complete answer. '.repeat(4000)+'END';
  const result={requestId,projectId:project.id,action:'answer_completed',banRequired:false,response,nativeReceipt:{requestId,projectId:project.id,invocationRunId:'run',runId:'run',stepId:'step',executionId:'native-session',receiptId:'receipt',sessionId:'native-session',nativeSessionId:'native',sequence:1,conversationKey:project.conversation_id}};
  expect((await signedPost('/api/v1/pipeline/callback',{runId:'run',deliveryId:'final',terminal:true,status:'ok',error:null,result})).status).toBe(200);
  await waitUntil(()=>seen.some(e=>e.ws===resumed&&e.type==='request'&&e.data.status==='succeeded'));expect(seen.findLast(e=>e.ws===resumed&&e.type==='request').data.response).toBe(response);
  app.db.run("UPDATE members SET state='banned' WHERE pubkey=?",[owner]);
  resumed.send('refresh');await waitUntil(()=>resumed.readyState===WebSocket.CLOSED);
 }finally{for(const ws of sockets)ws.close();runtime.stop();rmSync(root,{recursive:true,force:true});}
},15000);
