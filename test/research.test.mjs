import test from 'node:test';import assert from 'node:assert/strict';
import {runtime,imageRequest,request,fixture,provider} from './runtime.mjs';import {researchProvider,researchAnswer,sourceURL} from './research-fixtures.mjs';
import {saveCapture,adopt} from '../src/mutations.ts';import {getCapture} from '../src/core.ts';import {processJob} from '../src/queue.ts';
import {queueResearch,processResearch,researchFor,adoptResearch,saveExternal,changeExternal,controlResearch} from '../src/research.ts';import {validateResearch} from '../src/research-contract.ts';
test('explicit external research searches only the public question, rejects invented URLs and adopts through a versioned proposal',async()=>{
 const {env,sqlite}=runtime(),{id}=await (await saveCapture(imageRequest('本人の非公開メモ'),env)).json(),c=await getCapture(env,id);
 await processJob(env,c.job.id,provider(x=>fixture(x.asset_labels[0].id,x.user_note)));const ready=await getCapture(env,id),view=await (await adopt(request('/adopt','POST',{version:1,proposal_id:ready.proposals[0].id}),env,id)).json();
 const key=crypto.randomUUID(),input={question:'漫画で対象を後から見せる表現への別解釈は？',version:1,view_id:view.id};
 const run=await queueResearch(request('/research','POST',input,{'Idempotency-Key':key}),env,id);
 assert.equal((await queueResearch(request('/research','POST',input,{'Idempotency-Key':key}),env,id)).id,run.id);
 let calls=0;await processResearch(env,run.id,researchProvider(p=>{calls++;assert.equal(p.store,false);if(p.tools){assert.equal(p.input,input.question);assert.equal(p.max_tool_calls,2);assert.ok(!JSON.stringify(p).includes('本人の非公開メモ'));}}));
 assert.equal(calls,2);assert.equal((await researchFor(env,id))[0].state,'completed');assert.equal(sqlite.prepare('SELECT version FROM views').get().version,1);
 await adoptResearch(request('/adopt','POST',{version:1}),env,run.id);await adoptResearch(request('/adopt','POST',{version:1}),env,run.id);assert.equal(sqlite.prepare('SELECT version FROM views').get().version,2);
 const ref=JSON.parse(sqlite.prepare('SELECT references_json FROM view_revisions WHERE version=2').get().references_json);assert.equal(ref.research_id,run.id);assert.equal(ref.external_snapshot.evidence[0].source_url,sourceURL);
 const invalid=researchAnswer();invalid.evidence[0].source_url='https://example.com/invented';assert.throws(()=>validateResearch(invalid,[sourceURL],true));
 for(let n=0;n<2;n++)await queueResearch(request('/research','POST',{...input,question:`別の問い${n}`},{'Idempotency-Key':crypto.randomUUID()}),env,id);
 await assert.rejects(queueResearch(request('/research','POST',{...input,question:'上限超過'},{'Idempotency-Key':crypto.randomUUID()}),env,id),e=>e.status===429);
});
test('cancellation stops post-search generation, and uncertain search delivery never re-spends the run budget',async()=>{
 const {env,sqlite}=runtime(),{id}=await (await saveCapture(imageRequest(),env)).json();
 const create=()=>queueResearch(request('/r','POST',{question:'公開の問い',version:1},{'Idempotency-Key':crypto.randomUUID()}),env,id);
 const a=await create();let calls=0,fake=researchProvider();
 await processResearch(env,a.id,async(url,init)=>{calls++;await controlResearch(env,a.id,'cancel');return fake(url,init);});assert.equal(calls,1);assert.equal((await researchFor(env,id)).find(r=>r.id===a.id).state,'cancelled');
 const b=await create();await processResearch(env,b.id,async()=>{calls++;throw new Error('response lost');});assert.equal((await researchFor(env,id)).find(r=>r.id===b.id).state,'failed');
 await assert.rejects(controlResearch(env,b.id,'retry'),e=>e.status===409);assert.equal(sqlite.prepare('SELECT count(*) n FROM captures').get().n,1);
 const source=await saveExternal(request('/source','POST',{url:sourceURL,quote:'提供された抜き書き',scope:'最初の対象'},{'Idempotency-Key':crypto.randomUUID()}),env,id);
 await changeExternal(request('/source','PATCH',{version:1,scope:'本人による訂正'}),env,source.id);
 await assert.rejects(changeExternal(request('/source','PATCH',{version:1,scope:'古い編集'}),env,source.id),e=>e.status===409);
 await changeExternal(request('/source','DELETE',{version:2}),env,source.id);assert.equal(sqlite.prepare('SELECT count(*) n FROM external_sources').get().n,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM external_revisions').get().n,2);
});
test('external search resumes from retrieval checkpoint; manual quotes stay separate from personal reactions',async()=>{
 const {env,sqlite}=runtime(),sourceInput={url:sourceURL,quote:'著者の引用として本人が提供した文章',scope:'この作品に関する発言',source_type:'author_statement',speaker:'発言者',title:'手動資料'};
 const external=await saveExternal(request('/external','POST',sourceInput,{'Idempotency-Key':crypto.randomUUID()}),env),c=await getCapture(env,external.capture_id);assert.equal(c.kind,'external');assert.equal(c.original_text,'');assert.equal(c.external_sources[0].provenance,'user_provided');assert.equal(c.job,null);
 const run=await queueResearch(request('/research','POST',{question:'公開の表現に関する問い',version:1},{'Idempotency-Key':crypto.randomUUID()}),env,c.id);
 const fake=researchProvider();let calls=0;
 await processResearch(env,run.id,async(url,init)=>{calls++;return calls===2?new Response('down',{status:503}):fake(url,init);});assert.equal(calls,2);assert.equal((await researchFor(env,c.id))[0].state,'pending');
 sqlite.prepare('UPDATE research_runs SET available_at=0 WHERE id=?').run(run.id);
 await processResearch(env,run.id,researchProvider(p=>{assert.ok(!p.tools);calls++;}));assert.equal(calls,3);assert.equal((await researchFor(env,c.id))[0].state,'completed');
});
