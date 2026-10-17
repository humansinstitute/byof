(function () {
  'use strict';
  const version = 1, pending = new Map(), subscriptions = new Map(), earlyRelay = new Map();
  let earlyCount = 0, earlyBytes = 0;
  const datasetSubscriptions=new Map();
  let port, closed = false, sequence = 0, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  function failure(code, message) { const e = new Error(message); e.code = code; return e; }
  function close() {
    if(closed)return;closed=true;
    for(const s of datasetSubscriptions.values())callback(s.onStatus,{state:'closed',message:'Napplet bridge closed'});datasetSubscriptions.clear();
    for(const s of subscriptions.values()){s.closed=true;try{callback(s.onStatus,{state:'closed',message:'Napplet bridge closed'});}catch{}}subscriptions.clear();earlyRelay.clear();earlyCount=0;earlyBytes=0;
    port?.postMessage({version,type:'client-close'}); port?.close(); readyReject(failure('STALE','Napplet bridge closed'));
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(failure('STALE','Napplet bridge closed')); } pending.clear();
  }
  const handshakeTimer = setTimeout(() => { if (!port) { readyReject(failure('UNAVAILABLE','Napplet host unavailable')); closed = true; } }, 10000);
  function callback(fn,...args) {const result=fn?.(...args);if(result&&typeof result.then==='function')Promise.resolve(result).catch(e=>console.error('Napplet relay callback failed',e));}
  function relayMessage(r,draining=false) {
    const s=subscriptions.get(r.subscriptionId);
    if(!s&&!draining&&[...pending.values()].some(p=>p.subscribe)) {
      let bytes;try{bytes=new TextEncoder().encode(JSON.stringify(r)).length;}catch{return;}
      if(earlyCount<16&&earlyBytes+bytes<=262144){const messages=earlyRelay.get(r.subscriptionId)||[];messages.push(r);earlyRelay.set(r.subscriptionId,messages);earlyCount++;earlyBytes+=bytes;return;}
      close();return;
    }
    try {if(s&&!s.closed){if(r.payload?.type==='event')callback(s.onEvent,r.payload.event,{relay:r.payload.relay});else if(r.payload?.type==='status'){callback(s.onStatus,r.payload.status);if(r.payload.status.state==='closed'){s.closed=true;subscriptions.delete(r.subscriptionId);}}}}
    catch(e){console.error('Napplet relay callback failed',e);}
    finally{if(typeof r.deliveryId==='string')port.postMessage({version,type:'relay-ack',deliveryId:r.deliveryId});}
  }
  function drainRelay(id) {
    const messages=earlyRelay.get(id)||[];earlyRelay.delete(id);
    for(const r of messages){earlyCount--;earlyBytes-=new TextEncoder().encode(JSON.stringify(r)).length;relayMessage(r,true);}
  }
  function receive(event) {
    if (event.source !== parent || event.data?.type !== 'freedom-napplet-connect' || event.data.version !== version || event.ports.length !== 1 || port || closed) return;
    port = event.ports[0]; clearTimeout(handshakeTimer); window.removeEventListener('message',receive);
    port.onmessage = event => {
      const r = event.data;
      if(r?.version===version&&r.type==='dataset'){try{const s=datasetSubscriptions.get(r.handle);if(s){if(r.payload.type==='change')callback(s.onChange,r.payload);else if(r.payload.type==='status'){callback(s.onStatus,r.payload);if(r.payload.state==='closed')datasetSubscriptions.delete(r.handle);}}}finally{if(typeof r.deliveryId==='string')port.postMessage({version,type:'relay-ack',deliveryId:r.deliveryId});}return;}
      if (r?.type === 'close') return close();
      if(r?.version===version&&r.type==='relay'&&typeof r.subscriptionId==='string')return relayMessage(r);
      if (r?.version !== version || typeof r.id !== 'string') return;
      const p = pending.get(r.id); if (!p) return; pending.delete(r.id); clearTimeout(p.timer);
      if (r.ok) {if(p.subscribe){const s=p.subscribe;s.id=r.value.subscriptionId;subscriptions.set(s.id,s);queueMicrotask(()=>drainRelay(s.id));}p.resolve(r.value);} else p.reject(failure(r.error?.code || 'FAILED', r.error?.message || 'Request failed'));
    };
    port.start(); readyResolve();
  }
  window.addEventListener('message',receive);
  window.addEventListener('pagehide',close);
  parent.postMessage({type:'freedom-napplet-ready',version,documentId:__FREEDOM_DOCUMENT_ID__},'*');
  async function request(method, params = {}, subscribe) {
    if (closed) throw failure('STALE','Napplet bridge closed');
    if (pending.size >= 4) throw failure('BUSY','At most four requests may run together');
    let encoded; try { encoded = JSON.stringify(params); } catch { throw failure('INVALID','JSON parameters required'); }
    if (!encoded || new TextEncoder().encode(encoded).length > 49152) throw failure('TOO_LARGE','Request exceeds 48 KiB');
    await ready;
    if (closed || pending.size >= 4) throw failure(closed?'STALE':'BUSY','Bridge closed or busy');
    return new Promise((resolve,reject) => {
      const id = String(++sequence), timer = setTimeout(() => { pending.delete(id); reject(failure('TIMEOUT','Host request timed out')); },60000);
      pending.set(id,{resolve,reject,timer,subscribe}); port.postMessage({version,id,method,params:JSON.parse(encoded)});
    });
  }
  async function subscribe(options,callbacks) {
    if(!callbacks||typeof callbacks.onEvent!=='function'||(callbacks.onStatus!==undefined&&typeof callbacks.onStatus!=='function'))throw failure('INVALID','Supply onEvent and optional onStatus callbacks');
    const s={onEvent:callbacks.onEvent,onStatus:callbacks.onStatus,closed:false};
    const {subscriptionId}=await request('relay.subscribe',options,s);
    return Object.freeze({id:subscriptionId,close:async()=>{if(s.closed)return;await request('relay.close',{subscriptionId});s.closed=true;subscriptions.delete(subscriptionId);}});
  }
  async function openDataset(dataset){
    const opened=await request('datasets.open',{dataset});let ended=false;
    const call=(method,params={})=>{if(ended)return Promise.reject(failure('STALE','Dataset handle closed'));return request('datasets.'+method,{handle:opened.handle,...params});};
    return Object.freeze({name:opened.binding.name,visibility:opened.binding.visibility,schema:opened.schema,
      remove:(key,expectedVersion)=>call('remove',{key,expectedVersion}),get:key=>call('get',{key}),list:()=>call('list'),set:(key,value,expectedVersion)=>call('set',{key,value,expectedVersion}),
      watch:async callbacks=>{
        if(!callbacks||typeof callbacks.onChange!=='function'||callbacks.onStatus!==undefined&&typeof callbacks.onStatus!=='function')throw failure('INVALID','Supply onChange and optional onStatus callbacks');
        if(datasetSubscriptions.has(opened.handle))throw failure('BUSY','Dataset already watched');
        datasetSubscriptions.set(opened.handle,callbacks);
        try{await call('watch');}catch(e){datasetSubscriptions.delete(opened.handle);throw e;}
        return Object.freeze({close:async()=>{if(ended)return;await call('unwatch');datasetSubscriptions.delete(opened.handle);}});
      },close:async()=>{if(ended)return;await call('close');ended=true;datasetSubscriptions.delete(opened.handle);}
    });
  }
  const api = Object.freeze({version, cashu:Object.freeze({status:()=>request('cashu.status'),connect:()=>request('cashu.connect'),createDeposit:amount=>request('cashu.createDeposit',{amount}),checkDeposit:quote=>request('cashu.checkDeposit',{quote}),disconnect:()=>request('cashu.disconnect')}), datasets:Object.freeze({open:openDataset}), relay:Object.freeze({query:options=>request('relay.query',options),subscribe}), capabilities:()=>request('capabilities'), identity:Object.freeze({getPublicKey:()=>request('identity.getPublicKey')}), signing:Object.freeze({signEvent:event=>request('signing.signEvent',{event})}), storage:Object.freeze({get:key=>request('storage.get',{key}),set:(key,value)=>request('storage.set',{key,value}),remove:key=>request('storage.remove',{key})})});
  Object.defineProperty(window,'napplet',{value:api,writable:false,configurable:false});
})();
