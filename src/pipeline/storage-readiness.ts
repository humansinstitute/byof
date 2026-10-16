import {operatorDecision} from './operator-build.ts';
import {terminal} from './operations.ts';
export function storageDecision(input:any){
 const decision=operatorDecision(input);
 if(!decision.builderAllowed||input.storageReady===true||input.mode==='answer')return decision;
 const intent=input.screen?.answers?.implementation;
 // With unavailable storage only clearly conversational auto requests proceed.
 const answer=input.mode==='auto'&&intent?.type==='noul'&&typeof intent.noul==='number'&&Number.isFinite(intent.noul)&&intent.noul>=0&&intent.noul<0.05;
 if(answer)return decision;
 return {...decision,builderAllowed:false,blockedResult:{action:'build_failed',banRequired:false,retryable:true,code:'storage_unready',response:'Private storage needs authorization before app changes can run. Your saved app is preserved. Ask a question, or have the site administrator connect the selected Tower workspace.'}};
}
export function storageTerminal(input:any){return terminal({...input,builder:input.builder??input.blockedResult});}
