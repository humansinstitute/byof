import {expect,test} from 'bun:test';
import {contentBounds,fitCamera,initialCamera,objectBounds,screenBounds} from '../public/public-canvas-camera.js';

const near={id:'near',kind:'napplet',x:120,y:80,width:440,height:424};
const far={id:'far',kind:'napplet',x:4120,y:2680,width:440,height:424};
const backwards={id:'arrow',kind:'arrow',x:200,y:200,width:300,height:180,endX:-300,endY:-180,curveX:-120,curveY:-240};

test('public Canvas cameras retain world geometry and spatial separation at every zoom',()=>{
 expect(objectBounds(backwards)).toEqual({left:-100,top:-40,right:200,bottom:200});
 expect(contentBounds([near,far])).toMatchObject({left:120,top:80,right:4560,bottom:3104,width:4440,height:3024});
 const initial=initialCamera([near,far],{width:1000,height:700});
 expect(initial.scale).toBe(1);expect(screenBounds(near,initial)).toMatchObject({left:280,top:138,right:720,bottom:562});
 for(const camera of [{x:50,y:-20,scale:.5},{x:-700,y:140,scale:1.5}]){
  const a=screenBounds(near,camera),b=screenBounds(far,camera);
  expect(b.left-a.left).toBe((far.x-near.x)*camera.scale);
  expect(b.top-a.top).toBe((far.y-near.y)*camera.scale);
  expect(a.right-a.left).toBe(near.width*camera.scale);
  expect(b.right-b.left).toBe(far.width*camera.scale);
 }
 const fitted=fitCamera([near,far],{width:1000,height:700});
 expect(fitted.scale).toBeLessThan(.25);expect(screenBounds(far,fitted).left).toBeGreaterThan(screenBounds(near,fitted).right);
});

test('initial public view frames saved content rather than fitting a spread-out board',()=>{
 const initial=initialCamera([near,far],{width:390,height:788}),fitted=fitCamera([near,far],{width:390,height:788});
 expect(initial.scale).toBeCloseTo(342/440);expect(initial.scale).toBeGreaterThan(fitted.scale*5);
 expect(screenBounds(near,initial).left).toBeCloseTo(24);expect(screenBounds(far,initial).left).toBeGreaterThan(3000);
});
