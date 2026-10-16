// Trusted parent only. No host cookie, CSRF, lease token or signer enters the iframe.
import { canvasDomain, datasetDisplayName } from '/canvas-host.js';
import { participantSigner, verifyEvent, getEventHash } from '/identity.js';
const VERSION=1, MAX_BYTES=49152, METHODS=['capabilities','identity.getPublicKey','signing.signEvent','storage.get','storage.set','storage.remove','relay.query','relay.subscribe','relay.close'];
const SIGN_KINDS=[1,30023,30024,30078];
export function installNappletHost(context) {
  const error=(code,message)=>Object.assign(new Error(message),{code});
  const relayPool=createRelayPool(verifyEvent);
  const canvas=canvasDomain({context,backend,ask,assert,error,close});
  const allMethods=[...METHODS,...canvas.methods];
  const frames=new Map(), retired=new WeakMap(); let consent=null, signingPending=false;
  function stamp() { const c=context(); return c.member?`${c.member.pubkey}:${c.workshop}`:''; }
  function valid(b) { return !b.closed && b.frame.isConnected && b.frame.contentWindow===b.window && b.frame.getAttribute('src')===b.src && b.frame.getAttribute('sandbox')==='allow-scripts allow-forms' && (!b.expires||Date.now()<b.expires) && stamp()===b.stamp; }
  function assert(b) { if(!valid(b))throw error('STALE','Frame or account changed; reload the Napplet'); }
  async function backend(b,action,body,signal) {
    assert(b);
    const c=context(),response=await fetch('/api/v1/napplet/'+action,{method:'POST',credentials:'same-origin',signal,headers:{'content-type':'application/json','x-csrf-token':c.csrf,'x-workshop-id':b.workshop},body:JSON.stringify(body)});
    const result=await response.json();
    if(action==='open'&&result.token){b.token=result.token;if(!valid(b))release(b);}
    assert(b);
    if(!response.ok)throw error(response.status===401||response.status===403?'DENIED':response.status===413?'QUOTA':response.status===409?'CONFLICT':'FAILED',result.error||'Host request failed');
    return result;
  }
  function release(b) {
    if(!b.token||b.released)return;b.released=true;
    const c=context();void fetch('/api/v1/napplet/data',{method:'POST',credentials:'same-origin',keepalive:true,headers:{'content-type':'application/json','x-csrf-token':c.csrf,'x-workshop-id':b.workshop},body:JSON.stringify({token:b.token,method:'close'})}).catch(()=>{});
  }
  function close(b) {
    if(b.closed)return;
    b.relays?.forEach(r=>r.close()); b.relays?.clear(); clearInterval(b.leaseTimer);
    b.closed=true; retired.set(b.frame,b.src); b.port?.postMessage({type:'close'}); b.port?.close();
    b.controllers.forEach(c=>c.abort());
    if(consent?.binding===b)consent.cancel();
    release(b);
  }
  function sync() {
    for(const [frame,b] of frames)if(!valid(b)){close(b);frames.delete(frame);}
    for(const frame of document.querySelectorAll('iframe[data-napplet]'))if(!frames.has(frame)){
      const c=context();if(!c.member||!c.workshop||retired.get(frame)===frame.getAttribute('src'))continue;
      const url=new URL(frame.src,location.href),match=url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/preview$/);
      if(url.origin!==location.origin||!match||url.searchParams.get('workshop')!==c.workshop||frame.getAttribute('sandbox')!=='allow-scripts allow-forms')continue;
      const b={frame,window:frame.contentWindow,src:frame.getAttribute('src'),stamp:stamp(),workshop:c.workshop,user:c.member.pubkey,project:decodeURIComponent(match[1]),revision:url.searchParams.get('revision'),closed:false,loaded:false,controllers:new Set(),inflight:0,seen:0,lastId:0,identityGranted:false,relays:new Map(),relaySequence:0,unacked:new Map()};
      frames.set(frame,b);
      frame.addEventListener('load',()=>{if(b.loaded){close(b);}b.loaded=true;});
    }
    revoke.hidden=![...frames.values()].some(b=>valid(b));
  }
  new MutationObserver(sync).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','sandbox']});
  setInterval(sync,500);
  function ask(b,kind,event,signal) {
    assert(b); if(consent)throw error('BUSY','Another permission request is open');
    return new Promise((resolve,reject)=>{
      const dialog=document.createElement('dialog');dialog.className='napplet-consent';
      const datasetLabel=kind==='dataset'?datasetDisplayName(event.name):'';
      const heading=document.createElement('h2');heading.textContent=kind==='dataset'?`Open ${datasetLabel}?`:kind==='identity'?'Share your public identity?':'Sign this Napplet event?';heading.id='napplet-consent-title';dialog.setAttribute('aria-labelledby',heading.id);dialog.append(heading);
      const summary=document.createElement('p');summary.textContent=kind==='dataset'?`${b.title} can read and update information ${event.visibility==='shared'?'shared with everyone':'saved privately for you'} on this Canvas.`:`${b.title} · v${b.revisionNumber} · ${b.workshopTitle}`;dialog.append(summary);
      if(kind==='dataset'){const note=document.createElement('p');note.textContent='This access stays with this tool on this Canvas, and you can revoke it at any time.';dialog.append(note);}
      const details=document.createElement('details'),label=document.createElement('summary');label.textContent=kind==='dataset'?'Technical details':'Inspect app binding';details.append(label);
      const app=document.createElement('p');app.textContent=`${b.title} · v${b.revisionNumber} · ${b.workshopTitle}`;
      const identity=document.createElement('p');identity.textContent=`Account: ${context().member.name || 'BYOF Canvas participant'}${context().member.identity_type==='temporary'?' (temporary identity; lost when this tab closes or you sign out)':''}`;
      const key=document.createElement('code');key.className='consent-pubkey';key.textContent=b.user;
      const binding=document.createElement('p');binding.textContent=`Project ${b.project} · revision ${b.revision} · BYOF Canvas ${b.workshop}`;
      if(kind==='dataset')details.append(app,identity,key,binding);else dialog.append(identity,key),details.append(binding);
      if(event){const pre=document.createElement('pre');pre.textContent=JSON.stringify(event,null,2);kind==='dataset'?details.append(pre):dialog.append(pre);}
      dialog.append(details);
      if(kind!=='dataset'){const explanation=document.createElement('p');explanation.textContent=kind==='identity'?'Allow this running version to read your authenticated public key. You can revoke access with the host’s Revoke Napplet permissions button or by leaving this page.':'Review the complete event below. Approval asks your current signer to sign exactly this content as your logged-in account. The signature may be copied by this app. This host does not publish it.';dialog.insertBefore(explanation,details);}
      const actions=document.createElement('div');actions.className='actions';
      const deny=document.createElement('button');deny.textContent=kind==='dataset'?'Not now':'Deny';deny.dataset.nappletConsent='deny';
      const allow=document.createElement('button');allow.textContent=kind==='dataset'?'Open':kind==='identity'?'Allow identity':'Approve signing';allow.dataset.nappletConsent='allow';
      actions.append(deny,allow);dialog.append(actions);document.body.append(dialog);
      let done=false;
      const finish=(approved)=>{if(done)return;done=true;signal.removeEventListener('abort',cancel);dialog.close();dialog.remove();consent=null;if(approved){try{assert(b);resolve();}catch(e){reject(e);}}else reject(error('DENIED','Permission denied or revoked'));};
      const cancel=()=>finish(false);consent={binding:b,cancel};signal.addEventListener('abort',cancel,{once:true});
      deny.onclick=cancel;allow.onclick=()=>finish(true);dialog.addEventListener('cancel',e=>{e.preventDefault();cancel();});dialog.showModal();deny.focus();
    });
  }
  function validateEvent(input) {
    if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(k=>!['kind','created_at','tags','content'].includes(k)))throw error('INVALID','Supply an unsigned event: kind, created_at, tags, content only');
    if(!SIGN_KINDS.includes(input.kind))throw error('FORBIDDEN','Only kinds 1, 30023, 30024 and 30078 may be signed; authentication, delegation, manifests and host authority are blocked');
    if(!Number.isSafeInteger(input.created_at)||Math.abs(input.created_at-Math.floor(Date.now()/1000))>600||typeof input.content!=='string'||new TextEncoder().encode(input.content).length>16384||!Array.isArray(input.tags)||input.tags.length>64||input.tags.some(t=>!Array.isArray(t)||t.length>8||t.some(v=>typeof v!=='string'||v.length>1024)||t[0]==='delegation'))throw error('INVALID','Invalid event timestamp, content or tags');
    return JSON.parse(JSON.stringify(input));
  }
  async function execute(b,method,p,signal) {
    if(method==='capabilities'){if(Object.keys(p).length)throw error('INVALID','Capabilities takes no parameters');return {version:VERSION,methods:allMethods,datasets:{explicitConsent:true,sharedRequiresCanvasAccess:true,valueBytes:32768,keys:128,quotaBytes:4194304,versionChecked:true},signing:{available:!!participantSigner(context().member.identity_type),kinds:SIGN_KINDS},storage:{durable:true,keyBytes:128,valueBytes:32768,quotaBytes:262144,keys:128},limits:{requestBytes:MAX_BYTES,concurrency:4,timeoutMs:60000},relay:{readOnly:true,relays:APPROVED_RELAYS,limits:RELAY_LIMITS},publication:false};}
    if(method.startsWith('datasets.'))return canvas.execute(b,method,p,signal);
    if(method.startsWith('relay.')) {
      if(method==='relay.close') {if(Object.keys(p).length!==1||typeof p.subscriptionId!=='string'||!/^ft\d{1,8}$/.test(p.subscriptionId))throw error('INVALID','Subscription ID required');b.relays.get(p.subscriptionId)?.close();b.relays.delete(p.subscriptionId);for(const [id,a] of b.unacked)if(a.subscriptionId===p.subscriptionId)b.unacked.delete(id);return;}
      if(b.relays.size>=4)throw error('BUSY','At most four relay operations per frame');
      validateRelayOptions(p);await backend(b,'data',{token:b.token,method:'check'},signal);assert(b);
      if(b.relays.size>=4)throw error('BUSY','At most four relay operations per frame');
      if(method==='relay.query') {const handle=relayPool.query(p);b.relays.set(handle.id,handle);const cancel=()=>handle.close();signal.addEventListener('abort',cancel,{once:true});try{return await handle.promise;}finally{handle.close();b.relays.delete(handle.id);signal.removeEventListener('abort',cancel);}}
      let handle;
      const deliver=payload=>{
        if(!valid(b)){close(b);return;}
        if(b.unacked.size>=16){b.port.postMessage({version:VERSION,type:'relay',subscriptionId:handle.id,payload:{type:'status',status:{state:'closed',message:'Consumer buffer exceeded',truncated:true}}});handle.close();b.relays.delete(handle.id);return;}
        const deliveryId=String(++b.relaySequence);
        b.unacked.set(deliveryId,{subscriptionId:handle.id,time:Date.now()});
        b.port.postMessage({version:VERSION,type:'relay',subscriptionId:handle.id,deliveryId,payload});
        if(payload.type==='status'&&payload.status.state==='closed'){b.relays.delete(handle.id);for(const [id,a]of b.unacked)if(a.subscriptionId===handle.id)b.unacked.delete(id);}
      };
      handle=relayPool.subscribe(p,deliver);b.relays.set(handle.id,handle);return {subscriptionId:handle.id};
    }
    if(method==='identity.getPublicKey'){
      if(Object.keys(p).length)throw error('INVALID','Identity takes no parameters');
      if(!b.identityGranted){await ask(b,'identity',null,signal);assert(b);b.identityGranted=true;}
      const check=await backend(b,'data',{token:b.token,method:'check'},signal);if(check.user!==b.user)throw error('STALE','Account changed');return b.user;
    }
    if(method==='signing.signEvent') {
      if(Object.keys(p).length!==1||!('event' in p))throw error('INVALID','Only event is accepted');
      if(signingPending)throw error('BUSY','A signer request is still pending');
      const event=validateEvent(p.event),unsigned={...event,pubkey:b.user};
      await ask(b,'sign',unsigned,signal);
      await backend(b,'data',{token:b.token,method:'check'},signal);assert(b);
      if(signingPending)throw error('BUSY','A signer request is still pending');
      signingPending=true;
      try {
      const signer=participantSigner(context().member.identity_type);
      if(!signer?.getPublicKey||!signer.signEvent)throw error('SIGNER_UNAVAILABLE','The active participant signer is unavailable');
      if(await signer.getPublicKey()!==b.user)throw error('SIGNER_MISMATCH','Active signer does not match the logged-in participant');
      assert(b);if(signal.aborted)throw error('TIMEOUT','Signing timed out');
      let signed;try{signed=JSON.parse(JSON.stringify(await signer.signEvent(JSON.parse(JSON.stringify(unsigned)))));}catch{throw error('SIGNER_REJECTED','Signer rejected or failed');}
      assert(b);if(signal.aborted)throw error('TIMEOUT','Signing timed out');
      if(participantSigner(context().member.identity_type)!==signer || await signer.getPublicKey()!==b.user || signed.pubkey!==b.user || getEventHash(signed)!==getEventHash(unsigned) || !verifyEvent(signed))throw error('SIGNER_MISMATCH','Signer returned an invalid or changed event');
      await backend(b,'data',{token:b.token,method:'check'},signal);return {...unsigned,id:signed.id,sig:signed.sig};
      } finally { signingPending=false; }
    }
    const action=method.split('.')[1],allowed=action==='set'?['key','value']:['key'];
    if(Object.keys(p).some(k=>!allowed.includes(k)))throw error('INVALID','Unexpected storage field');
    const result=await backend(b,'data',{token:b.token,method:action,...p},signal);return action==='get'?result.value:undefined;
  }
  window.addEventListener('message',async event=>{
    if(event.data?.type!=='freedom-napplet-ready'||event.data.version!==VERSION||typeof event.data.documentId!=='string'||event.data.documentId.length!==36||event.origin!=='null'||event.ports.length)return;
    sync(); const b=[...frames.values()].find(b=>b.window===event.source);if(!b||!valid(b))return;
    if(b.port||b.connecting){if(b.documentId!==event.data.documentId)close(b);return;}
    b.documentId=event.data.documentId;b.connecting=true;const setup=new AbortController();b.controllers.add(setup);const timer=setTimeout(()=>setup.abort(),10000);
    try {
      const binding=await backend(b,'open',{projectId:b.project,revisionId:b.revision,documentId:event.data.documentId},setup.signal);
      if(binding.user!==b.user)throw error('STALE','Authenticated account changed');
      b.token=binding.token;b.expires=binding.expires;b.leaseTimer=setInterval(()=>{if(!valid(b)||[...b.unacked.values()].some(a=>Date.now()-a.time>5000)){close(b);return;}if(b.checking)return;b.checking=true;const c=new AbortController(),t=setTimeout(()=>c.abort(),5000);void backend(b,'data',{token:b.token,method:'check'},c.signal).catch(()=>close(b)).finally(()=>{clearTimeout(t);b.checking=false;});},10000);b.title=binding.title;b.workshopTitle=binding.workshopTitle;b.revisionNumber=binding.revisionNumber;
      const channel=new MessageChannel();b.port=channel.port1;
      b.port.onmessage=async message=>{
        const r=message.data;
        if(!valid(b)){close(b);return;}
        if(r?.version===VERSION&&r.type==='client-close'&&Object.keys(r).every(k=>['version','type'].includes(k))){close(b);return;}
        if(r?.version===VERSION&&r.type==='relay-ack'&&typeof r.deliveryId==='string'&&Object.keys(r).every(k=>['version','type','deliveryId'].includes(k))){b.unacked.delete(r.deliveryId);return;}
        // Monotonic bounded IDs prevent replay without an unbounded seen-ID set.
        if(!r||r.version!==VERSION||typeof r.id!=='string'||!/^\d{1,8}$/.test(r.id)||Number(r.id)<=b.lastId)return;
        b.lastId=Number(r.id);
        const reply=(ok,value)=>{if(valid(b))b.port.postMessage({version:VERSION,id:r.id,ok,...(ok?{value}:{error:value})});};
        const now=Date.now();if(!b.rateStart||now-b.rateStart>60000){b.rateStart=now;b.seen=0;}if(++b.seen>120)return reply(false,{code:'BUSY',message:'Bridge request limit reached'});
        let bytes;try{bytes=new TextEncoder().encode(JSON.stringify(r)).length;}catch{return reply(false,{code:'INVALID',message:'JSON request required'});}
        if(bytes>MAX_BYTES)return reply(false,{code:'TOO_LARGE',message:'Request exceeds 48 KiB'});
        if(!allMethods.includes(r.method))return reply(false,{code:'UNKNOWN_METHOD',message:'Unknown Napplet method'});
        if(Object.keys(r).some(k=>!['version','id','method','params'].includes(k))||!r.params||Array.isArray(r.params)||typeof r.params!=='object')return reply(false,{code:'INVALID',message:'Invalid request fields'});
        if(b.inflight>=4)return reply(false,{code:'BUSY',message:'Bridge request limit reached'});
        b.inflight++;const controller=new AbortController();b.controllers.add(controller);
        let timeout;const expired=new Promise((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(error('TIMEOUT','Host request timed out'));},55000);});
        try{reply(true,await Promise.race([execute(b,r.method,r.params,controller.signal),expired]));}catch(e){reply(false,{code:e.code||'FAILED',message:e.code?e.message:'Host operation failed'});}finally{clearTimeout(timeout);controller.abort();b.controllers.delete(controller);b.inflight--;}
      };
      b.port.start();assert(b);b.window.postMessage({type:'freedom-napplet-connect',version:VERSION},'*',[channel.port2]);
    }catch{close(b);}finally{clearTimeout(timer);b.controllers.delete(setup);}
  });
  const revoke=document.createElement('button');revoke.type='button';revoke.hidden=true;revoke.title='Closes current channels; reload or reopen an app to reconnect';revoke.className='napplet-revoke';revoke.textContent='Revoke';revoke.setAttribute('aria-label','Revoke Napplet permissions');
  revoke.onclick=()=>{for(const b of frames.values())close(b);};document.body.append(revoke);
  window.addEventListener('pagehide',()=>{for(const b of frames.values())close(b);});
  return {sync,revoke:()=>{for(const b of frames.values())close(b);}};
}

