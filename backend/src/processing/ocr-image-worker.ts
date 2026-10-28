import {parentPort,workerData} from 'node:worker_threads';
import {open,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import sharp from 'sharp';
const {path,destination,type,expectedBytes,config}=workerData;
try{
  sharp.cache(false);sharp.concurrency(1);
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let bytes:Buffer;
  try{const info=await file.stat();if(!info.isFile()||info.size!==expectedBytes||info.size>config.maxFileBytes)throw Error();
    bytes=await file.readFile();if(bytes.length!==expectedBytes)throw Error();}finally{await file.close();}
  if(type==='png'? !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
    bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||bytes.at(-2)!==255||bytes.at(-1)!==217)throw Error();
  const image=sharp(bytes,{failOn:'warning',limitInputPixels:config.maxPixels,animated:false});
  const info=await image.metadata();
  if(info.format!==(type==='png'?'png':'jpeg')||!info.width||!info.height||(info.pages??1)!==1||info.width*info.height>config.maxPixels)throw Error();
  // Only source EXIF orientation is applied; no guessed rotations or invented characters.
  const output=await image.rotate().resize({width:config.maxEdge,height:config.maxEdge,fit:'inside',withoutEnlargement:true})
    .greyscale().timeout({seconds:3}).png().toBuffer();
  if(output.length>config.maxTempBytes)throw Error();
  await writeFile(destination,output,{flag:'wx',mode:0o600});parentPort?.postMessage(true);
}catch{parentPort?.postMessage(false);}
