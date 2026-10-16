import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Member} from './auth.ts';
import {now} from './auth.ts';
import {sha256} from './assets.ts';
import {limits} from './config.ts';
import {demand} from './errors.ts';
import {createStorageJob,dispatchStorageJob,pollStorageJob,storageStatus,type StorageConfig} from './storage.ts';
import {uuid} from './tower-storage-client.ts';
import type {Workshop} from './workshop.ts';

const imageTypes=new Set(['image/png','image/jpeg','image/webp','image/gif']);

function filename(value:unknown){
  demand(typeof value==='string'&&value.length>0&&value.length<=180&&!/[\u0000-\u001f\u007f/\\]/u.test(value),400,'Image filename is invalid');
  return value;
}

function imageBytes(body:any){
  demand(typeof body.base64==='string'&&body.base64.length>0&&body.base64.length<=Math.ceil(limits.attachmentBytes/3)*4+4&&/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64),400,'Image data is invalid');
  const bytes=Buffer.from(body.base64,'base64');
  demand(bytes.length>0&&bytes.length<=limits.attachmentBytes&&bytes.toString('base64')===body.base64,413,'Image is too large or invalid');
  demand(body.sizeBytes===bytes.length,400,'Image size changed during upload');
  return new Uint8Array(bytes);
}

function view(row:any,status:string,error:string|null=null){
  return {attachment_id:row.id,kind:'image',filename:row.filename,content_type:row.content_type,size_bytes:row.size_bytes,storage_object_id:row.storage_object_id||null,status,error};
}

export async function prepareChatAttachment(workshop:Workshop,member:Member,config:StorageConfig|undefined,projectId:string,body:any){
  const project=workshop.project(member,projectId,true);
  demand(config,503,'Private Tower storage is unavailable');
  const binding=storageStatus(workshop,config).binding;demand(binding&&storageStatus(workshop,config).state==='ready',409,'Private Tower storage is not ready');
  demand(uuid.test(body.attachmentId),400,'Attachment id is invalid');
  const name=filename(body.filename),contentType=String(body.contentType||'').toLowerCase();demand(imageTypes.has(contentType),415,'Paste a PNG, JPEG, WebP or GIF image');
  const bytes=imageBytes(body),hash=sha256(bytes);
  const existing=workshop.db.query('SELECT * FROM chat_attachments WHERE id=?').get(body.attachmentId) as any;
  if(existing){demand(existing.workshop_id===workshop.id&&existing.project_id===project.id&&existing.uploader===member.pubkey&&existing.filename===name&&existing.content_type===contentType&&existing.size_bytes===bytes.length&&existing.sha256===hash,409,'Attachment id already belongs to different image data');return chatAttachmentStatus(workshop,member,config,projectId,body.attachmentId);}
  const candidate={attachmentId:body.attachmentId,projectId:project.id,uploader:member.pubkey,filename:name,contentType,sizeBytes:bytes.length};
  const jobId=createStorageJob(workshop,'chat_attachment',binding.target,name,bytes,candidate,undefined,contentType);
  workshop.db.run('INSERT INTO chat_attachments VALUES(?,?,?,?,?,?,?,?,?,?,?)',[body.attachmentId,workshop.id,project.id,member.pubkey,jobId,null,name,contentType,bytes.length,hash,now()]);
  await dispatchStorageJob(workshop,config,jobId);
  return view(workshop.db.query('SELECT * FROM chat_attachments WHERE id=?').get(body.attachmentId),'uploading');
}

