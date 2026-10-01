import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,unzipSync} from 'fflate';
import {archiveImages} from '../public/import.js';
import {cbz} from './import-fixtures.mjs';
import {runtime,png,request} from './runtime.mjs';import {saveCapture} from '../src/mutations.ts';import {getCapture} from '../src/core.ts';
test('archive inventory skips non-images and bounds expansion before decompression',()=>{
 const candidates=archiveImages(unzipSync,cbz);assert.equal(candidates.length,2);
 assert.deepEqual(Object.keys(unzipSync(cbz,{filter:e=>e.name===candidates[1].key})),['photos/two.png']);
 assert.throws(()=>archiveImages(unzipSync,zipSync({'../bad.png':new Uint8Array(20)})));
 assert.throws(()=>archiveImages(unzipSync,zipSync({'huge.png':new Uint8Array(9*1024*1024)})));
 assert.throws(()=>archiveImages(unzipSync,zipSync(Object.fromEntries(Array.from({length:121},(_,i)=>[`${i}.png`,new Uint8Array(12)])))));
});
test('selected conversion keys and source fingerprint commit atomically with the corresponding photos',async()=>{
 const {env,sqlite}=runtime(),key=crypto.randomUUID(),receipt={source_hash:'a'.repeat(64),source_name:'photos.cbz',source_size:cbz.length,format:'zip',conversion_keys:['photos/two.png']};
 const upload=()=>{const f=new FormData();f.append('file',new File([png],'chosen.png',{type:'image/png'}));f.set('import_receipt',JSON.stringify(receipt));return request('/capture','POST',f,{'Idempotency-Key':key});};
 const saved=await (await saveCapture(upload(),env)).json();await saveCapture(upload(),env);const capture=await getCapture(env,saved.id);
 assert.equal(capture.assets.length,1);assert.equal(capture.imports.length,1);assert.equal(capture.imports[0].asset_id,capture.assets[0].id);assert.equal(capture.imports[0].conversion_key,'photos/two.png');assert.equal(sqlite.prepare('SELECT count(*) n FROM capture_imports').get().n,1);
 receipt.conversion_keys=['photos/one.png'];await assert.rejects(saveCapture(upload(),env),e=>e.status===409);
});
