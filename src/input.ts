import {boundedBody,digest,text,fail,HttpError} from './core.ts';
export const MAX_UPLOAD=8*1024*1024, MAX_SCENE=20*1024*1024, MAX_ASSETS=8;
export type InputAsset={bytes:Uint8Array;mime:string;name:string};
export type ImportReceipt={source_hash:string;source_name:string;source_size:number;format:'pdf'|'zip';conversion_keys:string[]};
export type Input={text:string;note:string;assets:InputAsset[];hash:string;import_receipt?:ImportReceipt};
export function requestKey(request:Request){const key=request.headers.get('idempotency-key');if(!key||!/^[a-zA-Z0-9_-]{16,100}$/.test(key))fail(400,'保存操作を確認できません。');return key;}
export function sniff(bytes:Uint8Array):[string,string]|null{
 const ascii=(a:number,b:number)=>new TextDecoder().decode(bytes.slice(a,b)),match=(a:number[])=>a.every((n,i)=>bytes[i]===n);
 if(bytes.length<12)return null;
 if(match([137,80,78,71,13,10,26,10]))return ['image/png','png'];
 if(match([255,216,255]))return ['image/jpeg','jpg'];
 if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP')return ['image/webp','webp'];
 if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE')return ['audio/wav','wav'];
 if(ascii(0,4)==='OggS')return ['audio/ogg','ogg'];
 if(match([26,69,223,163]))return ['audio/webm','webm'];
 if(ascii(4,8)==='ftyp'&&['M4A ','M4B ','isom','mp41','mp42'].includes(ascii(8,12)))return ['audio/mp4','m4a'];
 if(ascii(0,3)==='ID3'||(bytes[0]===255&&(bytes[1]&0xe0)===0xe0))return ['audio/mpeg','mp3'];
 return null;
}
export async function captureInput(request:Request):Promise<Input>{
 const bytes=await boundedBody(request,MAX_SCENE+100000),type=request.headers.get('content-type')||'';
 let input:Omit<Input,'hash'>;
 if(type.startsWith('application/json')){
  try{const value=JSON.parse(new TextDecoder().decode(bytes));input={text:text(value.text).trim(),note:text(value.note||''),assets:[]};if(!input.text)fail(400,'一言を残してください。');}
  catch(e){if(e instanceof HttpError)throw e;fail(400,'入力を読み取れませんでした。');}
 }else{
  if(!type.startsWith('multipart/form-data'))fail(415,'画像・音声・文章を選んでください。');
  let form:FormData;try{form=await new Request('http://localhost',{method:'POST',headers:{'Content-Type':type},body:bytes}).formData();}catch{fail(400,'ファイルを読み取れませんでした。');}
  const files=form.getAll('file');if(!files.length||files.length>MAX_ASSETS)fail(400,'一つの場面は8ファイルまで取り込めます。');
  const assets:InputAsset[]=[];let total=0;
  for(const f of files){
   if(!(f instanceof File)||!f.size||f.size>MAX_UPLOAD)fail(413,'ファイルは1つ8MBまでです。');
   total+=f.size;if(total>MAX_SCENE)fail(413,'一つの場面は合計20MBまでです。');
   const data=new Uint8Array(await f.arrayBuffer()),detected=sniff(data);
   if(!detected||f.type.startsWith('image/')!==detected[0].startsWith('image/'))fail(415,'JPEG・PNG・WebP画像、またはMP3・M4A・WAV・WebM・Ogg音声を選んでください。HEICはJPEGへ変換してください。');
   assets.push({bytes:data,mime:detected[0],name:`original.${detected[1]}`});
  }
  input={text:text(form.get('text')||''),note:text(form.get('note')||''),assets};
  if(form.has('import_receipt')){
   let receipt:ImportReceipt;try{receipt=JSON.parse(text(form.get('import_receipt'),10000));}catch{fail(400,'取り込み元の情報を確認してください。');}
   if(!receipt||Object.keys(receipt).some(k=>!['source_hash','source_name','source_size','format','conversion_keys'].includes(k))||!['pdf','zip'].includes(receipt.format)||!/^[a-f0-9]{64}$/.test(receipt.source_hash)||!Number.isInteger(receipt.source_size)||receipt.source_size<1||receipt.source_size>25*1024*1024||!Array.isArray(receipt.conversion_keys)||receipt.conversion_keys.length!==assets.length||new Set(receipt.conversion_keys).size!==assets.length||assets.some(a=>!a.mime.startsWith('image/')))fail(400,'取り込み元の情報を確認してください。');
   text(receipt.source_name,500);receipt.conversion_keys.forEach(k=>text(k,1000));input.import_receipt=receipt;
  }
 }
 const hashes=await Promise.all(input.assets.map(async a=>[a.mime,await digest(a.bytes)]));
 return {...input,hash:await digest(JSON.stringify({text:input.text,note:input.note,assets:hashes,import_receipt:input.import_receipt}))};
}
export async function stageAssets(env:Env,key:string,input:Input){
 const keys:string[]=[];
 for(let i=0;i<input.assets.length;i++){
  const a=input.assets[i],objectKey=`originals/${await digest(key)}/${input.hash}/${i}/${a.name}`;
  await env.DB.prepare('INSERT OR IGNORE INTO staged_uploads VALUES(?,?)').bind(objectKey,Date.now()).run();
  await env.ORIGINALS.put(objectKey,a.bytes,{httpMetadata:{contentType:a.mime}});keys.push(objectKey);
 }
 return keys;
}
