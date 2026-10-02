import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { digest,stmt,now } from './core.ts';

export const usesAccess=(env:Env)=>env.AUTH_MODE==='cloudflare-access';
const keySets=new Map<string,ReturnType<typeof createRemoteJWKSet>>();
export async function accessLoggedIn(request:Request,env:Env,ctx?:ExecutionContext) {
 if(!env.ACCESS_AUD||!env.ACCESS_OWNER_EMAIL)return false;
 if(ctx?.access){
  if(ctx.access.aud!==env.ACCESS_AUD)return false;
  try{const identity=await ctx.access.getIdentity();if(identity?.email)return identity.email.toLowerCase()===env.ACCESS_OWNER_EMAIL.toLowerCase();}catch{/* Verify the application cookie when runtime identity is unavailable. */}
 }
 // Static Assets' internal router does not forward ctx.access. Verify the
 // signed Access assertion, never the unsigned authenticated-email header.
 const token=request.headers.get('Cf-Access-Jwt-Assertion')||/(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('cookie')||'')?.[1];
 if(!token||!env.ACCESS_AUD||!env.ACCESS_OWNER_EMAIL||!env.ACCESS_TEAM_DOMAIN)return false;
 try{
  const issuer=new URL(env.ACCESS_TEAM_DOMAIN);
  if(issuer.protocol!=='https:'||!issuer.hostname.endsWith('.cloudflareaccess.com')||issuer.pathname!=='/'||issuer.search||issuer.hash||issuer.port||issuer.username||issuer.password)return false;
  const origin=issuer.origin;
  let keys=keySets.get(origin);
  if(!keys){keys=createRemoteJWKSet(new URL(`${origin}/cdn-cgi/access/certs`));keySets.set(origin,keys);}
  const {payload}=await jwtVerify(token,keys,{issuer:origin,audience:env.ACCESS_AUD,algorithms:['RS256'],requiredClaims:['exp','sub','email']});
  return typeof payload.email==='string'&&payload.email.toLowerCase()===env.ACCESS_OWNER_EMAIL.toLowerCase();
 }catch{return false;}
}
export async function loggedIn(request:Request,env:Env) {
 if(usesAccess(env))return accessLoggedIn(request,env);
 const token=/(?:^|;\s*)mh_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('cookie')||'')?.[1];
 return token ? Boolean(await stmt(env,'SELECT hash FROM sessions WHERE hash=? AND expires>?',await digest(token),now()).first()) : false;
}
export async function login(request:Request,env:Env,password:unknown) {
 if(usesAccess(env))return {status:404,error:'Cloudflareでログインしてください。'};
 if (!env.APP_PASSWORD||env.APP_PASSWORD.length<16) return {status:503,error:'ログインの設定を確認してください。'};
 const address=await digest(request.headers.get('CF-Connecting-IP')||'local');
 const count=await stmt(env,`INSERT INTO login_limits(address,count,reset_at) VALUES(?,1,?)
 ON CONFLICT(address) DO UPDATE SET count=CASE WHEN reset_at>? THEN count+1 ELSE 1 END,
 reset_at=CASE WHEN reset_at>? THEN reset_at ELSE excluded.reset_at END RETURNING count`,address,now()+900000,now(),now()).first<{count:number}>();
 if ((count?.count||0)>8) return {status:429,error:'少し待ってからお試しください。'};
 const [a,b]=await Promise.all([digest(typeof password==='string'?password.slice(0,1000):''),digest(env.APP_PASSWORD)]);
 if(!timingSafeEqual(new TextEncoder().encode(a),new TextEncoder().encode(b))) return {status:401,error:'パスワードを確認してください。'};
 const token=Array.from(crypto.getRandomValues(new Uint8Array(32))).map(n=>n.toString(16).padStart(2,'0')).join('');
 await env.DB.batch([stmt(env,'DELETE FROM login_limits WHERE address=?',address),stmt(env,'DELETE FROM sessions WHERE expires<=?',now()),stmt(env,'INSERT INTO sessions VALUES(?,?)',await digest(token),now()+604800000)]);
 return {status:200,cookie:`mh_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${new URL(env.APP_ORIGIN).protocol==='https:'?'; Secure':''}`};
}
export async function logout(request:Request,env:Env) {
 const token=/(?:^|;\s*)mh_session=([a-f0-9]{64})/.exec(request.headers.get('cookie')||'')?.[1];
 if(token) await stmt(env,'DELETE FROM sessions WHERE hash=?',await digest(token)).run();
 return `mh_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${env.APP_ORIGIN.startsWith('https:')?'; Secure':''}`;
}
