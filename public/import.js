import {localGet,localAll,localPut,localDelete} from './local.js';
const MB=1024*1024;
export const limits={file:25*MB,expanded:60*MB,count:120,pixels:24_000_000};
export function archiveImages(unzip,bytes){
 const entries=[];let total=0;
 unzip(bytes,{filter(entry){
  if(!/\.(png|jpe?g|webp)$/i.test(entry.name)||entry.name.startsWith('__MACOSX/'))return false;
  if(entry.name.split(/[\\/]/).includes('..')||entry.name.startsWith('/')||entry.originalSize>8*MB||!entry.originalSize)throw new Error('安全に開けない画像が含まれています。');
  total+=entry.originalSize;entries.push({key:entry.name,size:entry.originalSize});
  if(entries.length>limits.count||total>limits.expanded)throw new Error('画像は120点・展開後60MBまでです。必要な画像だけのファイルに分けてください。');
  return false;
 }});
 if(!entries.length)throw new Error('JPEG・PNG・WebP画像が見つかりませんでした。');
 return entries.sort((a,b)=>a.key.localeCompare(b.key,undefined,{numeric:true}));
}
async function canvasBlob(canvas,quality=.85){return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('画像に変換できませんでした。')),'image/jpeg',quality));}
async function imageThumbnail(blob){
 const image=await createImageBitmap(blob);
 try{
  if(image.width*image.height>limits.pixels)throw new Error('画像の解像度が大きすぎます。');
  const scale=Math.min(1,280/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
  canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);return canvasBlob(canvas,.7);
 }finally{image.close();}
}
async function pdfDocument(file){
 const pdf=await import('/vendor/pdf.mjs');pdf.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';
 return pdf.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,enableXfa:false,cMapUrl:'/vendor/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/standard_fonts/',wasmUrl:'/vendor/wasm/'}).promise;
}
async function pdfImage(doc,index,max){
 const item=await doc.getPage(index+1),base=item.getViewport({scale:1}),scale=Math.min(2,max/Math.max(base.width,base.height)),viewport=item.getViewport({scale});
 if(!Number.isFinite(viewport.width*viewport.height)||viewport.width<=0||viewport.height<=0||viewport.width*viewport.height>limits.pixels)throw new Error('変換できない画像サイズです。');
 const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
 try{await item.render({canvas,viewport,annotationMode:0}).promise;return await canvasBlob(canvas);}finally{item.cleanup();canvas.width=canvas.height=1;}
}
export async function openImport(file,onProgress=()=>{},signal){
 if(!file.size||file.size>limits.file)throw new Error('PDF・ZIP/CBZは25MBまでです。');
 const bytes=new Uint8Array(await file.arrayBuffer()),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');
 let job=await localGet('imports',hash);
 if(job?.status==='completed')return job;
 const other=(await localAll('imports')).filter(j=>j.id!==hash),used=other.reduce((n,j)=>n+j.file.size+j.items.reduce((s,i)=>s+(i.thumbnail?.size||0),0),0);
 if(used+file.size>80*MB)throw new Error('端末内の取り込み待ちが80MBを超えます。先に残している候補を取り込むか、削除してください。');
 const isPdf=new TextDecoder().decode(bytes.slice(0,5))==='%PDF-',isZip=bytes[0]===80&&bytes[1]===75;
 if(!isPdf&&!isZip)throw new Error('PDF・ZIP/CBZを選んでください。');
 const doc=isPdf?await pdfDocument(file):null,zip=isZip?await import('/vendor/fflate.mjs'):null;
 let entries;
 try{entries=doc?Array.from({length:doc.numPages},(_,i)=>({key:String(i)})):archiveImages(zip.unzipSync,bytes);
  if(entries.length>limits.count)throw new Error('候補は120点までです。必要な部分だけのPDFに分けてください。');
  job=job||{id:hash,file,kind:isPdf?'pdf':'zip',status:'converting',items:entries.map(e=>({...e,thumbnail:null,error:null})),selected:[],request_key:crypto.randomUUID(),created_at:Date.now()};
  await localPut('imports',job);
  for(let i=0;i<job.items.length;i++){
   if(signal?.aborted)throw new DOMException('Aborted','AbortError');
   const entry=job.items[i];if(entry.thumbnail)continue;
   try{entry.thumbnail=doc?await pdfImage(doc,i,280):await imageThumbnail(new Blob([zip.unzipSync(bytes,{filter:e=>e.name===entry.key})[entry.key]]));entry.error=null;}
   catch(e){entry.error=e.message;}
   await localPut('imports',job);onProgress(i+1,job.items.length,job);
   // Yield to input and cancellation rather than occupying the UI in one loop.
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  job.status=job.items.some(i=>i.error)?'partial':'ready';await localPut('imports',job);return job;
 }finally{await doc?.loadingTask.destroy();}
}
export async function selectImport(job,selected){
 if(selected.length>8)throw new Error('一つのメモは8枚までです。');
 job.selected=selected;await localPut('imports',job);
}
export async function importFiles(job){
 if(!job.selected.length||job.selected.length>8)throw new Error('残したい写真を1〜8枚選んでください。');
 const doc=job.kind==='pdf'?await pdfDocument(job.file):null,zip=doc?null:await import('/vendor/fflate.mjs'),bytes=doc?null:new Uint8Array(await job.file.arrayBuffer());
 try{
  const files=[];let total=0;
  for(const key of job.selected){const i=job.items.findIndex(e=>e.key===key);if(i<0)throw new Error('選択した画像が見つかりません。');
   const blob=doc?await pdfImage(doc,i,2200):new Blob([zip.unzipSync(bytes,{filter:e=>e.name===key})[key]]);
   if(!blob.size||blob.size>8*MB||(total+=blob.size)>20*MB)throw new Error('選んだ画像は1枚8MB・合計20MBまでです。枚数を減らしてください。');
   const ext=doc?'jpg':key.split('.').pop().toLowerCase(),mime=ext==='png'?'image/png':ext==='webp'?'image/webp':'image/jpeg';
   files.push(new File([blob],`import-${files.length+1}.${ext}`,{type:mime}));
  }return files;
 }finally{await doc?.loadingTask.destroy();}
}
export async function finishImport(job){job.status='completed';job.file=new Blob();job.items=[];await localPut('imports',job);}
export const pendingImports=async()=>(await localAll('imports')).filter(j=>j.status!=='completed');
export const removeImport=job=>localDelete('imports',job.id);
