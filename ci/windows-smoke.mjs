import {spawn,spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import assert from 'node:assert/strict';
const exe=resolve(process.env.ALLOVA_EXE||'');assert(exe.endsWith('Allova.exe'));
const out=resolve('smoke-results');await mkdir(out,{recursive:true});
const expected=process.env.ALLOVA_VERSION;assert(/^\d+\.\d+\.\d+$/.test(expected));
const appData=join(out,'qa-profile');await mkdir(appData,{recursive:true});
const report={platform:process.platform,gameVersion:expected,checks:[],screenshots:[],errors:[]};
assert.equal(process.platform,'win32','This workflow must test the actual Windows executable');
let child,ws,id=0,pending=new Map();
function rpc(method,params={}){return new Promise((resolve,reject)=>{const next=++id,t=setTimeout(()=>{pending.delete(next);reject(Error('CDP timeout: '+method))},20000);pending.set(next,{resolve:v=>{clearTimeout(t);resolve(v)},reject});ws.send(JSON.stringify({id:next,method,params}))})}
async function evaluate(expression,userGesture=false){const r=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture});if(r.exceptionDetails)throw Error(r.exceptionDetails.text+': '+JSON.stringify(r.exceptionDetails.exception));return r.result.value}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,seconds=100){for(let t=0;t<seconds*4;t++){if(await fn())return;await wait(250)}throw Error('Timed out: '+label)}
async function connect(offline,port){
 const args=[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1','--enable-logging=stderr',...(offline?['--host-resolver-rules=MAP * ~NOTFOUND']:[])];
 child=spawn(exe,args,{cwd:dirname(exe),env:{...process.env,APPDATA:appData,LOCALAPPDATA:join(appData,'Local')},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);child.on('error',e=>report.errors.push(String(e)));
 let target;
 await until(async()=>{if(child.exitCode!==null)throw Error('Allova.exe exited '+child.exitCode+' '+log.slice(-2000));try{target=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page'&&t.url.startsWith('https://armageddonallova.win'));return !!target?.webSocketDebuggerUrl}catch{return false}},'Windows app debugger',30);
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}});
 await rpc('Runtime.enable');await rpc('Page.enable');
 return async()=>{try{await rpc('Browser.close')}catch{}try{ws.close()}catch{}await wait(1000);if(child.exitCode===null)child.kill();await writeFile(join(out,offline?'offline-runtime.log':'online-runtime.log'),log)};
}
async function screenshot(name){const r=await rpc('Page.captureScreenshot',{format:'png'});await writeFile(join(out,name+'.png'),Buffer.from(r.data,'base64'));report.screenshots.push(name+'.png')}
async function title(){await until(()=>evaluate('!!document.getElementById("press-start")'),'bundled title after complete loading',120)}
async function click(id){const box=await evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,disabled:e.disabled}})()`);assert(box&&box.width>0&&box.height>0&&!box.disabled,'Missing/hidden/disabled button '+id);await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',clickCount:1});await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x,y:box.y,button:'left',clickCount:1});await wait(150)}
let stop;
try{
 stop=await connect(true,9229);await title();await screenshot('offline-title');
 const core=await evaluate(`(async()=>({origin:location.origin,requireType:typeof require,processType:typeof process,installed:await (await fetch('/api/version')).json(),asset:await (async()=>{const r=await fetch('/assets/mon1.png');return {status:r.status,mime:r.headers.get('content-type'),bytes:(await r.arrayBuffer()).byteLength}})(),online:await (async()=>{const r=await fetch('/api/phone-config');return {status:r.status,body:await r.json()}})()}))()`);
 assert.equal(core.origin,'https://armageddonallova.win');assert.equal(core.requireType,'undefined');assert.equal(core.processType,'undefined');assert.equal(core.installed.version,expected);assert.equal(core.asset.status,200);assert(core.asset.bytes>0);assert.equal(core.online.status,503,'DNS-disabled online read must fail safely');
 report.checks.push('Actual Allova.exe launches cold offline to complete title','Renderer has no Node.js require/process','Bundled local artwork serves correctly','Installed version matches package','Offline online-service error retains gameplay');
 await click('press-start');await click('new-game');assert(await evaluate('!!document.getElementById("trainer-name")&&!!document.getElementById("begin")'));await screenshot('new-game-form');await click('back-title');
 const fixture=await readFile(new URL('./save-fixture.json',import.meta.url),'utf8');
 // This synthetic QA fixture is written only to this runner’s fresh throwaway profile.
 await evaluate(`localStorage.setItem('allova.first-journey.v1',${JSON.stringify(fixture)})`);await stop();stop=null;
 stop=await connect(false,9230);await title();await click('press-start');assert((await evaluate('document.getElementById("continue")?.innerText||""')).includes('Desktop QA'));await screenshot('retained-save');
 const auth=await evaluate(`(async()=>{const r=await fetch('/api/phone-config',{cache:'no-store'});const d=await r.json();return {status:r.status,enabled:d.enabled,origin:new URL(d.url).origin}})()`);assert.equal(auth.status,200);assert.equal(auth.origin,'https://tyzpaxcqpygnnlftxapf.supabase.co');
 report.checks.push('Synthetic local adventure survives closing and relaunching','Same-origin live phone configuration read succeeds without a token');
 await click('continue');await screenshot('continued-game');
 const save=await evaluate(`JSON.parse(localStorage.getItem('allova.first-journey.v1'))`);assert.equal(save.name,'Desktop QA');assert.equal(save.version,1);assert.equal(save.party[0].id,1);
 report.checks.push('Existing save version and party preserved on Continue');
 // Override only the destination in this throwaway test profile; packaged behavior keeps its native Save dialog.
 const downloads=join(out,'downloads');await mkdir(downloads,{recursive:true});
 await rpc('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true});
 await click('quick-options');await click('options-tab-save');await click('export');
 const backup=join(downloads,'allova-save.json');
 await until(async()=>{try{return (await stat(backup)).size>0}catch{return false}},'JSON save export',20);
 const exported=JSON.parse(await readFile(backup,'utf8'));assert.equal(exported.name,'Desktop QA');assert.equal(exported.party[0].id,1);
 const doc=await rpc('DOM.getDocument');const input=await rpc('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#import-save'});assert(input.nodeId);
 await rpc('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[backup]});
 await until(()=>evaluate('document.getElementById("choice-0")?.innerText==="Import save"'),'save import review');
 assert((await evaluate('document.getElementById("dialogue").innerText')).includes('Desktop QA'));await screenshot('import-review');
 await click('choice-0');assert.equal((await evaluate("JSON.parse(localStorage.getItem('allova.first-journey.v1')).party[0].id")),1);
 report.checks.push('JSON save export and explicit import round-trip preserve the synthetic party');
 report.status='passed';
}catch(e){report.status='failed';report.errors.push(String(e.stack||e));try{await screenshot('failure')}catch{}process.exitCode=1}
finally{if(stop)await stop();try{ws?.close()}catch{}if(child?.pid&&child.exitCode===null)spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore'});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))}
