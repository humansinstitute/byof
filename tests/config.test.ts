import {afterEach,expect,test} from 'bun:test';
import {configuration} from '../src/config.ts';

const previousData=process.env.FREEDOM_DATA_DIR,previousFollowup=process.env.FREEDOM_FOLLOWUP_CONFIG,previousRoot=process.env.FREEDOM_NAPPLET_ROOT;
afterEach(()=>{
 if(previousData===undefined)delete process.env.FREEDOM_DATA_DIR;else process.env.FREEDOM_DATA_DIR=previousData;
 if(previousFollowup===undefined)delete process.env.FREEDOM_FOLLOWUP_CONFIG;else process.env.FREEDOM_FOLLOWUP_CONFIG=previousFollowup;
 if(previousRoot===undefined)delete process.env.FREEDOM_NAPPLET_ROOT;else process.env.FREEDOM_NAPPLET_ROOT=previousRoot;
});

test('remote publication staging roots are app-owned and cannot be supplied by installation JSON',()=>{
 process.env.FREEDOM_DATA_DIR='/data';
 delete process.env.FREEDOM_NAPPLET_ROOT;
 process.env.FREEDOM_FOLLOWUP_CONFIG=JSON.stringify({remotePreparation:true,localBuilderRoot:'/workspace/untrusted',receiptRecovery:{remotePreparation:true},additionalScopes:[{remotePreparation:true}]});
 const config=configuration();
 expect(config.followup?.localBuilderRoot).toBe('/data/remote-builds');
 expect(config.followup?.receiptRecovery?.localBuilderRoot).toBe('/data/remote-builds');
 expect(config.followup?.additionalScopes?.[0]?.localBuilderRoot).toBe('/data/remote-builds');
});
