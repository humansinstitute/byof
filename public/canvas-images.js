export const canvasImageLimits={inputBytes:10_000_000,inputSide:16_000,inputPixels:40_000_000,outputBytes:2_000_000,outputSide:2048,outputPixels:4_194_304};

function encoded(canvas,type,quality){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('Picture encoding failed.')),type,quality));}
function dimensions(width,height,scale=1){
  const safe=Math.min(scale,1,canvasImageLimits.outputSide/Math.max(width,height),Math.sqrt(canvasImageLimits.outputPixels/(width*height)));
  return {width:Math.max(1,Math.round(width*safe)),height:Math.max(1,Math.round(height*safe))};
}
function hasAlpha(context,width,height){
  const pixels=context.getImageData(0,0,width,height).data;
  for(let index=3;index<pixels.length;index+=4)if(pixels[index]!==255)return true;
  return false;
}
async function render(bitmap,scale){
  const size=dimensions(bitmap.width,bitmap.height,scale),canvas=document.createElement('canvas');canvas.width=size.width;canvas.height=size.height;
  const context=canvas.getContext('2d',{alpha:true});if(!context)throw Error('Picture processing is unavailable.');
  context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(bitmap,0,0,size.width,size.height);
  return {canvas,context,...size};
}
export async function prepareCanvasImage(blob){
  if(!['image/png','image/jpeg','image/webp'].includes(blob?.type)||!blob.size||blob.size>canvasImageLimits.inputBytes)throw Error('Use a PNG, JPEG or WebP picture under 10 MB.');
  const bitmap=await createImageBitmap(blob);try{
    if(bitmap.width>canvasImageLimits.inputSide||bitmap.height>canvasImageLimits.inputSide||bitmap.width*bitmap.height>canvasImageLimits.inputPixels)throw Error('Picture dimensions exceed capacity.');
    let scale=1;
    for(let pass=0;pass<12;pass++){
      const frame=await render(bitmap,scale),transparent=hasAlpha(frame.context,frame.width,frame.height),png=await encoded(frame.canvas,'image/png');
      if(transparent){if(png.size<=canvasImageLimits.outputBytes)return {blob:png,mime:'image/png',width:frame.width,height:frame.height,transparent:true};}
      else {
        let jpeg=await encoded(frame.canvas,'image/jpeg',.92);
        // PNG remains best for compact, crisp screenshots; photographic pixels use JPEG.
        if(png.size<=canvasImageLimits.outputBytes&&(png.size<=800_000||png.size<=jpeg.size*1.35))return {blob:png,mime:'image/png',width:frame.width,height:frame.height,transparent:false};
        if(jpeg.size<=canvasImageLimits.outputBytes)return {blob:jpeg,mime:'image/jpeg',width:frame.width,height:frame.height,transparent:false};
        for(const quality of [.88,.84,.80,.76]){jpeg=await encoded(frame.canvas,'image/jpeg',quality);if(jpeg.size<=canvasImageLimits.outputBytes)return {blob:jpeg,mime:'image/jpeg',width:frame.width,height:frame.height,transparent:false};}
      }
      scale*=.88;
    }
    throw Error('Picture exceeds capacity after resizing.');
  }finally{bitmap.close();}
}

export async function blobBase64(blob){
  const bytes=new Uint8Array(await blob.arrayBuffer());let value='';
  for(let offset=0;offset<bytes.length;offset+=0x8000)value+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
  return btoa(value);
}
