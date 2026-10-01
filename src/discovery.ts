import {stmt,rows,text,fail,id,now,type Harvest} from './core.ts';
const normalize=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s。、！？?!「」『』]/g,'');
function similarity(q:string,s:string){
 const a=normalize(q),b=normalize(s);if(!a||!b)return 0;if(b.includes(a))return 10;
 if(a.length<2)return 0;
 const grams=new Set(Array.from({length:a.length-1},(_,i)=>a.slice(i,i+2))),matched=[...grams].filter(g=>b.includes(g));
 return matched.length<2?0:matched.length/grams.size;
}
export async function searchCaptures(env:Env,query:string){
 const records=await rows<{id:string;kind:string;version:number;created_at:number;source_title:string|null;source_certainty:string|null;source_inherited:number;state:string;error_code:string|null;result:string|null;original_text:string;note:string}>(env,`SELECT c.id,c.kind,c.version,c.created_at,c.original_text,c.note,c.source_inherited,s.title AS source_title,s.certainty AS source_certainty,j.state,j.error_code,h.result FROM captures c LEFT JOIN sources s ON s.id=c.source_id LEFT JOIN jobs j ON j.capture_id=c.id AND j.version=c.version LEFT JOIN harvests h ON h.capture_id=c.id AND h.version=c.version ORDER BY c.updated_at DESC LIMIT 500`);
 const aliases=await rows<{capture_id:string;alias:string}>(env,`SELECT DISTINCT g.capture_id,a.alias FROM nodes n JOIN generations g ON g.id=n.generation_id JOIN captures c ON c.id=g.capture_id AND c.version=g.version LEFT JOIN concept_mappings m ON m.source_id=n.concept_id JOIN concept_aliases a LEFT JOIN concept_mappings am ON am.source_id=a.concept_id WHERE coalesce(am.target_id,a.concept_id)=coalesce(m.target_id,n.concept_id)`);
 return records.map(({result,original_text,note,...c})=>{
  const h=result?JSON.parse(result) as Harvest:null;
  const candidates:[string,string][]=[['本人の一言',`${original_text} ${note}`],['作品名',c.source_title||''],...aliases.filter(a=>a.capture_id===c.id).map(a=>['概念の別名',a.alias] as [string,string]),
   ...h?.claims.map(v=>['観察・解釈',v.text] as [string,string])||[],...h?.mechanisms.map(v=>['仕組みの記述',`${v.expression} ${v.information_change} ${v.possible_effect} ${v.limits}`] as [string,string])||[],...h?.concepts.map(v=>['概念の説明',`${v.name} ${v.description}`] as [string,string])||[],...h?.questions.map(v=>['未解決の問い',v.text] as [string,string])||[]];
  const matches=candidates.map(([kind,value])=>({kind,text:value,score:similarity(query,value)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  return {...c,harvest:h,original_preview:(note||original_text).slice(0,100),search_reason:matches[0]?`${matches[0].kind}との言葉の一致`:'',search_evidence:matches[0]?.text||'',score:matches[0]?.score||0};
 }).filter(c=>c.score>0).sort((a,b)=>b.score-a.score||b.created_at-a.created_at).slice(0,40);
}
export async function conceptDetail(env:Env,conceptId:string){
 const k=await stmt(env,'SELECT * FROM concepts WHERE id=?',conceptId).first<{id:string;name:string;description:string}>();if(!k)fail(404,'概念が見つかりません。');
 const m=await stmt(env,'SELECT target_id FROM concept_mappings WHERE source_id=?',conceptId).first<{target_id:string}>(),canonical=m?.target_id||conceptId;
 const [captures,aliases,concepts,revision,actions]=await Promise.all([
  rows<{id:string;source_title:string|null;result:string}>(env,`SELECT DISTINCT c.id,s.title AS source_title,h.result FROM captures c JOIN generations g ON g.capture_id=c.id AND g.version=c.version JOIN nodes n ON n.generation_id=g.id LEFT JOIN concept_mappings m ON m.source_id=n.concept_id JOIN harvests h ON h.capture_id=c.id AND h.version=c.version LEFT JOIN sources s ON s.id=c.source_id WHERE coalesce(m.target_id,n.concept_id)=? ORDER BY c.created_at DESC LIMIT 30`,canonical),
  rows<{alias:string}>(env,'SELECT a.alias FROM concept_aliases a LEFT JOIN concept_mappings m ON m.source_id=a.concept_id WHERE coalesce(m.target_id,a.concept_id)=?',canonical),rows<{id:string;name:string;description:string}>(env,'SELECT id,name,description FROM concepts WHERE id NOT IN(SELECT source_id FROM concept_mappings) LIMIT 100'),
  stmt(env,"SELECT value FROM settings WHERE key='concept_revision'").first<{value:string}>(),rows<{id:string;kind:string;revision:number;undone:number;reason:string;data:string}>(env,'SELECT * FROM concept_actions ORDER BY revision DESC LIMIT 10'),
 ]);return {concept:k,canonical_id:canonical,captures:captures.map(c=>({...c,result:JSON.parse(String(c.result))})),aliases,concepts,revision:Number(revision?.value||0),actions:actions.map(a=>({...a,data:JSON.parse(String(a.data))}))};
}
export async function organizeConcept(env:Env,conceptId:string,input:Record<string,unknown>){
 const detail=await conceptDetail(env,conceptId),base=Number(input.revision);if(base!==detail.revision)fail(409,'概念の整理が更新されています。開き直してください。');
 const reason=text(input.reason,2000).trim(),action=id(),kind=String(input.kind);if(!reason)fail(400,'整理する理由を一言残してください。');
 const statements:D1PreparedStatement[]=[];let data:Record<string,unknown>;
 const guard=`EXISTS(SELECT 1 FROM settings WHERE key='concept_revision' AND value=?)`;
 if(kind==='alias'){
  const alias=text(input.alias,200).trim();if(!alias)fail(400,'別名を入力してください。');data={concept_id:detail.canonical_id,alias};
  statements.push(stmt(env,`INSERT OR IGNORE INTO concept_aliases SELECT ?,?,?,? WHERE ${guard}`,id(),detail.canonical_id,alias,action,String(base)));
 }else if(kind==='merge'){
  const target=text(input.target_id,36);if(target===detail.canonical_id||detail.canonical_id!==conceptId)fail(400,'統合先を確認してください。');
  if(!detail.concepts.some(k=>k.id===target))fail(400,'統合先を確認してください。');
  if(await stmt(env,'SELECT 1 FROM concept_mappings WHERE target_id=?',conceptId).first())fail(409,'この概念には統合済みの別概念があります。先にその統合を戻してください。');
  data={source_id:conceptId,target_id:target};statements.push(stmt(env,`INSERT INTO concept_mappings SELECT ?,?,? WHERE ${guard}`,conceptId,target,action,String(base)));
 }else if(kind==='undo'){
  const prior=await stmt(env,'SELECT * FROM concept_actions WHERE id=? AND undone=0',text(input.action_id,36)).first<{id:string;kind:string;data:string}>();if(!prior)fail(409,'戻す整理が見つかりません。');
  const old=JSON.parse(prior.data) as {source_id?:string;target_id?:string};
  if(prior.kind==='merge'&&await stmt(env,'SELECT 1 FROM concept_mappings WHERE source_id=?',old.target_id!).first())fail(409,'統合先がさらに統合されています。新しい整理から戻してください。');
  if(!['merge','alias'].includes(prior.kind))fail(400,'この操作は戻せません。');data={action_id:prior.id};
  statements.push(stmt(env,`DELETE FROM concept_mappings WHERE action_id=? AND ${guard}`,prior.id,String(base)),stmt(env,`DELETE FROM concept_aliases WHERE action_id=? AND ${guard}`,prior.id,String(base)),stmt(env,`UPDATE concept_actions SET undone=1 WHERE id=? AND ${guard}`,prior.id,String(base)));
 }else fail(400,'別名・統合・取り消しを選んでください。');
 const result=await env.DB.batch([
  stmt(env,`INSERT INTO concept_actions SELECT ?,?,?,?,?,?,0 WHERE ${guard}`,action,base+1,kind,JSON.stringify(data),reason,now(),String(base)),...statements,
  stmt(env,`UPDATE settings SET value=? WHERE key='concept_revision' AND value=?`,String(base+1),String(base)),
 ]);if(!result[0].meta.changes)fail(409,'概念の整理が更新されています。開き直してください。');return {ok:true,revision:base+1};
}
