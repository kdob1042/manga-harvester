// Rebuild selected records through their normal versioned durable jobs.
const origin=process.env.APP_ORIGIN,password=process.env.APP_PASSWORD,ids=process.argv.slice(2);
if(!origin||!password||!ids.length||ids.some(id=>!/^[a-f0-9-]{36}$/.test(id)))throw new Error('Set APP_ORIGIN + APP_PASSWORD, then pass capture UUIDs.');
const login=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password})});
if(!login.ok)throw new Error('Login failed');
const cookie=login.headers.get('set-cookie').split(';')[0];
try{
 for(const id of ids){
  const response=await fetch(`${origin}/api/captures/${id}`,{headers:{Cookie:cookie}});if(!response.ok)throw new Error(`Record missing: ${id}`);const c=await response.json();
  const update=await fetch(`${origin}/api/captures/${id}`,{method:'PATCH',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({version:c.version})});
  if(!update.ok)throw new Error(`Rebuild conflicted: ${id}`);console.log(`Queued ${id}`);
 }
}finally{await fetch(origin+'/api/logout',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:'{}'});}
