import type {Database} from "bun:sqlite";
import type {Assets} from "./assets.ts";
import {sha256} from "./assets.ts";
import {mouseFreePongSource,originalCashuSource,originalPongSource,originalSpinnerSource,pointerPongSource,starters} from "./starters.ts";

const spinnerTitle="Bitcoin spinner";
const spinnerDescription="Ask the important question. The answer is always Yes.";

export function upgradeUntouchedOriginalSpinners(db:Database,assets:Assets):number {
  const replacement=starters.find(starter=>starter.id==="spinner")!.source;
  const originalHash=sha256(originalSpinnerSource),replacementHash=assets.put(replacement);
  return db.transaction(()=>{
    const matches=db.query(`SELECT p.id,p.owner,p.current_revision
      FROM projects p JOIN revisions current ON current.id=p.current_revision
      WHERE p.origin_project IS NULL AND p.deleted_at IS NULL
        AND p.title=? AND p.description=?
        AND current.number=1 AND current.parent_id IS NULL AND current.restored_from IS NULL
        AND current.source_hash=?
        AND (SELECT COUNT(*) FROM revisions history WHERE history.project_id=p.id)=1`).all(spinnerTitle,spinnerDescription,originalHash) as {id:string;owner:string;current_revision:string}[];
    let upgraded=0;
    for(const project of matches){
      const revisionId=crypto.randomUUID();
      db.run("INSERT INTO revisions(id,project_id,number,parent_id,restored_from,source_hash,author,created_at) VALUES(?,?,2,?,NULL,?,?,?)",[revisionId,project.id,project.current_revision,replacementHash,project.owner,Math.floor(Date.now()/1000)]);
      upgraded+=db.run("UPDATE projects SET current_revision=? WHERE id=? AND current_revision=?",[revisionId,project.id,project.current_revision]).changes;
    }
    return upgraded;
  }).immediate();
}

export function upgradeUntouchedOriginalCashuWallets(db:Database,assets:Assets):number {
  const replacement=starters.find(starter=>starter.id==="cashu")!.source;
  const originalHash=sha256(originalCashuSource),replacementHash=assets.put(replacement);
  return db.transaction(()=>{
    const matches=db.query(`SELECT p.id,p.owner,p.current_revision
      FROM projects p JOIN revisions current ON current.id=p.current_revision
      WHERE p.origin_project IS NULL AND p.deleted_at IS NULL
        AND p.title='SATCADE wallet' AND p.description='A retro arcade wallet for receiving and sending sats over Lightning.'
        AND current.number=1 AND current.parent_id IS NULL AND current.restored_from IS NULL
        AND current.source_hash=?
        AND (SELECT COUNT(*) FROM revisions history WHERE history.project_id=p.id)=1`).all(originalHash) as {id:string;owner:string;current_revision:string}[];
    let upgraded=0;
    for(const project of matches){
      const revisionId=crypto.randomUUID();
      db.run("INSERT INTO revisions(id,project_id,number,parent_id,restored_from,source_hash,author,created_at) VALUES(?,?,2,?,NULL,?,?,?)",[revisionId,project.id,project.current_revision,replacementHash,project.owner,Math.floor(Date.now()/1000)]);
      upgraded+=db.run("UPDATE projects SET current_revision=? WHERE id=? AND current_revision=?",[revisionId,project.id,project.current_revision]).changes;
    }
    return upgraded;
  }).immediate();
}

export function upgradeUntouchedOriginalPongProjects(db:Database,assets:Assets):number {
  const replacement=starters.find(starter=>starter.id==="pong")!.source;
  const originalHash=sha256(originalPongSource),pointerHash=sha256(pointerPongSource),mouseFreeHash=sha256(mouseFreePongSource),replacementHash=assets.put(replacement);
  return db.transaction(()=>{
    const matches=db.query(`SELECT p.id,p.owner,p.current_revision,current.number
      FROM projects p JOIN revisions current ON current.id=p.current_revision
      WHERE p.origin_project IS NULL AND p.deleted_at IS NULL
        AND p.title='Pong' AND p.description='Play the classic paddle game immediately with keyboard or touch controls.'
        AND current.restored_from IS NULL
        AND current.source_hash IN (?,?,?)`).all(originalHash,pointerHash,mouseFreeHash) as {id:string;owner:string;current_revision:string;number:number}[];
    const allowed=new Set([
      originalHash,pointerHash,mouseFreeHash,
      `${originalHash},${pointerHash}`,`${originalHash},${mouseFreeHash}`,`${pointerHash},${mouseFreeHash}`,
      `${originalHash},${pointerHash},${mouseFreeHash}`
    ]);
    let upgraded=0;
    for(const project of matches){
      const history=db.query("SELECT id,number,parent_id,restored_from,source_hash FROM revisions WHERE project_id=? ORDER BY number").all(project.id) as {id:string;number:number;parent_id:string|null;restored_from:string|null;source_hash:string}[];
      const exactChain=history.every((revision,index)=>revision.number===index+1&&revision.parent_id===(index?history[index-1]!.id:null)&&revision.restored_from===null);
      if(!exactChain||!allowed.has(history.map(revision=>revision.source_hash).join(",")))continue;
      const revisionId=crypto.randomUUID();
      db.run("INSERT INTO revisions(id,project_id,number,parent_id,restored_from,source_hash,author,created_at) VALUES(?,?,?,?,NULL,?,?,?)",[revisionId,project.id,project.number+1,project.current_revision,replacementHash,project.owner,Math.floor(Date.now()/1000)]);
      upgraded+=db.run("UPDATE projects SET current_revision=? WHERE id=? AND current_revision=?",[revisionId,project.id,project.current_revision]).changes;
    }
    return upgraded;
  }).immediate();
}
