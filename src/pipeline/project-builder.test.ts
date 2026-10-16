import {expect,test} from "bun:test";
import {persistentDecision,completedCandidate,safeProgress} from "./project-builder.ts";
const screen={model:"jev-test",answers:{injection:{type:"noul",noul:0},extraction:{type:"noul",noul:0}}};
test("pinned activation gate never permits classifier errors or bans",()=>{
 expect(persistentDecision({screen}).builderAllowed).toBe(false);
 expect(persistentDecision({screen,executionEnabled:true}).builderAllowed).toBe(true);
 expect(persistentDecision({screen:{},executionEnabled:true}).builderAllowed).toBe(false);
 expect(persistentDecision({screen:{...screen,answers:{...screen.answers,injection:{type:"noul",noul:0.95}}},executionEnabled:true}).builderAllowed).toBe(false);
});
test("correlated isolated completion remains a candidate, never promoted native text",()=>{
 const input={requestId:"r",projectId:"p",runId:"run",turn:{status:"completed",requestId:"r",projectId:"p",invocationRunId:"run",executionId:"e",receiptId:"receipt",sequence:1,output:{executionProfile:"isolated-codex",projectFiles:[]}}};
 expect(completedCandidate(input)).toMatchObject({action:"build_failed",code:"artifact_validation_pending",banRequired:false,retryable:false});
 for(const turn of [{...input.turn,status:"sending"},{...input.turn,invocationRunId:null},{...input.turn,executionId:null}])expect(completedCandidate({...input,turn})).toMatchObject({code:"builder_completion_invalid",retryable:true});
});
test("progress requires trusted mapping and discards every native text field",()=>{
 const mapping={runId:"run",requestId:"r",projectId:"p"};
 expect(safeProgress({...mapping,status:"building",reasoning:"private",tool:"private"} as any,mapping)).toEqual({...mapping,status:"building"});
 expect(()=>safeProgress({...mapping,runId:"foreign",status:"building"},mapping)).toThrow();
 expect(()=>safeProgress({...mapping,status:"private native text"},mapping)).toThrow();
});
