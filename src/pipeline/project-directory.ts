import { lstatSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve, parse, join } from 'node:path';
/** Called only after installation-pinned routing; never accepts a caller's path. */
export function ensureBuilderDirectory(directory: string) {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw Error('builder_directory_denied');
  let current = parse(directory).root;
  for (const part of directory.slice(current.length).split('/').filter(Boolean)) {
    current = join(current,part);
    try { const entry=lstatSync(current); if (entry.isSymbolicLink() || !entry.isDirectory()) throw Error('builder_directory_denied'); }
    catch (error:any) { if (error.code !== 'ENOENT') throw error; try { mkdirSync(current,{mode:0o700}); } catch (createError:any) { if(createError.code !== 'EEXIST') throw createError; } const created=lstatSync(current); if(created.isSymbolicLink() || !created.isDirectory()) throw Error('builder_directory_denied'); }
  }
}

/** Refresh only the app-authoritative page. Supporting builder files survive follow-ups. */
export function seedBuilderSource(directory: string, source: string) {
  ensureBuilderDirectory(directory);
  const target = join(directory, 'index.html');
  for (const file of [target]) {
    try { const entry = lstatSync(file); if (!entry.isFile() || entry.isSymbolicLink()) throw Error('builder_source_denied'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  const staging = join(directory, '.index-'+randomUUID()+'.next');
  writeFileSync(staging, source, {mode: 0o600, flag: 'wx'});
  try { renameSync(staging, target); } catch (error) { unlinkSync(staging); throw error; }
}
