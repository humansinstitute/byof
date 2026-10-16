// Trusted parent dataset domain. No tokens, cookies, signing authority or stores enter the child.
export function datasetDisplayName(name) {
 return typeof name==='string' ? name.split(/[-_]+/).filter(Boolean).map(word=>word[0].toUpperCase()+word.slice(1)).join(' ') : 'Shared Data';
}
export function canvasDomain({context,backend,ask,assert,error,close}) {
 const methods=['datasets.open','datasets.get','datasets.list','datasets.set','datasets.remove','datasets.close','datasets.watch','datasets.unwatch'];
 async function execute(b,method,p,signal){
  const action=method.split('.')[1];b.datasets??=new Map();b.datasetWatches??=new Map();
  if(action==='open'){
   if(Object.keys(p).length!==1||!p.dataset||Object.keys(p.dataset).some(k=>!['name','visibility','description','fields'].includes(k))||!/^[a-z][a-z0-9_-]{0,63}$/.test(p.dataset.name)||!['shared','private'].includes(p.dataset.visibility))throw error('INVALID','Supply a named shared/private dataset');
   if(b.datasets.size>=4)throw error('QUOTA','At most four datasets per Napplet');
   await ask(b,'dataset',p.dataset,signal);assert(b);
   const opened=await backend(b,'dataset',{token:b.token,method:'open',dataset:p.dataset},signal);b.datasets.set(opened.handle,opened.binding);return opened;
  }
  const allowed=action==='set'?['handle','key','value','expectedVersion']:action==='remove'?['handle','key','expectedVersion']:action==='get'?['handle','key']:['handle'];
  if(Object.keys(p).some(k=>!allowed.includes(k))||!b.datasets.has(p.handle))throw error('DENIED','Dataset permission missing or invalid fields');
  if(action==='watch'){
   if(b.datasetWatches.size>=4||b.datasetWatches.has(p.handle))throw error('QUOTA','At most one watch per handle, four per Napplet');
   const controller=new AbortController();b.controllers.add(controller);
   const watch={close:()=>{controller.abort();b.controllers.delete(controller);b.datasetWatches.delete(p.handle);}};b.datasetWatches.set(p.handle,watch);
   void pump(b,p.handle,controller).finally(()=>watch.close());return {handle:p.handle};
  }
  if(action==='unwatch'){b.datasetWatches.get(p.handle)?.close();return;}
  if(action==='close'){b.datasetWatches.get(p.handle)?.close();await backend(b,'dataset',{token:b.token,method:'close',handle:p.handle},signal);b.datasets.delete(p.handle);return;}
  return backend(b,'dataset',{token:b.token,method:action,...p},signal);
 }
 function deliver(b,handle,payload){assert(b);if(b.unacked.size>=16){close(b);return;}const deliveryId=String(++b.relaySequence);b.unacked.set(deliveryId,{time:Date.now()});b.port.postMessage({version:1,type:'dataset',handle,payload,deliveryId});}
 async function pump(b,handle,controller){let backoff=1000;
  while(!controller.signal.aborted){
   try{
    assert(b);const c=context();
    const response=await fetch('/api/v1/napplet/dataset/watch',{method:'POST',credentials:'same-origin',signal:controller.signal,headers:{'content-type':'application/json','x-csrf-token':c.csrf,'x-workshop-id':b.workshop},body:JSON.stringify({token:b.token,handle})});
    assert(b);if([401,403,404].includes(response.status)){close(b);return;}if(!response.ok)throw Error('Watch unavailable');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    // Every connection begins with a full host read and a refetch hint, including reconnects.
    while(!controller.signal.aborted){const {value,done}=await reader.read();if(done)throw Error('Watch disconnected');buffer+=decoder.decode(value,{stream:true});if(buffer.length>16384)throw Error('Watch buffer exceeded');let index;while((index=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);if(message.type!=='heartbeat')deliver(b,handle,message);if(message.state==='closed'){b.datasets.delete(handle);controller.abort();return;}}backoff=1000;}
   }catch{if(controller.signal.aborted)return;try{deliver(b,handle,{type:'status',state:'recovering',message:'Disconnected; refetch current data after recovery'});}catch{return;}}
   await new Promise(resolve=>{const timer=setTimeout(done,backoff);function done(){clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();}controller.signal.addEventListener('abort',done,{once:true});});backoff=Math.min(10000,backoff*2);
  }
 }
 return {methods,execute};
}
