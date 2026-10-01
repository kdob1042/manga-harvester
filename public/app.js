import {rememberState,offlineState,lockDevice,pendingFailure,pendingUploads,queueUpload,sendUpload,syncUploads,removePending,retryPending,downloadLocal,forgetDevice} from './offline.js';
import {openImport,selectImport,importFiles,finishImport,pendingImports,removeImport} from './import.js';
const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#notice');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const date = value => new Intl.DateTimeFormat('ja-JP', { month:'short', day:'numeric', timeZone:'Asia/Tokyo' }).format(new Date(value));
const $ = selector => document.querySelector(selector);
let state, currentCapture = null, currentView = null, query = '', recorder = null, stream = null, uploading = false, uploadPending = null;
let noticeTimer, searchTimer, pollBusy = false;
const shownReflections = new Set();
let importController=null, importURLs=[];
function stopImport(){importController?.abort();importController=null;importURLs.forEach(u=>URL.revokeObjectURL(u));importURLs=[];}
const errors = {
  ai_not_configured:'原資料は保存済みです。AI設定後に自動で読み取ります。',
  daily_limit:'原資料は保存済みです。今日の解析上限に達しました。明日、自動で続けます。',
  invalid_output:'読み取り結果を確認できませんでした。原資料は残っています。',
  empty_transcript:'音声を読み取れませんでした。原音声は残っています。',
  refused:'この資料は解析できませんでした。原資料は残っています。',
  incomplete_output:'解析結果が途中で止まりました。原資料は残っています。',
  provider_rejected:'解析の設定を確認する必要があります。原資料は残っています。',
};
const statusLabel = c => ({ completed:'', pending:'読み取り待ち', running:'読み取り中', failed:'読み取りできませんでした', blocked:c.error_code === 'daily_limit' ? '明日読み取り' : '保存済み・AI設定待ち', superseded:'新しい版を読み取り中' })[c.state || c.job?.state] || '';
const bind = (selector, event, fn) => $(selector)?.addEventListener(event, fn);

function showNotice(text) {
  clearTimeout(noticeTimer); notice.textContent = text;
  noticeTimer = setTimeout(() => { notice.textContent = ''; }, 4500);
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials:'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || '通信を確認して、もう一度お試しください。');
    error.status = response.status;
    if (response.status === 401 && path !== '/api/login') { await lockDevice(); closeDialog(); login(); }
    throw error;
  }
  return data;
}
const json = (method, data) => ({ method, headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(data) });

function login() {
  currentCapture = null; currentView = null; state = null;
  app.innerHTML = `<div class="login"><p class="eyebrow">MANGA HARVESTER</p><h1>面白さのメモ。</h1>
    <form id="login-form"><label><span>パスワード</span><input id="password" type="password" required autocomplete="current-password"></label>
    <p id="login-error" class="error" role="alert"></p><button class="primary" type="submit">開く</button></form></div>`;
  app.removeAttribute('aria-busy');
  bind('#login-form', 'submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { await api('/api/login', json('POST', { password:$('#password').value })); await home(); }
    catch (error) { $('#login-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
}

function header(record = true) {
  return `<header class="top"><div class="brand"><img src="/favicon.svg" alt="">Manga Harvester</div><div class="top-actions">
    ${record ? '<button id="record" class="primary">取り込む<span aria-hidden="true">＋</span></button>' : ''}
    <details class="menu"><summary aria-label="メニュー">···</summary><div class="menu-panel">
    <label><span>記録を検索</span><input id="search" type="search" placeholder="一言・表現・仕組みから" value="${esc(query)}"></label>
    <button id="privacy">AIと保存について</button><a href="/api/export" download>すべて書き出す</a>
    <button id="logout">閉じる</button></div></details></div></header>`;
}
function wireHeader() {
  bind('#record', 'click', () => recordDialog());
  bind('#search', 'input', event => {
    query = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try { state = await api(`/api/state?q=${encodeURIComponent(query)}`); renderFeed(); }
      catch (error) { showNotice(error.message); }
    }, 300);
  });
  bind('#privacy', 'click', privacyDialog);
  bind('#logout', 'click', logoutDevice);
}

async function home() {
  let next;
  try {next = await api(`/api/state?q=${encodeURIComponent(query)}`);if(!query)await rememberState(next);}
  catch(e){if(e.status)throw e;next=await offlineState();if(!next)throw e;next={...next,offline:true};}
  next.device_pending=await pendingUploads();
  state = next; currentCapture = null; currentView = null;
  app.innerHTML = `${header()}<section class="intro"><p class="eyebrow">MANGA HARVESTER</p>
    <h1>面白さのメモ。</h1><p>${'写真と一言から、面白さを言葉に。'}</p></section><section id="feed"></section>`;
  app.removeAttribute('aria-busy'); wireHeader(); renderFeed();
}
function renderFeed() {
  if (!$('#feed')) return;
  const captures = state.captures;
  $('#feed').innerHTML = `${pendingHTML()}${reflectionHTML()}${captures.length ? '<p class="section-label">写真から育った知見</p>' : ''}${captures.map(c => {
    const summary = c.harvest?.summary || c.original_preview || (c.kind === 'scene' ? '残した写真・音声' : '残した一言');
    const label = statusLabel(c);
    return `<button class="capture-row" data-capture="${c.id}"><span class="row-meta"><span>${c.source_certainty === 'inferred' ? '推定 ' : ''}${esc(c.source_title || '作品名なし')}${c.source_inherited ? '（直前の作品）' : ''}</span><span>${date(c.created_at)}</span></span>
      <h2>${esc(summary)}</h2>${c.search_reason?`<p class="subtle">${esc(c.search_reason)}：${esc(c.search_evidence)}</p>`:''}${label ? `<span class="status ${esc(c.state)}">${esc(label)}</span>` : `<p class="question-preview">${esc(c.harvest?.questions[0]?.text || '原資料と、考えの続きを読む。')}</p>`}</button>`;
  }).join('')}${!captures.length ? `<div class="empty"><img class="empty-symbol" src="/favicon.svg" alt=""><h2>${query ? 'その言葉は、まだ見つかりません。' : '最初の一枚から、育っていきます。'}</h2><p>${query ? '別の言葉で探してみてください。' : '写真と、どこがどう面白いかの一言から。'}</p></div>` : ''}
    ${state.views.length && !query ? `<p class="section-label">自分の漫画観</p>${state.views.map(v => `<button class="view-row" data-view="${v.id}"><span class="row-meta">自分の漫画観 · 第${v.version}版</span><h2>${esc(v.body)}</h2></button>`).join('')}` : ''}`;
  wirePending();wireReflection();
  document.querySelectorAll('[data-capture]').forEach(el => el.addEventListener('click', () => openCapture(el.dataset.capture).catch(e => showNotice(e.message))));
  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => openView(el.dataset.view).catch(e => showNotice(e.message))));
}

