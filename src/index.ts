import {saveExternal,queueResearch,adoptResearch,changeExternal,controlResearch} from './research.ts';
import {searchCaptures,semanticSearch,conceptDetail,organizeConcept} from './discovery.ts';
import {currentReflection,revisit} from './reflection.ts';
import {Buffer} from 'node:buffer';
import {HttpError,fail,text,version,jsonBody,stmt,rows,getCapture,now,type Capture,type Harvest,type Asset,type View} from './core.ts';
import {loggedIn,login,logout} from './auth.ts';
import {dispatch,cleanup,consume} from './queue.ts';
import {graphFor} from './graph.ts';
import {AiError} from './ai.ts';

const json=(data:unknown,status=200,headers:HeadersInit={})=>Response.json(data,{status,headers});
const has=(input:Record<string,unknown>,key:string)=>Object.hasOwn(input,key);
function headers(response:Response,env:Env){
 const result=new Response(response.body,response);
 result.headers.set('Cache-Control','no-store');result.headers.set('X-Content-Type-Options','nosniff');
 result.headers.set('Referrer-Policy','same-origin');
 result.headers.set('Content-Security-Policy',"default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
 result.headers.set('Permissions-Policy','camera=(self), microphone=(self), geolocation=()');
 if(env.APP_ORIGIN?.startsWith('https:'))result.headers.set('Strict-Transport-Security','max-age=31536000');return result;
}
async function list(env:Env,search:string){
 if(search.trim())return searchCaptures(env,search);
 const escaped=`%${search.replace(/[\\%_]/g,'\\$&')}%`;
 const data=await rows<Capture&{result:string|null;state:string;error_code:string|null;original_preview:string}>(env,`SELECT c.id,c.kind,c.version,c.created_at,c.source_inherited,
 s.title AS source_title,s.certainty AS source_certainty,j.state,j.error_code,h.result,substr(CASE WHEN c.note<>'' THEN c.note ELSE c.original_text END,1,100) AS original_preview
 FROM captures c LEFT JOIN sources s ON s.id=c.source_id LEFT JOIN jobs j ON j.capture_id=c.id AND j.version=c.version
 LEFT JOIN harvests h ON h.capture_id=c.id AND h.version=c.version
 WHERE ?='' OR c.original_text LIKE ? ESCAPE '\\' OR c.note LIKE ? ESCAPE '\\' OR h.result LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\'
 ORDER BY c.created_at DESC,c.rowid DESC LIMIT 100`,search,escaped,escaped,escaped,escaped);
 return data.map(({result,...c})=>({...c,harvest:result?JSON.parse(result) as Harvest:null}));
}
import {saveCapture,editCapture,supplement,adopt} from './mutations.ts';
async function editView(request:Request,env:Env,viewId:string){
 const input=await jsonBody(request),v=await stmt(env,'SELECT * FROM views WHERE id=?',viewId).first<View>();if(!v)fail(404,'見方が見つかりません。');
 const base=version(input.version);if(v.version!==base)fail(409,'見方が更新されています。開き直してください。');
 const restore=has(input,'restore_version')?version(input.restore_version):base;
 const reference=await stmt(env,'SELECT * FROM view_revisions WHERE view_id=? AND version=?',viewId,restore).first<{body:string;references_json:string}>();
 if(!reference)fail(400,'復元する版がありません。');
 const body=has(input,'restore_version')?reference.body:text(input.body).trim(),reason=has(input,'restore_version')?`第${restore}版へ復元`:text(input.reason,2000).trim();
 if(!body||!reason)fail(400,'見方の本文と変更理由を残してください。');
 // Insert revision first, conditionally on the current version. A concurrent edit makes both writes no-ops.
 const result=await env.DB.batch([
  stmt(env,`INSERT INTO view_revisions(view_id,version,body,reason,references_json,created_at)
   SELECT id,version+1,?,?,?,? FROM views WHERE id=? AND version=?`,body,reason,reference.references_json,now(),viewId,base),
  stmt(env,'UPDATE views SET body=?,version=version+1 WHERE id=? AND version=?',body,viewId,base),
 ]);
 if(!result[1].meta.changes)fail(409,'見方が更新されています。開き直してください。');return json({ok:true});
}
async function deleteCapture(request:Request,env:Env,captureId:string){
 const input=await jsonBody(request),base=version(input.version);
 const result=await env.DB.batch([
  stmt(env,`INSERT OR IGNORE INTO retired_requests SELECT m.request_key,m.request_hash,m.capture_id,? FROM mutations m JOIN captures c ON c.id=m.capture_id WHERE c.id=? AND c.version=?`,now(),captureId,base),
  stmt(env,`INSERT OR IGNORE INTO retired_requests SELECT e.request_key,'external',e.capture_id,? FROM external_sources e JOIN captures c ON c.id=e.capture_id WHERE c.id=? AND c.version=?`,now(),captureId,base),
  stmt(env,`INSERT OR IGNORE INTO capture_tombstones SELECT id,? FROM captures WHERE id=? AND version=?`,now(),captureId,base),
  stmt(env,`INSERT OR IGNORE INTO object_deletions(object_key,created_at) SELECT a.object_key,? FROM assets a JOIN captures c ON c.id=a.capture_id WHERE c.id=? AND c.version=?`,now(),captureId,base),
  stmt(env,'DELETE FROM captures WHERE id=? AND version=?',captureId,base),
  stmt(env,'DELETE FROM concepts WHERE id NOT IN(SELECT concept_id FROM nodes WHERE concept_id IS NOT NULL) AND id NOT IN(SELECT concept_id FROM concept_scopes) AND id NOT IN(SELECT source_id FROM concept_scopes) AND id NOT IN(SELECT target_id FROM concept_mappings WHERE source_id IN(SELECT concept_id FROM nodes WHERE concept_id IS NOT NULL))'),
  stmt(env,"DELETE FROM settings WHERE key='current_source' AND value IN (SELECT id FROM sources WHERE id NOT IN(SELECT source_id FROM captures WHERE source_id IS NOT NULL))"),
  stmt(env,'DELETE FROM sources WHERE id NOT IN(SELECT source_id FROM captures WHERE source_id IS NOT NULL)'),
 ]);
 if(!result[4].meta.changes)fail(409,'記録が更新されています。開き直してください。');
 // Deletion intent is durable even if R2 temporarily fails. Private download routes already stop resolving.
 try{await cleanup(env);}catch{return json({ok:true,originals_pending:true});}return json({ok:true});
}

// Original files are exported one at a time rather than accumulated into Worker memory.
function exportData(env:Env){
 const encoder=new TextEncoder();
 const stream=new ReadableStream<Uint8Array>({async start(controller){
  try{
   controller.enqueue(encoder.encode(`{"format":"manga-harvester/v3","exported_at":${JSON.stringify(new Date().toISOString())}`));
   for(const table of ['sources','captures','capture_revisions','harvests','views','view_revisions','asset_transcripts','assets','generations','concepts','nodes','relations','comparisons','reactions','proposals','overrides','reflections','revisit_events','concept_actions','concept_mappings','concept_aliases','external_sources','research_runs','external_revisions','capture_imports','import_assets','concept_scopes']){
    controller.enqueue(encoder.encode(`,${JSON.stringify(table)}:[`));let offset=0,first=true;
    while(true){
     const records=await rows<Record<string,unknown>>(env,`SELECT * FROM ${table} ORDER BY rowid LIMIT 50 OFFSET ?`,offset);
     for(const record of records){
      if(table==='captures'){delete record.request_key;delete record.request_hash;delete record.mutation_id;}
      if(table==='assets'){
       const object=await env.ORIGINALS.get(String(record.object_key));if(!object)throw new Error('export_original_missing');
       record.base64=Buffer.from(await object.arrayBuffer()).toString('base64');delete record.object_key;delete record.request_key;delete record.request_hash;
      }
      if(table==='external_sources'||table==='research_runs')delete record.request_key;
      if(table==='harvests')record.result=JSON.parse(String(record.result));
      if(table==='view_revisions'){record.references=JSON.parse(String(record.references_json));delete record.references_json;}
      controller.enqueue(encoder.encode(`${first?'':','}${JSON.stringify(record)}`));first=false;
     }
     if(records.length<50)break;offset+=50;
    }
    controller.enqueue(encoder.encode(']'));
   }
   controller.enqueue(encoder.encode('}'));controller.close();
  }catch{controller.error(new Error('Export interrupted. Retry without simultaneous edits.'));}
 }});
 return new Response(stream,{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="manga-harvester-export.json"'}});
}

async function route(request:Request,env:Env,ctx:ExecutionContext){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(!['GET','HEAD'].includes(method)&&request.headers.get('origin')!==env.APP_ORIGIN)fail(403,'この画面から操作し直してください。');
 if(path==='/healthz'&&method==='GET')return json({ok:true});
 if(path==='/api/login'&&method==='POST'){
  const result=await login(request,env,(await jsonBody(request)).password);
  return json(result.status===200?{ok:true}:{error:result.error},result.status,result.cookie?{'Set-Cookie':result.cookie}:{});
 }
 if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
 if(!await loggedIn(request,env))fail(401,'ログインしてください。');
 if(path==='/api/logout'&&method==='POST')return json({ok:true},200,{'Set-Cookie':await logout(request,env)});
 if(path==='/api/search'&&method==='POST')return json(await semanticSearch(env,text((await jsonBody(request)).query,200)));
 if(path==='/api/state'&&method==='GET'){
  const day=new Date().toISOString().slice(0,10);
  const [captures,views,current,usage,reflection,instance]=await Promise.all([
   list(env,(url.searchParams.get('q')||'').slice(0,200)),rows<View>(env,'SELECT * FROM views ORDER BY created_at DESC LIMIT 100'),
   stmt(env,"SELECT s.* FROM sources s JOIN settings t ON t.value=s.id WHERE t.key='current_source'").first(),
   stmt(env,'SELECT calls FROM ai_daily WHERE day=?',day).first<{calls:number}>(),currentReflection(env),
   stmt(env,"SELECT value FROM settings WHERE key='instance_id'").first<{value:string}>(),
  ]);
  return json({instance_id:instance?.value,ai_configured:Boolean(env.OPENAI_API_KEY),captures,views,reflection,current_source:current,usage:{calls:usage?.calls||0},daily_limit:Number(env.AI_DAILY_CALL_LIMIT)});
 }
 const externalMatch=/^\/api\/external-sources\/([a-f0-9-]{36})$/.exec(path);
 if(externalMatch&&['PATCH','DELETE'].includes(method))return json(await changeExternal(request,env,externalMatch[1]));
 const researchMatch=/^\/api\/research\/([a-f0-9-]{36})\/(adopt|cancel|retry)$/.exec(path);
 if(researchMatch&&method==='POST'){if(researchMatch[2]==='adopt')return json(await adoptResearch(request,env,researchMatch[1]));const result=await controlResearch(env,researchMatch[1],researchMatch[2]);ctx.waitUntil(dispatch(env));return json(result);}
 const conceptMatch=/^\/api\/concepts\/([a-f0-9-]{36})$/.exec(path);
 if(conceptMatch&&method==='GET')return json(await conceptDetail(env,conceptMatch[1]));
 if(conceptMatch&&method==='POST')return json(await organizeConcept(env,conceptMatch[1],await jsonBody(request)));
 const reflectionMatch=/^\/api\/reflections\/([a-f0-9-]{36})$/.exec(path);
 if(reflectionMatch&&method==='POST'){if(!await revisit(env,reflectionMatch[1],(await jsonBody(request)).action))fail(400,'振り返りが見つかりません。');return json({ok:true});}
 if(path==='/api/external-sources'&&method==='POST')return json(await saveExternal(request,env),201);
 if(path==='/api/captures'&&method==='POST'){
  const saved=await saveCapture(request,env);ctx.waitUntil(dispatch(env));return saved;
 }
 const match=/^\/api\/captures\/([a-f0-9-]{36})(?:\/(assets|retry|adopt|graph|external-sources|research))?$/.exec(path);
 if(match){
  const [,captureId,action]=match;
  if(!action&&method==='GET'){const c=await getCapture(env,captureId);if(!c)fail(404,'記録が見つかりません。');return json(c);}
  if(!action&&method==='PATCH'){const saved=await editCapture(request,env,captureId);ctx.waitUntil(dispatch(env));return saved;}
  if(!action&&method==='DELETE')return deleteCapture(request,env,captureId);
  if(action==='external-sources'&&method==='POST')return json(await saveExternal(request,env,captureId),201);
  if(action==='research'&&method==='POST'){const saved=await queueResearch(request,env,captureId);ctx.waitUntil(dispatch(env));return json(saved,201);}
  if(action==='graph'&&method==='GET'){const graph=await graphFor(env,captureId);if(!graph)fail(404,'記録が見つかりません。');return json(graph);}
  if(action==='assets'&&method==='POST'){const saved=await supplement(request,env,captureId);ctx.waitUntil(dispatch(env));return saved;}
  if(action==='adopt'&&method==='POST')return adopt(request,env,captureId);
  if(action==='retry'&&method==='POST'){
   const input=await jsonBody(request);
   const change=await stmt(env,`UPDATE jobs SET state='pending',attempts=0,error_code=NULL,available_at=?,dispatched_at=NULL
    WHERE capture_id=? AND version=? AND version=(SELECT version FROM captures WHERE id=?) AND state IN('blocked','failed')`,now(),captureId,version(input.version),captureId).run();
   if(!change.meta.changes)fail(409,'記録が更新されたか、処理中です。');ctx.waitUntil(dispatch(env));return json({ok:true});
  }
 }
 const assetMatch=/^\/api\/assets\/([a-f0-9-]{36})$/.exec(path);
 if(assetMatch&&method==='GET'){
  const asset=await stmt(env,'SELECT * FROM assets WHERE id=?',assetMatch[1]).first<Asset>();if(!asset)fail(404,'原資料が見つかりません。');
  const object=await env.ORIGINALS.get(asset.object_key);if(!object)fail(404,'原資料が見つかりません。');
  return new Response(object.body,{headers:{'Content-Type':asset.mime,'Content-Length':String(object.size),'Content-Disposition':`inline; filename="${asset.name}"`}});
 }
 const viewMatch=/^\/api\/views\/([a-f0-9-]{36})$/.exec(path);
 if(viewMatch){
  if(method==='GET'){
   const v=await stmt(env,'SELECT * FROM views WHERE id=?',viewMatch[1]).first<View>();if(!v)fail(404,'見方が見つかりません。');
   const revisions=await rows<Record<string,unknown>>(env,'SELECT * FROM view_revisions WHERE view_id=? ORDER BY version DESC',v.id);
   const enriched=await Promise.all(revisions.map(async r=>{
    const references=JSON.parse(String(r.references_json)) as {capture_id:string;capture_version:number};
    const source=await stmt(env,'SELECT version FROM captures WHERE id=?',references.capture_id).first<{version:number}>();
    return {...r,references,reference_state:!source?'deleted':source.version===references.capture_version?'current':'changed',references_json:undefined};
   }));
   return json({...v,revisions:enriched});
  }
  if(method==='PATCH')return editView(request,env,viewMatch[1]);
 }
 if(path==='/api/export'&&method==='GET')return exportData(env);
 fail(404,'この操作は見つかりません。');
}

export default {
 async fetch(request,env,ctx){
  try{return headers(await route(request,env,ctx),env);}
  catch(e){
   const message=e instanceof HttpError?e.message:e instanceof AiError?(e.code==='daily_limit'?'今日のAI利用上限に達しました。':e.code==='ai_not_configured'?'AIの設定が必要です。':'資料について回答できませんでした。'):'操作を完了できませんでした。原資料を残したまま、もう一度お試しください。';
   return headers(json({error:message},e instanceof HttpError?e.status:e instanceof AiError?503:500),env);
  }
 },
 async scheduled(_event,env){await dispatch(env);await cleanup(env);},
 async queue(batch,env){await consume(batch,env);},
} satisfies ExportedHandler<Env>;
