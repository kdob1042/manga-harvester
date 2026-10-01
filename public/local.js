const NAME='manga-harvester-local', VERSION=1;
let opening;
function db(){return opening ||= new Promise((resolve,reject)=>{
 const request=indexedDB.open(NAME,VERSION);
 request.onupgradeneeded=()=>{for(const name of ['meta','imports','outbox'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:'id'});};
 request.onsuccess=()=>resolve(request.result);request.onerror=()=>{opening=null;reject(new Error('端末内へ保存できません。空き容量やブラウザの設定を確認してください。'));};
});}
export async function localGet(store,id){const d=await db();return new Promise((resolve,reject)=>{const r=d.transaction(store).objectStore(store).get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function localAll(store){const d=await db();return new Promise((resolve,reject)=>{const r=d.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function localPut(store,value){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction(store,'readwrite');tx.objectStore(store).put(value);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(new Error('端末の空き容量が足りません。元のファイルを残して、容量を空けてください。'));tx.onabort=()=>reject(tx.error);});}
export async function localDelete(store,id){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction(store,'readwrite');tx.objectStore(store).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
export async function clearLocal(){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction(['meta','imports','outbox'],'readwrite');for(const name of ['meta','imports','outbox'])tx.objectStore(name).clear();tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