function pendingHTML() {
  return `${state.offline?'<p class="status">圏外 · 新しいメモは端末内に残します。</p>':''}${(state.device_pending||[]).map(p=>`<button class="capture-row device-pending" data-pending="${p.id}"><span class="row-meta">端末内保存 · ${p.error?'送信の確認が必要':'接続後に送信待ち'}</span><h2>${esc(p.note||p.text||'残した写真・音声')}</h2>${p.error?`<p class="subtle">${esc(p.error.message)}</p>`:''}</button>`).join('')}`;
}
function wirePending(){document.querySelectorAll('[data-pending]').forEach(el=>el.addEventListener('click',()=>pendingDialog(el.dataset.pending).catch(e=>showNotice(e.message))));}
async function pendingDialog(id){
  const p=(await pendingUploads()).find(p=>p.id===id);if(!p)return;
  stopImport();const urls=p.files.map(f=>({url:URL.createObjectURL(f),mime:f.type}));importURLs=urls.map(f=>f.url);
  modal('端末内に残したメモ',`<p>${esc(p.note||p.text||'')}</p><div class="photo-strip">${urls.filter(f=>f.mime.startsWith('image/')).map(f=>`<img src="${f.url}" alt="送信待ちの写真">`).join('')}</div>${urls.filter(f=>f.mime.startsWith('audio/')).map(f=>`<audio controls src="${f.url}"></audio>`).join('')}
    <p class="subtle">${esc(p.error?.message||'接続が戻ると、同じ保存操作として一度だけ送信します。')}<br>サーバー保存・AI分析はまだ完了していません。</p>
    ${p.error?.status===409&&p.target?'<button id="rebase-pending" class="quiet">最新の記録を確認して追記する</button>':''}
    <button id="export-local" class="quiet">端末内の原資料を書き出す</button><details class="fold"><summary>この送信待ちを削除する</summary><p>端末内の写真・音声・文章を削除します。</p><button id="remove-pending" class="quiet">この端末から削除する</button></details>`);
  bind('#export-local','click',()=>downloadLocal().catch(e=>showNotice(e.message)));
  bind('#remove-pending','click',async()=>{await removePending(p.id);closeDialog();await home();});
  bind('#rebase-pending','click',async()=>{
    try{const fresh=await api(`/api/captures/${p.target.id}`);modal('追記先の現在の内容',`<p>${esc(fresh.note||fresh.original_text||fresh.harvest?.summary||'写真のメモ')}</p><p>第${p.target.version}版から第${fresh.version}版に更新されています。端末内の一言と写真を、この内容に追記します。</p><button id="confirm-rebase" class="primary">この内容に追記する</button>`);
      bind('#confirm-rebase','click',async()=>{await retryPending(p.id,fresh);await syncUploads(api,state.instance_id);closeDialog();await home();});
    }catch(e){showNotice(e.message);}
  });
}
async function logoutDevice(){
  const pending=await pendingUploads(),imports=await pendingImports();
  const finish=async()=>{
    // Revoke the server session before clearing local data. Offline logout is
    // deferred rather than leaving an authenticated cookie that reopens later.
    try{await api('/api/logout',json('POST',{}));await forgetDevice();closeDialog();login();}catch(e){showNotice('接続してから閉じてください。端末内のメモは残っています。');}
  };
  if(pending.length||imports.length){
    modal('保存待ちのメモがあります',`<p>送信待ち${pending.length}件、変換候補${imports.length}件が端末内に残っています。閉じると、この端末の原資料を削除します。</p><button id="logout-export" class="quiet">先に端末内の原資料を書き出す</button><button id="logout-discard" class="primary">端末内のデータを削除して閉じる</button>`);
    bind('#logout-export','click',()=>downloadLocal().catch(e=>showNotice(e.message)));bind('#logout-discard','click',finish);
  }else await finish();
}

