import type {Database} from "bun:sqlite";
import type {Assets} from "./assets.ts";
import {sha256} from "./assets.ts";
import {originalSpinnerSource,starters} from "./starters.ts";

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
