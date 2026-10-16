import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { generateSecretKey, getPublicKey, finalizeEvent, type Event } from "nostr-tools";
import { application } from "../src/application.ts";
import { sha256 } from "../src/assets.ts";
import { nsiteAggregate, type PublicationPorts } from "../src/publication.ts";
test("publication selects exact consent only, verifies remote bytes/events, retains partial failure and resumes immutable signing", async()=>{
  const dir=mkdtempSync('/tmp/freedom-publication-'),secret=generateSecretKey(),pubkey=getPublicKey(secret);
  const app=application({dataDir:dir,origin:'https://test.example',hostPubkey:pubkey,version:'test'});
  try {
    app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[pubkey,'Test host','extension','admitted',20,1]);const host=app.auth.member(pubkey);
    const project=app.workshop.create(host,'todo').project;const selections=[{projectId:project.id,revisionId:project.current_revision}];
    expect(()=>app.publication.prepare(host,selections)).toThrow('consent');
    app.workshop.share(host,project.id,{revisionId:project.current_revision});expect(()=>app.publication.prepare(host,selections)).toThrow('consent');
    app.workshop.consent(host,project.id,{revisionId:project.current_revision,granted:true});const snapshot=app.publication.prepare(host,selections);
    const blobs=new Map<string,Uint8Array>(),events=new Map<string,Event>();let fail=true,uploads=0,signs=0;
    const ports:PublicationPorts={publisherPubkey:pubkey,servers:['https://storage.example'],relays:['wss://relay.example'],sign:async e=>{signs++;return finalizeEvent(e,secret)},upload:async(_s,h,b)=>{uploads++;blobs.set(h,b)},readAsset:async(_s,h)=>{const b=blobs.get(h);if(!b)throw Error('missing');return b},publish:async(_r,e)=>{if(fail)throw Error('relay unavailable');events.set(e.id,finalizeEvent({kind:e.kind,created_at:e.created_at,content:e.content,tags:e.tags},secret))},readEvent:async(_r,id)=>events.get(id)||null};
    let release!:()=>void, entered!:()=>void;const held=new Promise<void>(r=>release=r), started=new Promise<void>(r=>entered=r);let first=true;
    const heldPorts={...ports,readAsset:async(s:string,h:string)=>{if(first){first=false;entered();await held;}return ports.readAsset(s,h);}};
    const running=app.publication.publish(host,snapshot.id,heldPorts);await started;
    await expect(app.publication.publish(host,snapshot.id,ports)).rejects.toThrow('active execution claim');release();
    await expect(running).rejects.toThrow('relay unavailable');expect((app.publication.list(host)[0] as any).status).toBe('partial_failure');expect(uploads).toBe(3);
    app.db.run('INSERT INTO publication_claims VALUES(?,?,?)',[snapshot.id,'expired-worker',Date.now()-1]);
    app.db.run('INSERT INTO publication_operations VALUES(?,?,?,?,?,?)',[snapshot.id,'interrupted-proof','pending',null,null,1]);
    const count=signs;fail=false;const receipt=await app.publication.publish(host,snapshot.id,ports);expect(receipt.events.map(e=>e.kind)).toEqual([5129,35128]);expect(uploads).toBe(3);expect(signs).toBe(count+1);expect((app.db.query('SELECT status FROM publication_operations WHERE operation=?').get('interrupted-proof') as any).status).toBe('interrupted');expect(app.db.query('SELECT * FROM publication_claims').all()).toEqual([]);
    expect((app.publication.list(host)[0] as any).status).toBe('verified');
    const site=[...events.values()].find(e=>e.kind===35128)!;expect(site.tags.find(t=>t[0]==='x')?.[1]).toBe(nsiteAggregate(site.tags.filter(t=>t[0]==='path').map(t=>({path:t[1]!,hash:t[2]!}))));
    const allPublic=[...blobs.values()].map(b=>new TextDecoder().decode(b)).join('\n');expect(allPublic).not.toContain('Private instructions');expect(allPublic).not.toContain('conversation_id');expect(allPublic).toContain(pubkey);
    const firstHash=[...blobs.keys()][0]!;expect(sha256(blobs.get(firstHash)!)).toBe(firstHash);
    app.workshop.consent(host,project.id,{revisionId:project.current_revision,granted:false});await expect(app.publication.publish(host,snapshot.id,ports)).rejects.toThrow('Consent');
    app.workshop.consent(host,project.id,{revisionId:project.current_revision,granted:true});
    const revokedPorts={...ports,readAsset:async()=>{app.workshop.consent(host,project.id,{revisionId:project.current_revision,granted:false});throw Error('missing');}};
    await expect(app.publication.publish(host,snapshot.id,revokedPorts)).rejects.toThrow('Consent');expect(uploads).toBe(3);
  } finally {app.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('nsite aggregate hash ignores path ordering',()=>{const paths=[{path:'/index.html',hash:'a'.repeat(64)},{path:'/app.html',hash:'b'.repeat(64)}];expect(nsiteAggregate(paths)).toBe(nsiteAggregate([...paths].reverse()));});