function reflectionHTML() {
  const r = !query && state.reflection;
  if (!r) return '';
  const x = r.data.comparison;
  return `<aside class="reflection"><div class="reflection-head"><p class="section-label">あとで、考えの続きを</p><button id="dismiss-reflection" class="quiet" aria-label="この振り返りを見送る">×</button></div>
    ${r.data.user_words.length ? `<blockquote>${r.data.user_words.map(esc).join(' ／ ')}</blockquote>` : ''}
    <p>${esc(x.shared_structure)}</p><p class="subtle">${esc(x.differences)}</p>
    ${r.data.target_words.length ? `<p class="subtle">以前の自分の一言：${r.data.target_words.map(esc).join(' ／ ')}</p>` : '<p class="subtle">以前のメモへの好き・嫌いは、まだ不明です。</p>'}
    <p>${esc(x.question)}</p>${(r.data.counterfactuals || []).map(f => `<details class="fold"><summary>もし変えるなら（仮想比較）</summary><p>${esc(f.change)}</p><p>${esc(f.possible_effect)}</p><p class="subtle">未実験の仮説 · ${esc(f.limits)}</p></details>`).join('')}
    <a href="#" id="revisit-record">以前の写真と一言へ戻る</a> · <a href="#" id="reflection-record">今回のメモを読む</a>
    ${r.changes.map(v => `<p class="subtle">漫画観は第${v.version}版へ：${esc(v.reason)}</p>`).join('')}</aside>`;
}
function wireReflection() {
  const r = !query && state.reflection;
  if (!r) return;
  if (!shownReflections.has(r.id)) { shownReflections.add(r.id); api(`/api/reflections/${r.id}`, json('POST', {action:'shown'})).catch(() => shownReflections.delete(r.id)); }
  bind('#dismiss-reflection','click',async () => { try { await api(`/api/reflections/${r.id}`, json('POST',{action:'dismissed'})); state.reflection=null; renderFeed(); } catch(e) { showNotice(e.message); } });
  bind('#revisit-record','click',async e => {e.preventDefault();try {await api(`/api/reflections/${r.id}`, json('POST',{action:'opened'}));await openCapture(r.target_id);}catch(e){showNotice(e.message);}});
  bind('#reflection-record','click',e => {e.preventDefault();openCapture(r.capture_id).catch(e=>showNotice(e.message));});
}

