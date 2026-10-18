import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {application} from "../src/application.ts";
import {Assets} from "../src/assets.ts";
import {openDatabase} from "../src/database.ts";
import {originalSpinnerSource,starters} from "../src/starters.ts";

const title="Bitcoin spinner",description="Ask the important question. The answer is always Yes.";

test("startup upgrades only exact untouched original spinner lineage and is idempotent",()=>{
  const directory=mkdtempSync("/tmp/freedom-spinner-upgrade-"),owner="a".repeat(64);
  const db=openDatabase(directory),assets=new Assets(join(directory,"objects")),oldHash=assets.put(originalSpinnerSource),editedHash=assets.put(originalSpinnerSource.replace("Ready?","Edited"));
  const workshopId=(db.query("SELECT workshop_id FROM workshop_identity WHERE id=1").get() as any).workshop_id;
  db.run("INSERT INTO members(pubkey,name,identity_type,state,created_at) VALUES(?,'Owner','temporary','admitted',1)",[owner]);
  const seed=(id:string,sourceHash:string,options:{name?:string;origin?:string|null;revisions?:number}={})=>{
    const first=id+"-r1";
    db.run("INSERT INTO projects(id,owner,title,description,conversation_id,origin_project,origin_revision,created_at,workshop_id) VALUES(?,?,?,?,?,?,?,?,?)",[id,owner,options.name??title,description,id+"-conversation",options.origin??null,options.origin?"untouched-r1":null,1,workshopId]);
    db.run("INSERT INTO revisions(id,project_id,number,parent_id,restored_from,source_hash,author,created_at) VALUES(?,?,1,NULL,NULL,?,?,1)",[first,id,oldHash,owner]);
    let current=first;
    if((options.revisions??1)>1){current=id+"-r2";db.run("INSERT INTO revisions(id,project_id,number,parent_id,restored_from,source_hash,author,created_at) VALUES(?,?,2,?,NULL,?,?,2)",[current,id,first,sourceHash,owner]);}
    db.run("UPDATE projects SET current_revision=? WHERE id=?",[current,id]);
  };
  seed("untouched",oldHash);
  seed("renamed",oldHash,{name:"My spinner"});
  seed("edited",editedHash,{revisions:2});
  seed("restored",oldHash,{revisions:2});
  seed("fork",oldHash,{origin:"untouched"});
  db.close();

  let app=application({dataDir:directory,hostPubkey:null,origin:null,version:"test"});
  try{
    const correctedHash=app.workshop.assets.put(starters.find(starter=>starter.id==="spinner")!.source);
    expect(app.db.query("SELECT number,parent_id,source_hash FROM revisions WHERE project_id='untouched' ORDER BY number").all()).toEqual([
      {number:1,parent_id:null,source_hash:oldHash},
      {number:2,parent_id:"untouched-r1",source_hash:correctedHash}
    ]);
    for(const id of ["renamed","edited","restored","fork"]){
      const rows=app.db.query("SELECT source_hash FROM revisions WHERE project_id=? ORDER BY number").all(id) as any[];
      expect(rows.at(-1)!.source_hash).not.toBe(correctedHash);
    }
    app.db.close();app=application({dataDir:directory,hostPubkey:null,origin:null,version:"test"});
    expect(app.db.query("SELECT COUNT(*) count FROM revisions WHERE project_id='untouched'").get()).toEqual({count:2});
  }finally{app.db.close();rmSync(directory,{recursive:true,force:true});}
});
