import type {Database} from "bun:sqlite";
import type {Assets} from "./assets.ts";
import {sha256} from "./assets.ts";
import {originalCashuSource,originalPongSource,originalSpinnerSource,pointerPongSource,starters} from "./starters.ts";

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
  const originalHash=sha256(originalPongSource),pointerHash=sha256(pointerPongSource),replacementHash=assets.put(replacement);
  return db.transaction(()=>{
    const matches=db.query(`SELECT p.id,p.owner,p.current_revision,current.number
      FROM projects p JOIN revisions current ON current.id=p.current_revision
      WHERE p.origin_project IS NULL AND p.deleted_at IS NULL
        AND p.title='Pong' AND p.description='Play the classic paddle game immediately with keyboard or touch controls.'
        AND current.restored_from IS NULL
        AND (
          (current.number=1 AND current.parent_id IS NULL AND current.source_hash IN (?,?)
            AND (SELECT COUNT(*) FROM revisions history WHERE history.project_id=p.id)=1)
          OR
          (current.number=2 AND current.source_hash=?
            AND (SELECT COUNT(*) FROM revisions history WHERE history.project_id=p.id)=2
            AND EXISTS(SELECT 1 FROM revisions parent WHERE parent.id=current.parent_id AND parent.project_id=p.id
              AND parent.number=1 AND parent.parent_id IS NULL AND parent.restored_from IS NULL AND parent.source_hash=?))
        )`).all(originalHash,pointerHash,pointerHash,originalHash) as {id:string;owner:string;current_revision:string;number:number}[];
    let upgraded=0;
    for(const project of matches){
      const revisionId=crypto.randomUUID();
      db.run("INSERT INTO revisions(id,project_id,number,parent_id,restored_from,source_hash,author,created_at) VALUES(?,?,?,?,NULL,?,?,?)",[revisionId,project.id,project.number+1,project.current_revision,replacementHash,project.owner,Math.floor(Date.now()/1000)]);
      upgraded+=db.run("UPDATE projects SET current_revision=? WHERE id=? AND current_revision=?",[revisionId,project.id,project.current_revision]).changes;
    }
    return upgraded;
  }).immediate();
}