function modal(title, body) {
  dialog.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button id="close-dialog" class="quiet" aria-label="閉じる">×</button></div>${body}`;
  if (!dialog.open) dialog.showModal();
  bind('#close-dialog', 'click', closeDialog);
}
function stopRecorder() {
  const previous = recorder; recorder = null;
  if (previous?.state === 'recording') previous.stop();
  stream?.getTracks().forEach(t => t.stop()); stream = null;
}
function closeDialog() {
  if (uploading) return;
  stopRecorder(); stopImport(); dialog.close();
}
dialog.addEventListener('cancel', event => { if (uploading) event.preventDefault(); else {stopRecorder();stopImport();} });

function getMode() { try { return localStorage.getItem('capture-mode') || 'image'; } catch { return 'image'; } }
function setMode(mode) { try { localStorage.setItem('capture-mode', mode); } catch { /* device preferences are optional */ } }

function recordDialog(target = null) {
  uploadPending = null;
  const mode = ['image','audio','text','import'].includes(getMode()) ? getMode() : 'image';
  modal(target ? '一言・写真を足す' : '写真と一言を残す', `<label><span>残し方</span><select id="capture-mode" class="capture-mode">
    <option value="image">写真</option><option value="audio">音声</option><option value="text">一言</option><option value="import">PDF・ZIP/CBZ</option></select></label>
    <div id="capture-body" class="capture-body"></div><p id="capture-error" class="error" role="alert"></p>
    <p class="subtle">${target ? 'いま開いている記録に追加します。' : '保存したら、そのまま読書へ。読み取りは続きます。'}</p>`);
  $('#capture-mode').value = mode;
  const render = () => {
    stopRecorder(); stopImport(); setMode($('#capture-mode').value);
    const selected = $('#capture-mode').value;
    $('#capture-error').textContent = '';
    if (selected === 'image') {
      $('#capture-body').innerHTML = `<label><span>どこがどう面白い？（任意）</span><textarea id="image-note" placeholder="この無言の反応が好き。" maxlength="20000"></textarea></label><input id="image-file" type="file" accept="image/jpeg,image/png,image/webp" multiple><button id="pick-image" class="primary">写真を貼る・選ぶ</button><p>ここへ貼り付け・ドロップもできます。<br>8枚まで、合計20MB。JPEG・PNG・WebP。</p>`;
      bind('#pick-image', 'click', () => $('#image-file').click());
      bind('#image-file', 'change', event => { if (event.target.files[0]) saveUpload(Array.from(event.target.files), null, target, null, $('#image-note')?.value || ''); });
    } else if (selected === 'audio') {
      $('#capture-body').innerHTML = `<button id="record-audio" class="primary">一言、話す</button><p id="record-status">録音を終えると、自動で保存します。</p>
        <details class="fold"><summary>音声ファイルから残す</summary><input id="audio-file" type="file" accept="audio/*,.webm,.m4a"></details>`;
      // A native file picker remains available even if microphone permission is denied.
      bind('#audio-file', 'change', event => { if (event.target.files[0]) saveUpload(event.target.files[0], null, target); });
      bind('#record-audio', 'click', async () => {
        if (recorder?.state === 'recording') { recorder.stop(); return; }
        try {
          if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('このブラウザでは録音できません。音声ファイルか、写真・文章を使ってください。');
          const recordingStream = await navigator.mediaDevices.getUserMedia({ audio:true });
          if (!dialog.open || $('#capture-mode')?.value !== 'audio') { recordingStream.getTracks().forEach(t => t.stop()); return; }
          stream = recordingStream;
          const mime = ['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
          recorder = new MediaRecorder(stream, mime ? { mimeType:mime } : {});
          const chunks = []; let timer, bytes = 0, overLimit = false;
          const recording = recorder;
          recording.ondataavailable = event => {
            chunks.push(event.data); bytes += event.data.size;
            if (bytes > 8 * 1024 * 1024 && recording.state === 'recording') { overLimit = true; recording.stop(); }
          };
          recording.onstop = () => {
            clearTimeout(timer); recordingStream.getTracks().forEach(t => t.stop());
            // Closing or switching modes cancels recording rather than silently uploading.
            if (!dialog.open || $('#capture-mode')?.value !== 'audio' || recorder !== recording) return;
            const blob = new Blob(chunks, { type:recording.mimeType || 'audio/webm' });
            if (overLimit || blob.size > 8 * 1024 * 1024) { $('#capture-error').textContent = '音声は8MB以下にしてください。'; return; }
            const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
            saveUpload(new File([blob], `recording.${ext}`, { type:blob.type }), null, target);
          };
          recording.onerror = () => { clearTimeout(timer); stopRecorder(); if ($('#capture-error')) $('#capture-error').textContent = '録音できませんでした。音声ファイルから残せます。'; };
          recording.start(1000);
          $('#record-audio').textContent = '話し終わる'; $('#record-status').textContent = '録音中 · 最長2分'; $('#record-status').classList.add('recording');
          timer = setTimeout(() => { if (recording.state === 'recording') recording.stop(); }, 120000);
        } catch (error) { $('#capture-error').textContent = error.name === 'NotAllowedError' ? 'マイクが使えません。音声ファイルか、写真・文章を使ってください。' : error.message; }
      });
    } else if (selected === 'import') {
      importPicker(target);
    } else {
      $('#capture-body').innerHTML = `<form id="text-form"><label><span>残したい文章・一言</span><textarea id="capture-text" maxlength="20000" placeholder="どこが、どう面白かった？" required></textarea></label><button class="primary" type="submit">残す</button></form>`;
      bind('#text-form', 'submit', event => { event.preventDefault(); saveUpload(null, $('#capture-text').value, target); });
    }
  };
  bind('#capture-mode', 'change', render); render();
}

async function importPicker(target) {
  $('#capture-body').innerHTML=`<label><span>どこがどう面白い？（任意）</span><textarea id="import-note" maxlength="20000"></textarea></label>
    <input id="import-file" type="file" accept="application/pdf,.zip,.cbz"><button id="pick-import" class="primary">ファイルを選ぶ</button><p>端末内で変換し、選んだ写真だけを残します。25MBまで。候補120点まで。</p><div id="import-resume"></div><div id="import-candidates"></div>`;
  bind('#pick-import','click',()=>$('#import-file').click());
  bind('#import-file','change',e=>{if(e.target.files[0])prepareImport(e.target.files[0],target);});
  try {
    const jobs=await pendingImports();if(!$('#import-resume'))return;
    $('#import-resume').innerHTML=jobs.map(j=>`<div class="import-resume-row"><button class="quiet" data-resume-import="${j.id}">${esc(j.file.name||'変換途中のファイル')}を続ける</button><button class="quiet" data-remove-import="${j.id}">候補を削除</button></div>`).join('');
    document.querySelectorAll('[data-resume-import]').forEach(el=>el.addEventListener('click',()=>prepareImport(jobs.find(j=>j.id===el.dataset.resumeImport).file,target)));
    document.querySelectorAll('[data-remove-import]').forEach(el=>el.addEventListener('click',async()=>{await removeImport(jobs.find(j=>j.id===el.dataset.removeImport));importPicker(target);}));
  }catch(e){if($('#capture-error'))$('#capture-error').textContent=e.message;}
}
async function prepareImport(file,target) {
  stopImport();importController=new AbortController();const controller=importController;
  const note=$('#import-note')?.value||'';
  $('#pick-import').hidden=true;$('#import-resume').innerHTML='';$('#capture-error').textContent='候補を変換しています。閉じても端末内に残ります。';
  try {
    const job=await openImport(file,(done,total)=>{if(!controller.signal.aborted&&$('#capture-error'))$('#capture-error').textContent=`候補を変換中 ${done} / ${total}`;},controller.signal);
    if(controller.signal.aborted)return;
    if(job.status==='completed'){ $('#capture-error').textContent='このファイルは取り込み済みです。';$('#pick-import').hidden=false;return; }
    $('#capture-error').textContent=job.status==='partial'?'変換できなかった候補があります。元のファイルは端末内に残しています。':'';
    $('#import-candidates').innerHTML=`<p>残したい写真を1〜8枚選んでください。</p><div class="import-grid">${job.items.map((item,i)=>{
      const url=item.thumbnail?URL.createObjectURL(item.thumbnail):null;if(url)importURLs.push(url);
      return `<label class="import-item"><input type="checkbox" data-import-key="${esc(item.key)}" ${job.selected.includes(item.key)?'checked':''} ${item.error?'disabled':''}>${url?`<img src="${url}" alt="候補画像 ${i+1}">`:`<span>${esc(item.error)}</span>`}</label>`;
    }).join('')}</div><button id="save-import" class="primary">選んだ写真を残す</button><details class="fold"><summary>変換に失敗した候補を再試行</summary><button id="retry-import" class="quiet">同じファイルを変換し直す</button></details>`;
    $('#import-note').value=note;
    document.querySelectorAll('[data-import-key]').forEach(el=>el.addEventListener('change',async()=>{try{await selectImport(job,Array.from(document.querySelectorAll('[data-import-key]:checked')).map(e=>e.dataset.importKey));$('#capture-error').textContent='';}catch(e){el.checked=false;$('#capture-error').textContent=e.message;}}));
    bind('#retry-import','click',()=>prepareImport(job.file,target));
    bind('#save-import','click',async()=>{
      const button=$('#save-import');button.disabled=true;
      try{await selectImport(job,Array.from(document.querySelectorAll('[data-import-key]:checked')).map(e=>e.dataset.importKey));const files=await importFiles(job);
        await saveUpload(files,null,target,{files,text:null,target,note:$('#import-note').value,key:job.request_key,import_job:job});
      }catch(e){if($('#capture-error'))$('#capture-error').textContent=e.message;}
      finally{button.disabled=false;}
    });
  }catch(e){if(!controller.signal.aborted&&$('#capture-error')){ $('#capture-error').textContent=e.name==='PasswordException'?'パスワード付きPDFは端末で解除してから取り込んでください。':e.message;$('#pick-import').hidden=false;}}
}

async function saveUpload(file, text, target, reuse = null, note = '') {
  if (uploading) return;
  const files = Array.isArray(file) ? file : file ? [file] : [];
  if (files.length > 8 || files.some(f => f.size > 8 * 1024 * 1024) || files.reduce((n,f) => n+f.size,0) > 20*1024*1024) { $('#capture-error').textContent = '8ファイルまで、1つ8MB・合計20MBまでです。'; return; }
  uploading = true;
  const pending = reuse || { files, text, target, note, key:crypto.randomUUID() };
  uploadPending = pending;
  $('#capture-error').textContent = '保存しています。';
  dialog.querySelectorAll('button,input,textarea,select').forEach(el => { el.disabled = true; });
  try {
    await queueUpload(pending);
    let localOnly=false;
    try{if(!navigator.onLine)throw new TypeError('offline');await sendUpload(pending,api);await removePending(pending.key);}
    catch(e){if(e.status){await pendingFailure(pending.key,e);throw e;}localOnly=true;}
    if(pending.import_job)await finishImport(pending.import_job);
    uploading = false; uploadPending = null; stopImport(); dialog.close();
    if (target && !localOnly) await openCapture(target.id); else await home();
    showNotice(localOnly?'端末内に保存しました。接続が戻ると送信します。':'保存しました。分析はあとで読めます。');
  } catch (error) {
    uploading = false;
    if (!dialog.open) return;
    $('#capture-error').textContent = error.message;
    dialog.querySelectorAll('button,input,textarea,select').forEach(el => { el.disabled = false; });
    // Keep the same request key and bytes on retry, including after an uncertain network failure.
    $('.upload-retry')?.remove();
    $('#capture-body').querySelectorAll('.primary').forEach(el => { el.hidden = true; });
    const retry = document.createElement('button'); retry.className = 'primary upload-retry'; retry.textContent = 'もう一度保存する';
    retry.addEventListener('click', () => saveUpload(pending.files, pending.text, pending.target, pending));
    $('#capture-body').append(retry);
  }
}

async function openCapture(captureId) {
  currentCapture = await api(`/api/captures/${captureId}`); currentView = null; renderCapture();
}
function evidenceHTML(c,e) {
  const a=c.assets.find(a=>a.id===e.asset_id);
  return `<span class="evidence">${a ? `<a href="/api/assets/${a.id}" target="_blank" rel="noopener">${a.mime.startsWith('image/') ? '元の写真' : '元の音声'}</a>` : e.origin==='user' ? '本人の一言' : ''}${e.quote ? ` · ${esc(e.quote)}` : ''}</span>`;
}
function renderCapture() {
  const c=currentCapture,h=c.harvest,label=statusLabel({...c.job,error_code:c.job?.error_code});
  const proposal=c.proposals.find(p=>!p.adopted_view_id&&p.view_id)||c.proposals.find(p=>!p.adopted_view_id)||c.proposals[0];
  app.innerHTML=`${header(false)}<button id="back" class="back">← 面白さのメモ</button><article>
    <div class="detail-head"><p class="eyebrow">${esc(c.source_title||'作品名なし')}${c.source_inherited?'（直前の作品から引き継ぎ）':''} · ${date(c.created_at)}</p><h1>${esc(h?.summary||c.note||c.original_text||'写真を残しました。')}</h1>${label?`<p class="status">${esc(label)}</p>`:''}
    ${['failed','blocked'].includes(c.job?.state)?`<p class="subtle">${esc(errors[c.job.error_code]||'原資料は保存済みです。詳細から再試行できます。')}</p>`:''}</div>
    <div class="photo-strip">${c.assets.filter(a=>a.mime.startsWith('image/')).map(a=>`<a href="/api/assets/${a.id}" target="_blank" rel="noopener"><img src="/api/assets/${a.id}" alt="取り込んだ写真" loading="lazy"></a>`).join('')}</div>
    ${c.original_text||c.note||c.job?.transcript?`<blockquote class="user-note">${esc([c.original_text,c.note,c.job?.transcript].filter(Boolean).join('\n'))}</blockquote>`:''}
    ${h?`${c.harvest_version!==c.version?'<p class="subtle">以下は更新前の分析です。新しい分析ができるまで残しています。</p>':''}<section class="detail-section"><h2>面白さの言語化</h2>${h.claims.map(claim=>`<div class="knowledge-item"><span class="origin">${({observation:'写真からの観察',interpretation:'AIの解釈',hypothesis:'条件付きの仮説'})[claim.kind]}</span><p>${esc(claim.text)}</p>${claim.conditions.length?`<p class="subtle">${claim.conditions.map(esc).join(' ／ ')}</p>`:''}${claim.evidence.map(e=>evidenceHTML(c,e)).join('')}</div>`).join('')}</section>
    ${h.mechanisms.length?`<section class="detail-section"><h2>どう効いていそうか</h2>${h.mechanisms.map(m=>`<div class="knowledge-item"><p>${esc(m.expression)}</p><p>${esc(m.information_change)} ${esc(m.possible_effect)}</p><p class="subtle">${esc(m.context)} · ${esc(m.limits)}</p></div>`).join('')}</section>`:''}
    ${c.comparisons.length?`<section class="detail-section"><h2>以前のメモとのつながり</h2>${c.comparisons.map(x=>`<div class="comparison"><p>${esc(x.data.shared_structure)}</p><p class="subtle">${esc(x.data.differences)}</p>${x.target_version!==x.target_current_version?'<p class="subtle">比較先は更新されています。旧版に対する比較です。</p>':''}<a href="#" data-compare="${x.target_id}">${esc(x.target_title||'比較したメモ')}を読む</a><p>${esc(x.data.question)}</p></div>`).join('')}</section>`:''}
    ${proposal?`<section class="draft"><h2>${proposal.adopted_view_id?'自分の漫画観に残しました':proposal.view_id?'漫画観の更新案':'漫画観の案'}</h2><p class="prose">${esc(proposal.data.text)}</p><p class="subtle">${esc(proposal.data.reason)}</p>${proposal.adopted_view_id?`<a href="#" id="adopted-view">漫画観と履歴を読む</a>`:`<button id="adopt" class="primary">${proposal.view_id?'この見方に更新':'自分の漫画観にする'}</button>`}</section>`:''}
    ${h.questions.length?`<section class="detail-section"><h2>考えの続き</h2>${h.questions.map(q=>`<p>${esc(q.text)}</p>`).join('')}</section>`:''}
    ${h.uncertainties.length?`<p class="subtle">分析の留保：${h.uncertainties.map(esc).join(' ／ ')}</p>`:''}`:''}
    <details id="local-graph" class="fold"><summary>このメモのつながりを読む</summary><div id="graph-body"></div></details>
    <details class="fold"><summary>一言・写真・音声を足す</summary><button id="supplement" class="quiet">同じメモに追加する</button></details>
    <details class="fold"><summary>原資料・訂正など</summary>
    ${c.assets.filter(a=>a.mime.startsWith('audio/')).map(a=>`<audio controls preload="none" src="/api/assets/${a.id}"></audio>`).join('')}
    ${h?.extracted_text?`<p class="prose">${esc(h.extracted_text)}</p>`:''}<div class="secondary-links"><button id="correct">一言・作品名を訂正</button><button id="retry">もう一度分析</button><button id="delete" class="danger">このメモを削除</button></div>
    ${h?.concepts.length?`<p class="concepts">${h.concepts.map(k=>esc(k.name)).join(' · ')}</p>`:''}</details></article>`;
  wireHeader();bind('#back','click',()=>home().catch(e=>showNotice(e.message)));
  bind('#local-graph','toggle',()=>{if($('#local-graph').open&&!$('#graph-body').innerHTML)renderGraph(c.id).catch(e=>showNotice(e.message));});
  bind('#supplement','click',()=>recordDialog(c));
  document.querySelectorAll('[data-compare]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();openCapture(a.dataset.compare).catch(e=>showNotice(e.message));}));
  bind('#adopted-view','click',e=>{e.preventDefault();openView(proposal.adopted_view_id).catch(e=>showNotice(e.message));});
  bind('#adopt','click',async e=>{
    e.target.disabled=true;
    try{const saved=await api(`/api/captures/${c.id}/adopt`,json('POST',{version:c.version,proposal_id:proposal.id}));await openView(saved.id);}
    catch(error){showNotice(error.message);e.target.disabled=false;}
  });
  bind('#correct','click',()=>{
    modal('メモを訂正',`<form id="correct-form" class="field-stack"><label><span>一言・訂正</span><textarea id="note" maxlength="20000">${esc(c.note)}</textarea></label><label><span>作品名（任意）</span><input id="source-title" maxlength="500" value="${esc(c.source_title)}"></label><p id="edit-error" class="error" role="alert"></p><button class="primary">訂正を残す</button></form>`);
    bind('#correct-form','submit',async e=>{
      e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;
      try{await api(`/api/captures/${c.id}`,json('PATCH',{version:c.version,note:$('#note').value,source_title:$('#source-title').value}));closeDialog();await openCapture(c.id);}
      catch(error){$('#edit-error').textContent=error.message;button.disabled=false;}
    });
  });
  bind('#retry','click',async()=>{
    try{
      if(['failed','blocked'].includes(c.job?.state))await api(`/api/captures/${c.id}/retry`,json('POST',{version:c.version}));
      else await api(`/api/captures/${c.id}`,json('PATCH',{version:c.version}));
      await openCapture(c.id);showNotice('もう一度分析します。');
    }catch(e){showNotice(e.message);}
  });
  bind('#delete','click',()=>{
    modal('このメモを削除',`<p>写真・音声・分析を削除します。採用済みの漫画観と改訂履歴は残ります。</p><p id="delete-error" class="error" role="alert"></p><button id="delete-confirm" class="primary">削除する</button>`);
    bind('#delete-confirm','click',async e=>{e.target.disabled=true;try{await api(`/api/captures/${c.id}`,json('DELETE',{version:c.version}));closeDialog();await home();}catch(error){$('#delete-error').textContent=error.message;e.target.disabled=false;}});
  });
}
async function openView(viewId) {
  const v = await api(`/api/views/${viewId}`); currentView = v; currentCapture = null;
  app.innerHTML = `${header(false)}<button id="back" class="back">← 面白さのメモ</button><article>
    <div class="detail-head"><p class="eyebrow">自分の漫画観 · 第${v.version}版</p><h1 class="prose">${esc(v.body)}</h1></div>
    <section class="detail-section"><h2>この見方の根拠</h2><p>${esc(v.revisions[0].references.source_title || '残した資料')}${''}</p>
    ${v.revisions[0].reference_state!=='deleted' ? `<a href="#" id="view-source">原資料と解析を読む</a>${v.revisions[0].reference_state==='changed'?'<p class="subtle">根拠のメモは更新されています。履歴には採用時の記録を残しています。</p>':''}` : '<p class="subtle">元のメモは削除されました。採用時の漫画観と改訂履歴を残しています。</p>'}</section>
    <details class="fold"><summary>見方を編集・履歴を読む</summary><button id="edit-view" class="quiet">見方を編集する</button>
    ${v.revisions.map(r => `<div class="history"><p class="subtle">第${r.version}版 · ${date(r.created_at)}</p><p class="prose">${esc(r.body)}</p><p class="subtle">${esc(r.reason)}</p>${r.version !== v.version ? `<button data-restore="${r.version}">この版へ戻す</button>` : ''}</div>`).join('')}</details></article>`;
  wireHeader(); bind('#back','click', () => home().catch(e => showNotice(e.message)));
  bind('#view-source','click', event => { event.preventDefault(); openCapture(v.revisions[0].references.capture_id).catch(e => showNotice(e.message)); });
  bind('#edit-view','click', () => {
    modal('自分の漫画観を編集', `<form id="view-form" class="field-stack"><label><span>今の見方</span><textarea id="view-body" required maxlength="20000">${esc(v.body)}</textarea></label>
      <label><span>変えた理由</span><input id="view-reason" required maxlength="2000"></label><p id="view-error" class="error" role="alert"></p><button class="primary">見方を更新する</button></form>`);
    bind('#view-form','submit', async event => {
      event.preventDefault();
      try { await api(`/api/views/${v.id}`, json('PATCH', { version:v.version, body:$('#view-body').value, reason:$('#view-reason').value })); closeDialog(); await openView(v.id); }
      catch (e) { $('#view-error').textContent = e.message; }
    });
  });
  document.querySelectorAll('[data-restore]').forEach(el => el.addEventListener('click', () => {
    modal('過去の見方へ戻す', `<p>第${el.dataset.restore}版の文章を、新しい版として残します。</p><p id="restore-error" class="error" role="alert"></p><button id="restore-confirm" class="primary">この版へ戻す</button>`);
    bind('#restore-confirm','click', async () => {
      try { await api(`/api/views/${v.id}`, json('PATCH', { version:v.version, restore_version:Number(el.dataset.restore) })); closeDialog(); await openView(v.id); }
      catch (e) { $('#restore-error').textContent = e.message; }
    });
  }));
}

async function renderGraph(captureId) {
  const g=await api(`/api/captures/${captureId}/graph`);if(!$('#graph-body')||currentCapture?.id!==captureId)return;
  const labels={claim:'根拠・解釈',concept:'概念',mechanism:'仕組み',question:'問い'},relationLabels={example_of:'例になっている',supports_interpretation:'解釈を支える',qualifies:'成立条件を加える',analogous_to:'似た構造',contrasts_with:'対照',evidence_for:'根拠になっている'};
  const nodes=g.nodes.map(n=>({...n,data:JSON.parse(n.data)})),name=n=>n?.data.name||n?.data.text||n?.data.expression||'記述';
  $('#graph-body').innerHTML=nodes.length?`<p class="subtle">このメモの現在の分析だけを表示しています。</p>${nodes.map(n=>`<div class="graph-node"><span class="origin">${labels[n.kind]}</span><p>${esc(name(n))}</p>${n.concept_id?`<button class="quiet" data-concept="${n.concept_id}">同じ概念のメモ・別名・整理</button>`:''}</div>`).join('')}
    ${g.relations.map(r=>{const d=JSON.parse(r.data);return `<p class="graph-relation">${esc(name(nodes.find(n=>n.id===r.from_id)))} → ${esc(relationLabels[r.kind]||r.kind)} → ${esc(name(nodes.find(n=>n.id===r.to_id)))}${d.reason?`<br><span class="subtle">${esc(d.reason)} ${(d.conditions||[]).map(esc).join(' ／ ')}</span>`:''}</p>`;}).join('')}`:'新しい分析ができると、ここに根拠とつながりを表示します。';
  document.querySelectorAll('[data-concept]').forEach(el=>el.addEventListener('click',()=>conceptDialog(el.dataset.concept).catch(e=>showNotice(e.message))));
}
async function conceptDialog(conceptId) {
  const k=await api(`/api/concepts/${conceptId}`);
  modal(k.concept.name,`<p>${esc(k.concept.description)}</p>${k.aliases.length?`<p class="subtle">別名：${k.aliases.map(a=>esc(a.alias)).join(' ／ ')}</p>`:''}
    ${k.captures.map(c=>`<button class="capture-row" data-concept-record="${c.id}">${esc(c.source_title||'作品名なし')} · ${esc(c.result.summary)}</button>`).join('')}
    <details class="fold"><summary>別名を足す・同じ意味の概念と統合する</summary><form id="concept-form"><label><span>整理の方法</span><select id="concept-kind"><option value="alias">別名を足す</option><option value="merge">同じ意味として統合する</option></select></label>
    <label id="alias-label"><span>別名</span><input id="concept-alias" maxlength="200"></label><label id="merge-label" hidden><span>統合先（説明も確認してください）</span><select id="concept-target">${k.concepts.filter(v=>v.id!==k.canonical_id).map(v=>`<option value="${v.id}">${esc(v.name)} · ${esc(v.description)}</option>`).join('')}</select></label>
    <label><span>理由</span><input id="concept-reason" required maxlength="2000"></label><p id="concept-error" class="error"></p><button class="quiet">整理を残す</button></form><p class="subtle">元の分析・写真・漫画観の履歴は残ります。</p></details>
    <details class="fold"><summary>整理の履歴・統合を戻す</summary>${k.actions.filter(a=>a.data.concept_id===k.canonical_id||a.data.source_id===conceptId||a.data.target_id===k.canonical_id).map(a=>`<p>第${a.revision}版 · ${esc(a.reason)} ${a.undone?'（取り消し済み）':`<button class="quiet" data-undo-concept="${a.id}">この整理を戻す</button>`}</p>`).join('')}</details>`);
  document.querySelectorAll('[data-concept-record]').forEach(el=>el.addEventListener('click',()=>{closeDialog();openCapture(el.dataset.conceptRecord).catch(e=>showNotice(e.message));}));
  bind('#concept-kind','change',()=>{$('#alias-label').hidden=$('#concept-kind').value!=='alias';$('#merge-label').hidden=$('#concept-kind').value!=='merge';});
  bind('#concept-form','submit',async e=>{e.preventDefault();try{await api(`/api/concepts/${conceptId}`,json('POST',{kind:$('#concept-kind').value,revision:k.revision,alias:$('#concept-alias').value,target_id:$('#concept-target').value,reason:$('#concept-reason').value}));await conceptDialog(conceptId);}catch(e){$('#concept-error').textContent=e.message;}});
  document.querySelectorAll('[data-undo-concept]').forEach(el=>el.addEventListener('click',async()=>{try{await api(`/api/concepts/${conceptId}`,json('POST',{kind:'undo',revision:k.revision,action_id:el.dataset.undoConcept,reason:'本人がこの整理を取り消した。'}));await conceptDialog(conceptId);}catch(e){showNotice(e.message);}}));
}

function privacyDialog() {
  modal('AIと保存について', `<div class="privacy"><p>残した写真・音声・文章は、このアプリの非公開データとして保存します。</p>
    <p>解析には、対象の写真・音声・文章と、比較に必要な過去の知見（直近24件まで）、概念（40件まで）、漫画観（12件まで）をOpenAIへ送ります。通常の記録ごとに確認操作はありません。</p>
    <p>AIが作るのは知見と見方の案です。「自分の漫画観にする」を選んだ文章だけが、本人の見方として残ります。</p>
    <p class="subtle">${state?.ai_configured ? 'AI解析は設定済みです。' : 'AI解析は未設定です。原資料を保存して待ちます。'}<br>今日の呼び出し ${state?.usage.calls || 0} / ${state?.daily_limit || '—'}（UTC日次）。音声は文字起こしと理解で通常2回。<br>解析は有料APIを使います。上限は呼び出し数で、金額上限ではありません。</p>
    <p class="subtle">削除は記録の詳細から。書き出しには元ファイルと履歴も含みます。</p></div>`);
}

// Poll only small summaries. Never replace an open editor or an expanded source while reading.
setInterval(async () => {
  if (!state || document.hidden || dialog.open || uploading || pollBusy) return;
  pollBusy = true;
  try {
    if (currentCapture && ['pending','running','blocked'].includes(currentCapture.job?.state)) {
      if (!app.querySelector('details[open]')) {
        const fresh = await api(`/api/captures/${currentCapture.id}`);
        if (fresh.job?.state !== currentCapture.job?.state || fresh.version !== currentCapture.version) { currentCapture = fresh; renderCapture(); }
      }
    } else if (!currentCapture && !currentView) {
      const completed=await syncUploads(api,state.instance_id);if(!state)return;
      state = await api(`/api/state?q=${encodeURIComponent(query)}`);if(!query)await rememberState(state);state.device_pending=await pendingUploads();renderFeed();if(completed.length)showNotice('端末のメモを同期しました。分析はあとで読めます。');
    }
  } catch (e) { if (e.status !== 401) { /* Preserve the last readable page during a temporary outage. */ } }
  finally { pollBusy = false; }
}, 2500);

function receivePhotos(files) {
  if(!state||uploading||!files.length)return;
  if(!dialog.open)recordDialog(currentCapture);
  const mode=$('#capture-mode');
  if(!mode)return;
  mode.value='image';mode.dispatchEvent(new Event('change'));
  saveUpload(files,null,currentCapture,null,$('#image-note')?.value||'');
}
document.addEventListener('paste',event=>{
  const photos=Array.from(event.clipboardData?.files||[]).filter(f=>f.type.startsWith('image/'));
  if(photos.length&&state&&!uploading){event.preventDefault();
    if(dialog.open&&$('#capture-mode')?.value==='image')saveUpload(photos,null,currentCapture,null,$('#image-note')?.value||'');
    else receivePhotos(photos);
  }
});
document.addEventListener('dragover',event=>{if(state&&event.dataTransfer?.types.includes('Files'))event.preventDefault();});
document.addEventListener('drop',event=>{
  const photos=Array.from(event.dataTransfer?.files||[]).filter(f=>f.type.startsWith('image/'));
  if(photos.length&&state){event.preventDefault();
    if(dialog.open&&$('#capture-mode')?.value==='image')saveUpload(photos,null,currentCapture,null,$('#image-note')?.value||'');
    else receivePhotos(photos);
  }
});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
window.addEventListener('online',()=>{if(state)home().then(()=>syncUploads(api,state.instance_id)).then(()=>home()).catch(e=>showNotice(e.message));});
home().catch(error => { if (error.status !== 401) { app.innerHTML = '<p class="loading">接続を確認して、画面を開き直してください。</p>'; } });
