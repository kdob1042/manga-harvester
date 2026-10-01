const CACHE='manga-shell-v1';
const SHELL=['/','/index.html','/app.js','/style.css','/favicon.svg','/local.js','/offline.js','/import.js','/manifest.webmanifest'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 // Private API responses, originals, credentials and exports are never cached.
 if(event.request.method!=='GET'||url.origin!==self.location.origin||!SHELL.includes(url.pathname))return;
 event.respondWith(fetch(event.request).then(response=>{if(response.ok)caches.open(CACHE).then(cache=>cache.put(event.request,response.clone()));return response;}).catch(()=>caches.match(event.request).then(cached=>cached||caches.match('/'))));
});
