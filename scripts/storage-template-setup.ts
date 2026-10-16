// Operator installs one pinned Tower connector. Site-admin workspace choices stay in the app.
import { configuration } from '../src/config.ts';
const [grantPath]=Bun.argv.slice(2);
if(!grantPath||Bun.spawnSync(['git','check-ignore',grantPath]).exitCode!==0||Bun.spawnSync(['git','ls-files','--error-unmatch',grantPath]).exitCode===0)throw Error('Use an ignored/untracked managed grant receipt');
const config=configuration(),receipt=await Bun.file(grantPath).json(),grant=receipt.grant;
const base=config.storage;
if(!base||grant.installationId!==base.installationId||grant.appNpub!==base.appNpub||grant.origin!==base.pipeline.origin||grant.callbackUrl!==base.pipeline.callbackUrl||grant.appRoot!==process.cwd()||!receipt.credentialFile)throw Error('Storage installation grant mismatch');
const template={...base,pipeline:{...base.pipeline,definitionId:grant.definitionId,credentialFile:receipt.credentialFile}};
const templates=[...(config.storageTemplates||[]).filter(t=>t.towerOrigin!==template.towerOrigin),template];
const envFile=Bun.file('.env'),current=await envFile.text(),line='FREEDOM_STORAGE_TEMPLATES='+JSON.stringify(templates);
await Bun.write(envFile,current.match(/^FREEDOM_STORAGE_TEMPLATES=.*$/m)?current.replace(/^FREEDOM_STORAGE_TEMPLATES=.*$/m,line):current+'\n'+line+'\n');
console.log(JSON.stringify({towerOrigin:template.towerOrigin,definitionId:grant.definitionId,installationId:template.installationId,legacyPreserved:true}));
