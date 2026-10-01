import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,unzipSync} from 'fflate';
import {archiveImages} from '../public/import.js';
import {cbz} from './import-fixtures.mjs';
test('archive inventory skips non-images and bounds expansion before decompression',()=>{
 const candidates=archiveImages(unzipSync,cbz);assert.equal(candidates.length,2);
 assert.deepEqual(Object.keys(unzipSync(cbz,{filter:e=>e.name===candidates[1].key})),['photos/two.png']);
 assert.throws(()=>archiveImages(unzipSync,zipSync({'../bad.png':new Uint8Array(20)})));
 assert.throws(()=>archiveImages(unzipSync,zipSync({'huge.png':new Uint8Array(9*1024*1024)})));
 assert.throws(()=>archiveImages(unzipSync,zipSync(Object.fromEntries(Array.from({length:121},(_,i)=>[`${i}.png`,new Uint8Array(12)])))));
});
