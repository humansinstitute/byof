import { readdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureBuilderDirectory } from './pipeline/project-directory.ts';
import { sha256 } from './assets.ts';
/** Copy supporting files without replacing either source or destination. Operator-only setup. */
export function copyProjectFiles(source:string,destination:string):{path:string;sha256:string}[] {
  ensureBuilderDirectory(source);ensureBuilderDirectory(destination);
  const evidence:{path:string;sha256:string}[]=[];
  function copy(relative:string){
    const from=join(source,relative),to=join(destination,relative),stat=lstatSync(from);
    if(stat.isSymbolicLink())throw Error('migration_symlink_denied');
    if(stat.isDirectory()){
      ensureBuilderDirectory(to);
      for(const name of readdirSync(from))copy(join(relative,name));
    }else if(stat.isFile()){
      const bytes=readFileSync(from),hash=sha256(bytes);
      try{writeFileSync(to,bytes,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;const existing=lstatSync(to);if(!existing.isFile()||existing.isSymbolicLink()||sha256(readFileSync(to))!==hash)throw Error('migration_destination_conflict');}
      evidence.push({path:relative,sha256:hash});
    }else throw Error('migration_file_denied');
  }
  for(const name of readdirSync(source))copy(name);
  return evidence;
}
