import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import worker from '../src/index.ts';
import {runtime,request} from './runtime.mjs';

test('Access protects static files and APIs; only a valid owner assertion replaces password sessions',async()=>{
 const {env,sqlite}=runtime();
 Object.assign(env,{AUTH_MODE:'cloudflare-access',ACCESS_TEAM_DOMAIN:'https://test-owner.cloudflareaccess.com',ACCESS_AUD:'manga-only',ACCESS_OWNER_EMAIL:'owner@example.com'});
 const {publicKey,privateKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey);
 Object.assign(jwk,{kid:'owner-test',alg:'RS256',use:'sig'});
 const actualFetch=globalThis.fetch;
 globalThis.fetch=async url=>{assert.equal(String(url),`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);return Response.json({keys:[jwk]});};
 const ctx={waitUntil(p){p.catch(()=>{});}};
 const sign=async(overrides={},key=privateKey)=>new SignJWT({email:'owner@example.com',...overrides})
  .setProtectedHeader({alg:'RS256',kid:'owner-test'}).setIssuer(overrides.iss??env.ACCESS_TEAM_DOMAIN)
  .setAudience(overrides.aud??env.ACCESS_AUD).setSubject('owner-id').setIssuedAt()
  .setExpirationTime(overrides.exp??'5m').sign(key);
 const send=(path,token,method='GET',body,extra={})=>worker.fetch(request(path,method,body,{'Cf-Access-Authenticated-User-Email':'owner@example.com',...(token?{'Cf-Access-Jwt-Assertion':token}:{}),...extra}),env,ctx);
 try{
  const passwordLogin=await import('../src/auth.ts').then(m=>m.login(request('/api/login','POST'),env,env.APP_PASSWORD));
  assert.equal(passwordLogin.status,404);
  for(const path of ['/','/app.js','/healthz','/api/state','/api/export','/api/assets/00000000-0000-0000-0000-000000000000'])assert.equal((await send(path,null)).status,401,path);
  const old='a'.repeat(64),hash=await import('../src/core.ts').then(m=>m.digest(old));
  sqlite.prepare('INSERT INTO sessions VALUES(?,?)').run(hash,Date.now()+60000);
  assert.equal((await send('/api/state',null,'GET',undefined,{cookie:`mh_session=${old}`})).status,401);
  const invalid=[await sign({email:'another@example.com'}),await sign({aud:'another-app'}),await sign({iss:'https://other.cloudflareaccess.com'}),await sign({exp:Math.floor(Date.now()/1000)-10}),'forged',await sign({},(await generateKeyPair('RS256')).privateKey)];
  for(const token of invalid)assert.equal((await send('/api/state',token)).status,401);
  const token=await sign();delete env.APP_PASSWORD;
  assert.equal((await send('/',token)).status,200);
  const state=await send('/api/state',token);assert.equal(state.status,200);assert.equal((await state.json()).auth_mode,'cloudflare-access');
  assert.equal((await send('/api/login',token,'POST',{password:'anything'})).status,404);
  const saved=await send('/api/captures',token,'POST',{text:'反応を先に見せるところが面白い'},{'Idempotency-Key':crypto.randomUUID()});assert.equal(saved.status,201);
  assert.equal((await send('/api/export',token)).status,200);
  const out=await send('/api/logout',token,'POST',{});assert.equal(out.status,200);assert.equal((await out.json()).logout_url,'/cdn-cgi/access/logout');assert.match(out.headers.get('set-cookie'),/Max-Age=0/);
  env.ACCESS_AUD='';assert.equal((await send('/',token)).status,401);
 }finally{globalThis.fetch=actualFetch;sqlite.close();}
});
