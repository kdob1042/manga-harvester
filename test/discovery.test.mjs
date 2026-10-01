import test from 'node:test';import assert from 'node:assert/strict';
import {runtime,imageRequest,fixture,provider} from './runtime.mjs';
import {saveCapture} from '../src/mutations.ts';import {getCapture} from '../src/core.ts';import {processJob} from '../src/queue.ts';
import {searchCaptures,semanticSearch,conceptDetail,organizeConcept} from '../src/discovery.ts';
test('search explains matching text and concept organization preserves original evidence with reversible aliases and merges',async()=>{
 const {env,sqlite}=runtime(),{id}=await (await saveCapture(imageRequest('この間が好き'),env)).json(),c=await getCapture(env,id);
 await processJob(env,c.job.id,provider(x=>fixture(x.asset_labels[0].id,x.user_note)));
 const search=await searchCaptures(env,'対象への期待');assert.equal(search[0].id,id);assert.ok(search[0].search_reason);assert.ok(search[0].search_evidence);
 const concept=sqlite.prepare('SELECT id FROM concepts').get().id,before=sqlite.prepare('SELECT result FROM harvests').get().result;
 const k=await conceptDetail(env,concept);await organizeConcept(env,concept,{kind:'alias',revision:k.revision,alias:'リアクション待ち',reason:'自分の呼び方'});
 assert.equal((await searchCaptures(env,'リアクション待ち'))[0].id,id);
 await assert.rejects(organizeConcept(env,concept,{kind:'alias',revision:0,alias:'test',reason:'stale'}),e=>e.status===409);
 const target=crypto.randomUUID();sqlite.prepare('INSERT INTO concepts VALUES(?,?,?,?)').run(target,'待ちの演出','同じ意味として本人が整理する','test');
 await organizeConcept(env,concept,{kind:'merge',revision:1,target_id:target,reason:'この文脈では同じ意味'});
 const detail=await conceptDetail(env,concept);assert.equal(detail.canonical_id,target);assert.equal(detail.captures[0].id,id);
 await organizeConcept(env,concept,{kind:'undo',revision:2,action_id:detail.actions[0].id,reason:'意味を分けて考える'});
 assert.equal((await conceptDetail(env,concept)).canonical_id,concept);assert.equal(sqlite.prepare('SELECT result FROM harvests').get().result,before);
});
test('meaning search returns only existing versions and exact excerpts, with no external search or original image upload',async()=>{
 const {env}=runtime(),{id}=await (await saveCapture(imageRequest('この反応が好き'),env)).json(),c=await getCapture(env,id);await processJob(env,c.job.id,provider(x=>fixture(x.asset_labels[0].id,x.user_note)));
 const response=match=>Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({matches:[match]})}]}]});
 const match={capture_id:id,version:1,node_id:'c2',reason:'知りたいことを待たせる体験に近い',quote:'対象への疑問が生まれる'};
 const result=await semanticSearch(env,'先が知りたくて待たされる',async(url,init)=>{const p=JSON.parse(init.body);assert.equal(p.tools,undefined);assert.ok(!init.body.includes('input_image'));assert.equal(p.store,false);return response(match);});
 assert.equal(result.captures[0].id,id);assert.ok(result.captures[0].search_reason.includes(match.reason));assert.equal(result.captures[0].search_evidence,match.quote);
 await assert.rejects(semanticSearch(env,'待たされる',async()=>response({...match,quote:'本人が感動した'})),e=>e.code==='invalid_output');
});
