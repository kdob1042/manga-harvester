import {stmt,rows,id,now,digest,type Harvest,type AiContext,type Capture,type Asset,type View} from './core.ts';

export async function contextFor(env:Env,c:Capture,assets:Asset[]):Promise<AiContext>{
 const [prior,concepts,views]=await Promise.all([
  rows<{id:string;version:number;source_title:string|null;generation_id:string;result:string}>(env,`SELECT c.id,c.version,s.title AS source_title,g.id AS generation_id,h.result FROM captures c JOIN harvests h ON h.capture_id=c.id AND h.version=c.version JOIN generations g ON g.capture_id=c.id AND g.version=c.version LEFT JOIN sources s ON s.id=c.source_id WHERE c.id<>? ORDER BY c.updated_at DESC LIMIT 24`,c.id),
  rows<{id:string;name:string;description:string}>(env,`SELECT DISTINCT k.id,k.name,k.description FROM concepts k JOIN nodes n ON n.concept_id=k.id JOIN generations g ON g.id=n.generation_id JOIN captures c ON c.id=g.capture_id AND c.version=g.version ORDER BY g.created_at DESC LIMIT 40`),
  rows<View>(env,'SELECT * FROM views ORDER BY created_at DESC LIMIT 12'),
 ]);
 return {assets,candidates:prior.map(({result,...p})=>({...p,harvest:JSON.parse(result) as Harvest})),concepts,views};
}

// These statements execute in the SAME D1 transaction as harvests and job completion.
// Every write checks the input revision + consumer lease; stale runs cannot overwrite.
export async function graphStatements(env:Env,c:Capture,h:Harvest,context:AiContext,jobId:string,token:string){
 const generation=id(),guard=`EXISTS(SELECT 1 FROM jobs j JOIN captures c ON c.id=j.capture_id WHERE j.id=? AND j.state='running' AND j.lease_token=? AND c.version=j.version)`;
 const s:D1PreparedStatement[]=[stmt(env,`INSERT INTO generations(id,capture_id,version,created_at) SELECT ?,?,?,? WHERE ${guard}`,generation,c.id,c.version,now(),jobId,token)];
 const local=new Map<string,string>();
 for(const [kind,group] of [['claim',h.claims],['concept',h.concepts],['mechanism',h.mechanisms],['question',h.questions]] as const){
  for(const item of group){
   const nodeId=id();local.set(item.id,nodeId);
   let conceptId:string|null=null;
   if(kind==='concept'&&'name' in item){
    if(item.existing_id)conceptId=item.existing_id;
    else{
     // Equal names with different meanings remain separate concepts.
     const fingerprint=await digest(`${item.name.normalize('NFKC').trim()}\n${item.description.normalize('NFKC').trim()}`);
     conceptId=(await stmt(env,'SELECT id FROM concepts WHERE fingerprint=?',fingerprint).first<{id:string}>())?.id||id();
     s.push(stmt(env,`INSERT OR IGNORE INTO concepts(id,name,description,fingerprint) SELECT ?,?,?,? WHERE ${guard}`,conceptId,item.name,item.description,fingerprint,jobId,token));
     // Parallel consumers might choose different UUIDs for the same fingerprint.
     s.push(stmt(env,`INSERT INTO nodes(id,generation_id,local_id,kind,concept_id,data) SELECT ?,?,?,?,(SELECT id FROM concepts WHERE fingerprint=?),? WHERE ${guard}`,nodeId,generation,item.id,kind,fingerprint,JSON.stringify(item),jobId,token));continue;
    }
   }
   s.push(stmt(env,`INSERT INTO nodes(id,generation_id,local_id,kind,concept_id,data) SELECT ?,?,?,?,?,? WHERE ${guard}`,nodeId,generation,item.id,kind,conceptId,JSON.stringify(item),jobId,token));
  }
 }
 for(const r of h.relations){
  s.push(stmt(env,`INSERT INTO relations(id,generation_id,from_id,to_id,kind,scope,data) SELECT ?,?,?,?,?,?,? WHERE ${guard}`,id(),generation,local.get(r.from)!,local.get(r.to)!,r.kind,'knowledge',JSON.stringify(r),jobId,token));
 }
 // Basic evidence-to-concept/mechanism edges exist even if the model omitted relations.
 for(const item of [...h.concepts,...h.mechanisms,...h.questions])for(const ref of item.claim_ids){
  s.push(stmt(env,`INSERT INTO relations(id,generation_id,from_id,to_id,kind,scope,data) SELECT ?,?,?,?,?,?,? WHERE ${guard}`,id(),generation,local.get(ref)!,local.get(item.id)!,'evidence_for','knowledge',JSON.stringify({claim_id:ref}),jobId,token));
 }
 for(const comparison of h.comparisons){
  const target=context.candidates.find(p=>p.id===comparison.target_id)!;
  s.push(stmt(env,`INSERT INTO comparisons(id,generation_id,target_generation_id,kind,data) SELECT ?,?,?,?,? WHERE ${guard} AND EXISTS(SELECT 1 FROM captures WHERE id=? AND version=?)`,id(),generation,target.generation_id,comparison.kind,JSON.stringify({...comparison,target_version:target.version}),jobId,token,target.id,target.version));
 }
 for(const reaction of h.reactions)s.push(stmt(env,`INSERT INTO reactions(id,generation_id,quote,kind,interpretation) SELECT ?,?,?,?,? WHERE ${guard}`,id(),generation,reaction.quote,reaction.kind,reaction.interpretation,jobId,token));
 for(const p of [...(h.view_draft?[{...h.view_draft,view_id:null,base_revision:null}]:[]),...h.view_proposals]){
  s.push(stmt(env,`INSERT INTO proposals(id,generation_id,view_id,base_revision,data) SELECT ?,?,?,?,? WHERE ${guard}`,id(),generation,p.view_id,p.base_revision,JSON.stringify(p),jobId,token));
 }
 return s;
}

export async function graphFor(env:Env,captureId:string){
 const c=await stmt(env,'SELECT version FROM captures WHERE id=?',captureId).first<{version:number}>();if(!c)return null;
 const g=await stmt(env,'SELECT id FROM generations WHERE capture_id=? AND version=?',captureId,c.version).first<{id:string}>();
 if(!g)return {nodes:[],relations:[],comparisons:[]};
 const [nodes,relations,comparisons]=await Promise.all([
  rows(env,'SELECT * FROM nodes WHERE generation_id=?',g.id),rows(env,'SELECT * FROM relations WHERE generation_id=?',g.id),
  rows(env,`SELECT x.* FROM comparisons x JOIN generations t ON t.id=x.target_generation_id JOIN captures c ON c.id=t.capture_id AND c.version=t.version WHERE x.generation_id=?`,g.id),
 ]);return {generation_id:g.id,nodes,relations,comparisons};
}
