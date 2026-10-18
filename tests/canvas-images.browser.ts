// Real Chrome coverage for Canvas image decoding, alpha detection and browser encoding.
import {chromium,expect} from '@playwright/test';

const origin='https://canvas-images.fixture',browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.route('**/*',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/canvas-images.js')return route.fulfill({contentType:'application/javascript',body:await Bun.file('public/canvas-images.js').text()});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Canvas image test</title>'});
  });
  await page.goto(origin);
  const evidence=await page.evaluate(async()=>{
    const {prepareCanvasImage}=await import('/canvas-images.js') as any;
    const toBlob=(canvas:HTMLCanvasElement,type='image/png')=>new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('encode failed')),type));
    const photo=document.createElement('canvas');photo.width=2470;photo.height=1032;const photoContext=photo.getContext('2d')!,pixels=photoContext.createImageData(photo.width,photo.height);
    let seed=0x24701032;
    for(let y=0;y<photo.height;y++)for(let x=0;x<photo.width;x++){
      seed=(seed*1664525+1013904223)>>>0;const noise=(seed>>>24)-128,index=(y*photo.width+x)*4,horizon=y/photo.height;
      pixels.data[index]=Math.max(0,Math.min(255,(horizon<.58?68+120*(1-horizon):45+85*horizon)+noise*.20+22*Math.sin(x/113)));
      pixels.data[index+1]=Math.max(0,Math.min(255,(horizon<.58?118+105*(1-horizon):75+55*(1-horizon))+noise*.16+15*Math.sin((x+y)/79)));
      pixels.data[index+2]=Math.max(0,Math.min(255,(horizon<.58?170+70*(1-horizon):42+25*horizon)+noise*.12));pixels.data[index+3]=255;
    }
    photoContext.putImageData(pixels,0,0);const source=await toBlob(photo),prepared=await prepareCanvasImage(source);

    const transparent=document.createElement('canvas');transparent.width=1200;transparent.height=600;const alphaContext=transparent.getContext('2d')!;alphaContext.clearRect(0,0,1200,600);alphaContext.fillStyle='#e63946';alphaContext.fillRect(100,100,1000,400);
    const alpha=await prepareCanvasImage(await toBlob(transparent)),alphaBitmap=await createImageBitmap(alpha.blob),alphaRead=document.createElement('canvas');alphaRead.width=alpha.width;alphaRead.height=alpha.height;alphaRead.getContext('2d')!.drawImage(alphaBitmap,0,0);const corner=alphaRead.getContext('2d')!.getImageData(0,0,1,1).data[3];alphaBitmap.close();

    const graphic=document.createElement('canvas');graphic.width=1600;graphic.height=900;const graphicContext=graphic.getContext('2d')!;graphicContext.fillStyle='white';graphicContext.fillRect(0,0,1600,900);graphicContext.fillStyle='#111827';graphicContext.fillRect(80,80,1440,100);graphicContext.fillStyle='#2563eb';for(let row=0;row<6;row++)graphicContext.fillRect(100,240+row*90,900-row*70,36);
    const crisp=await prepareCanvasImage(await toBlob(graphic));
    return {source:{width:photo.width,height:photo.height,bytes:source.size,mime:source.type},photo:{width:prepared.width,height:prepared.height,bytes:prepared.blob.size,mime:prepared.mime},alpha:{width:alpha.width,height:alpha.height,bytes:alpha.blob.size,mime:alpha.mime,corner},crisp:{width:crisp.width,height:crisp.height,bytes:crisp.blob.size,mime:crisp.mime}};
  });
  expect(evidence.photo).toMatchObject({width:2048,height:856,mime:'image/jpeg'});expect(evidence.photo.bytes).toBeLessThanOrEqual(2_000_000);expect(evidence.photo.width).toBeGreaterThan(675);
  expect(evidence.alpha).toMatchObject({width:1200,height:600,mime:'image/png',corner:0});expect(evidence.alpha.bytes).toBeLessThanOrEqual(2_000_000);
  expect(evidence.crisp).toMatchObject({width:1600,height:900,mime:'image/png'});expect(evidence.crisp.bytes).toBeLessThanOrEqual(2_000_000);
  console.log('Canvas image quality evidence',JSON.stringify(evidence));
}finally{await browser.close();}
