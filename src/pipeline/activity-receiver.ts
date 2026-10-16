import {createHash} from 'node:crypto';
import {verifyEvent,type Event} from 'nostr-tools';
import {DeliveryDenied} from './receiver.ts';
export type ActivityEnvelope = {version:1;eventId:string;sequence:number;runId:string;stepId:string;sessionId:string|null;turnId:string;correlation:Record<string,string>;timestamp:string;type:'commentary'|'tools'|'completed'|'failed';content:string};
export type VerifiedActivity = {envelope:ActivityEnvelope;authEventId:string;bodyHash:string;publicUrl:string;authCreatedAt:number};
const id=(x:unknown):x is string=>typeof x==='string'&&x.length>0&&x.length<=200&&!/[\x00-\x1f]/.test(x);
/** Authenticate exact bytes first. Freshness is checked in the transaction AFTER
 * stable event dedup so an already accepted retry can be safely acknowledged. */
export function verifyActivity(input:{body:string;authorization:string|null;publicUrl:string;signerPubkey:string;eventHeader:string|null;runHeader:string|null}):VerifiedActivity {
  if(Buffer.byteLength(input.body)>131072)throw new DeliveryDenied('activity_body_too_large');
  if(!input.authorization?.startsWith('Nostr '))throw new DeliveryDenied('authorization_required');
  const bodyHash=createHash('sha256').update(input.body).digest('hex');
  let event:Event,e:ActivityEnvelope;
  try{event=JSON.parse(Buffer.from(input.authorization.slice(6),'base64').toString('utf8'));e=JSON.parse(input.body);if(!verifyEvent(event))throw Error();}catch{throw new DeliveryDenied('invalid_signature_or_body');}
  if(event.pubkey!==input.signerPubkey||event.kind!==27235||event.content!==''||!Number.isInteger(event.created_at))throw new DeliveryDenied('signer_or_kind_denied');
  const one=(name:string)=>{const tags=event.tags.filter(t=>t[0]===name);if(tags.length!==1||tags[0]!.length!==2)throw new DeliveryDenied('invalid_'+name+'_tag');return tags[0]![1];};
  if(one('u')!==input.publicUrl||one('method')!=='POST'||one('payload')!==bodyHash)throw new DeliveryDenied('request_binding_denied');
  if(!e||Object.keys(e).sort().join(',')!=='content,correlation,eventId,runId,sequence,sessionId,stepId,timestamp,turnId,type,version'||e.version!==1||!/^[0-9a-f]{64}$/.test(e.eventId)||!id(e.runId)||!id(e.stepId)||!id(e.turnId)||!id(e.sessionId)||!Number.isSafeInteger(e.sequence)||e.sequence<1||e.sequence>257||typeof e.timestamp!=='string'||!Number.isFinite(Date.parse(e.timestamp))||!['commentary','tools','completed','failed'].includes(e.type)||typeof e.content!=='string'||!e.content.trim()||e.content.length>4000)throw new DeliveryDenied('invalid_activity_envelope');
  if(e.sequence===257&&!['completed','failed'].includes(e.type))throw new DeliveryDenied('activity_capacity_denied');
  if(e.type!=='commentary'&&e.content!==({tools:'Using tools',completed:'Completed',failed:'Failed'} as any)[e.type])throw new DeliveryDenied('invalid_activity_content');
  if(!e.correlation||Array.isArray(e.correlation)||Object.keys(e.correlation).length>16||!Object.values(e.correlation).every(id)||!id(e.correlation.requestId)||!id(e.correlation.projectId)||!id(e.correlation.workshopId)||!id(e.correlation.nativeRequestId)||!id(e.correlation.generation))throw new DeliveryDenied('activity_correlation_required');
  if(one('event')!==e.eventId||one('run')!==e.runId||input.eventHeader!==e.eventId||input.runHeader!==e.runId)throw new DeliveryDenied('receipt_binding_denied');
  return {envelope:e,authEventId:event.id,bodyHash,publicUrl:input.publicUrl,authCreatedAt:event.created_at};
}
