import {test,expect} from 'bun:test';
import {agentPublicationConfiguration} from '../src/pipeline/publication-configuration.ts';
import {nip19} from 'nostr-tools';
test('all capable scopes use the new protocol while original owned-run grants remain exact recovery authority',()=>{
 const scope:any={fileVersions:true,replacementEnabled:true,builderRoot:'/napplets',appPubkey:'a'.repeat(64),origin:'https://autopilot.test',callbackUrl:'https://app.test/api/v1/pipeline/callback',definitionId:'old-one',credentialFile:'/one',ownerPubkey:'owner-one'};
 const current={...scope,additionalScopes:[{...scope,definitionId:'old-two',credentialFile:'/two',ownerPubkey:'owner-two',previousDefinitionId:'older-two',previousCredentialFile:'/older-two'}]};
 const receipt={credentialFile:'/new',grant:{expiresAt:Date.now()+3600000,definitionId:'new',functionHashes:{'freedomtools.agentPublish.v66':'hash'},appRoot:'/app',installationId:'installation',appNpub:nip19.npubEncode(scope.appPubkey),origin:scope.origin,callbackUrl:'https://app.test/api/v1/pipeline/message'}};
 const result=agentPublicationConfiguration(current,receipt,'/app','installation');
 expect(result.agentPublication).toBe(true);expect(result.definitionId).toBe('new');expect(result.callbackUrl).toBe(receipt.grant.callbackUrl);expect(result.receiptRecovery?.definitionId).toBe('old-one');
 expect(result.additionalScopes?.[0].agentPublication).toBe(true);expect(result.additionalScopes?.[0].ownerPubkey).toBe('owner-two');expect(result.additionalScopes?.[0].receiptRecovery).toEqual(current.additionalScopes[0]);
 expect(current.definitionId).toBe('old-one');
 for(const grant of [{...receipt.grant,appRoot:'/other'},{...receipt.grant,installationId:'other'},{...receipt.grant,appNpub:nip19.npubEncode('b'.repeat(64))},{...receipt.grant,callbackUrl:scope.callbackUrl},{...receipt.grant,functionHashes:{}}])expect(()=>agentPublicationConfiguration(current,{...receipt,grant},'/app','installation')).toThrow('mismatch');
 expect(()=>agentPublicationConfiguration({...current,additionalScopes:[{...scope,suspended:true}]},receipt,'/app','installation')).toThrow('Capable scope changed');
});

test('Goose configuration pins v69, preserves Codex grants and disables unsupported native deletion',async()=>{
 const {gooseBuilderConfiguration}=await import('../src/pipeline/goose-configuration.ts');
 const current:any={fileVersions:true,replacementEnabled:true,builderRoot:'/napplets',appPubkey:'a'.repeat(64),origin:'https://autopilot.test',callbackUrl:'https://app.test/api/v1/pipeline/message',definitionId:'codex',credentialFile:'/codex',nativeDeletion:{definitionId:'old-delete'}};
 const receipt={credentialFile:'/goose',grant:{expiresAt:Date.now()+3600000,definitionId:'goose',functionHashes:{'freedomtools.agentPublish.v69':'publish','freedomtools.followupPrepare.v69':'prepare','session.completedTurn':'completed'},appRoot:'/app',installationId:'installation',appNpub:nip19.npubEncode(current.appPubkey),origin:current.origin,callbackUrl:current.callbackUrl}};
 const next=gooseBuilderConfiguration(current,receipt,'/app','installation');
 expect(next.builderRuntime).toEqual({agent:'goose',provider:'openrouter',model:'z-ai/glm-5.3'});expect(next.receiptRecovery?.definitionId).toBe('codex');expect(next.nativeDeletion).toBeUndefined();expect(next.receiptRecovery?.nativeDeletion).toEqual(current.nativeDeletion);
 expect(()=>gooseBuilderConfiguration(current,{...receipt,grant:{...receipt.grant,functionHashes:{'freedomtools.agentPublish.v69':'publish'}}},'/app','installation')).toThrow('pinned grant');
});