export async function chatAttachmentStatus(workshop:Workshop,member:Member,config:StorageConfig|undefined,projectId:string,attachmentId:string){
  workshop.project(member,projectId,true);demand(config,503,'Private Tower storage is unavailable');
  const row=workshop.db.query('SELECT * FROM chat_attachments WHERE id=? AND workshop_id=? AND project_id=? AND uploader=?').get(attachmentId,workshop.id,projectId,member.pubkey) as any;
  demand(row,404,'Pasted image upload was not found');
  const job=await pollStorageJob(workshop,config,row.storage_job_id);
  if(job.status==='verified'){
    demand(uuid.test(job.objectId)&&job.contentType===row.content_type&&job.sizeBytes===row.size_bytes&&job.sha256===row.sha256,409,'Verified image receipt changed');
    workshop.db.run('UPDATE chat_attachments SET storage_object_id=? WHERE id=? AND storage_object_id IS NULL',[job.objectId,row.id]);
    const ready=workshop.db.query('SELECT * FROM chat_attachments WHERE id=?').get(row.id) as any;return view(ready,'ready');
  }
  if(job.error)return view(row,'error','Tower could not store this image. Retry or remove it.');
  return view(row,'uploading');
}

export function bindRequestAttachments(workshop:Workshop,member:Member,projectId:string,requestId:string,prompt:string,input:unknown){
  const attachments=input===undefined?[]:input;demand(Array.isArray(attachments)&&attachments.length<=8,400,'Use at most eight pasted images per message');
  const ids=new Set<string>();const normalized=attachments.map((item:any,index)=>{
    demand(item&&typeof item==='object'&&uuid.test(item.attachment_id)&&uuid.test(item.storage_object_id)&&!ids.has(item.attachment_id),400,'Attachment payload is invalid');ids.add(item.attachment_id);
    const row=workshop.db.query(`SELECT a.*,j.status job_status,j.object_id job_object_id FROM chat_attachments a JOIN storage_jobs j ON j.id=a.storage_job_id WHERE a.id=? AND a.workshop_id=? AND a.project_id=? AND a.uploader=?`).get(item.attachment_id,workshop.id,projectId,member.pubkey) as any;
    demand(row&&row.job_status==='verified'&&row.storage_object_id===item.storage_object_id&&row.job_object_id===item.storage_object_id,409,'Wait for every pasted image to finish uploading');
    demand(prompt.includes(`storage://${row.storage_object_id}`),400,'Pasted image link is missing from the message');
    const metadata={attachment_id:row.id,kind:'image',filename:row.filename,content_type:row.content_type,size_bytes:row.size_bytes,storage_object_id:row.storage_object_id};
    return {index,metadata};
  });
  const existing=requestAttachments(workshop,requestId);
  if(existing.length){demand(JSON.stringify(existing)===JSON.stringify(normalized.map(item=>item.metadata)),409,'Request attachments changed after save');return existing;}
  for(const item of normalized)workshop.db.run('INSERT INTO request_attachments VALUES(?,?,?,?)',[requestId,item.metadata.attachment_id,item.index,JSON.stringify(item.metadata)]);
  return normalized.map(item=>item.metadata);
}

export function requestAttachments(workshop:Workshop,requestId:string){
  return (workshop.db.query('SELECT metadata_json FROM request_attachments WHERE request_id=? ORDER BY ordinal').all(requestId) as any[]).map(row=>JSON.parse(row.metadata_json));
}

export function materializeRequestAttachments(workshop:Workshop,requestId:string,directory:string){
  const attachments=requestAttachments(workshop,requestId);if(!attachments.length)return [];
  const folder=join(directory,'.attachments');mkdirSync(folder,{recursive:true,mode:0o700});
  return attachments.map(attachment=>{
    const row=workshop.db.query('SELECT j.base64,j.sha256,j.size_bytes FROM chat_attachments a JOIN storage_jobs j ON j.id=a.storage_job_id WHERE a.id=?').get(attachment.attachment_id) as any;
    const bytes=Buffer.from(row.base64,'base64');demand(bytes.length===row.size_bytes&&sha256(bytes)===row.sha256,409,'Saved attachment bytes changed');
    const path=join(folder,`${attachment.storage_object_id}-${attachment.filename}`);writeFileSync(path,bytes,{mode:0o600});
    return {...attachment,storage_ref:`storage://${attachment.storage_object_id}`,local_path:path};
  });
}
