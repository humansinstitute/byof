import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {application} from "../src/application.ts";
import {Assets} from "../src/assets.ts";
import {openDatabase} from "../src/database.ts";
import {mouseFreePongSource,originalCashuSource,originalPongSource,originalSpinnerSource,pointerPongSource,starters} from "../src/starters.ts";

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

test("startup upgrades only exact untouched original SATCADE lineage and is idempotent",()=>{
  const directory=mkdtempSync("/tmp/freedom-cashu-upgrade-"),owner="b".repeat(64);
  const db=openDatabase(directory),assets=new Assets(join(directory,"objects")),oldHash=assets.put(originalCashuSource),editedHash=assets.put(originalCashuSource.replace("Pocket sats.","My sats."));
  const workshopId=(db.query("SELECT workshop_id FROM workshop_identity WHERE id=1").get() as any).workshop_id;
  db.run("INSERT INTO members(pubkey,name,identity_type,state,created_at) VALUES(?,'Owner','temporary','admitted',1)",[owner]);
  const seed=(id:string,sourceHash:string,options:{title?:string;origin?:string|null;revisions?:number}={})=>{
    const first=id+"-r1";
    db.run("INSERT INTO projects(id,owner,title,description,conversation_id,origin_project,origin_revision,created_at,workshop_id) VALUES(?,?,?,?,?,?,?,?,?)",[id,owner,options.title??"SATCADE wallet","A retro arcade wallet for receiving and sending sats over Lightning.",id+"-conversation",options.origin??null,options.origin?"untouched-r1":null,1,workshopId]);
    db.run("INSERT INTO revisions(id,project_id,number,parent_id,restored_from,source_hash,author,created_at) VALUES(?,?,1,NULL,NULL,?,?,1)",[first,id,oldHash,owner]);
    let current=first;
    if((options.revisions??1)>1){current=id+"-r2";db.run("INSERT INTO revisions(id,project_id,number,parent_id,restored_from,source_hash,author,created_at) VALUES(?,?,2,?,NULL,?,?,2)",[current,id,first,sourceHash,owner]);}
    db.run("UPDATE projects SET current_revision=? WHERE id=?",[current,id]);
  };
  seed("untouched",oldHash); seed("renamed",oldHash,{title:"My wallet"}); seed("edited",editedHash,{revisions:2}); seed("fork",oldHash,{origin:"untouched"});
  db.close();

  let app=application({dataDir:directory,hostPubkey:null,origin:null,version:"test"});
  try{
    const correctedHash=app.workshop.assets.put(starters.find(starter=>starter.id==="cashu")!.source);
    expect(app.db.query("SELECT number,parent_id,source_hash FROM revisions WHERE project_id='untouched' ORDER BY number").all()).toEqual([
      {number:1,parent_id:null,source_hash:oldHash},
      {number:2,parent_id:"untouched-r1",source_hash:correctedHash}
    ]);
    for(const id of ["renamed","edited","fork"]){
      const rows=app.db.query("SELECT source_hash FROM revisions WHERE project_id=? ORDER BY number").all(id) as any[];
      expect(rows.at(-1)!.source_hash).not.toBe(correctedHash);
    }
    app.db.close();app=application({dataDir:directory,hostPubkey:null,origin:null,version:"test"});
    expect(app.db.query("SELECT COUNT(*) count FROM revisions WHERE project_id='untouched'").get()).toEqual({count:2});
  }finally{app.db.close();rmSync(directory,{recursive:true,force:true});}
});

