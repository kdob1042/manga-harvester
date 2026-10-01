import {validate} from './harvest-contract.js';
const string={type:'string'},nullable={type:['string','null']},array=(items:unknown)=>({type:'array',items}),object=(properties:Record<string,unknown>)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const researchSchema=object({
 summary:string,
 evidence:array(object({source_url:string,text:string,source_type:{type:'string',enum:['author_statement','editor_statement','criticism','research','review','unknown']},speaker:nullable,published_at:nullable,scope:string,limitations:string,independence_group:string})),
 alternatives:array(string),unanswered:array(string),
 proposal:{anyOf:[object({text:string,reason:string,source_urls:array(string),limits:string}),{type:'null'}]},
});
export type ResearchResult={summary:string;evidence:{source_url:string;text:string;source_type:string;speaker:string|null;published_at:string|null;scope:string;limitations:string;independence_group:string}[];alternatives:string[];unanswered:string[];proposal:{text:string;reason:string;source_urls:string[];limits:string}|null};
export function publicUrl(value:unknown){
 if(typeof value!=='string'||value.length>2000)throw new Error('invalid_source_url');
 const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||!url.hostname.includes('.')||url.hostname.endsWith('.local')||url.hostname.endsWith('.localhost')||/^[\d.]+$/.test(url.hostname)||url.hostname.includes(':'))throw new Error('invalid_source_url');
 url.hash='';for(const key of [...url.searchParams.keys()])if(/^utm_|^(fbclid|gclid)$/i.test(key))url.searchParams.delete(key);return url.toString();
}
export function validateResearch(value:unknown,urls:string[],hasView:boolean):ResearchResult{
 validate(researchSchema,value);const result=value as ResearchResult,allowed=new Set(urls.map(publicUrl));
 if(!result.summary.trim()||result.evidence.length>6)throw new Error('invalid_research');
 for(const e of result.evidence){e.source_url=publicUrl(e.source_url);if(!allowed.has(e.source_url)||!e.text.trim()||!e.scope.trim()||!e.limitations.trim()||!e.independence_group.trim())throw new Error('invalid_research_source');if(['author_statement','editor_statement'].includes(e.source_type)&&!e.speaker?.trim())throw new Error('missing_speaker');}
 if(result.proposal){if(!hasView||!result.proposal.text.trim()||!result.proposal.reason.trim()||!result.proposal.limits.trim()||!result.proposal.source_urls.length)throw new Error('invalid_research_proposal');result.proposal.source_urls=result.proposal.source_urls.map(publicUrl);if(result.proposal.source_urls.some(u=>!result.evidence.some(e=>e.source_url===u)))throw new Error('invalid_proposal_source');}
 return result;
}
