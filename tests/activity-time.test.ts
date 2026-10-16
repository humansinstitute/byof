import {expect,test} from 'bun:test';
import {activityInstant,collapseActivity,newestInstant,perthEventTime} from '../public/activity-time.js';
import type {ActivityEvent} from '../public/activity-time.js';

test('Perth event labels distinguish today, earlier dates and missing timestamps',()=>{
 const now='2026-10-15T06:00:00.000Z';
 expect(perthEventTime('2026-10-15T05:05:00.000Z','Last tool',now)).toEqual({
  datetime:'2026-10-15T05:05:00.000Z',
  text:'Last tool 1:05 pm AWST',
  ariaLabel:'Last tool Thursday 15 October 2026 at 1:05 pm, Australian Western Standard Time',
 });
 expect(perthEventTime('2026-10-14T15:59:00.000Z','Received',now)?.text).toBe('Received 14 Oct, 11:59 pm AWST');
 expect(perthEventTime('', 'Received',now)).toBeNull();
 expect(perthEventTime('invalid', 'Received',now)).toBeNull();
});

test('commentary uses receiver time while tools retain source time',()=>{
 expect(activityInstant({type:'commentary',timestamp:'2026-10-15T03:00:00Z',receivedAt:'2026-10-15T03:01:00Z'})).toBe('2026-10-15T03:01:00.000Z');
 expect(activityInstant({type:'tools',timestamp:'2026-10-15T03:00:00Z',receivedAt:'2026-10-15T03:01:00Z'})).toBe('2026-10-15T03:00:00.000Z');
 expect(activityInstant({type:'commentary',timestamp:'2026-10-15T03:00:00Z'})).toBeNull();
});

test('late older tool replay cannot move a collapsed tool bubble backward',()=>{
 const events:ActivityEvent[]=[
  {type:'commentary',turnId:'turn',content:'First',receivedAt:'2026-10-15T04:50:00Z'},
  {type:'tools',turnId:'turn',timestamp:'2026-10-15T05:05:00Z'},
  {type:'tools',turnId:'turn',timestamp:'2026-10-15T04:55:00Z'},
  {type:'commentary',turnId:'turn',content:'Second',receivedAt:'2026-10-15T05:06:00Z'},
 ];
 const rows=collapseActivity(events);
 expect(rows).toEqual([
  {type:'commentary',turnId:'turn',content:'First',instant:'2026-10-15T04:50:00.000Z'},
  {type:'tools',turnId:'turn',instant:'2026-10-15T05:05:00.000Z'},
  {type:'commentary',turnId:'turn',content:'Second',instant:'2026-10-15T05:06:00.000Z'},
 ]);
 expect(newestInstant(rows.map((row:{instant:string|null})=>row.instant),'bad')).toBe('2026-10-15T05:06:00.000Z');
});
