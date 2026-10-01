export const sourceURL='https://example.com/interview';
export function researchAnswer(hasView=true){return {summary:'同じ表現にも複数の説明があり、対象の限定が必要。',evidence:[{source_url:sourceURL,text:'情報を保留する表現への説明がある。',source_type:'criticism',speaker:null,published_at:null,scope:'特定の表現に対する批評',limitations:'作者の直接発言ではなく、効果の実験でもない',independence_group:'同じ批評'}],alternatives:['反応への共感という別の説明もある。'],unanswered:['自分が面白いと感じた理由は追加のメモで確かめる。'],proposal:hasView?{text:'情報を保留する表現は期待を生む可能性があるが、共感という説明も残す。',reason:'批評から別の説明と限界を加えた。',source_urls:[sourceURL],limits:'作者意図や普遍的な好みは断定しない。'}:null};}
export const researchProvider=(onCall=()=>{})=>async(url,init)=>{
 const payload=JSON.parse(init.body);onCall(payload);
 return Response.json(payload.tools?{status:'completed',output:[{type:'web_search_call',action:{sources:[{url:sourceURL}]}},{type:'message',content:[{type:'output_text',text:'批評による説明。',annotations:[{type:'url_citation',url:sourceURL,title:'検証用の架空資料',start_index:0,end_index:8}]}]}]}:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(researchAnswer(Boolean(JSON.parse(payload.input).selected_context.view)))}]}]});
};
