import {processResearch} from '../src/research.ts';
import {researchProvider} from '../test/research-fixtures.mjs';
import {cbz,pdfFixture} from '../test/import-fixtures.mjs';
// Real UI + API + SQLite storage + queue consumer. The provider response is injected,
// so this check never claims to verify actual model quality or incur API costs.
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import worker from '../src/index.ts';
import {processJob} from '../src/queue.ts';
import {runtime,fixture,provider,png} from '../test/runtime.mjs';
const f=runtime(),origin='http://localhost:8793';f.env.APP_ORIGIN=origin;
f.env.ASSETS.fetch=async r=>{
 const pathname=new URL(r.url).pathname,file=pathname==='/'?'index.html':pathname.slice(1);
 if(file.includes('..')||!['index.html','app.js','style.css','favicon.svg','local.js','import.js','offline.js','sw.js','manifest.webmanifest'].includes(file)&&!file.startsWith('vendor/'))return new Response('missing',{status:404});
 return new Response(await readFile(new URL(`../public/${file}`,import.meta.url)),{headers:{'Content-Type':file.endsWith('.mjs')||file.endsWith('.js')?'text/javascript':({'index.html':'text/html','style.css':'text/css','favicon.svg':'image/svg+xml'})[file]||'application/octet-stream'}});
};
let draining=false;
async function drain(){if(draining)return;draining=true;try{while(f.sent.length){const {job_id,research_id}=f.sent.shift();if(research_id){await processResearch(f.env,research_id,researchProvider());continue;}await processJob(f.env,job_id,provider(x=>{
 const h=fixture(x.asset_labels[0]?.id,x.user_note||x.original_or_corrected_text);
 if(!x.asset_labels.some(a=>a.mime.startsWith('image/')))h.claims.forEach(c=>c.evidence=[{asset_id:null,quote:x.original_or_corrected_text,origin:'user',certainty:'explicit'}]);
 if(x.candidates.length){h.comparisons=[{target_id:x.candidates[0].id,kind:'shares_structure_with',shared_structure:'反応を先に提示する仕組みが共通している。',differences:'緊張と笑いでは、対象を明かした後の効果が異なる。',question:'どこから笑いに変わるのか？',claim_ids:['c1'],target_claim_ids:['c1']}];h.concepts[0].existing_id=x.concepts[0]?.id||null;}
 if(x.views.length)h.view_proposals=[{view_id:x.views[0].id,base_revision:x.views[0].version,text:'反応を先に見せる演出は、対象が未知のときに効きそう。笑いと緊張では明かし方も異なる。',reason:'別のメモとの比較から条件を加えた。',claim_ids:['c2']}];
 return h;
 }));}}finally{draining=false;}}
