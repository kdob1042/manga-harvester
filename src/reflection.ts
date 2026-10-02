import {stmt,rows,id,now,type Capture,type Harvest,type AiContext} from './core.ts';

// A reflection is a projection of the already validated analysis, never another
// unbounded model call. Keep both input versions so edits invalidate the card.
export async function reflectionStatements(env:Env,c:Capture,h:Harvest,context:AiContext,generation:string,guard:string,jobId:string,token:string){
 for(const comparison of h.comparisons){
  const target=context.candidates.find(t=>t.id===comparison.target_id)!;
  const prior=await stmt(env,`SELECT 1 FROM revisit_events e JOIN reflections r ON r.id=e.reflection_id
   JOIN generations g ON g.id=r.target_generation_id WHERE g.capture_id=? AND e.created_at>? LIMIT 1`,target.id,now()-30*86400000).first();
  if(prior)continue;
  return [stmt(env,`INSERT INTO reflections(id,generation_id,target_generation_id,data,created_at)
   SELECT ?,?,?,?,? WHERE ${guard} AND EXISTS(SELECT 1 FROM captures WHERE id=? AND version=?)`,
   id(),generation,target.generation_id,JSON.stringify({comparison,user_words:h.reactions.map(r=>r.quote),target_words:target.harvest.reactions.map(r=>r.quote),counterfactuals:h.counterfactuals||[],questions:h.questions.map(q=>q.text)}),now(),jobId,token,target.id,target.version)];
 }
 return [];
}
export async function currentReflection(env:Env){
 const r=await stmt(env,`SELECT r.*,g.capture_id,t.capture_id AS target_id FROM reflections r
  JOIN generations g ON g.id=r.generation_id JOIN captures c ON c.id=g.capture_id AND c.version=g.version
  JOIN generations t ON t.id=r.target_generation_id JOIN captures p ON p.id=t.capture_id AND p.version=t.version
  WHERE NOT EXISTS(SELECT 1 FROM revisit_events e WHERE e.reflection_id=r.id AND e.action IN ('dismissed','opened'))
  ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).first<{id:string;data:string;capture_id:string;target_id:string;created_at:number}>();
 if(!r)return null;
 const changes=await rows(env,`SELECT view_id,version,body,reason FROM view_revisions
  WHERE created_at>=? ORDER BY created_at DESC LIMIT 3`,r.created_at);
 return {...r,data:JSON.parse(r.data),changes};
}
export async function revisit(env:Env,reflectionId:string,action:unknown){
 if(!['shown','opened','dismissed'].includes(String(action)))return false;
 const result=await stmt(env,`INSERT OR IGNORE INTO revisit_events(id,reflection_id,action,created_at)
  SELECT ?,id,?,? FROM reflections WHERE id=?`,id(),String(action),now(),reflectionId).run();
 return Boolean(result.meta.changes)||Boolean(await stmt(env,'SELECT id FROM reflections WHERE id=?',reflectionId).first());
}
