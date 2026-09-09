import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
 const root=mkdtempSync(join(tmpdir(),'tunnel-test-'));
 const bin=join(root,'bin'); mkdirSync(bin);
 const app=join(root,'app'); mkdirSync(app); writeFileSync(join(app,'compose.yaml'),'services: {}');
 const config=join(root,'config'); const sites=join(config,'dev-proxy/sites');
 writeFileSync(join(bin,'docker'), `#!${Bun.which('bun')}\nconst a=process.argv.slice(2);require('node:fs').appendFileSync(process.env.LOG,JSON.stringify(a)+'\\n');
 if(a[0]==='ps')console.log(JSON.stringify({Names:'unrelated-caddy',Ports:'0.0.0.0:9999->80/tcp'})+'\\n'+JSON.stringify({Names:'right-caddy',Ports:'0.0.0.0:8000->80/tcp'}));
 if(a[0]==='inspect')console.log(JSON.stringify([{Source:process.env.BAD_MOUNT?'wrong':process.env.SITES,Destination:'/etc/caddy/sites'}]));
 if(a[0]==='compose'&&a.includes('ps'))console.log(JSON.stringify({Publishers:[{PublishedPort:8123}]}));
 if(a.includes('down')&&process.env.FAIL_DOWN)process.exit(1);
 if(a[0]==='exec'&&process.env.FAIL_RELOAD)process.exit(1);
 `,{mode:0o755});
 const run=(args:string[], extra={})=>Bun.spawnSync([process.execPath,join(import.meta.dir,'cli.ts'),...args],{cwd:app,env:{...process.env,PATH:bin+':'+process.env.PATH,TUNNEL_CONFIG_DIR:config,TUNNEL_PROXY_PORT:'8000',TUNNEL_DOMAIN:'stack.avyayv.com',SITES:sites,LOG:join(root,'log'),...extra}});
 return {root,sites,config,run,log:()=>readFileSync(join(root,'log'),'utf8'),close:()=>rmSync(root,{recursive:true,force:true})};
}
test('up prints full URL, reuses identity, and reloads only the matching proxy; down removes route',()=>{
 const f=fixture();try{
 const up=f.run(['up','--name','review']);expect(up.exitCode).toBe(0);expect(up.stdout.toString()).toContain('http://review.stack.avyayv.com:8000');
 expect(f.run(['up']).stdout.toString()).toContain('http://review.stack.avyayv.com:8000');
 expect(f.run(['ls']).stdout.toString()).toContain('http://review.stack.avyayv.com:8000');
 expect(f.log()).toContain('["exec","right-caddy"');expect(f.log()).not.toContain('["exec","unrelated-caddy"');
 expect(f.run(['down']).exitCode).toBe(0);expect(existsSync(join(f.sites,'review.caddy'))).toBe(false);
 expect(existsSync(join(f.config,'dev-proxy/mappings/review.json'))).toBe(false);
 }finally{f.close()}
});
test('failed stack shutdown retains mapping and route',()=>{const f=fixture();try{
 expect(f.run(['up','--name','review']).exitCode).toBe(0);
 expect(f.run(['down'],{FAIL_DOWN:'1'}).exitCode).not.toBe(0);
 expect(existsSync(join(f.sites,'review.caddy'))).toBe(true);
 }finally{f.close()}});
test('rejects wrong proxy mounts and invalid names before writing route',()=>{const f=fixture();try{
 expect(f.run(['up','--name','review'],{BAD_MOUNT:'1'}).exitCode).not.toBe(0);
 expect(existsSync(join(f.sites,'review.caddy'))).toBe(false);
 expect(f.run(['up','--name','../escape']).exitCode).not.toBe(0);
 }finally{f.close()}});

test('registration failure leaves no route and unmanaged routes are protected',()=>{const f=fixture();try{
 expect(f.run(['up','--name','review'],{FAIL_RELOAD:'1'}).exitCode).not.toBe(0);
 expect(existsSync(join(f.sites,'review.caddy'))).toBe(false);
 mkdirSync(f.sites,{recursive:true});writeFileSync(join(f.sites,'review.caddy'),'original');
 expect(f.run(['up','--name','review']).exitCode).not.toBe(0);
 expect(readFileSync(join(f.sites,'review.caddy'),'utf8')).toBe('original');
 }finally{f.close()}});
test('unpublished target port is rejected',()=>{const f=fixture();try{
 expect(f.run(['up','--name','review','--port','9000']).exitCode).not.toBe(0);
 expect(existsSync(join(f.sites,'review.caddy'))).toBe(false);
 }finally{f.close()}});
