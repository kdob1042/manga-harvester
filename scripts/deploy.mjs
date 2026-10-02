import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const production=config.env.production;
if(production.vars.AUTH_MODE!=='cloudflare-access'||!production.vars.ACCESS_AUD||!production.vars.ACCESS_OWNER_EMAIL||!/^https:\/\/[^/]+\.cloudflareaccess\.com$/.test(production.vars.ACCESS_TEAM_DOMAIN||'')){
 console.error('Configure owner-only Cloudflare Access and its audience, team domain and owner email before deploying production.');process.exit(1);
}
if(!production.vars.APP_ORIGIN.startsWith('https://')||production.vars.APP_ORIGIN.includes('.invalid')||production.d1_databases[0].database_id.startsWith('00000000-')){
 console.error('Set production APP_ORIGIN and the actual production D1 database_id in wrangler.jsonc.');process.exit(1);
}
const assets=spawnSync('node',['scripts/assets.mjs'],{stdio:'inherit'});if(assets.status!==0)process.exit(assets.status||1);
for(const args of [['d1','migrations','apply','DB','--remote','--env','production'],['deploy','--env','production']]){
 const result=spawnSync('npx',['wrangler',...args],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);
}