// Fixed public registry; never take a socket URL from an event tag or generated code.
export const APPROVED_RELAYS = Object.freeze(['wss://relay.damus.io','wss://nos.lol','wss://relay.primal.net']);
export const RELAY_LIMITS = Object.freeze({filters:4,filterValues:32,history:100,eventBytes:16384,responseBytes:262144,subscriptionsPerFrame:4,subscriptions:24,connections:3,unacknowledged:16,dedupe:4096,eventsPerMinute:240,timeoutMs:15000});
const relayError=(code,message)=>Object.assign(new Error(message),{code});
const relayBytes=value=>new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value)).length;
export function validateRelayOptions(options) {
  if(!options||Array.isArray(options)||typeof options!=='object'||Object.keys(options).some(k=>!['filters','relays','timeoutMs'].includes(k)))throw relayError('INVALID','Expected filters, optional approved relays and timeoutMs');
  const {filters}=options;
  if(!Array.isArray(filters)||!filters.length||filters.length>4)throw relayError('INVALID','Supply one to four NIP-01 filters');
  const normalized=filters.map(f=>{
    if(!f||Array.isArray(f)||typeof f!=='object'||Object.keys(f).length>12)throw relayError('INVALID','Invalid relay filter');
    for(const [k,v] of Object.entries(f)) {
      if(['since','until','limit'].includes(k)) {if(!Number.isSafeInteger(v)||v<0||(k==='limit'&&v>100))throw relayError('INVALID','Invalid filter time or limit');continue;}
      if(!['ids','authors','kinds'].includes(k)&&!/^#[a-zA-Z]$/.test(k))throw relayError('INVALID','Unsupported NIP-01 filter field');
      if(!Array.isArray(v)||!v.length||v.length>32||v.some(x=>k==='kinds'?(!Number.isInteger(x)||x<0||x>65535):(typeof x!=='string'||x.length>256||(['ids','authors','#e','#p'].includes(k)&&! /^[a-f0-9]{64}$/.test(x)))))throw relayError('INVALID','Invalid filter values');
    }
    if(f.since!==undefined&&f.until!==undefined&&f.since>f.until)throw relayError('INVALID','since must not exceed until');
    return {...f,limit:f.limit??100};
  });
  const relays=options.relays??APPROVED_RELAYS;
  if(!Array.isArray(relays)||!relays.length||relays.length>3||new Set(relays).size!==relays.length||relays.some(r=>!APPROVED_RELAYS.includes(r)))throw relayError('FORBIDDEN','Only exact approved public WSS relay URLs are supported');
  const timeoutMs=options.timeoutMs??15000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>20000)throw relayError('INVALID','Relay timeout must be 1000–20000 ms');
  if(relayBytes(options)>8192)throw relayError('TOO_LARGE','Relay options exceed 8 KiB');
  return {filters:JSON.parse(JSON.stringify(normalized)),relays:[...relays],timeoutMs};
}
export function relayEventMatches(event,filters) {
  return filters.some(f=>Object.entries(f).every(([k,v])=>k==='limit'||(k==='ids'?v.includes(event.id):k==='authors'?v.includes(event.pubkey):k==='kinds'?v.includes(event.kind):k==='since'?event.created_at>=v:k==='until'?event.created_at<=v:event.tags.some(t=>t[0]===k.slice(1)&&v.includes(t[1])))));
}
export function validRelayEvent(event,filters,verify) {
  try {
    if(!event||Object.keys(event).some(k=>!['id','pubkey','sig','kind','created_at','tags','content'].includes(k))||! /^[a-f0-9]{64}$/.test(event.id)||! /^[a-f0-9]{64}$/.test(event.pubkey)||! /^[a-f0-9]{128}$/.test(event.sig)||!Number.isInteger(event.kind)||event.kind<0||event.kind>65535||!Number.isSafeInteger(event.created_at)||event.created_at<0||typeof event.content!=='string'||!Array.isArray(event.tags)||event.tags.length>128||event.tags.some(t=>!Array.isArray(t)||!t.length||t.length>16||t.some(x=>typeof x!=='string'||x.length>2048))||relayBytes(event)>16384||!relayEventMatches(event,filters))return false;
    // Fresh parsed objects only: no caller-supplied nostr-tools verification cache.
    return verify(JSON.parse(JSON.stringify(event)));
  }catch{return false;}
}
// One connection per approved relay, shared across bound documents. Only REQ/CLOSE are sent.
export function createRelayPool(verify, Socket=WebSocket) {
  const connections=new Map(),operations=new Set();let sequence=0;
  function state(op,url,state,message='',extra={}) {
    if(op.closed)return;
    op.states.set(url,{url,state,message:message.slice(0,256),...extra});
    if(op.live)op.deliver({type:'status',status:{...op.states.get(url)}});
    else if([...op.states.values()].every(s=>['eose','failed'].includes(s.state)))finish(op);
    if(op.live&&[...op.states.values()].every(s=>s.state==='failed'&&!s.retryMs)){op.deliver({type:'status',status:{state:'closed',message:'All relays failed; reopen to retry',gapPossible:true}});dispose(op);}
  }
  function finish(op) {
    if(op.closed)return;
    const relays=[...op.states.values()],complete=relays.every(s=>s.state==='eose');
    const counts=op.options.filters.map(()=>0),events=[];
    for(const event of [...op.events.values()].sort((a,b)=>b.created_at-a.created_at||a.id.localeCompare(b.id))) {
      const eligible=op.options.filters.map((f,i)=>relayEventMatches(event,[f])&&counts[i]<f.limit);
      if(eligible.some(Boolean)){events.push(event);eligible.forEach((yes,i)=>{if(yes)counts[i]++;});}else op.truncated=true;
    }
    const result={events,relays,complete,partial:!complete,truncated:op.truncated};
    dispose(op);op.resolve?.(result);
  }
  function dispose(op) {
    if(op.closed)return;op.closed=true;clearTimeout(op.timer);op.deadlines.forEach(clearTimeout);op.deadlines.clear();operations.delete(op);
    for(const url of op.options.relays){const c=connections.get(url);if(!c)continue;c.ops.delete(op.id);if(c.socket?.readyState===1)c.socket.send(JSON.stringify(['CLOSE',op.id]));if(!c.ops.size){clearTimeout(c.retryTimer);clearTimeout(c.openTimer);c.socket?.close();connections.delete(url);}}
  }
  function req(c,op) {
    const filters=op.options.filters.map(f=>c.gapSince?{...f,since:Math.max(f.since??0,c.gapSince)}:f);
    if(op.live||!op.historyCounts.has('*'))op.historyCounts.set(op.live?c.url:'*',op.options.filters.map(()=>0));
    state(op,c.url,c.gapSince?'recovering':'loading','',{gapPossible:!!c.gapSince});
    if(op.live){clearTimeout(op.deadlines.get(c.url));op.deadlines.set(c.url,setTimeout(()=>{
      if(op.closed||op.states.get(c.url).state==='live')return;
      c.ops.delete(op.id);if(c.socket?.readyState===1)c.socket.send(JSON.stringify(['CLOSE',op.id]));
      state(op,c.url,'failed','Timed out waiting for stored events',{gapPossible:true});
      if(!c.ops.size){clearTimeout(c.retryTimer);c.socket?.close();connections.delete(c.url);}
    },op.options.timeoutMs));}
    c.socket.send(JSON.stringify(['REQ',op.id,...filters]));
  }
  function connect(c) {
    if(!c.ops.size)return;
    let socket;try{socket=new Socket(c.url);}catch{lost(c);return;}c.socket=socket;
    c.openTimer=setTimeout(()=>socket.close(),10000);
    socket.onopen=()=>{if(connections.get(c.url)!==c||c.socket!==socket)return socket.close();clearTimeout(c.openTimer);for(const op of c.ops.values())req(c,op);};
    socket.onmessage=message=>{
      if(c.socket!==socket||connections.get(c.url)!==c)return;
      if(typeof message.data!=='string'||relayBytes(message.data)>32768){socket.close();return;}
      const now=Date.now();if(!c.rateStart||now-c.rateStart>1000){c.rateStart=now;c.received=0;}if(++c.received>128){socket.close();return;}
      let msg;try{msg=JSON.parse(message.data);}catch{return;}if(!Array.isArray(msg))return;
      // AUTH/OK and unknown messages are ignored; no signer or publication path exists.
      if(msg[0]==='NOTICE'){for(const op of c.ops.values())state(op,c.url,op.states.get(c.url).state,typeof msg[1]==='string'?msg[1]:'Relay notice');return;}
      const op=c.ops.get(msg[1]);if(!op||op.closed)return;
      if(msg[0]==='EOSE'&&msg.length===2){clearTimeout(op.deadlines.get(c.url));state(op,c.url,op.live?'live':'eose','',{gapPossible:!!c.gapSince,truncated:op.historyTruncated.has(c.url)});return;}
      if(msg[0]==='CLOSED'){clearTimeout(op.deadlines.get(c.url));c.ops.delete(op.id);state(op,c.url,'failed',typeof msg[2]==='string'?msg[2]:'Relay closed subscription');if(!c.ops.size){socket.close();connections.delete(c.url);}return;}
      if(msg[0]!=='EVENT'||msg.length!==3)return;
      if(!op.rateStart||now-op.rateStart>60000){op.rateStart=now;op.received=0;}if(++op.received>240){op.truncated=true;state(op,c.url,'failed','Event rate limit reached');if(op.live){op.deliver({type:'status',status:{state:'closed',message:'Event rate limit reached',truncated:true}});dispose(op);}else finish(op);return;}
      const event=msg[2];if(!validRelayEvent(event,op.options.filters,verify)||op.seen.has(event.id))return;
      if(op.live&&op.states.get(c.url).state!=='live') {
        const counts=op.historyCounts.get(op.live?c.url:'*'),eligible=op.options.filters.map((f,i)=>relayEventMatches(event,[f])&&counts[i]<f.limit);
        if(!eligible.some(Boolean)){op.truncated=true;if(op.live&&!op.historyTruncated.has(c.url)){op.historyTruncated.add(c.url);state(op,c.url,op.states.get(c.url).state,'Stored history limit reached',{truncated:true,gapPossible:!!c.gapSince});}return;}
        eligible.forEach((yes,i)=>{if(yes)counts[i]++;});
      }
      if(op.seen.size>=4096){op.deliver({type:'status',status:{state:'closed',message:'Dedupe capacity reached; reopen subscription',truncated:true}});dispose(op);return;}op.seen.add(event.id);
      if(op.live){op.deliver({type:'event',event,relay:c.url});return;}
      const size=relayBytes(event);if(op.events.size>=100||op.bytes+size>258048){op.truncated=true;for(const [url,s] of op.states)if(s.state!=='eose')op.states.set(url,{url,state:'failed',message:'Query result capacity reached'});finish(op);return;}op.bytes+=size;op.events.set(event.id,event);
    };
    socket.onerror=()=>socket.close();socket.onclose=()=>{if(c.socket!==socket)return;clearTimeout(c.openTimer);lost(c);};
  }
  function lost(c) {
    if(connections.get(c.url)!==c||!c.ops.size)return;
    c.gapSince=c.gapSince??Math.floor(Date.now()/1000)-60;
    const delay=Math.min(30000,1000*2**c.attempt++);
    for(const op of [...c.ops.values()]) {
      clearTimeout(op.deadlines.get(c.url));
      state(op,c.url,'failed',`Relay disconnected; ${op.live?'retrying':'query incomplete'}`,{gapPossible:true,retryMs:delay});
      if(!op.live)c.ops.delete(op.id);
    }
    if(!c.ops.size){connections.delete(c.url);return;}
    if(c.attempt>6){for(const op of [...c.ops.values()])state(op,c.url,'failed','Reconnect budget exhausted; reopen to retry',{gapPossible:true});c.ops.clear();connections.delete(c.url);return;}
    c.retryTimer=setTimeout(()=>connect(c),delay);
  }
  function start(raw,live,deliver) {
    const options=validateRelayOptions(raw);if(operations.size>=24||sequence>=99999999)throw relayError('BUSY','Relay subscription capacity reached');
    const op={id:'ft'+(++sequence),options,live,deliver,deadlines:new Map(),historyCounts:new Map(),historyTruncated:new Set(),states:new Map(options.relays.map(url=>[url,{url,state:'connecting',message:''}])),events:new Map(),seen:new Set(),bytes:0,truncated:false,closed:false};operations.add(op);
    if(!live)op.promise=new Promise(resolve=>op.resolve=resolve);
    if(!live)op.timer=setTimeout(()=>{for(const [url,s]of op.states)if(s.state!=='eose')op.states.set(url,{url,state:'failed',message:'Query deadline exceeded'});finish(op);},options.timeoutMs);
    // Defer connection setup so the handle/response precedes all delivery messages.
    setTimeout(()=>{if(op.closed)return;for(const url of options.relays){let c=connections.get(url);if(!c){c={url,ops:new Map(),attempt:0};connections.set(url,c);c.ops.set(op.id,op);connect(c);}else{c.ops.set(op.id,op);if(c.socket?.readyState===1)req(c,op);}}});
    return {id:op.id,promise:op.promise,close:()=>{if(live)dispose(op);else{for(const url of options.relays)if(op.states.get(url).state!=='eose')op.states.set(url,{url,state:'failed',message:'Query closed'});finish(op);}},closed:()=>op.closed};
  }
  return {query:options=>start(options,false,()=>{}),subscribe:(options,deliver)=>start(options,true,deliver)};
}
