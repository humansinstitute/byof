// App-owned native CLI. The opaque session capability stays in process memory;
// no signing key, installation credential or storage secret enters the builder.
import {randomUUID} from 'node:crypto';
const sessionId=process.env.WINGMAN_SESSION_ID||process.env.SESSION_ID;
const origin=process.env.WINGMAN_BROKER_URL||process.env.WINGMAN_CAPABILITY_BROKER_URL||process.env.WINGMAN_URL;
let token=process.env.WINGMAN_CAPABILITY;
if(!sessionId||!origin||!token)throw Error('Scoped native tool capability unavailable');
const [command,...checks]=Bun.argv.slice(2);
if(command!=='publish'||!checks.length)throw Error('Usage: bun .agents/napplet-publish.js publish "actual validation and result" ...');
async function call(path,body){return fetch(new URL(path,origin),{method:'POST',redirect:'error',headers:{authorization:'Bearer '+token,'x-wingman-capability-nonce':randomUUID(),'content-type':'application/json'},body:JSON.stringify(body)});}
const body={sessionId,tool:'napplet.publish',args:{validation:checks}};
let response=await call('/api/mcp/wingman/project-tool',body);
if(response.status===401){const refreshed=await call('/api/mcp/capabilities/refresh',{sessionId});if(refreshed.ok){token=(await refreshed.json()).token;response=await call('/api/mcp/wingman/project-tool',body);}}
if(response.status===409&&(await response.clone().json()).code==='capability_reissued'){const adopted=await call('/api/mcp/capabilities/reissue-adopt',{sessionId});if(adopted.ok){token=(await adopted.json()).token;response=await call('/api/mcp/wingman/project-tool',body);}}
const result=await response.json();
if(!response.ok||result.status!=='published')throw Error(result.error||'Publication pending; retry this same tool call. Your last version is preserved.');
console.log(JSON.stringify(result));
