import {localGet,localAll,localPut,localDelete,clearLocal} from './local.js';
const MAX=80*1024*1024;
let syncing=false;
export async function rememberState(state){
 if(typeof state.instance_id!=='string'||!/^[a-f0-9]{32}$/.test(state.instance_id))throw Object.assign(new Error('保存先の識別情報を確認できません。接続して画面を開き直してください。'),{status:503});
 const prior=await localGet('meta','session');
 if(prior&&prior.instance_id!==state.instance_id){
  if((await localAll('outbox')).length)throw Object.assign(new Error('保存待ちのデータは別の保存先のものです。端末内の書き出し・削除をしてから開き直してください。'),{status:409});
  await clearLocal();
 }
 await localPut('meta',{id:'session',active:true,instance_id:state.instance_id});await localPut('meta',{id:'state',value:state});
}
export async function offlineState(){const session=await localGet('meta','session');if(!session?.active)return null;return (await localGet('meta','state'))?.value;}
export async function pendingUploads(){return (await localAll('outbox')).sort((a,b)=>a.created_at-b.created_at);}
export async function queueUpload(pending){
 const session=await localGet('meta','session');if(!session?.active)throw new Error('オンラインで一度ログインしてから、圏外で記録できます。');
 const entries=await pendingUploads(),bytes=entries.filter(e=>e.id!==pending.key).reduce((n,e)=>n+e.files.reduce((s,f)=>s+f.size,0),0)+pending.files.reduce((n,f)=>n+f.size,0);
 if(bytes>MAX||entries.length>=100&&!entries.some(e=>e.id===pending.key))throw new Error('端末内の保存待ちは80MB・100件までです。同期するか、書き出して整理してください。');
 const copy={...pending,id:pending.key,instance_id:session.instance_id,created_at:Date.now(),error:null};delete copy.import_job;
 await localPut('outbox',copy);try{await navigator.storage?.persist?.();}catch{/* Best effort; the browser still decides eviction. */}return copy;
}
export async function sendUpload(pending,send){
 const headers={'Idempotency-Key':pending.key};let body;
 if(pending.files.length){body=new FormData();pending.files.forEach(f=>body.append('file',f,f.name||'original'));body.set('note',pending.note);if(pending.import_receipt)body.set('import_receipt',JSON.stringify(pending.import_receipt));}
 else{headers['Content-Type']='application/json';body=JSON.stringify({text:pending.text,note:pending.note});}
 if(pending.target)headers['X-Capture-Version']=String(pending.target.version);
 return send(pending.target?`/api/captures/${pending.target.id}/assets`:'/api/captures',{method:'POST',headers,body});
}
export async function syncUploads(send,instanceId){
 if(syncing||!navigator.onLine)return [];syncing=true;const completed=[];
 try{
  for(const pending of await pendingUploads()){
   if(pending.instance_id!==instanceId||pending.error?.blocked)continue;
   try{const saved=await sendUpload(pending,send);await localDelete('outbox',pending.id);completed.push(saved);}
   catch(e){
    pending.error={message:e.message,status:e.status||0,blocked:Boolean(e.status&&e.status!==429&&e.status<500)};
    await localPut('outbox',pending);if(!e.status||e.status===401||e.status>=500)break;
   }
  }
 }finally{syncing=false;}return completed;
}
export async function lockDevice(){const session=await localGet('meta','session');if(session)await localPut('meta',{...session,active:false});}
export async function pendingFailure(id,error){const pending=await localGet('outbox',id);if(pending){pending.error={message:error.message,status:error.status||0,blocked:Boolean(error.status&&error.status!==429&&error.status<500)};await localPut('outbox',pending);}}
export async function removePending(id){await localDelete('outbox',id);}
export async function retryPending(id,target){const pending=await localGet('outbox',id);if(!pending)return;if(target)pending.target={id:target.id,version:target.version};pending.error=null;await localPut('outbox',pending);}
export async function downloadLocal(){
 const data={format:'manga-harvester-device/v1',exported_at:new Date().toISOString(),outbox:[],imports:[]};
 async function bytes(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});}
 for(const pending of await pendingUploads())data.outbox.push({...pending,files:await Promise.all(pending.files.map(async f=>({name:f.name,mime:f.type,size:f.size,base64:await bytes(f)})))});
 for(const job of await localAll('imports'))if(job.status!=='completed')data.imports.push({...job,file:{name:job.file.name,mime:job.file.type,base64:await bytes(job.file)},items:job.items.map(({thumbnail,...i})=>i)});
 const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='manga-harvester-device.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
export const forgetDevice=clearLocal;
