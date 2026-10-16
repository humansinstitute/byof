import {test,expect} from 'bun:test';
const source=await Bun.file('public/app.js').text();
const helpers=source.slice(0,source.indexOf("import { installNappletHost }"));
const {selectionRect,enclosedIds,movementObjects,groupDelta}=new Function(helpers+';return {selectionRect,enclosedIds,movementObjects,groupDelta};')();
test('selection normalizes all four drag directions and requires full enclosure',()=>{for(const [a,b] of [[{x:0,y:0},{x:100,y:100}],[{x:100,y:100},{x:0,y:0}],[{x:100,y:0},{x:0,y:100}],[{x:0,y:100},{x:100,y:0}]])expect(enclosedIds([{id:'inside',left:0,top:20,right:100,bottom:90},{id:'partial',left:90,top:20,right:110,bottom:30}],selectionRect(a,b))).toEqual(['inside']);expect(enclosedIds([{id:'point',left:0,top:0,right:0,bottom:0}],selectionRect({x:0,y:0},{x:0,y:0}))).toEqual([]);});
test('selected groups include descendants once and keep spacing at coordinate limits',()=>{const objects=[{id:'group',x:49990,y:10},{id:'child',groupId:'group',x:49995,y:20},{id:'other',x:0,y:0}];const moving=movementObjects(objects,new Set(['group','child']));expect(moving.map((o: {id: string})=>o.id)).toEqual(['group','child']);expect(groupDelta(moving,30,5)).toEqual({x:5,y:5});expect(objects[0].x).toBe(49990);});

test('browser helpers require no new runtime asset',()=>{expect(source).not.toContain("from '/board-selection.js'");});
