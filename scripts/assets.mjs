import {mkdir,copyFile,cp} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
const require=createRequire(import.meta.url),pdf=dirname(require.resolve('pdfjs-dist/package.json')),zip=resolve(dirname(require.resolve('fflate')),'..');
await mkdir('public/vendor',{recursive:true});
await Promise.all([
 copyFile(resolve(pdf,'build/pdf.mjs'),'public/vendor/pdf.mjs'),copyFile(resolve(pdf,'build/pdf.worker.mjs'),'public/vendor/pdf.worker.mjs'),
 copyFile(resolve(zip,'esm/browser.js'),'public/vendor/fflate.mjs'),
 ...['cmaps','standard_fonts','wasm'].map(name=>cp(resolve(pdf,name),`public/vendor/${name}`,{recursive:true})),
 copyFile(resolve(pdf,'LICENSE'),'public/vendor/pdf-LICENSE.txt'),copyFile(resolve(zip,'LICENSE'),'public/vendor/fflate-LICENSE.txt'),
]);
console.log('Prepared same-origin import libraries.');
