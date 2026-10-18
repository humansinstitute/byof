export const MIN_SCALE=.15,MAX_SCALE=2;
export const clampScale=value=>Math.max(MIN_SCALE,Math.min(MAX_SCALE,value));

export function objectBounds(object){
  if(object.kind!=='arrow')return {left:object.x,top:object.y,right:object.x+object.width,bottom:object.y+object.height};
  const curveX=object.curveX??object.endX/2,curveY=object.curveY??object.endY/2;
  return {left:object.x+Math.min(0,object.endX,curveX),top:object.y+Math.min(0,object.endY,curveY),right:object.x+Math.max(0,object.endX,curveX),bottom:object.y+Math.max(0,object.endY,curveY)};
}

export function contentBounds(objects){
  if(!objects.length)return {left:0,top:0,right:1,bottom:1,width:1,height:1};
  const bounds=objects.map(objectBounds),left=Math.min(...bounds.map(b=>b.left)),top=Math.min(...bounds.map(b=>b.top)),right=Math.max(...bounds.map(b=>b.right)),bottom=Math.max(...bounds.map(b=>b.bottom));
  return {left,top,right,bottom,width:Math.max(1,right-left),height:Math.max(1,bottom-top)};
}

export function cameraForBounds(bounds,viewport,scale){
  const next=clampScale(scale);
  return {scale:next,x:(viewport.width-(bounds.right-bounds.left)*next)/2-bounds.left*next,y:(viewport.height-(bounds.bottom-bounds.top)*next)/2-bounds.top*next};
}

export function initialCamera(objects,viewport){
  const focus=objects.find(o=>o.kind==='napplet')||objects.find(o=>!['group','arrow'].includes(o.kind))||objects[0];
  if(!focus)return {x:24,y:24,scale:1};
  const bounds=objectBounds(focus),width=Math.max(1,bounds.right-bounds.left),height=Math.max(1,bounds.bottom-bounds.top);
  const scale=clampScale(Math.min(1,(viewport.width-48)/width,(viewport.height-48)/height));
  return cameraForBounds(bounds,viewport,scale);
}

export function fitCamera(objects,viewport){
  const bounds=contentBounds(objects),scale=clampScale(Math.min(1,(viewport.width-32)/bounds.width,(viewport.height-32)/bounds.height));
  return cameraForBounds(bounds,viewport,scale);
}

export function screenBounds(object,camera){
  const bounds=objectBounds(object);
  return {left:camera.x+bounds.left*camera.scale,top:camera.y+bounds.top*camera.scale,right:camera.x+bounds.right*camera.scale,bottom:camera.y+bounds.bottom*camera.scale};
}