test("startup upgrades only exact untouched original Pong lineage and is idempotent",()=>{
  const directory=mkdtempSync("/tmp/freedom-pong-upgrade-"),owner="c".repeat(64),title="Pong",description="Play the classic paddle game immediately with keyboard or touch controls.";
  const db=openDatabase(directory),assets=new Assets(join(directory,"objects")),oldHash=assets.put(originalPongSource),pointerHash=assets.put(pointerPongSource),mouseFreeHash=assets.put(mouseFreePongSource),editedHash=assets.put(originalPongSource.replace("Game running.","My game."));
  const workshopId=(db.query("SELECT workshop_id FROM workshop_identity WHERE id=1").get() as any).workshop_id;
  db.run("INSERT INTO members(pubkey,name,identity_type,state,created_at) VALUES(?,'Owner','temporary','admitted',1)",[owner]);
  const seed=(id:string,sourceHash:string,options:{title?:string;description?:string;origin?:string|null;revisions?:number;restored?:boolean;deleted?:boolean;firstHash?:string}={})=>{
    const first=id+"-r1";
    db.run("INSERT INTO projects(id,owner,title,description,conversation_id,origin_project,origin_revision,created_at,workshop_id,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?)",[id,owner,options.title??title,options.description??description,id+"-conversation",options.origin??null,options.origin?"untouched-r1":null,1,workshopId,options.deleted?2:null]);
    db.run("INSERT INTO revisions(id,project_id,number,parent_id,restored_from,source_hash,author,created_at) VALUES(?,?,1,NULL,NULL,?,?,1)",[first,id,options.firstHash??oldHash,owner]);
    let current=first;
    if((options.revisions??1)>1){current=id+"-r2";db.run("INSERT INTO revisions(id,project_id,number,parent_id,restored_from,source_hash,author,created_at) VALUES(?,?,2,?,?,?,?,2)",[current,id,first,options.restored?first:null,sourceHash,owner]);}
    db.run("UPDATE projects SET current_revision=? WHERE id=?",[current,id]);
  };
  seed("untouched",oldHash);
  seed("pointer-fresh",pointerHash,{firstHash:pointerHash});
  seed("pointer-upgraded",pointerHash,{revisions:2});
  seed("mousefree-fresh",mouseFreeHash,{firstHash:mouseFreeHash});
  seed("mousefree-original",mouseFreeHash,{revisions:2});
  seed("mousefree-pointer",mouseFreeHash,{revisions:2,firstHash:pointerHash});
  seed("mousefree-chain",pointerHash,{revisions:2});
  db.run("INSERT INTO revisions(id,project_id,number,parent_id,restored_from,source_hash,author,created_at) VALUES('mousefree-chain-r3','mousefree-chain',3,'mousefree-chain-r2',NULL,?,?,3)",[mouseFreeHash,owner]);
  db.run("UPDATE projects SET current_revision='mousefree-chain-r3' WHERE id='mousefree-chain'");
  seed("renamed",oldHash,{title:"My Pong"});
  seed("redescribed",oldHash,{description:"My paddle game"});
  seed("edited",editedHash,{revisions:2});
  seed("restored",oldHash,{revisions:2,restored:true});
  seed("fork",oldHash,{origin:"untouched"});
  seed("deleted",oldHash,{deleted:true});
  db.close();

  let app=application({dataDir:directory,hostPubkey:null,origin:null,version:"test"});
  try{
    const correctedHash=app.workshop.assets.put(starters.find(starter=>starter.id==="pong")!.source);
    expect(app.db.query("SELECT number,parent_id,source_hash FROM revisions WHERE project_id='untouched' ORDER BY number").all()).toEqual([
      {number:1,parent_id:null,source_hash:oldHash},
      {number:2,parent_id:"untouched-r1",source_hash:correctedHash}
    ]);
    expect(app.db.query("SELECT number,source_hash FROM revisions WHERE project_id='pointer-fresh' ORDER BY number").all()).toEqual([{number:1,source_hash:pointerHash},{number:2,source_hash:correctedHash}]);
    expect(app.db.query("SELECT number,source_hash FROM revisions WHERE project_id='pointer-upgraded' ORDER BY number").all()).toEqual([{number:1,source_hash:oldHash},{number:2,source_hash:pointerHash},{number:3,source_hash:correctedHash}]);
    for(const id of ["mousefree-fresh","mousefree-original","mousefree-pointer","mousefree-chain"]){
      const rows=app.db.query("SELECT source_hash FROM revisions WHERE project_id=? ORDER BY number").all(id) as {source_hash:string}[];
      expect(rows.at(-1)!.source_hash).toBe(correctedHash);
    }
    for(const id of ["renamed","redescribed","edited","restored","fork","deleted"]){
      const rows=app.db.query("SELECT source_hash FROM revisions WHERE project_id=? ORDER BY number").all(id) as any[];
      expect(rows.at(-1)!.source_hash).not.toBe(correctedHash);
    }
    app.db.close();app=application({dataDir:directory,hostPubkey:null,origin:null,version:"test"});
    expect(app.db.query("SELECT COUNT(*) count FROM revisions WHERE project_id='untouched'").get()).toEqual({count:2});
    expect(app.db.query("SELECT COUNT(*) count FROM revisions WHERE project_id='pointer-fresh'").get()).toEqual({count:2});
    expect(app.db.query("SELECT COUNT(*) count FROM revisions WHERE project_id='pointer-upgraded'").get()).toEqual({count:3});
    expect(app.db.query("SELECT COUNT(*) count FROM revisions WHERE project_id='mousefree-fresh'").get()).toEqual({count:2});
    expect(app.db.query("SELECT COUNT(*) count FROM revisions WHERE project_id='mousefree-original'").get()).toEqual({count:3});
    expect(app.db.query("SELECT COUNT(*) count FROM revisions WHERE project_id='mousefree-pointer'").get()).toEqual({count:3});
    expect(app.db.query("SELECT COUNT(*) count FROM revisions WHERE project_id='mousefree-chain'").get()).toEqual({count:4});
  }finally{app.db.close();rmSync(directory,{recursive:true,force:true});}
});
