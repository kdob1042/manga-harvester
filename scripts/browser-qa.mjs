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
 if(!['index.html','app.js','style.css','favicon.svg'].includes(file))return new Response('missing',{status:404});
 return new Response(await readFile(new URL(`../public/${file}`,import.meta.url)),{headers:{'Content-Type':({'index.html':'text/html','app.js':'text/javascript','style.css':'text/css','favicon.svg':'image/svg+xml'})[file]}});
};
let draining=false;
async function drain(){if(draining)return;draining=true;try{while(f.sent.length){const {job_id}=f.sent.shift();await processJob(f.env,job_id,provider(x=>{
 const h=fixture(x.asset_labels[0]?.id,x.user_note||x.original_or_corrected_text);
 if(!x.asset_labels.some(a=>a.mime.startsWith('image/')))h.claims.forEach(c=>c.evidence=[{asset_id:null,quote:x.original_or_corrected_text,origin:'user',certainty:'explicit'}]);
 if(x.candidates.length){h.comparisons=[{target_id:x.candidates[0].id,kind:'shares_structure_with',shared_structure:'反応を先に提示する仕組みが共通している。',differences:'緊張と笑いでは、対象を明かした後の効果が異なる。',question:'どこから笑いに変わるのか？',claim_ids:['c1'],target_claim_ids:['c1']}];h.concepts[0].existing_id=x.concepts[0]?.id||null;}
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
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'artifacts/desktop-detail.png',fullPage:true});assertNoOverflow(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
 await page.locator('#back').click();await page.screenshot({path:'artifacts/desktop-feed.png',fullPage:true});await expect(page.locator('.primary:visible')).toHaveCount(1);
 await page.getByRole('button',{name:'取り込む'}).click();await page.locator('#capture-mode').selectOption('audio');await page.locator('#record-audio').click();await expect(page.locator('#capture-error')).not.toBeEmpty();await page.getByText('音声ファイルから残す',{exact:true}).click();await expect(page.locator('#audio-file')).toBeVisible();
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Browser QA passed: 390/1280px, one primary action, multi-photo + comment, paste, save/reload, original images, comparison, adoption/edit/history, microphone fallback, no overflow.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));f.sqlite.close();}
function assertNoOverflow(value){if(value)throw new Error('Horizontal overflow');}
