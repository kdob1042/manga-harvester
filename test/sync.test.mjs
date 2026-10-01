import test from 'node:test';import assert from 'node:assert/strict';
import worker from '../src/index.ts';import {runtime,imageRequest,request} from './runtime.mjs';import {saveCapture} from '../src/mutations.ts';
test('deleted records cannot be resurrected by an old create or supplement request',async()=>{
 const {env,sqlite}=runtime(),key=crypto.randomUUID(),{id}=await (await saveCapture(imageRequest('before',1,key),env)).json();
 const login=await worker.fetch(request('/api/login','POST',{password:env.APP_PASSWORD}),env,{waitUntil(){}}),Cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await worker.fetch(request(`/api/captures/${id}`,'DELETE',{version:2},{Cookie}),env,{waitUntil(){}})).status,409);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM retired_requests').get().n,0);
 assert.equal((await worker.fetch(request(`/api/captures/${id}`,'DELETE',{version:1},{Cookie}),env,{waitUntil(){}})).status,200);
 await assert.rejects(saveCapture(imageRequest('before',1,key),env),e=>e.status===410);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM captures').get().n,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM capture_tombstones').get().n,1);
});