const server=createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks),tasks=[];
  const request=new Request(origin+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{})});
  const response=await worker.fetch(request,f.env,{waitUntil(p){tasks.push(p);}});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  await Promise.all(tasks);await drain();
 }catch(e){console.error('QA server failure',e.message);if(!res.headersSent)res.writeHead(500);res.end('QA failure');}
});
await new Promise(resolve=>server.listen(8793,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--single-process','--in-process-gpu','--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist']}:{})});
const errors=[];
const realFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>{
 if(String(url).startsWith('https://api.openai.com/')){
  const body=JSON.parse(init.body);if(body.text?.format?.name!=='manga_search_v1')throw new Error('Unexpected outbound API in browser QA');
  const c=JSON.parse(body.input).candidates[0];return Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({matches:[{capture_id:c.id,version:c.version,node_id:'c2',reason:'待たせる体験と、反応の先行提示が関連する',quote:'対象への疑問が生まれる'}]})}]}]});
 }
 return realFetch(url,init);
};
try{
 await mkdir('artifacts',{recursive:true});
 const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.locator('#password').fill(f.env.APP_PASSWORD);await page.getByRole('button',{name:'開く',exact:true}).click();
 await expect(page.getByRole('button',{name:'取り込む'})).toBeVisible();await expect(page.locator('.primary:visible')).toHaveCount(1);
 await page.screenshot({path:'artifacts/mobile-empty.png',fullPage:true});
 await page.getByRole('button',{name:'取り込む'}).click();await page.locator('#image-note').fill('この無言の反応が好き');
 await expect(page.getByRole('dialog').locator('.primary:visible')).toHaveCount(1);await page.screenshot({path:'artifacts/mobile-import.png',fullPage:true});
 await page.locator('#image-file').setInputFiles([{name:'reaction.png',mimeType:'image/png',buffer:png},{name:'reveal.png',mimeType:'image/png',buffer:png}]);
 await expect(page.getByRole('dialog')).not.toBeVisible();await page.reload();
 await expect(page.getByRole('button',{name:/反応を先に見せる/})).toBeVisible();await page.getByRole('button',{name:/反応を先に見せる/}).click();
 await expect(page.getByRole('button',{name:'自分の漫画観にする'})).toBeVisible();await expect(page.locator('.photo-strip img')).toHaveCount(2);await expect(page.locator('.primary:visible')).toHaveCount(1);
 await expect(page.getByText('この無言の反応が好き',{exact:true})).toBeVisible();
 assertNoOverflow(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
 await page.screenshot({path:'artifacts/mobile-detail.png',fullPage:true});
 await page.getByRole('button',{name:'自分の漫画観にする'}).click();await expect(page.getByText('自分の漫画観 · 第1版',{exact:true})).toBeVisible();
 await page.getByText('見方を編集・履歴を読む',{exact:true}).click();await page.getByRole('button',{name:'見方を編集する',exact:true}).click();
 await page.locator('#view-body').fill('反応を先に見せる演出は、情報不足の条件で効きそう。');await page.locator('#view-reason').fill('効く条件を加えた。');await page.getByRole('button',{name:'見方を更新する'}).click();await expect(page.getByText('自分の漫画観 · 第2版',{exact:true})).toBeVisible();
 await page.locator('#back').click();await page.getByRole('button',{name:'取り込む'}).click();await page.locator('#image-note').fill('対象を後で見せるところが面白い');
 // Exercise the real paste handler with a file, without mocking API requests.
 await page.evaluate(base64=>{const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),data=new DataTransfer();data.items.add(new File([bytes],'pasted.png',{type:'image/png'}));document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},png.toString('base64'));
 await expect(page.getByRole('dialog')).not.toBeVisible();await page.reload();await expect(page.locator('.capture-row')).toHaveCount(2);
 await page.locator('.capture-row').first().click();await expect(page.getByText('以前のメモとのつながり',{exact:true})).toBeVisible();await page.screenshot({path:'artifacts/mobile-comparison.png',fullPage:true});
 await expect(page.getByRole('button',{name:'この見方に更新',exact:true})).toBeVisible();await expect(page.locator('.primary:visible')).toHaveCount(1);
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'artifacts/desktop-detail.png',fullPage:true});assertNoOverflow(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
 await page.getByRole('button',{name:'この見方に更新',exact:true}).click();await expect(page.getByText('自分の漫画観 · 第3版',{exact:true})).toBeVisible();
 await page.locator('#back').click();await page.screenshot({path:'artifacts/desktop-feed.png',fullPage:true});await expect(page.locator('.primary:visible')).toHaveCount(1);
 await page.getByRole('button',{name:'取り込む'}).click();await page.locator('#capture-mode').selectOption('audio');await page.locator('#record-audio').click();await expect(page.locator('#capture-error')).not.toBeEmpty();await page.getByText('音声ファイルから残す',{exact:true}).click();await expect(page.locator('#audio-file')).toBeVisible();
 await page.locator('#close-dialog').click();
 await page.getByRole('button',{name:'取り込む'}).click();await page.locator('#capture-mode').selectOption('import');
 await page.locator('#import-file').setInputFiles({name:'photos.cbz',mimeType:'application/zip',buffer:Buffer.from(cbz)});
 await expect(page.locator('.import-grid img')).toHaveCount(2);await page.locator('[data-import-key]').first().check();
 await page.locator('#save-import').click();await expect(page.getByRole('dialog')).not.toBeVisible();await page.reload();await expect(page.locator('.capture-row')).toHaveCount(3);
 await page.locator('.capture-row').first().click();await expect(page.locator('.photo-strip img')).toHaveCount(1);await page.locator('#back').click();
 await page.getByRole('button',{name:'取り込む'}).click();await page.locator('#capture-mode').selectOption('import');
 await page.locator('#import-file').setInputFiles({name:'shapes.pdf',mimeType:'application/pdf',buffer:pdfFixture()});
 await expect(page.locator('.import-grid img')).toHaveCount(2).catch(async e=>{console.error('PDF import:',await page.locator('#capture-error').innerText());throw e;});await page.locator('[data-import-key]').last().check();
 await page.locator('#save-import').click();await expect(page.getByRole('dialog')).not.toBeVisible();await page.reload();await expect(page.locator('.capture-row')).toHaveCount(4);
 await page.locator('.capture-row').first().click();await expect(page.locator('.photo-strip img')).toHaveCount(1);
 await page.locator('#back').click();
 await page.evaluate(()=>navigator.serviceWorker.ready);await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBeTruthy();
 await page.context().setOffline(true);await page.getByRole('button',{name:'取り込む'}).click();await page.locator('#capture-mode').selectOption('image');
 await page.locator('#image-note').fill('圏外で残す、この反応が好き');await page.locator('#image-file').setInputFiles({name:'offline.png',mimeType:'image/png',buffer:png});
 await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.locator('.device-pending')).toHaveCount(1);
 await page.reload();await expect(page.locator('.device-pending')).toHaveCount(1);await expect(page.getByText('圏外 · 新しいメモは端末内に残します。',{exact:true})).toBeVisible();
 await page.context().setOffline(false);await expect(page.locator('.device-pending')).toHaveCount(0,{timeout:15000});await expect(page.locator('.capture-row')).toHaveCount(5);
 // The server accepted the original; only the response is lost. Automatic
 // replay must not create a second capture or a second analysis job.
 await page.route('**/api/captures',async route=>{await route.fetch();await route.abort();},{times:1});
 await page.getByRole('button',{name:'取り込む'}).click();await page.locator('#image-note').fill('通信応答だけ失われたメモ');
 await page.locator('#image-file').setInputFiles({name:'lost-response.png',mimeType:'image/png',buffer:png});await expect(page.getByRole('dialog')).not.toBeVisible();
 await expect.poll(()=>f.sqlite.prepare('SELECT count(*) n FROM captures').get().n).toBe(6);
 await expect(page.locator('.device-pending')).toHaveCount(0,{timeout:15000});assertNoOverflow(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
 if(f.sqlite.prepare('SELECT count(*) n FROM jobs').get().n!==6)throw new Error('Duplicate analysis jobs after replay');
 await expect(page.locator('.capture-row')).toHaveCount(6);await page.screenshot({path:'artifacts/desktop-reflection.png',fullPage:true});
 await page.locator('.capture-row').first().click();await page.locator('#local-graph summary').click();await expect(page.locator('.graph-node')).toHaveCount(5);
 await page.locator('[data-concept]').first().click();await expect(page.getByRole('dialog')).toBeVisible();await page.locator('#close-dialog').click();
 await page.locator('#external-materials summary').first().click();await page.locator('#start-research').click();await page.locator('#research-question').fill('公開資料による反応先行の別解釈');
 await page.locator('#research-view').selectOption({index:1});await page.locator('#research-form button').click();await expect(page.getByRole('dialog')).not.toBeVisible();
 await page.reload();await page.locator('.capture-row').first().click();await page.locator('#external-materials summary').first().click();
 await expect(page.locator('[data-adopt-research]')).toBeVisible();await page.locator('[data-adopt-research]').click();await expect(page.getByText('自分の漫画観 · 第4版',{exact:true})).toBeVisible();
 await page.locator('#back').click();await page.locator('.menu summary').click();await page.locator('#search').fill('先が知りたくて待たされる');await page.locator('#search').press('Enter');
 await expect(page.getByText(/AIによる関連づけ：待たせる体験/)).toBeVisible();await page.locator('.capture-row').first().click();await expect(page.locator('.photo-strip img')).toHaveCount(1);await page.locator('#back').click();
 // Continue with the unselected photo from the same archive.
 await page.locator('.menu summary').click();await page.locator('#search').fill('');await page.locator('#search').press('Tab');await page.waitForTimeout(400);await page.locator('.menu summary').click();
 await page.getByRole('button',{name:'取り込む'}).click();await page.locator('#capture-mode').selectOption('import');
 await page.locator('[data-resume-import]').filter({hasText:'photos.cbz'}).click();await expect(page.locator('.import-grid img')).toHaveCount(2);
 await expect(page.locator('[data-import-key]').first()).toBeDisabled();await page.locator('[data-import-key]').last().check();await page.locator('#save-import').click();await expect(page.getByRole('dialog')).not.toBeVisible();
 await page.reload();await expect(page.locator('.capture-row')).toHaveCount(7);await page.locator('.capture-row').first().click();
 await expect(page.locator('.photo-strip img')).toHaveCount(1);await page.getByText('原資料・訂正など',{exact:true}).click();await expect(page.getByText(/取り込み元：photos.cbz/)).toBeVisible();
 // Access may return an HTML 401, rather than app JSON, when a session expires.
 // Verify the UI preserves the outbox and shows SSO, without a password form.
 await page.evaluate(async()=>{
  const {localGet,localPut}=await import('/local.js');const session=await localGet('meta','session');
  for(const [id,status] of [['auth-expired',401],['version-conflict',409]])await localPut('outbox',{id,key:id,instance_id:session.instance_id,created_at:Date.now(),files:[],note:'未送信の一言',error:{status,blocked:true}});
 });
 await page.route('**/api/state**',async route=>{
  if(route.request().headers()['x-requested-with']!=='XMLHttpRequest')throw new Error('Missing Access AJAX header');
  await route.fulfill({status:401,contentType:'text/html',body:'Access session expired'});
 });
 await page.reload();await expect(page.getByRole('button',{name:'Cloudflareで開く',exact:true})).toBeVisible();await expect(page.locator('#password')).toHaveCount(0);
 const retained=await page.evaluate(async()=>{
  const {localGet}=await import('/local.js');const {offlineState,rememberState,pendingUploads}=await import('/offline.js');
  if(await offlineState())throw new Error('Expired session remains active');
  const saved=(await localGet('meta','state')).value;await rememberState({...saved,auth_mode:'cloudflare-access'});
  return (await pendingUploads()).map(p=>({id:p.id,error:p.error}));
 });
 if(retained.find(p=>p.id==='auth-expired')?.error!==null||retained.find(p=>p.id==='version-conflict')?.error?.status!==409)throw new Error('Reauthentication must resume only auth failures');
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Browser QA passed: 390/1280px, one primary action, multi-photo + comment, paste, save/reload, original images, comparison, adoption/edit/history, microphone fallback, no overflow.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));f.sqlite.close();}
function assertNoOverflow(value){if(value)throw new Error('Horizontal overflow');}
