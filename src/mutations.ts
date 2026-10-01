import {stmt,id,now,fail,text,version,jsonBody,getCapture,revisionStatement,jobStatement} from './core.ts';
import {captureInput,requestKey,stageAssets,MAX_ASSETS,MAX_SCENE,type Input} from './input.ts';
const json=(v:unknown,status=200)=>Response.json(v,{status});
async function duplicate(env:Env,key:string,hash:string,target?:string){
 const prior=await stmt(env,'SELECT capture_id,request_hash FROM mutations WHERE request_key=?',key).first<{capture_id:string;request_hash:string}>();
 if(!prior){if(await stmt(env,'SELECT 1 FROM retired_requests WHERE request_key=?',key).first())fail(410,'この保存操作の記録は削除済みです。再送では復元できません。');return null;}
 if(prior.request_hash!==hash||target&&prior.capture_id!==target)fail(409,'同じ保存操作の内容が変わっています。');return json({id:prior.capture_id,duplicate:true});
}
function assetsSQL(env:Env,captureId:string,input:Input,keys:string[],mutation:string,start:number){
 const sql:D1PreparedStatement[]=[];
 const imported=input.import_receipt,importId=id();
 if(imported)sql.push(stmt(env,`INSERT INTO capture_imports SELECT ?,id,?,?,?,?,? FROM captures WHERE id=? AND mutation_id=?`,importId,imported.source_hash,imported.source_name,imported.source_size,imported.format,now(),captureId,mutation));
 for(let i=0;i<input.assets.length;i++){
  const a=input.assets[i],assetId=id();sql.push(stmt(env,`INSERT INTO assets(id,capture_id,object_key,name,mime,size,upload_index,created_at) SELECT ?,id,?,?,?,?,?,? FROM captures WHERE id=? AND mutation_id=?`,assetId,keys[i],a.name,a.mime,a.bytes.length,start+i,now(),captureId,mutation));
  if(imported)sql.push(stmt(env,`INSERT INTO import_assets SELECT ?,id,? FROM assets WHERE id=?`,importId,imported.conversion_keys[i],assetId));
  sql.push(stmt(env,'DELETE FROM staged_uploads WHERE object_key=? AND EXISTS(SELECT 1 FROM assets WHERE object_key=?)',keys[i],keys[i]));
 }return sql;
}
export async function saveCapture(request:Request,env:Env){
 const key=requestKey(request),input=await captureInput(request),prior=await duplicate(env,key,input.hash);if(prior)return prior;
 const captureId=id(),mutation=id(),keys=await stageAssets(env,key,input);
 const current=await stmt(env,"SELECT value FROM settings WHERE key='current_source'").first<{value:string}>();
 try{await env.DB.batch([
  stmt(env,`INSERT INTO captures(id,request_key,request_hash,source_id,source_inherited,kind,original_text,note,mutation_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,captureId,key,input.hash,current?.value||null,current?1:0,input.assets.length?'scene':'text',input.text,input.note,mutation,now(),now()),
  ...assetsSQL(env,captureId,input,keys,mutation,0),revisionStatement(env,captureId,mutation),jobStatement(env,captureId,1,mutation),
  stmt(env,'INSERT INTO mutations VALUES(?,?,?)',key,captureId,input.hash),
 ]);}catch(e){const same=await duplicate(env,key,input.hash);if(same)return same;throw e;}
 return json({id:captureId,duplicate:false},201);
}
export async function supplement(request:Request,env:Env,captureId:string){
 const key=requestKey(request),input=await captureInput(request),prior=await duplicate(env,key,input.hash,captureId);if(prior)return prior;
 const c=await getCapture(env,captureId);if(!c)fail(404,'場面が見つかりません。');
 const base=version(request.headers.get('x-capture-version'));if(c.version!==base)fail(409,'場面が更新されています。開き直してください。');
 if(c.assets.length+input.assets.length>MAX_ASSETS||c.assets.reduce((n,a)=>n+a.size,0)+input.assets.reduce((n,a)=>n+a.bytes.length,0)>MAX_SCENE)fail(413,'一つの場面は8ファイル・合計20MBまでです。');
 const keys=await stageAssets(env,key,input),mutation=id(),note=[c.note,input.text,input.note].filter(Boolean).join('\n');text(note);
 try{
  const result=await env.DB.batch([
   stmt(env,'UPDATE captures SET note=?,version=version+1,mutation_id=?,updated_at=? WHERE id=? AND version=?',note,mutation,now(),captureId,base),
   ...assetsSQL(env,captureId,input,keys,mutation,c.assets.length),revisionStatement(env,captureId,mutation),jobStatement(env,captureId,base+1,mutation),
   stmt(env,'INSERT INTO mutations SELECT ?,id,? FROM captures WHERE id=? AND mutation_id=?',key,input.hash,captureId,mutation),
  ]);
  if(!result[0].meta.changes){const same=await duplicate(env,key,input.hash,captureId);if(same)return same;fail(409,'場面が更新されています。開き直してください。');}
 }catch(e){const same=await duplicate(env,key,input.hash,captureId);if(same)return same;throw e;}
 return json({id:captureId,version:base+1},201);
}
export async function editCapture(request:Request,env:Env,captureId:string){
 const c=await getCapture(env,captureId);if(!c)fail(404,'場面が見つかりません。');
 const input=await jsonBody(request),base=version(input.version);if(c.version!==base)fail(409,'場面が更新されています。開き直してください。');
 const mutation=id(),has=(k:string)=>Object.hasOwn(input,k),sourceTitle=has('source_title')?text(input.source_title,500).trim():null;
 const s:D1PreparedStatement[]=[];
 if(sourceTitle)s.push(stmt(env,`INSERT OR IGNORE INTO sources(id,title,certainty,created_at) SELECT ?,?,'explicit',? WHERE EXISTS(SELECT 1 FROM captures WHERE id=? AND version=?)`,id(),sourceTitle,now(),captureId,base));
 const expr=sourceTitle!==null?'(SELECT id FROM sources WHERE title=?)':'source_id',values:(string|number|null)[]=[has('corrected_text')?input.corrected_text===null?null:text(input.corrected_text):c.corrected_text,has('note')?text(input.note):c.note];
 if(sourceTitle!==null)values.push(sourceTitle);
 values.push(sourceTitle!==null?1:c.source_locked,sourceTitle!==null?0:c.source_inherited,mutation,now(),captureId,base);
 const updateIndex=s.length;
 s.push(stmt(env,`UPDATE captures SET corrected_text=?,note=?,source_id=${expr},source_locked=?,source_inherited=?,version=version+1,mutation_id=?,updated_at=? WHERE id=? AND version=?`,...values));
 s.push(revisionStatement(env,captureId,mutation),jobStatement(env,captureId,base+1,mutation),stmt(env,`INSERT INTO overrides SELECT ?,id,'capture_edit',?,? FROM captures WHERE id=? AND mutation_id=?`,id(),JSON.stringify(input),now(),captureId,mutation));
 if(sourceTitle!==null){
  s.push(stmt(env,`DELETE FROM settings WHERE key='current_source' AND EXISTS(SELECT 1 FROM captures WHERE id=? AND mutation_id=? AND source_id IS NULL)`,captureId,mutation));
  s.push(stmt(env,`INSERT OR REPLACE INTO settings SELECT 'current_source',source_id FROM captures WHERE id=? AND mutation_id=? AND source_id IS NOT NULL`,captureId,mutation));
 }
 const result=await env.DB.batch(s);if(!result[updateIndex].meta.changes)fail(409,'場面が更新されています。開き直してください。');return json({id:captureId,version:base+1});
}
export async function adopt(request:Request,env:Env,captureId:string){
 const input=await jsonBody(request),c=await getCapture(env,captureId);if(!c)fail(404,'場面が見つかりません。');
 if(c.version!==version(input.version))fail(409,'根拠が更新されています。新しい案を確認してください。');
 const p=c.proposals.find(p=>p.id===input.proposal_id);if(!p)fail(409,'採用する案を確認してください。');
 if(p.adopted_view_id)return json({id:p.adopted_view_id,duplicate:true});
 const draft=p.data as {text:string;reason:string;claim_ids:string[]},viewId=p.view_id||id(),time=now();
 const refs={capture_id:c.id,capture_version:c.version,source_title:c.source_title,asset_ids:c.assets.map(a=>a.id),claim_ids:draft.claim_ids,harvest_snapshot:c.harvest,proposal_id:p.id};
 const guard=`EXISTS(SELECT 1 FROM captures c JOIN generations g ON g.capture_id=c.id AND g.version=c.version JOIN proposals p ON p.generation_id=g.id WHERE c.id=? AND c.version=? AND p.id=? AND p.adopted_view_id IS NULL)`;
 const s:D1PreparedStatement[]=[];
 if(p.view_id){
  const current=await stmt(env,'SELECT version FROM views WHERE id=?',p.view_id).first<{version:number}>();
  if(!current||current.version!==p.base_revision)fail(409,'漫画観が更新されています。この場面を再解析すると新しい案を作れます。');
  s.push(stmt(env,`INSERT INTO view_revisions(view_id,version,body,reason,references_json,created_at) SELECT id,version+1,?,?,?,? FROM views WHERE id=? AND version=? AND ${guard}`,draft.text,draft.reason,JSON.stringify(refs),time,viewId,p.base_revision,c.id,c.version,p.id));
  s.push(stmt(env,`UPDATE views SET body=?,version=version+1 WHERE id=? AND version=? AND ${guard}`,draft.text,viewId,p.base_revision,c.id,c.version,p.id));
 }else{
  s.push(stmt(env,`INSERT OR IGNORE INTO views(id,capture_id,draft_key,title,body,version,created_at) SELECT ?,?,?,?,?,1,? WHERE ${guard}`,viewId,c.id,p.id,c.harvest!.summary.slice(0,80),draft.text,time,c.id,c.version,p.id));
  s.push(stmt(env,`INSERT OR IGNORE INTO view_revisions SELECT id,1,?,?,?,? FROM views WHERE id=?`,draft.text,draft.reason,JSON.stringify(refs),time,viewId));
 }
 s.push(stmt(env,`UPDATE proposals SET adopted_view_id=? WHERE id=? AND ${guard} AND EXISTS(SELECT 1 FROM view_revisions WHERE view_id=? AND version=? AND references_json=?)`,viewId,p.id,c.id,c.version,p.id,viewId,p.base_revision?p.base_revision+1:1,JSON.stringify(refs)));
 await env.DB.batch(s);
 const saved=await stmt(env,'SELECT adopted_view_id FROM proposals WHERE id=?',p.id).first<{adopted_view_id:string|null}>();
 if(!saved?.adopted_view_id)fail(409,'漫画観か根拠が更新されました。開き直してください。');return json({id:saved.adopted_view_id},201);
}
