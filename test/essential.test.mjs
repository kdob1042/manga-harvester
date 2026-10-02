import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import {saveCapture,supplement,editCapture,adopt} from '../src/mutations.ts';
import {getCapture} from '../src/core.ts';
import {dispatch,processJob} from '../src/queue.ts';
import {graphFor} from '../src/graph.ts';
import {validateHarvest} from '../src/harvest-contract.js';
import {runtime,png,request,imageRequest,fixture,provider} from './runtime.mjs';
const ctx={waitUntil(p){p.catch(()=>{});}};
const count=(db,table)=>Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
async function capture(env,note='',count=1){const saved=await (await saveCapture(imageRequest(note,count),env)).json();return getCapture(env,saved.id);}

test('photos + comment → durable job → validated knowledge; only explicit adoption creates a view',async()=>{
 const {env,sqlite}=runtime(),c=await capture(env,'この間が好き',2);
 assert.equal(c.assets.length,2);assert.equal(c.note,'この間が好き');
 assert.equal(count(sqlite,'jobs'),1);assert.equal(count(sqlite,'views'),0);
 await dispatch(env);let calls=0;
 await processJob(env,c.job.id,provider(x=>fixture(x.asset_labels[0].id,x.user_note),(url,init)=>{calls++;const body=JSON.parse(init.body);assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.equal(body.input[0].content.filter(x=>x.type==='input_image').length,2);}));
 const done=await getCapture(env,c.id);assert.equal(done.job.state,'completed');assert.equal(calls,1);assert.equal(done.harvest.reactions[0].quote,'この間が好き');
 assert.equal(count(sqlite,'views'),0);const graph=await graphFor(env,c.id);assert.equal(graph.nodes.length,5);assert.ok(graph.relations.length>=4);
 const p=done.proposals[0],adopted=await (await adopt(request('/adopt','POST',{version:1,proposal_id:p.id}),env,c.id)).json();
 await adopt(request('/adopt','POST',{version:1,proposal_id:p.id}),env,c.id);assert.equal(count(sqlite,'views'),1);assert.equal(count(sqlite,'view_revisions'),1);assert.ok(adopted.id);
});

test('resending photos or a supplement is idempotent; corrections preserve originals and supersede results',async()=>{
 const {env,sqlite}=runtime(),key=crypto.randomUUID(),a=await (await saveCapture(imageRequest('',2,key),env)).json();
 const b=await (await saveCapture(imageRequest('',2,key),env)).json();assert.equal(a.id,b.id);assert.equal(count(sqlite,'assets'),2);
 await assert.rejects(saveCapture(imageRequest('different',2,key),env),e=>e.status===409);
 const c=await getCapture(env,a.id),supplementKey=crypto.randomUUID();
 const req=()=>request('/add','POST',{text:'この反応が好き'},{'Idempotency-Key':supplementKey,'X-Capture-Version':'1'});
 await supplement(req(),env,c.id);await supplement(req(),env,c.id);assert.equal((await getCapture(env,c.id)).version,2);
 await processJob(env,c.job.id,provider(()=>{throw new Error('should not call');}));assert.equal(sqlite.prepare('SELECT state FROM jobs WHERE id=?').get(c.job.id).state,'superseded');
 await editCapture(request('/edit','PATCH',{version:2,note:'皮肉なので好意ではない'}),env,c.id);
 assert.equal(count(sqlite,'assets'),2);assert.equal(count(sqlite,'capture_revisions'),3);
});

test('cross-record comparisons carry both evidence sets; same names with different meanings stay separate',async()=>{
 const {env,sqlite}=runtime(),a=await capture(env);
 await processJob(env,a.job.id,provider(x=>fixture(x.asset_labels[0].id)));
 const b=await capture(env);
 await processJob(env,b.job.id,provider(x=>{const f=fixture(x.asset_labels[0].id);assert.equal(x.candidates.length,1);f.concepts[0].existing_id=x.concepts[0].id;f.comparisons=[{target_id:a.id,kind:'shares_structure_with',shared_structure:'反応を先に見せ、対象を後で明かす',differences:'対象が異なり、緊張と笑いの仮説が異なる',question:'同じ提示順でも効果が変わる条件は？',claim_ids:['c1','c2'],target_claim_ids:['c1','c2']}];return f;}));
 assert.equal(count(sqlite,'concepts'),1);assert.equal((await getCapture(env,b.id)).comparisons[0].target_id,a.id);
 const c=await capture(env);await processJob(env,c.job.id,provider(x=>{const f=fixture(x.asset_labels[0].id);f.concepts[0].description='同名だが別の意味。';return f;}));assert.equal(count(sqlite,'concepts'),2);
 await editCapture(request('/edit','PATCH',{version:1,note:'補足'}),env,a.id);assert.equal((await graphFor(env,b.id)).comparisons.length,0);
});

test('reject forged reactions, invalid references, page structures; a stale run cannot commit',async()=>{
 const {env,sqlite}=runtime(),c=await capture(env),f=fixture(c.assets[0].id),context={assets:c.assets,candidates:[],concepts:[],views:[]};
 assert.doesNotThrow(()=>validateHarvest(f,'',context));
 assert.throws(()=>validateHarvest({...f,reactions:[{quote:'感動した',kind:'like',interpretation:'好き'}]},'',context));
 assert.throws(()=>validateHarvest({...f,page:3},'',context));
 assert.throws(()=>validateHarvest({...f,relations:[{from:'c1',to:'missing',kind:'qualifies',reason:'test',conditions:[]}]},'',context));
 await processJob(env,c.job.id,provider(async x=>{await editCapture(request('/edit','PATCH',{version:1,note:'処理中の本人訂正'}),env,c.id);return fixture(x.asset_labels[0].id);}));
 assert.equal(count(sqlite,'generations'),0);assert.equal(count(sqlite,'harvests'),0);assert.equal((await getCapture(env,c.id)).version,2);
});

