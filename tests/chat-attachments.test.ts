import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {application} from '../src/application.ts';
import {bindRequestAttachments,materializeRequestAttachments,requestAttachments} from '../src/chat-attachments.ts';
import {sha256} from '../src/assets.ts';
import {clipboardImages,imageMarkdown,imageUploadsBlockSend,insertImageMarkers,replaceImageMarker,submittedImageAttachments} from '../public/chat-attachments.js';

test('paste helpers preserve surrounding text, multiple markers, failures and ordinary text paste',()=>{
  const inserted=insertImageMarkers('before AFTER',7,7,['one','two']);
  expect(inserted.value).toBe('before [ Uploading image one... ]\n[ Uploading image two... ]AFTER');
  const first=replaceImageMarker(inserted.value,inserted.tokens[0]!,imageMarkdown('image.png','11111111-1111-4111-8111-111111111111'));
  const second=replaceImageMarker(first.value,inserted.tokens[1]!,'[ Image upload failed: image.jpg ]');
  expect(second.value).toContain('before ![image.png](storage://11111111-1111-4111-8111-111111111111)');
  expect(second.value.endsWith('[ Image upload failed: image.jpg ]AFTER')).toBe(true);
  expect(clipboardImages({items:[{kind:'string',type:'text/plain',getAsFile:()=>null}]} as any)).toEqual([]);
  const ready={status:'ready',attachment:{attachment_id:'a'}},failed={status:'error'};
  expect(submittedImageAttachments([ready,failed])).toEqual([{attachment_id:'a'}]);
  expect(imageUploadsBlockSend([ready,failed])).toBe(true);
});

test('request attachment snapshot is exact, linked in Markdown and materialized for Agent 21',()=>{
  const directory=mkdtempSync('/tmp/freedom-chat-attachment-'),app=application({dataDir:directory,hostPubkey:null,origin:null,version:'test'});
  try{
    const owner='a'.repeat(64);app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Owner','temporary','admitted',20,1]);
    const member=app.auth.member(owner),project=app.workshop.create(member,'blank').project,attachmentId=crypto.randomUUID(),objectId=crypto.randomUUID(),jobId=crypto.randomUUID(),bytes=Buffer.from('image bytes'),requestId=crypto.randomUUID();
    app.db.run('INSERT INTO storage_jobs(id,operation,candidate_json,target_json,file_name,sha256,size_bytes,base64,status,object_id,workshop_id,content_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[jobId,'chat_attachment','{}','{}','image.png',sha256(bytes),bytes.length,bytes.toString('base64'),'verified',objectId,app.workshop.id,'image/png']);
    app.db.run('INSERT INTO chat_attachments VALUES(?,?,?,?,?,?,?,?,?,?,?)',[attachmentId,app.workshop.id,project.id,owner,jobId,objectId,'image.png','image/png',bytes.length,sha256(bytes),1]);
    app.db.run('INSERT INTO requests(id,project_id,prompt,expected_revision,status,error,created_at,mode) VALUES(?,?,?,?,?,?,?,?)',[requestId,project.id,`look ![image.png](storage://${objectId})`,project.current_revision,'unavailable',null,1,'auto']);
    const payload={attachment_id:attachmentId,kind:'image',filename:'image.png',content_type:'image/png',size_bytes:bytes.length,storage_object_id:objectId};
    bindRequestAttachments(app.workshop,member,project.id,requestId,`look ![image.png](storage://${objectId})`,[payload]);
    expect(requestAttachments(app.workshop,requestId)).toEqual([payload]);
    expect(()=>bindRequestAttachments(app.workshop,member,project.id,requestId,'link removed',[payload])).toThrow('missing');
    const built=materializeRequestAttachments(app.workshop,requestId,directory+'/project');
    expect(built[0]).toMatchObject({...payload,storage_ref:`storage://${objectId}`});
    expect(readFileSync(built[0].local_path)).toEqual(bytes);
  }finally{app.db.close();rmSync(directory,{recursive:true,force:true});}
});
