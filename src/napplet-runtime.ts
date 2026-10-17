import client from '../templates/napplet-client.js' with { type: 'text' };
import { previewPolicy } from './assets.ts';
const previewEscapeBridge = `<script>document.addEventListener('keydown',function(event){if(event.key==='Escape'){event.preventDefault();parent.postMessage({type:'freedom-preview-escape'},'*');}},true);document.addEventListener('pointerdown',function(){parent.postMessage({type:'freedom-preview-focus'},'*');},true);document.addEventListener('focusin',function(){parent.postMessage({type:'freedom-preview-focus'},'*');});</script>`;
export function nappletRuntimeBootstrap(documentId:string) {
  const policy=previewPolicy.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  return {documentId,injection:`<meta http-equiv="Content-Security-Policy" content="${policy}"><script>${client.replace('__FREEDOM_DOCUMENT_ID__',JSON.stringify(documentId))}</script>`,suffix:previewEscapeBridge};
}
export function nappletRuntimeShell(documentId:string,sourceHash:string) {
  const runtime=nappletRuntimeBootstrap(documentId),injection=Buffer.from(runtime.injection).toString('base64'),suffix=Buffer.from(runtime.suffix).toString('base64');
  const script=`(function(){const expected=${JSON.stringify(sourceHash)},injection=atob(${JSON.stringify(injection)}),suffix=atob(${JSON.stringify(suffix)}),ready='<script>parent.postMessage({type:"freedom-napplet-document-ready",sourceHash:'+JSON.stringify(expected)+'},"*")<\\/script>',channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();document.body.textContent='Napplet payload unavailable';},10000);channel.port1.onmessage=async event=>{clearTimeout(timer);channel.port1.close();const source=event.data?.source;if(typeof source!=='string')return document.body.textContent='Napplet payload unavailable';const bytes=new TextEncoder().encode(source),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');if(hash!==expected)return document.body.textContent='Napplet payload integrity check failed';const doctype=source.match(/^(?:\\s|<!--[\\s\\S]*?-->)*<!doctype[^>]*>/i),at=doctype?doctype[0].length:0,html=source.slice(0,at)+injection+source.slice(at)+suffix+ready;document.open();document.write(html);document.close();};parent.postMessage({type:'freedom-napplet-source-request',sourceHash:expected},'*',[channel.port2]);})();`;
  return `<!doctype html><html><body><p>Loading Napplet…</p><script>${script}</script></body></html>`;
}
// Run before any app script. The injected code contains no identity or authority.
export function injectNappletBridge(source: string, documentId: string) {
  const script=nappletRuntimeBootstrap(documentId).injection;
  // Preserve standards mode while executing before any generated app script.
  const doctype=source.match(/^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i);
  return doctype ? source.slice(0,doctype[0].length)+script+source.slice(doctype[0].length) : script+source;
}
