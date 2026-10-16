// Install once for a managed WApp; browser-approved destinations require no per-Tower env entry.
import {configuration,publicKey} from '../src/config.ts';
import {readFileSync,writeFileSync,renameSync,statSync} from 'node:fs';
const [receiptPath]=Bun.argv.slice(2);
if(!receiptPath||Bun.spawnSync(['git','check-ignore',receiptPath]).exitCode!==0||Bun.spawnSync(['git','ls-files','--error-unmatch',receiptPath]).exitCode===0)throw Error('Use an ignored, untracked grant receipt');
const config=configuration(),receipt=await Bun.file(receiptPath).json(),grant=receipt.grant,base=config.storage;
if(!base||!receipt.credentialFile||grant.appRoot!==process.cwd()||grant.installationId!==base.installationId||grant.appNpub!==base.appNpub||publicKey(grant.appNpub)!==base.appPubkey||grant.origin!==base.pipeline.origin||grant.callbackUrl!==base.pipeline.callbackUrl||grant.expiresAt<=Date.now()||Object.keys(grant.functionHashes??{}).filter(k=>/^freedomtools\.storageJob\.v\d+$/.test(k)).length!==1)throw Error('Managed storage grant mismatch');
const managed={...base,pipeline:{...base.pipeline,definitionId:grant.definitionId,credentialFile:receipt.credentialFile}};
const source=readFileSync('.env','utf8'),key='FREEDOM_MANAGED_STORAGE_CONFIG=',lines=source.split('\n');
if(lines.filter(l=>l.startsWith(key)).length>1)throw Error('Duplicate managed storage configuration');
const content=lines.some(l=>l.startsWith(key))?lines.map(l=>l.startsWith(key)?key+JSON.stringify(managed):l).join('\n'):source+'\n'+key+JSON.stringify(managed)+'\n';
const temporary='.env.storage-'+crypto.randomUUID();writeFileSync(temporary,content,{flag:'wx',mode:statSync('.env').mode&0o777});renameSync(temporary,'.env');
console.log(JSON.stringify({definitionId:grant.definitionId,installationId:base.installationId,managedAppRestartRequired:true,existingBindingsPreserved:true}));
