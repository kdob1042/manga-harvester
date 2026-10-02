import test from 'node:test';
import assert from 'node:assert/strict';
import {saveCapture,editCapture} from '../src/mutations.ts';
import {getCapture} from '../src/core.ts';
import {processJob} from '../src/queue.ts';
import {currentReflection,revisit} from '../src/reflection.ts';
import {validateHarvest} from '../src/harvest-contract.js';
import {runtime,imageRequest,request,fixture,provider} from './runtime.mjs';
test('revisits require a meaningful comparison, respect feedback and invalidate edited references',async()=>{
 const {env,sqlite}=runtime();
 async function add(target){
  const {id}=await (await saveCapture(imageRequest('反応が好き'),env)).json(),c=await getCapture(env,id);
  await processJob(env,c.job.id,provider(x=>{const h=fixture(x.asset_labels[0].id,x.user_note);
   if(target)h.comparisons=[{target_id:target,kind:'contrasts_with',shared_structure:'対象を保留する',differences:'反応の意味が違う',question:'緊張と笑いの境目は？',claim_ids:['c2'],target_claim_ids:['c2']}];
   h.counterfactuals=[{change:'もし対象を先に見せるなら',possible_effect:'対象への疑問は減る可能性',limits:'未実験で、前後によって異なる',claim_ids:['c2']}];return h;}));return id;
 }
 const a=await add();assert.equal(await currentReflection(env),null);
 const b=await add(a),r=await currentReflection(env);assert.equal(r.target_id,a);assert.equal(r.capture_id,b);assert.equal(r.data.user_words[0],'反応が好き');
 await revisit(env,r.id,'shown');await revisit(env,r.id,'shown');assert.equal(sqlite.prepare('SELECT count(*) n FROM revisit_events').get().n,1);
 await revisit(env,r.id,'dismissed');assert.equal(await currentReflection(env),null);
 await add(a);assert.equal(await currentReflection(env),null);
 await add(b);assert.ok(await currentReflection(env));
 await editCapture(request('/edit','PATCH',{version:1,note:'これは好意ではない'}),env,b);assert.equal(await currentReflection(env),null);
 const c=await getCapture(env,a),bad=fixture(c.assets[0].id);bad.counterfactuals=[{change:'仮の変更',possible_effect:'予想',limits:'',claim_ids:['c2']}];
 assert.throws(()=>validateHarvest(bad,'',{assets:c.assets,candidates:[],concepts:[],views:[]}));
});
