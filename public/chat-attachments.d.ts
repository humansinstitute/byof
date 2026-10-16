export function clipboardImages(clipboardData:DataTransfer|null):File[];
export function imageUploadToken(id:string):string;
export function insertImageMarkers(value:string,start:number,end:number,ids:string[]):{value:string;tokens:string[];caret:number};
export function replaceImageMarker(value:string,token:string,replacement:string):{value:string;caret:number|null;replaced:boolean};
export function imageMarkdown(filename:string,objectId:string):string;
export function submittedImageAttachments(records:any[]):any[];
export function imageUploadsBlockSend(records:any[]):boolean;