test('API auth protects originals and export; source deletion retains adopted view history',async()=>{
 const {env,sqlite,objects}=runtime(),c=await capture(env);
 const unauthorized=await worker.fetch(request(`/api/assets/${c.assets[0].id}`),env,ctx);assert.equal(unauthorized.status,401);
 assert.equal((await worker.fetch(request('/api/export'),env,ctx)).status,401);
 const login=await worker.fetch(request('/api/login','POST',{password:env.APP_PASSWORD}),env,ctx);assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie};
 const state=await (await worker.fetch(request('/api/state','GET',undefined,headers),env,ctx)).json();assert.match(state.instance_id,/^[a-f0-9]{32}$/);
 assert.equal((await worker.fetch(request(`/api/assets/${c.assets[0].id}`,'GET',undefined,headers),env,ctx)).status,200);
 const foreign=request('/api/captures','POST',{text:'attack'},{...headers,Origin:'https://other.invalid','Idempotency-Key':crypto.randomUUID()});assert.equal((await worker.fetch(foreign,env,ctx)).status,403);
 await processJob(env,c.job.id,provider(x=>fixture(x.asset_labels[0].id)));const ready=await getCapture(env,c.id);
 await adopt(request('/adopt','POST',{version:1,proposal_id:ready.proposals[0].id}),env,c.id);
 const exportResponse=await worker.fetch(request('/api/export','GET',undefined,headers),env,ctx);const exported=await exportResponse.json();assert.equal(exported.assets[0].base64,png.toString('base64'));assert.ok(exported.nodes.length);
 const deleted=await worker.fetch(request(`/api/captures/${c.id}`,'DELETE',{version:1},headers),env,ctx);assert.equal(deleted.status,200);
 assert.equal(objects.size,0);assert.equal(count(sqlite,'generations'),0);assert.equal(count(sqlite,'views'),1);assert.equal(count(sqlite,'view_revisions'),1);assert.equal(sqlite.prepare('SELECT capture_id FROM views').get().capture_id,null);
});

test('audio is transcribed separately and retained; failures never erase originals',async()=>{
 const {env,sqlite}=runtime(),form=new FormData(),wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);form.append('file',new File([wav],'voice.wav',{type:'audio/wav'}));
 const saved=await (await saveCapture(request('/api/captures','POST',form,{'Idempotency-Key':crypto.randomUUID()}),env)).json(),c=await getCapture(env,saved.id);
 await processJob(env,c.job.id,provider(x=>{const f=fixture(null,'この反応が好き');f.claims.forEach(claim=>claim.evidence=[{asset_id:c.assets[0].id,quote:'この反応が好き',origin:'user',certainty:'explicit'}]);return f;}));
 const done=await getCapture(env,c.id);assert.equal(done.job.state,'completed');assert.equal(count(sqlite,'asset_transcripts'),1);assert.equal(count(sqlite,'ai_calls'),2);
 const other=await capture(env);env.OPENAI_API_KEY='';await processJob(env,other.job.id);assert.equal((await getCapture(env,other.id)).job.state,'blocked');assert.equal(count(sqlite,'assets'),2);
});

test('view update proposals preserve revision checks and old analysis survives failed rebuild',async()=>{
 const {env,sqlite}=runtime(),a=await capture(env);
 await processJob(env,a.job.id,provider(x=>fixture(x.asset_labels[0].id)));
 const first=await getCapture(env,a.id),v=await (await adopt(request('/adopt','POST',{version:1,proposal_id:first.proposals[0].id}),env,a.id)).json();
 const b=await capture(env);
 await processJob(env,b.job.id,provider(x=>{const f=fixture(x.asset_labels[0].id);f.view_proposals=[{view_id:v.id,base_revision:1,text:'反応の提示は、対象が未知のときに期待を作る。',reason:'別の写真から条件を加えた。',claim_ids:['c2']}];return f;}));
 const ready=await getCapture(env,b.id),p=ready.proposals.find(p=>p.view_id===v.id);
 assert.equal(sqlite.prepare('SELECT version FROM views WHERE id=?').get(v.id).version,1);
 await adopt(request('/adopt','POST',{version:1,proposal_id:p.id}),env,b.id);
 assert.equal(sqlite.prepare('SELECT version FROM views WHERE id=?').get(v.id).version,2);assert.equal(count(sqlite,'view_revisions'),2);
 const c=await capture(env);
 await processJob(env,c.job.id,provider(x=>{const f=fixture(x.asset_labels[0].id);f.view_proposals=[{view_id:v.id,base_revision:2,text:'古い案',reason:'test',claim_ids:['c2']}];return f;}));
 const old=await getCapture(env,c.id);
 sqlite.prepare('UPDATE views SET version=3,body=? WHERE id=?').run('本人が先に編集した本文',v.id);
 await assert.rejects(adopt(request('/adopt','POST',{version:1,proposal_id:old.proposals.find(p=>p.view_id===v.id).id}),env,c.id),e=>e.status===409);
 await editCapture(request('/edit','PATCH',{version:1,note:'本人が訂正'}),env,b.id);
 const update=await getCapture(env,b.id);env.OPENAI_API_KEY='';await processJob(env,update.job.id);
 const blocked=await getCapture(env,b.id);assert.equal(blocked.harvest_version,1);assert.equal(blocked.version,2);assert.equal(blocked.proposals.length,0);
});
