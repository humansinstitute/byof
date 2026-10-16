export function clipboardImages(clipboardData) {
  return [...(clipboardData?.items || [])]
    .filter(item => item?.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map(item => item.getAsFile?.())
    .filter(Boolean);
}

export function imageUploadToken(id) {
  return `[ Uploading image ${id}... ]`;
}

export function insertImageMarkers(value, start, end, ids) {
  const tokens=ids.map(imageUploadToken),text=tokens.join('\n');
  return {value:`${value.slice(0,start)}${text}${value.slice(end)}`,tokens,caret:start+text.length};
}

export function replaceImageMarker(value, token, replacement) {
  const index=value.indexOf(token);if(index<0)return {value,caret:null,replaced:false};
  return {value:`${value.slice(0,index)}${replacement}${value.slice(index+token.length)}`,caret:index+replacement.length,replaced:true};
}

export function imageMarkdown(filename, objectId) {
  const alt=String(filename||'image').replace(/[\[\]]/g,'').trim()||'image';
  return `![${alt}](storage://${objectId})`;
}

export function submittedImageAttachments(records) {
  return records.filter(record=>record.status==='ready').map(record=>record.attachment);
}

export function imageUploadsBlockSend(records) {
  return records.some(record=>record.status!=='ready');
}
