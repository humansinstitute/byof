import { sha256 } from './assets.ts';
import type { Workshop } from './workshop.ts';
import type { Member } from './auth.ts';
import { demand } from './errors.ts';
export const boardImageLimit=180000;
export function installBoardImages(workshop:Workshop) {
  workshop.db.exec(`CREATE TABLE IF NOT EXISTS workshop_board_images(workshop_id TEXT NOT NULL,hash TEXT NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,PRIMARY KEY(workshop_id,hash));`);
}
function crc32(bytes:Uint8Array){let crc=-1;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^-1)>>>0;}
export function rasterInfo(bytes:Uint8Array) {
  const b=Buffer.from(bytes);let width=0,height=0,mime='';
  if(b.length>=45&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    demand(b.readUInt32BE(8)===13&&b.toString('ascii',12,16)==='IHDR',400,'Invalid PNG header');
    width=b.readUInt32BE(16);height=b.readUInt32BE(20);let offset=8,data=false,ended=false;
    while(offset+12<=b.length){const length=b.readUInt32BE(offset),end=offset+12+length;demand(end<=b.length,400,'Truncated PNG');const type=b.toString('ascii',offset+4,offset+8);demand(crc32(b.subarray(offset+4,end-4))===b.readUInt32BE(end-4),400,'Invalid PNG checksum');demand(type!=='acTL',400,'Use a still picture');if(type==='IDAT')data=true;if(type==='IEND'){demand(length===0&&end===b.length,400,'Invalid PNG end');ended=true;break;}offset=end;}
    demand(data&&ended,400,'Incomplete PNG');mime='image/png';
  } else if(b.length>4&&b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217) {
    let offset=2;
    while(offset+4<=b.length){demand(b[offset]===255,400,'Invalid JPEG marker');while(b[offset]===255)offset++;const marker=b[offset++]!;if(marker===0xda||marker===0xd9)break;const size=b.readUInt16BE(offset);demand(size>=2&&offset+size<=b.length,400,'Truncated JPEG');if([0xc0,0xc1,0xc2].includes(marker)){demand(size>=8,400,'Invalid JPEG dimensions');height=b.readUInt16BE(offset+3);width=b.readUInt16BE(offset+5);}offset+=size;}
    mime='image/jpeg';
  } else demand(false,400,'Use a PNG or JPEG picture');
  demand(width>0&&height>0&&width<=2048&&height<=2048&&width*height<=4194304,400,'Picture dimensions exceed capacity');
  return {mime,width,height};
}
export function uploadBoardImage(workshop:Workshop,member:Member,body:any) {
  workshop.host(member);workshop.admitted(member);
  demand(body&&Object.keys(body).every(k=>k==='base64')&&typeof body.base64==='string'&&body.base64.length<=240000&&/^[A-Za-z0-9+/]+={0,2}$/.test(body.base64),400,'Invalid picture bytes');
  const bytes=Buffer.from(body.base64,'base64');demand(bytes.length>0&&bytes.length<=boardImageLimit,413,'Picture exceeds 180 KB');demand(bytes.toString('base64')===body.base64,400,'Invalid picture encoding');
  const info=rasterInfo(bytes),hash=sha256(bytes);
  return workshop.db.transaction(()=>{
    const exists=workshop.db.query('SELECT hash FROM workshop_board_images WHERE workshop_id=? AND hash=?').get(workshop.id,hash);
    demand(exists||(workshop.db.query('SELECT count(*) n FROM workshop_board_images WHERE workshop_id=?').get(workshop.id) as any).n<200,409,'Workshop picture capacity reached');
    workshop.assets.putBytes(bytes);
    workshop.db.run('INSERT OR IGNORE INTO workshop_board_images VALUES(?,?,?,?,?)',[workshop.id,hash,info.mime,info.width,info.height]);
    return {src:`/api/v1/board/images/${hash}?workshop=${workshop.id}`,sha256:hash,...info};
  }).immediate();
}
export function boardImageSource(workshop:Workshop,value:unknown) {
  if(typeof value!=='string'||!value.startsWith('/api/v1/board/images/'))return null;
  const pattern=new RegExp('^/api/v1/board/images/([a-f0-9]{64})\\?workshop='+workshop.id+'$'),match=value.match(pattern);
  demand(match&&workshop.db.query('SELECT hash FROM workshop_board_images WHERE workshop_id=? AND hash=?').get(workshop.id,match[1]!),400,'Workshop picture not found');return value;
}
export function readBoardImage(workshop:Workshop,member:Member,hash:string) {
  workshop.admitted(member);demand(/^[a-f0-9]{64}$/.test(hash),404,'Picture not found');
  const row=workshop.db.query('SELECT mime FROM workshop_board_images WHERE workshop_id=? AND hash=?').get(workshop.id,hash) as any;demand(row,404,'Picture not found');return {bytes:workshop.assets.getBytes(hash),mime:row.mime};
}
