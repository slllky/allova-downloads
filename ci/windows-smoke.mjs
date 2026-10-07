import {spawn,spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const ORIGIN='https://armageddonallova.win';
const MAIN_SHA='deff5d4565cce7ceda5c6e2e96ae05d0a71ac6fb1d291a9ec9787719feb746cb';
const CLIENT_SHA='0f002d159e22ac34572a69427cf5ed5bc9f1186485dc02c208a0229933c8e80e';
const SAVE_KEY='allova.first-journey.v1';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,seconds=60){const end=Date.now()+seconds*1000;while(Date.now()<end){if(await fn())return;await wait(250)}throw Error('Timed out: '+label)}
class CDP {
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.events=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&this.pending.has(m.id)){const p=this.pending.get(m.id);this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}else if(m.method){this.events.push(m);if(this.events.length>1000)this.events.shift()}})}
 static async connect(url){assert(/^ws:\/\/127\.0\.0\.1:\d+\//.test(url),'Debugger must be loopback only');const ws=new WebSocket(url);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});return new CDP(ws)}
 rpc(method,params={},timeout=20000){return new Promise((resolve,reject)=>{const id=++this.id,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timeout: '+method))},timeout);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}))})}
 async evaluate(expression,{userGesture=false,main=false,timeout=20000}={}){const r=await this.rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture,...(main?{includeCommandLineAPI:true}:{})},timeout);if(r.exceptionDetails)throw Error(r.exceptionDetails.text+': '+JSON.stringify(r.exceptionDetails.exception));return r.result.value}
 close(){this.ws.close();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Debugger closed'))}this.pending.clear()}
}

// Executed only in the loopback main-process inspector of the unchanged candidate.
// This observer is appended AFTER the release's original policy. It cannot undo
// preventDefault, invoke a rejected DownloadItem, or replace the production listener.
export function installExportObserver(q,backup,expectedDefaultPath){
 const w=q.desktopWindow,ses=w.webContents.session;
 const listeners=ses.listeners('will-download');
 if(listeners.length!==1)throw Error('Expected exactly one original download policy');
 const policy=listeners[0];
 if(q.exportEvidence)throw Error('Export observer is single use');
 q.exportEvidence={originalListenerCount:1,observerOrder:'appended-after-original-policy',observed:false};
 const evidence=q.exportEvidence;
 ses.once('will-download',(event,item,contents)=>{
  evidence.observed=true;evidence.defaultPrevented=event.defaultPrevented;
  try{
   const originalStillFirst=ses.listeners('will-download')[0]===policy;
   Object.assign(evidence,{originalStillFirst,sameWindow:contents===w.webContents,url:item.getURL(),initiator:item.getInitiatorOrigin(),gesture:item.hasUserGesture(),mime:item.getMimeType(),filename:item.getFilename(),dialog:item.getSaveDialogOptions(),pathBefore:item.getSavePath(),stateBefore:item.getState()});
  }catch(e){evidence.metadataError=String(e.message||e)}
  if(event.defaultPrevented!==false){evidence.rejected='Policy canceled the download or cancellation state is unknown';return}
  if(evidence.metadataError){evidence.rejected='Could not safely inspect DownloadItem metadata';return}
  try{
   const d=evidence.dialog;
   // Electron44.6 getter omits dialog properties. The pinned main.cjs hash proves
   // showOverwriteConfirmation was configured; returned title/path/filter are checked here.
   const accepted=evidence.originalStillFirst&&evidence.sameWindow&&evidence.url.startsWith('blob:https://armageddonallova.win/')&&evidence.initiator==='https://armageddonallova.win'&&evidence.gesture===true&&evidence.mime==='application/json'&&evidence.filename==='allova-save.json'&&d?.title==='Export Allova save backup'&&d.defaultPath===expectedDefaultPath&&d.filters?.length===1&&d.filters[0].name==='Allova JSON save'&&JSON.stringify(d.filters[0].extensions)==='["json"]'&&evidence.pathBefore===''&&evidence.stateBefore==='progressing';
   if(!accepted){evidence.rejected='Original policy/dialog configuration did not match the audited release';return}
   item.once('done',(_event,state)=>{evidence.done=state;evidence.savedPath=item.getSavePath();evidence.receivedBytes=item.getReceivedBytes();evidence.totalBytes=item.getTotalBytes()});
   // Fresh QA-only path, selected only AFTER verified original-policy acceptance.
   item.setSavePath(backup);evidence.destinationSelected=true;
  }catch(e){evidence.rejected=String(e.message||e)}
 });
 return {originalListenerCount:listeners.length,listenerCountAfter:ses.listenerCount('will-download')};
}

export async function probeDevToolsDisabled(w,listContents){
 const wc=w.webContents;const evidence={openedEvent:false,beforeOpen:wc.isDevToolsOpened(),before:listContents()};
 const opened=()=>{evidence.openedEvent=true};wc.on('devtools-opened',opened);
 try{
  wc.openDevTools({mode:'detach',activate:false});evidence.immediate=wc.isDevToolsOpened();
  await new Promise(r=>setTimeout(r,250));evidence.afterTick=wc.isDevToolsOpened();evidence.after=listContents();
  const ids=new Set(evidence.before.map(x=>x.id));evidence.newContents=evidence.after.filter(x=>!ids.has(x.id));
  evidence.passed=evidence.beforeOpen===false&&evidence.openedEvent===false&&evidence.immediate===false&&evidence.afterTick===false&&evidence.newContents.length===0;
  return evidence;
 }finally{if(wc.isDevToolsOpened()){evidence.cleanupClosedUnexpectedDevTools=true;wc.closeDevTools()}wc.removeListener('devtools-opened',opened)}
}

export function stableSave(save){const copy=structuredClone(save);delete copy.savedAt;delete copy.playtime;delete copy.gameTime;return copy}

async function run(){
 assert.equal(process.platform,'win32','This workflow must test the actual Windows executable');
 const exe=resolve(process.env.ALLOVA_EXE||'');assert(exe.endsWith('Allova.exe'));
 const expected=process.env.ALLOVA_VERSION;assert(/^\d+\.\d+\.\d+$/.test(expected));
 const out=resolve('smoke-results');await mkdir(out,{recursive:true});
 // Windows known-folder lookup may ignore APPDATA. The GitHub runner itself is
 // fresh and disposable; report the actual AllovaDesktop userData path below.
 const appData=join(out,'qa-profile');await mkdir(appData,{recursive:true});
 const report={platform:process.platform,nodeVersion:process.version,gameVersion:expected,checks:[],screenshots:[],errors:[],limitations:['Virtual Windows Server runner, not physical Windows 10/11 hardware','No live SMS/CAPTCHA or authenticated public multiplayer mutation','Save dialog configuration is inspected; its final destination is selected by the QA observer after policy acceptance']};
 const fixture=JSON.parse(await readFile(new URL('./save-fixture.json',import.meta.url),'utf8'));
 const appRoot=join(dirname(exe),'resources','app');
 const protectedPaths=['main.cjs','router.cjs','package.json','client-manifest.json','asset-aliases.json','build-metadata.json','client/game.js'];
 const hashes=async()=>Object.fromEntries(await Promise.all(protectedPaths.map(async p=>[p,createHash('sha256').update(await readFile(join(appRoot,p))).digest('hex')])));
 const beforeHashes=await hashes();assert.equal(beforeHashes['client/game.js'],CLIENT_SHA);assert.equal(beforeHashes['main.cjs'],MAIN_SHA);report.packageFilesBefore=beforeHashes;
 let child,desktop,reference,main,stop;
 async function screenshot(cdp,name){const r=await cdp.rpc('Page.captureScreenshot',{format:'png'});await writeFile(join(out,name+'.png'),Buffer.from(r.data,'base64'));report.screenshots.push(name+'.png')}
 async function click(cdp,id){const b=await cdp.evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,disabled:e.disabled}})()`);assert(b&&b.width>0&&b.height>0&&!b.disabled,'Missing/hidden/disabled button '+id);await cdp.rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:b.x,y:b.y,button:'left',clickCount:1});await cdp.rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:b.x,y:b.y,button:'left',clickCount:1});await wait(150)}
 async function key(cdp,key,code=key,duration=70){const virtual=({Escape:27,Enter:13,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Shift:16})[key]||(key.length===1?key.toUpperCase().charCodeAt(0):0);const fields={key,code,windowsVirtualKeyCode:virtual,nativeVirtualKeyCode:virtual};await cdp.rpc('Input.dispatchKeyEvent',{type:'rawKeyDown',...fields});await wait(duration);await cdp.rpc('Input.dispatchKeyEvent',{type:'keyUp',...fields});await wait(200)}
 const title=cdp=>until(()=>cdp.evaluate('!!document.getElementById("press-start")'),'complete title',120);
 async function connect(offline,port,inspectorPort){
  const args=[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1','--enable-logging=stderr',...(inspectorPort?[`--inspect=127.0.0.1:${inspectorPort}`]:[]),...(offline?['--host-resolver-rules=MAP * ~NOTFOUND']:[])];
  child=spawn(exe,args,{cwd:dirname(exe),env:{...process.env,APPDATA:appData,LOCALAPPDATA:join(appData,'Local')},stdio:['ignore','pipe','pipe']});
  const processRef=child;let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);child.on('error',e=>report.errors.push(String(e)));
  let target;await until(async()=>{if(child.exitCode!==null)throw Error('Allova.exe exited '+child.exitCode+' '+log.slice(-2000));try{target=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page'&&t.url.startsWith(ORIGIN));return !!target?.webSocketDebuggerUrl}catch{return false}},'Windows renderer debugger',30);
  desktop=await CDP.connect(target.webSocketDebuggerUrl);await desktop.rpc('Runtime.enable');await desktop.rpc('Page.enable');
  if(inspectorPort){let t;await until(async()=>{try{t=(await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`)).json())[0];return !!t?.webSocketDebuggerUrl}catch{return false}},'loopback main inspector',20);main=await CDP.connect(t.webSocketDebuggerUrl);const evaluate=main.evaluate.bind(main);main.evaluate=(expr,options={})=>evaluate(expr,{...options,main:true});await main.rpc('Runtime.enable');}
  return async()=>{reference?.close();reference=null;main?.close();main=null;try{await desktop.rpc('Browser.close',{},3000)}catch{}desktop?.close();await wait(1000);if(processRef.exitCode===null)spawnSync('taskkill',['/pid',String(processRef.pid),'/t','/f'],{stdio:'ignore'});await writeFile(join(out,offline?'offline-runtime.log':'online-runtime.log'),log)};
 }
 async function check(label,fn){try{await fn();report.checks.push(label);return true}catch(e){report.errors.push(label+': '+String(e.stack||e));try{await screenshot(desktop,'failure-'+report.errors.length)}catch{}return false}}
 try{
  stop=await connect(true,9229);await title(desktop);await screenshot(desktop,'offline-title');
  const core=await desktop.evaluate(`(async()=>({origin:location.origin,requireType:typeof require,processType:typeof process,installed:await(await fetch('/api/version')).json(),asset:await(async()=>{const r=await fetch('/assets/mon1.png');return{status:r.status,mime:r.headers.get('content-type'),bytes:(await r.arrayBuffer()).byteLength}})(),online:await(async()=>{const r=await fetch('/api/phone-config');return{status:r.status,body:await r.json()}})()}))()`);
  assert.equal(core.origin,ORIGIN);assert.equal(core.requireType,'undefined');assert.equal(core.processType,'undefined');assert.equal(core.installed.version,expected);assert.equal(core.asset.status,200);assert(core.asset.bytes>0);assert.equal(core.online.status,503);
  report.checks.push('Actual Windows executable loads full offline title/artwork with isolated renderer and safe network failure');
  await click(desktop,'press-start');await click(desktop,'new-game');assert(await desktop.evaluate('!!document.getElementById("trainer-name")&&!!document.getElementById("begin")'));await screenshot(desktop,'new-game-form');await click(desktop,'back-title');
  await desktop.evaluate(`localStorage.setItem(${JSON.stringify(SAVE_KEY)},${JSON.stringify(JSON.stringify(fixture))})`);await stop();stop=null;
  stop=await connect(false,9230,9231);await title(desktop);
  report.security=await main.evaluate(`(()=>{const E=require('electron');const all=E.BrowserWindow.getAllWindows();if(all.length!==1)throw Error('Expected one candidate window');const w=all[0];if(w.webContents.getURL()!==${JSON.stringify(ORIGIN+'/')})throw Error('Wrong candidate origin');globalThis.__allovaQA={desktopWindow:w};const p=w.webContents.getLastWebPreferences();return {count:all.length,electron:process.versions.electron,chromium:process.versions.chrome,userData:E.app.getPath('userData'),nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation,sandbox:p.sandbox,webSecurity:p.webSecurity,preload:p.preload??null,preloadFieldPresent:Object.hasOwn(p,'preload'),devTools:p.devTools??null,constructorProof:{mainSha256:${JSON.stringify(MAIN_SHA)},configuredPreload:'none',configuredDevTools:false},contentSize:w.getContentSize(),originalDownloadListeners:w.webContents.session.listenerCount('will-download'),defaultExportPath:require('node:path').join(E.app.getPath('downloads'),'allova-save.json')}})()`);
  assert.equal(report.security.electron,'44.6.0');assert.equal(report.security.nodeIntegration,false);assert.equal(report.security.contextIsolation,true);assert.equal(report.security.sandbox,true);assert.equal(report.security.webSecurity,true);if(report.security.preloadFieldPresent)assert.equal(report.security.preload,'');assert.equal(report.security.originalDownloadListeners,1);
  await check('Audited devTools:false prevents the supported DevTools opening API',async()=>{
   report.devToolsProbe=await main.evaluate(`(${probeDevToolsDisabled.toString()})(globalThis.__allovaQA.desktopWindow,()=>require('electron').webContents.getAllWebContents().map(w=>({id:w.id,type:w.getType()})))`);
   assert.equal(report.devToolsProbe.passed,true,'DevTools unexpectedly opened or created new WebContents');
  });
  await click(desktop,'press-start');assert((await desktop.evaluate('document.getElementById("continue")?.innerText||""')).includes('Desktop QA'));await screenshot(desktop,'retained-save');
  const auth=await desktop.evaluate(`(async()=>{const r=await fetch('/api/phone-config',{cache:'no-store'});const d=await r.json();return{status:r.status,enabled:d.enabled,origin:new URL(d.url).origin}})()`);assert.equal(auth.status,200);assert.equal(auth.origin,'https://tyzpaxcqpygnnlftxapf.supabase.co');report.checks.push('Synthetic save survives close/relaunch; live unauthenticated phone configuration read succeeds');
  await click(desktop,'continue');await screenshot(desktop,'continued-game');
  await check('Original download policy accepts user export; full JSON import round-trip preserves adventure',async()=>{
   const downloads=join(out,'downloads');await mkdir(downloads,{recursive:true});const backup=join(downloads,'allova-save.json');await assert.rejects(stat(backup),{code:'ENOENT'});
   await click(desktop,'quick-options');await click(desktop,'options-tab-save');
   const preExport=await desktop.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(SAVE_KEY)}))`);assert.equal(preExport.name,'Desktop QA');assert.equal(preExport.version,1);assert.deepEqual(preExport.party,fixture.party);
   report.exportObserver=await main.evaluate(`(${installExportObserver.toString()})(globalThis.__allovaQA,${JSON.stringify(backup)},${JSON.stringify(report.security.defaultExportPath)})`);assert.equal(report.exportObserver.listenerCountAfter,2);
   await desktop.evaluate(`document.getElementById('export').addEventListener('click',e=>{window.__exportClickEvidence={trusted:e.isTrusted,activation:navigator.userActivation.isActive}},{once:true})`);
   await click(desktop,'export');
   await until(async()=>{const e=await main.evaluate('globalThis.__allovaQA.exportEvidence');report.exportEvidence=e;if(e.rejected)throw Error(e.rejected);return !!e.done},'accepted DownloadItem completion',25);
   const clickEvidence=await desktop.evaluate('window.__exportClickEvidence');report.exportClick=clickEvidence;assert.equal(clickEvidence.trusted,true);assert.equal(clickEvidence.activation,true);assert.equal(report.exportEvidence.defaultPrevented,false);assert.equal(report.exportEvidence.done,'completed');assert.equal(report.exportEvidence.savedPath,backup);
   const size=(await stat(backup)).size;assert(size>0&&size<=400000);const exported=JSON.parse(await readFile(backup,'utf8'));assert.deepEqual(stableSave(exported),stableSave(preExport));
   // Deliberately change one fictional name so a no-op import cannot pass.
   const importCopy=structuredClone(exported);importCopy.name='Desktop Import';const importPath=join(downloads,'import-copy.json');await writeFile(importPath,JSON.stringify(importCopy));
   const doc=await desktop.rpc('DOM.getDocument');const input=await desktop.rpc('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#import-save'});assert(input.nodeId);await desktop.rpc('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[importPath]});
   await until(()=>desktop.evaluate('document.getElementById("choice-0")?.innerText==="Import save"'),'explicit import review');assert((await desktop.evaluate('document.getElementById("dialogue").innerText')).includes('Desktop Import'));await screenshot(desktop,'import-review');await click(desktop,'choice-0');
   const imported=await desktop.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(SAVE_KEY)}))`);assert.deepEqual(stableSave(imported),stableSave(importCopy));assert.equal(imported.name,'Desktop Import');await screenshot(desktop,'imported-adventure');
  });
  // Reference is an additional test-only sandboxed window with an ephemeral session.
  // It uses the real production web delivery, not the candidate's custom protocol.
  const referenceReady=await check('Create isolated live-web reference at matched native content size',async()=>{
   report.reference=await main.evaluate(`(async()=>{const E=require('electron'),q=globalThis.__allovaQA;const s=E.session.fromPartition('allova-reference-'+Date.now());s.setPermissionRequestHandler((_w,_p,cb)=>cb(false));s.setPermissionCheckHandler(()=>false);s.setDevicePermissionHandler(()=>false);s.webRequest.onBeforeRequest((d,cb)=>{let allowed=false;try{const u=new URL(d.url);allowed=['GET','HEAD'].includes(d.method)&&((u.protocol==='https:'&&u.origin===${JSON.stringify(ORIGIN)}&&(!u.pathname.startsWith('/api/')||['/api/version','/api/phone-config'].includes(u.pathname)))||(u.protocol==='blob:'&&u.origin===${JSON.stringify(ORIGIN)})||(u.protocol==='data:'&&['image','font','media'].includes(d.resourceType)))}catch{}cb({cancel:!allowed})});const size=q.desktopWindow.getContentSize();const w=new E.BrowserWindow({width:size[0],height:size[1],useContentSize:true,show:false,webPreferences:{session:s,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false,webviewTag:false}});q.referenceWindow=w;w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',e=>{if(e.url!==${JSON.stringify(ORIGIN+'/')})e.preventDefault()});w.webContents.on('will-attach-webview',e=>e.preventDefault());w.setMenu(null);w.webContents.setZoomFactor(q.desktopWindow.webContents.getZoomFactor());await w.loadURL(${JSON.stringify(ORIGIN+'/')});return {id:w.id,contentSize:w.getContentSize(),ephemeral:true,network:'GET/HEAD static plus version/phone-config only'}})()`,{timeout:120000});
   const targets=await(await fetch('http://127.0.0.1:9230/json/list')).json();const existing=desktop.ws.url;const target=targets.find(t=>t.type==='page'&&t.url===ORIGIN+'/'&&t.webSocketDebuggerUrl!==existing);assert(target);reference=await CDP.connect(target.webSocketDebuggerUrl);await reference.rpc('Runtime.enable');await reference.rpc('Page.enable');
   const source=await reference.evaluate(`(async()=>{const r=await fetch('/game.js',{cache:'no-store'});const bytes=await r.arrayBuffer();return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('')})()`);assert.equal(source,CLIENT_SHA,'Live web version must be exactly the packaged game');report.reference.gameJsSha256=source;
  });
  if(referenceReady)await check('Matched live-web/Windows visual, animation, audio and control evidence',async()=>{
   await runParity({desktop,reference,fixture,report,out,main,wait,until,click,key,screenshot});
  });
 }catch(e){report.errors.push(String(e.stack||e));try{await screenshot(desktop,'fatal-failure')}catch{}}
 finally{
  if(main)try{report.exportEvidence=await main.evaluate('globalThis.__allovaQA?.exportEvidence||null')}catch{}
  if(stop)await stop();else if(child?.pid&&child.exitCode===null)spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore'});
  report.packageFilesAfter=await hashes();try{assert.deepEqual(report.packageFilesAfter,beforeHashes);report.checks.push('Protected wrapper, manifest and game bundle hashes remain unchanged after QA')}catch(e){report.errors.push(String(e))}
  report.status=report.errors.length?'failed':'passed';await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
 }
}

/**
 * Local authoring helper. Inline runParity into the approved Windows verification
 * script; do not package this file or inject application/test replacement code.
 */
export async function runParity({desktop, reference, fixture, report, out, main, wait, until, click, key, screenshot}) {
  const {default: assert} = await import('node:assert/strict');
  const {writeFile} = await import('node:fs/promises');
  const {join} = await import('node:path');
  const started = Date.now(), deadline = started + 370000, cleanupDeadline = started + 400000;
  let currentDeadline = deadline;
  const saveKey = 'allova.first-journey.v1';
  const original = typeof fixture === 'string' ? JSON.parse(fixture) : structuredClone(fixture);
  assert(original?.version === 1 && original?.name === 'Desktop QA', 'Only the fictional Desktop QA fixture is allowed');
  const surfaces = [{name:'desktop', cdp:desktop, window:'desktopWindow'}, {name:'web', cdp:reference, window:'referenceWindow'}];
  const proof = report.parity = {
    status:'running', workBudgetMs:370000,cleanupHeadroomMs:30000, viewportRequested:{width:1008,height:655}, phases:[], pairs:[], captures:[], motion:[], audio:{}, controls:{},
    method:{application:'Unmodified packaged Windows renderer and production web renderer',
      input:'CDP Input mouse and keyboard actions on real game controls',
      fixture:'Fictional Desktop QA save seeded before each new document in the runner-only fresh profile',
      normalization:'Same BrowserWindow content size, zoom level 0, and no-preference reduced-motion media',
      runtimePatches:[], imageComparison:'No pixel tolerance or automated visual-equivalence claim. Full PNG pairs and phase metadata require independent review.'},
    limitations:['No physical speaker or human audibility verification.', 'No gamepad support claim; this check exercises mouse and keyboard.',
      'Live animation clocks, CSS blink phase, save timestamps, and randomly generated opponent traits are not frozen or patched.',
      'Reference window fullscreen is not exercised because its restricted test session denies fullscreen permission.'],
  };
  const failures=[];
  const safe = async fn => { try {return await fn()} catch {return null} };
  function remaining(label,cap=20000){const left=currentDeadline-Date.now();assert(left>0,label+': execution budget exhausted');return Math.max(1,Math.min(cap,left))}
  async function boundedUntil(fn,label,seconds=30){return until(fn,label,Math.min(seconds,remaining(label,seconds*1000)/1000))}
  async function phase(name, fn, {cleanup=false}={}) {
    currentDeadline=cleanup?cleanupDeadline:deadline;
    const row={name,status:'running',startedAt:new Date().toISOString()};proof.phases.push(row);
    try {remaining(name);row.result=await fn();row.status='passed';}
    catch(error) {row.status='failed';row.error=String(error.stack||error);failures.push(name+': '+error.message);}
    finally {row.elapsedMs=Date.now()-Date.parse(row.startedAt);currentDeadline=deadline}
    return row;
  }
  async function foreground(s) {
    const state=await main.evaluate(`(()=>{const w=globalThis.__allovaQA[${JSON.stringify(s.window)}];if(!w||w.isDestroyed())throw Error('Missing QA window');if(w.isMinimized())w.restore();w.show();w.focus();return {visible:w.isVisible(),focused:w.isFocused(),bounds:w.getContentBounds(),fullscreen:w.isFullScreen()}})()`);
    assert(state.visible, s.name+' window must be shown for real rendering/audio');
    await s.cdp.rpc('Page.bringToFront');
    await boundedUntil(()=>s.cdp.evaluate('!document.hidden'),s.name+' visible document',5);
    return state;
  }
  const visibleExpr = id => `(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e||e.closest('[hidden]'))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'})()`;
  const visible = (s,id) => s.cdp.evaluate(visibleExpr(id));
  async function see(s,id,seconds=15){await boundedUntil(()=>safe(()=>visible(s,id)),s.name+' visible #'+id,Math.max(1,Math.min(seconds,(currentDeadline-Date.now())/1000)))}
  async function titleReady(s,seconds=70){await boundedUntil(async()=>{if(await safe(()=>visible(s,'press-start')))return true;if(await safe(()=>visible(s,'intro-skip')))await click(s.cdp,'intro-skip');return false},s.name+' complete title via real intro-skip control',Math.max(1,Math.min(seconds,(currentDeadline-Date.now())/1000)))}
  async function realClick(s,id){await foreground(s);await see(s,id);await click(s.cdp,id)}
  async function reset(s,save,label) {
    await foreground(s);
    const previous=await s.cdp.evaluate('performance.timeOrigin');
    // Seeding on the next document prevents the old pagehide autosave from
    // overwriting the requested fictional scenario. The script is then removed.
    const source=`(()=>{if(location.origin!=='https://armageddonallova.win')return;for(const k of ${JSON.stringify([saveKey,'allova.save-before-harvest.v1','allova.presentation.v1','allova.touch-controls.v1'])})localStorage.removeItem(k);${save?`localStorage.setItem(${JSON.stringify(saveKey)},${JSON.stringify(JSON.stringify(save))});`:''}})();`;
    const injected=await s.cdp.rpc('Page.addScriptToEvaluateOnNewDocument',{source});
    try {
      await s.cdp.rpc('Page.reload',{ignoreCache:false});
      await boundedUntil(()=>safe(()=>s.cdp.evaluate(`performance.timeOrigin!==${JSON.stringify(previous)}&&document.readyState!=='loading'`)),s.name+' fresh '+label+' document',30);
      await titleReady(s);
      const actual=await s.cdp.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(saveKey)})||'null')`);
      if(save){assert.equal(actual?.name,save.name);assert.equal(actual?.map,save.map);assert.equal(actual?.x,save.x);assert.equal(actual?.y,save.y)}
      else assert.equal(actual,null,'Empty-title scenario must not contain an adventure');
    } finally {await s.cdp.rpc('Page.removeScriptToEvaluateOnNewDocument',{identifier:injected.identifier})}
  }
  async function metadata(s) {
    return s.cdp.evaluate(`(()=>{
      const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
      const visible=e=>{if(!e||e.closest('[hidden]'))return false;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden'};
      const ids=['game','top-display','control-display','overlay','command-panel','lower-home','display-preview','battle-hud','dialogue','press-start','continue','trainer-name','begin'];
      const e=document.getElementById('game');
      return {url:location.href,title:document.title,performanceNow:performance.now(),timeOrigin:performance.timeOrigin,visibility:document.visibilityState,
        viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,visualWidth:visualViewport?.width,visualHeight:visualViewport?.height,visualScale:visualViewport?.scale},
        reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,fullscreen:!!document.fullscreenElement,
        canvas:e?{width:e.width,height:e.height,rect:rect(e)}:null,console:rect(document.querySelector('.console')),
        elements:Object.fromEntries(ids.map(id=>{const e=document.getElementById(id);return [id,{visible:visible(e),rect:rect(e),kind:e?.dataset.kind||null}]})),
        visibleButtons:[...document.querySelectorAll('button')].filter(visible).map(e=>({id:e.id,text:e.innerText,disabled:e.disabled,pressed:e.getAttribute('aria-pressed'),rect:rect(e)})),
        text:{location:document.getElementById('location-name')?.textContent,lowerLocation:document.getElementById('lower-location')?.textContent,overlay:document.getElementById('overlay')?.innerText,commands:document.getElementById('command-panel')?.innerText,dialogue:document.getElementById('dialogue')?.innerText,ally:document.getElementById('ally-label')?.innerText,enemy:document.getElementById('enemy-label')?.innerText},
        visibleImages:[...document.images].filter(visible).map(i=>({src:i.currentSrc||i.src,complete:i.complete,width:i.naturalWidth,height:i.naturalHeight})),
        animations:document.getAnimations().map(a=>({target:a.effect?.target?.id||a.effect?.target?.className||null,name:a.animationName||null,currentTime:a.currentTime,playState:a.playState,timing:a.effect?.getComputedTiming?.()}))};
    })()`);
  }
  async function capture(s,label) {
    await foreground(s);
    await s.cdp.evaluate('document.fonts.ready.then(()=>true)',{timeout:remaining('Font readiness',8000)});
    await boundedUntil(()=>s.cdp.evaluate(`[...document.images].filter(i=>!i.closest('[hidden]')&&i.getBoundingClientRect().width>0&&i.getBoundingClientRect().height>0).every(i=>i.complete&&i.naturalWidth>0)`),s.name+' loaded visible images '+label,20);
    const before=await metadata(s), name='parity-'+label+'-'+s.name;
    await screenshot(s.cdp,name);
    const after=await s.cdp.evaluate('({performanceNow:performance.now(),visibility:document.visibilityState})');
    const row={surface:s.name,label,file:name+'.png',before,after};proof.captures.push(row);
    assert.equal(before.viewport.width,1008,s.name+' screenshot width');assert.equal(before.viewport.height,655,s.name+' screenshot height');return row;
  }
  function comparePair(label) {
    const captures=surfaces.map(s=>proof.captures.find(c=>c.surface===s.name&&c.label===label));
    const row={label,status:'incomplete',images:captures.filter(Boolean).map(c=>c.file),visualReview:'pending'};proof.pairs.push(row);
    if(captures.some(c=>!c)){row.reason='At least one scenario capture did not complete';throw Error(label+': '+row.reason)}
    const [a,b]=captures.map(c=>c.before);assert.deepEqual(a.viewport,b.viewport,label+' viewport and device scale must match');
    assert.equal(a.canvas.width,b.canvas.width,label+' native canvas width');assert.equal(a.canvas.height,b.canvas.height,label+' native canvas height');
    const deltas=[];
    for(const target of ['console','canvas']){
      const ar=target==='canvas'?a.canvas.rect:a.console,br=target==='canvas'?b.canvas.rect:b.console;
      for(const key of ['x','y','width','height'])deltas.push({target,key,delta:Math.abs(ar[key]-br[key])});
    }
    row.geometryDeltas=deltas;assert(deltas.every(d=>d.delta<=1),label+' principal layout differs by more than one CSS pixel');
    row.status='matched-viewport-and-principal-geometry';row.note='This is a layout check, not a pixel-equivalence or art-quality pass.';
  }
  async function motion(s,label,{frames=7,interval=130,requireChange=true}={}) {
    await foreground(s);
    const name='parity-motion-'+label+'-'+s.name;
    await screenshot(s.cdp,name+'-start');
    const samples=await s.cdp.evaluate(`(async()=>{
      const canvas=document.getElementById('game'),ctx=canvas.getContext('2d'),samples=[];let prior=null;
      for(let n=0;n<${frames};n++){
        if(n)await new Promise(r=>setTimeout(r,${interval}));
        const time=performance.now(),pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
        let changedPixels=0;if(prior)for(let i=0;i<pixels.length;i+=4)if(pixels[i]!==prior[i]||pixels[i+1]!==prior[i+1]||pixels[i+2]!==prior[i+2]||pixels[i+3]!==prior[i+3])changedPixels++;
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels)),v=>v.toString(16).padStart(2,'0')).join('');
        samples.push({time,sha256:digest,changedPixelsFromPrevious:prior?changedPixels:null,visible:!document.hidden});prior=new Uint8ClampedArray(pixels);
      }return {width:canvas.width,height:canvas.height,samples};
    })()`);
    await screenshot(s.cdp,name+'-end');
    const row={surface:s.name,label,files:[name+'-start.png',name+'-end.png'],...samples,distinctFrames:new Set(samples.samples.map(x=>x.sha256)).size};row.observation=row.distinctFrames>1?'canvas changed':'no canvas change observed';proof.motion.push(row);
    assert(samples.samples.every(x=>x.visible),'Motion samples must be foreground/visible');
    if(requireChange)assert(row.distinctFrames>1,s.name+' actual game canvas did not change during '+label);
    return row;
  }
  async function continueFixture(s) {await realClick(s,'press-start');await see(s,'continue');await realClick(s,'continue');await see(s,'quick-party');await wait(450)}
  async function advanceTo(s,id,label,seconds=35) {
    const end=Math.min(currentDeadline,Date.now()+seconds*1000),transcript=[];
    while(Date.now()<end){
      if(await visible(s,id))return transcript;
      if(await visible(s,'battle-next')){transcript.push(await s.cdp.evaluate('document.getElementById("dialogue")?.innerText||""'));await realClick(s,'battle-next')}
      else await wait(150);
    }
    throw Error(s.name+' timed out advancing explicit battle messages to '+label+'; '+JSON.stringify(transcript));
  }
  async function enterYoungsterBattle(s) {
    // Continue can trigger trainer sight before quick-party is usable. Observe
    // the real dialogue path; never require a manual challenge that may not exist.
    await realClick(s,'press-start');await see(s,'continue');await realClick(s,'continue');
    const began=Date.now(),end=Math.min(currentDeadline,began+25000),observations=[];
    let manualInteractionAttempted=false,manualChoiceAccepted=false,sawYoungster=false;
    while(Date.now()<end){
      const ui=await s.cdp.evaluate(`(()=>{const shown=id=>{const e=document.getElementById(id);if(!e||e.closest('[hidden]'))return false;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden'};return {text:document.getElementById('dialogue')?.innerText||'',choice:document.getElementById('choice-0')?.innerText||'',buttons:Object.fromEntries(['fight','battle-next','choice-0','dialogue-next','quick-party'].map(id=>[id,shown(id)]))}})()`),text=ui.text;
      if(/Youngster/.test(text))sawYoungster=true;
      if(ui.buttons.fight||ui.buttons['battle-next']){
        assert(sawYoungster,s.name+' entered a battle without observing Youngster');
        return {path:manualChoiceAccepted?'explicit manual challenge':'automatic trainer sight',manualInteractionAttempted,observations};
      }
      if(ui.buttons['choice-0']){
        assert(/Youngster/.test(text),s.name+' unexpected choice speaker: '+text);
        const choice=ui.choice;
        assert(/battle|rematch/i.test(choice),s.name+' unexpected Youngster choice: '+choice);
        observations.push({control:'choice-0',text,choice});manualChoiceAccepted=true;await realClick(s,'choice-0');
      }else if(ui.buttons['dialogue-next']){
        assert(/Youngster/.test(text),s.name+' unexpected pre-battle dialogue: '+text);
        observations.push({control:'dialogue-next',text});await realClick(s,'dialogue-next');
      }else if(!manualInteractionAttempted&&Date.now()-began>2000&&ui.buttons['quick-party']){
        // A visible field control can still be temporarily locked by trainer
        // notice. This attempt is recorded, and observation continues afterward.
        manualInteractionAttempted=true;await realClick(s,'game');await key(s.cdp,'e','KeyE',50);
      }else await wait(120);
    }
    throw Error(s.name+' Youngster did not reach real battle controls: '+JSON.stringify(observations));
  }
  async function liveAudio(s) {
    // Keep current-document AudioContext creation within the bounded CDP event
    // history rather than relying on a context from previous scenario reloads.
    await reset(s,original,'audio activation');await continueFixture(s);await foreground(s);
    assert(Array.isArray(s.cdp.events),'CDP event recording is required for live audio proof');
    await s.cdp.rpc('WebAudio.enable');
    const initial=await s.cdp.evaluate('document.getElementById("sound").getAttribute("aria-pressed")');
    // A real click switches existing default audio off, then on, allowing the
    // game's own pointer activation path to resume its real AudioContext.
    if(initial==='true')await realClick(s,'sound');
    assert.equal(await s.cdp.evaluate('document.getElementById("sound").getAttribute("aria-pressed")'),'false');
    const activationBefore=new Set(s.cdp.events);
    await realClick(s,'sound');
    assert.equal(await s.cdp.evaluate('document.getElementById("sound").getAttribute("aria-pressed")'),'true');
    await wait(500);
    const contexts=new Map();
    for(const e of s.cdp.events){if(['WebAudio.contextCreated','WebAudio.contextChanged'].includes(e.method))contexts.set(e.params.context.contextId,e.params.context);else if(e.method==='WebAudio.contextWillBeDestroyed')contexts.delete(e.params.contextId)}
    const candidates=[...contexts.values()].filter(c=>c.contextType==='realtime').reverse();assert(candidates.length,s.name+' real AudioContext was not reported');
    let context,first,last,lastError;
    for(const c of candidates){remaining('Live audio context');try{const a=await s.cdp.rpc('WebAudio.getRealtimeData',{contextId:c.contextId},remaining('Live audio first sample',5000));await wait(400);const b=await s.cdp.rpc('WebAudio.getRealtimeData',{contextId:c.contextId},remaining('Live audio second sample',5000));if(b.realtimeData.currentTime>a.realtimeData.currentTime){context=c;first=a.realtimeData;last=b.realtimeData;break}}catch(e){lastError=String(e)}}
    assert(context,s.name+' real audio clock did not advance: '+(lastError||JSON.stringify(candidates)));
    const events=s.cdp.events.filter(e=>e.method.startsWith('WebAudio.')&&!activationBefore.has(e));
    const nodes=events.filter(e=>e.method==='WebAudio.audioNodeCreated'&&e.params.node.contextId===context.contextId).map(e=>e.params.node);
    const connections=events.filter(e=>e.method==='WebAudio.nodesConnected'&&e.params.contextId===context.contextId).map(e=>e.params);
    const row={surface:s.name,initialPressed:initial,offThenOn:true,context,first,last,clockAdvance:last.currentTime-first.currentTime,
      sourceNodes:nodes.filter(n=>/BufferSource|Oscillator|ConstantSource/.test(n.nodeType)),nodeTypes:[...new Set(nodes.map(n=>n.nodeType))],connections,
      eventScope:'Only new WebAudio events after the real sound-on click',eventCount:events.length,claim:'Actual game WebAudio context, graph and advancing render clock observed; physical audibility is not measured.'};
    proof.audio[s.name]=row;
    assert(row.clockAdvance>0.05,s.name+' audio render clock advance was too small');
    assert(row.sourceNodes.length>0,s.name+' game created no observable audio source node');assert(connections.length>0,s.name+' game audio graph has no observed connections');
    return row;
  }

  for(const s of surfaces) await phase(s.name+' configure real viewport',async()=>{
    await main.evaluate(`(()=>{const w=globalThis.__allovaQA[${JSON.stringify(s.window)}];if(w.isFullScreen())w.setFullScreen(false);w.setContentSize(1008,655);w.webContents.setZoomLevel(0);return w.getContentBounds()})()`);
    await s.cdp.rpc('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await s.cdp.rpc('WebAudio.enable');
    await foreground(s);return (await metadata(s)).viewport;
  });
  for(const s of surfaces) await phase(s.name+' empty title and trainer form',async()=>{
    await reset(s,null,'empty title');await capture(s,'title');await realClick(s,'press-start');await realClick(s,'new-game');await see(s,'trainer-name');
    await realClick(s,'trainer-name');
    await s.cdp.rpc('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65,nativeVirtualKeyCode:65});
    await s.cdp.rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65,nativeVirtualKeyCode:65});
    await s.cdp.rpc('Input.insertText',{text:'Parity QA'});
    await realClick(s,'choose-alaina');assert.equal(await s.cdp.evaluate('document.getElementById("trainer-name").value'),'Parity QA');
    assert.equal(await s.cdp.evaluate('document.getElementById("choose-alaina").getAttribute("aria-pressed")'),'true');
    assert.equal(await s.cdp.evaluate('document.getElementById("begin").disabled'),false);
    await capture(s,'trainer-form');await realClick(s,'back-title');await see(s,'new-game');
    return {nameInput:'Parity QA',avatar:'alaina',beginAvailable:true,backReturnsToTitleMenu:true};
  });
  for(const s of surfaces) await phase(s.name+' saved title Sunset and party',async()=>{
    await reset(s,original,'saved title');await realClick(s,'press-start');assert((await s.cdp.evaluate('document.getElementById("continue")?.innerText||""')).includes('Desktop QA'));
    await capture(s,'saved-title');await realClick(s,'continue');await see(s,'quick-party');await wait(700);await capture(s,'sunset');
    await motion(s,'sunset-idle',{frames:7,interval:190,requireChange:false});
    await realClick(s,'quick-party');await see(s,'party-slot-0');await capture(s,'party-roster');await realClick(s,'party-slot-0');await realClick(s,'party-summary');
    await boundedUntil(()=>s.cdp.evaluate('!!document.querySelector(".summary-tabs")&&!!document.querySelector(".party-summary-top")'),s.name+' real party detail',10);
    await capture(s,'party-detail');
    for(let i=0;i<5 && !(await visible(s,'quick-party'));i++)await key(s.cdp,'Escape','Escape',50);
    await see(s,'quick-party');return {saveName:original.name,map:original.map,partySpecies:original.party.map(p=>p.id)};
  });
  for(const label of ['title','trainer-form','saved-title','sunset','party-roster','party-detail'])await phase('matched '+label+' geometry',async()=>comparePair(label));
  for(const s of surfaces)await phase(s.name+' real audio activation',()=>liveAudio(s));

  for(const s of surfaces) await phase(s.name+' keyboard movement and saved position',async()=>{
    await reset(s,original,'keyboard controls');await continueFixture(s);
    const before=await s.cdp.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(saveKey)}))`),attempts=[];
    let moved;
    for(const [input,code] of [['ArrowDown','ArrowDown'],['ArrowRight','ArrowRight'],['ArrowLeft','ArrowLeft'],['ArrowUp','ArrowUp']]){
      await realClick(s,'game');const held=key(s.cdp,input,code,1000);let walking;try{walking=await motion(s,'keyboard-walk-'+input,{frames:7,interval:100,requireChange:false})}finally{await held}await wait(250);
      await realClick(s,'quick-options');await realClick(s,'options-tab-save');await realClick(s,'option-save');
      const after=await s.cdp.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(saveKey)}))`);
      attempts.push({key:input,map:after.map,x:after.x,y:after.y,dir:after.dir,steps:after.steps,distinctCanvasFrames:walking.distinctFrames});
      await key(s.cdp,'Escape','Escape',50);await see(s,'quick-party');
      if(after.map!==before.map||after.x!==before.x||after.y!==before.y){assert(walking.distinctFrames>1,s.name+' saved movement changed but live walking frames did not');moved=after;break}
    }
    proof.controls[s.name]={before:{map:before.map,x:before.x,y:before.y,steps:before.steps},attempts};
    assert(moved,s.name+' real keyboard directions did not change the saved player position');
    await s.cdp.rpc('Page.reload',{ignoreCache:false});await wait(300);await titleReady(s,60);await continueFixture(s);
    const retained=await s.cdp.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(saveKey)}))`);
    for(const k of ['map','x','y','dir'])assert.equal(retained[k],moved[k],s.name+' keyboard save '+k+' retained');
    proof.controls[s.name].retained={map:retained.map,x:retained.x,y:retained.y,dir:retained.dir};
    await screenshot(s.cdp,'parity-keyboard-position-'+s.name);return proof.controls[s.name];
  });

  await phase('desktop real fullscreen roundtrip',async()=>{
    const s=surfaces[0];await foreground(s);const before=await s.cdp.evaluate('({width:innerWidth,height:innerHeight,fullscreen:!!document.fullscreenElement})');
    assert.equal(before.fullscreen,false);await realClick(s,'fullscreen');await boundedUntil(()=>s.cdp.evaluate('!!document.fullscreenElement'),'desktop DOM fullscreen entered',8);
    const entered=await s.cdp.evaluate('({width:innerWidth,height:innerHeight,tag:document.fullscreenElement?.className})');await screenshot(s.cdp,'parity-desktop-fullscreen');
    await key(s.cdp,'Escape','Escape',50);await wait(400);
    const exitMethod='Escape keyboard';
    if(await s.cdp.evaluate('!!document.fullscreenElement')){proof.controls.fullscreen={before,entered,enterMethod:'real #fullscreen pointer click',exitMethod:'Escape failed; no synthetic exit accepted as a control pass'};await main.evaluate('globalThis.__allovaQA.desktopWindow.setFullScreen(false)');throw Error('Real Escape input did not exit DOM fullscreen; inspector window exit was cleanup only')}
    await boundedUntil(()=>s.cdp.evaluate('!document.fullscreenElement&&innerWidth===1008&&innerHeight===655'),'desktop original viewport restored after fullscreen',8);
    const after=await s.cdp.evaluate('({width:innerWidth,height:innerHeight,fullscreen:!!document.fullscreenElement})');assert.deepEqual(after,before);
    proof.controls.fullscreen={before,entered,after,enterMethod:'real #fullscreen pointer click',exitMethod};return proof.controls.fullscreen;
  });

  for(const s of surfaces) await phase(s.name+' real Youngster trainer battle',async()=>{
    const battle=structuredClone(original);Object.assign(battle,{map:'route1',x:18,y:47,dir:'up'});battle.defeated=(battle.defeated||[]).filter(id=>id!=='r1-youngster');
    await reset(s,battle,'Youngster route1 battle');const intro=await enterYoungsterBattle(s);
    const messages=await advanceTo(s,'fight','Fight command',40);await capture(s,'trainer-battle');
    const before=await s.cdp.evaluate('({ally:document.getElementById("ally-hp-value")?.innerText,enemyFill:document.getElementById("enemy-hp-fill")?.style.width,dialogue:document.getElementById("dialogue")?.innerText})');
    await realClick(s,'fight');await see(s,'move-0');await capture(s,'battle-moves');await realClick(s,'move-0');
    await motion(s,'battle-move',{frames:8,interval:95});
    const afterMove=await s.cdp.evaluate('({ally:document.getElementById("ally-hp-value")?.innerText,enemyFill:document.getElementById("enemy-hp-fill")?.style.width,dialogue:document.getElementById("dialogue")?.innerText})');
    assert(/used|missed|attack|tackle/i.test(afterMove.dialogue||''),s.name+' battle move did not produce actual action text');
    await screenshot(s.cdp,'parity-battle-move-result-'+s.name);
    const turnMessages=[];let outcome='';const end=Math.min(currentDeadline,Date.now()+30000);
    while(Date.now()<end){
      if(await visible(s,'fight')){outcome='next real turn available';break}
      if(await visible(s,'quick-party')){outcome='trainer battle ended';break}
      if(await visible(s,'battle-next')){turnMessages.push(await s.cdp.evaluate('document.getElementById("dialogue")?.innerText||""'));await realClick(s,'battle-next')}
      else if(await visible(s,'dialogue-next')){turnMessages.push(await s.cdp.evaluate('document.getElementById("dialogue")?.innerText||""'));await realClick(s,'dialogue-next')}
      else if(await visible(s,'choice-0'))throw Error(s.name+' unexpected choice after first battle action: '+await s.cdp.evaluate('document.getElementById("dialogue")?.innerText||""'))
      else await wait(120);
    }
    assert(outcome,s.name+' battle did not reach next turn or battle end');
    return {fixture:{map:battle.map,x:battle.x,y:battle.y,dir:battle.dir,opponent:'r1-youngster'},intro,messages,before,afterMove,turnMessages,outcome,
      randomOpponent:'Fresh in-game trainer generation remains unmodified; random traits and damage are not compared pixel-for-pixel.'};
  });
  for(const label of ['trainer-battle','battle-moves'])await phase('matched '+label+' geometry',async()=>comparePair(label));

  await phase('all 33 bundled MP3 files decode sequentially',async()=>{
    const manifest=await main.evaluate(`require(require('node:path').join(require('electron').app.getAppPath(),'client-manifest.json'))`);
    const entries=Object.entries(manifest).filter(([path])=>path.endsWith('.mp3')).sort(([a],[b])=>a.localeCompare(b));assert.equal(entries.length,33,'Exact bundled music count');
    const decoded=[];proof.audio.bundledMP3=decoded;
    for(const [path,expected] of entries){
      remaining('Decode '+path);
      assert(/^assets\/music\/[A-Za-z0-9_./-]+\.mp3$/.test(path),'Safe manifest-owned music path');
      const item=await desktop.evaluate(`(async()=>{const path=${JSON.stringify(path)},response=await fetch('/'+path,{cache:'force-cache'});if(!response.ok)throw Error(path+' HTTP '+response.status);const bytes=await response.arrayBuffer(),sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');const context=new OfflineAudioContext(1,1,44100),buffer=await context.decodeAudioData(bytes.slice(0));let peak=0,energy=0,count=0;for(let channel=0;channel<buffer.numberOfChannels;channel++){const data=buffer.getChannelData(channel),stride=Math.max(1,Math.floor(data.length/100000));for(let i=0;i<data.length;i+=stride){const v=data[i];peak=Math.max(peak,Math.abs(v));energy+=v*v;count++}}return {path,status:response.status,bytes:bytes.byteLength,sha256,duration:buffer.duration,sampleRate:buffer.sampleRate,channels:buffer.numberOfChannels,frames:buffer.length,sampledPeak:peak,sampledRms:Math.sqrt(energy/count)}})()`,{timeout:remaining('Decode '+path,20000)});
      decoded.push(item);assert.equal(item.sha256,expected.sha256,path+' packaged SHA-256');assert.equal(item.bytes,expected.bytes,path+' packaged bytes');assert(item.duration>0&&item.frames>0&&item.channels>0&&item.sampledPeak>0,path+' nonempty decoded audio');
    }
    return {count:decoded.length,sequential:true,offlineDecodeOnly:true,physicalAudibility:false};
  });
  // Leave the normal fictional save in the desktop window rather than a battle
  // or fullscreen mode, including after an independently recorded phase failure.
  for(const s of surfaces)await phase(s.name+' restore fictional Sunset fixture',async()=>{await reset(s,original,'restored Sunset fixture');await continueFixture(s);return {map:original.map,x:original.x,y:original.y}},{cleanup:true});
  proof.elapsedMs=Date.now()-started;proof.status=failures.length?'failed':'evidence-collected';proof.visualReview='pending independent review of paired screenshots';proof.failures=failures;
  await writeFile(join(out,'parity-report.json'),JSON.stringify(proof,null,2)+'\n');
  assert.equal(failures.length,0,'Parity evidence failures: '+failures.join(' | '));
  report.checks.push('Matched 1008×655 real Windows and production-web title, trainer, town, party and trainer-battle evidence captured',
    'Actual renderer canvas motion and keyboard movement with retained saves verified on both surfaces',
    'Actual game WebAudio render clocks and graph activity observed; all 33 bundled MP3 files decoded and hash-checked',
    'Desktop fullscreen enter/exit restored its original viewport; screenshot equivalence remains subject to independent review');
  return proof;
}


// Local review source. Inline this function into the already approved CI script.
// This is a public-runtime API compatibility check, never an Allova/game test.
export async function runAPIPreflight({CDP, installExportObserver, probeDevToolsDisabled, wait, until}) {
  const {default: assert} = await import('node:assert/strict');
  const {spawn, spawnSync} = await import('node:child_process');
  const {readFile, writeFile, mkdir, mkdtemp, stat} = await import('node:fs/promises');
  const {resolve, join, basename, dirname} = await import('node:path');
  const {randomBytes} = await import('node:crypto');
  const {createServer} = await import('node:net');
  const started = Date.now(), deadline = started + 280000;
  const out = resolve('smoke-results');
  await mkdir(out, {recursive:true});
  const report = {
    kind:'synthetic-windows-electron-api-preflight', status:'running', startedAt:new Date().toISOString(),
    platform:process.platform, nodeVersion:process.version, runtimeExpected:'44.6.0', checks:[], errors:[], screenshots:[],
    limitations:[
      'Synthetic public-runtime API compatibility only. No game source, assets, draft release or user account is loaded.',
      'No game rendering, visual parity, physical audio audibility, or production save correctness claim.',
      'The native save-dialog configuration is read. The shared observer selects a fresh test path only after policy acceptance.',
      'Reference and default-context sentinels use synthetic data URLs; no production web content or external network is requested.',
    ],
    sources:[
      'https://www.electronjs.org/docs/latest/api/download-item',
      'https://www.electronjs.org/docs/latest/api/session',
      'https://www.electronjs.org/docs/latest/api/protocol',
      'https://chromedevtools.github.io/devtools-protocol/tot/WebAudio/',
    ],
  };
  let child, main, desktop, reference, sentinel, log = '', shutdownFile, expired = false, closing = false, attemptArmed = false;
  const connections = [];
  const remaining = (label, cap=20000) => {
    const left = deadline - Date.now();
    assert(!expired && left > 0, label + ': preflight execution budget exhausted');
    return Math.max(1, Math.min(cap, left));
  };
  async function poll(fn, label, seconds=15) {
    return until(async()=>{remaining(label);if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Synthetic Electron exited '+child.exitCode+'; '+log.slice(-2000));return fn()}, label, Math.min(seconds,remaining(label,seconds*1000)/1000));
  }
  async function connect(url, mainProcess=false) {
    const timeout=remaining('Debugger connection',8000);
    let timer;
    const pending=CDP.connect(url).then(c=>{if(closing){c.close();throw Error('Preflight is stopping')}return c});
    const c=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Debugger connection timeout')),timeout)})]).finally(()=>clearTimeout(timer));
    connections.push(c);
    const rpc=c.rpc.bind(c);
    c.rpc=(method,params={},limit=20000)=>rpc(method,params,remaining(method,limit));
    const evaluate=c.evaluate.bind(c);
    c.evaluate=(expression,options={})=>evaluate(expression,{...options,main:mainProcess,timeout:remaining('Runtime.evaluate',options.timeout||20000)});
    await c.rpc('Runtime.enable');
    if(!mainProcess){await c.rpc('Page.enable');await c.rpc('DOM.enable')}
    return c;
  }
  async function check(name, fn) {
    const row={name,status:'running',startedAt:new Date().toISOString()};report.checks.push(row);
    try {remaining(name);row.result=await fn();row.status='passed';return true}
    catch(error){row.status='failed';row.error=String(error.stack||error);report.errors.push(name+': '+error.message);return false}
    finally {
      if(attemptArmed){
        try{row.exportAttemptCleanup=await cleanupExportAttempt()}
        catch(error){row.status='failed';report.errors.push(name+' observer cleanup: '+error.message)}
      }
      row.elapsedMs=Date.now()-Date.parse(row.startedAt);await saveReport();
    }
  }
  async function cleanupExportAttempt(){
    const result=await main.evaluate(`(()=>{const q=globalThis.__preflight,c=q.observerCleanup;if(!c)throw Error('Missing QA observer cleanup identity');const s=q.desktopWindow.webContents.session;if(s.listeners('will-download')[0]!==c.policy)throw Error('Original policy identity/order changed');const wasPending=s.listeners('will-download').includes(c.observer);s.removeListener('will-download',c.observer);const remaining=s.listeners('will-download');if(remaining.length!==1||remaining[0]!==c.policy)throw Error('Unexpected download listeners after removing only QA observer');q.observerCleanup=null;return {removedPendingQAObserver:wasPending,originalPolicyRetained:true,remainingListenerCount:remaining.length,evidence:q.attempt.exportEvidence}})()`);
    attemptArmed=false;return result;
  }
  async function saveReport(){await writeFile(join(out,'api-preflight-report.json'),JSON.stringify(report,null,2));await writeFile(join(out,'api-preflight-runtime.log'),log)}
  async function targets(port) {
    const response=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(remaining('Target discovery',1500))});
    assert(response.ok,'Debugger target discovery failed');return response.json();
  }
  async function freePort() {
    const s=createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r)});
    const port=s.address().port;await new Promise((r,j)=>s.close(e=>e?j(e):r()));return port;
  }
  async function foreground(cdp, windowKey) {
    const state=await main.evaluate(`(()=>{const w=globalThis.__preflight[${JSON.stringify(windowKey)}];if(w.isMinimized())w.restore();w.show();w.focus();return {visible:w.isVisible(),focused:w.isFocused(),contentSize:w.getContentSize(),contentBounds:w.getContentBounds()}})()`);
    await cdp.rpc('Page.bringToFront');
    await poll(()=>cdp.evaluate('!document.hidden'),'foreground '+windowKey,5);
    assert(state.visible,'Window was not shown');return state;
  }
  async function click(cdp,id,windowKey='desktopWindow') {
    await foreground(cdp,windowKey);
    const b=await cdp.evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,disabled:e.disabled}})()`);
    assert(b&&b.width>0&&b.height>0&&!b.disabled,'Missing synthetic button '+id);
    await cdp.rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:b.x,y:b.y,button:'left',buttons:1,clickCount:1});
    await cdp.rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:b.x,y:b.y,button:'left',buttons:0,clickCount:1});
    await wait(100);
  }
  async function capture(cdp,windowKey,label) {
    const native=await foreground(cdp,windowKey);
    const before=await cdp.evaluate('({url:location.href,title:document.title,marker:document.body.dataset.preflight,visibility:document.visibilityState,focused:document.hasFocus(),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},fullscreen:!!document.fullscreenElement,time:performance.now()})');
    const shot=await cdp.rpc('Page.captureScreenshot',{format:'png'});
    const bytes=Buffer.from(shot.data,'base64');
    assert(bytes.length>100&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Screenshot must be a real PNG');
    const name='api-preflight-'+label+'.png';await writeFile(join(out,name),bytes);
    const row={file:name,bytes:bytes.length,pngWidth:bytes.readUInt32BE(16),pngHeight:bytes.readUInt32BE(20),native,before};report.screenshots.push(row);
    assert.equal(before.visibility,'visible');assert.equal(before.viewport.width,1008);assert.equal(before.viewport.height,655);return row;
  }
  async function closeConnections() {
    closing=true;
    await Promise.all(connections.map(c=>new Promise(resolve=>{
      if(c.ws.readyState===3){resolve();return}
      const timer=setTimeout(resolve,2000);
      c.ws.addEventListener('close',()=>{clearTimeout(timer);resolve()},{once:true});
      try{c.close()}catch{clearTimeout(timer);resolve()}
    })));
    report.cleanup={debuggerStatesBeforeQuit:connections.map(c=>c.ws.readyState)};
  }
  const watchdog=setTimeout(()=>{
    expired=true;report.deadlineExceeded=true;
    // Reject outstanding protocol work. Finally closes the sockets before quit.
    for(const c of connections)try{c.close()}catch{}
  },280000);
  try {
    assert.equal(process.platform,'win32','Preflight must execute on Windows');
    assert.equal(typeof CDP?.connect,'function');assert.equal(typeof installExportObserver,'function');assert.equal(typeof probeDevToolsDisabled,'function');
    const exe=resolve(process.env.ALLOVA_EXE||'');assert.equal(basename(exe).toLowerCase(),'electron.exe','Use the separately verified public Electron runtime');assert((await stat(exe)).isFile());
    const appDir=join(out,'preflight-app');await mkdir(appDir,{recursive:true});
    const fresh=await mkdtemp(join(appDir,'profile-'));
    const profile=join(fresh,'userData'),downloads=join(fresh,'downloads');
    await Promise.all([mkdir(profile),mkdir(downloads),mkdir(join(fresh,'appData')),mkdir(join(fresh,'localAppData'))]);
    shutdownFile=join(fresh,'shutdown.request');
    const config={origin:'https://armageddonallova.win',profile,downloads,shutdownFile,nonce:randomBytes(16).toString('hex'),payload:{format:'allova-api-preflight',version:1,name:'Synthetic API QA',value:17}};
    const mainSource='('+syntheticMain.toString()+')('+JSON.stringify(config)+');\n';
    await writeFile(join(appDir,'package.json'),JSON.stringify({name:'allova-api-preflight',version:'1.0.0',main:'main.cjs',private:true}));
    await writeFile(join(appDir,'main.cjs'),mainSource);
    const rendererPort=await freePort();let mainPort=await freePort();while(mainPort===rendererPort)mainPort=await freePort();
    report.launch={exe,appDir,profile,freshProfile:true,rendererPort,mainPort,network:'Synthetic local interception; all other requests blocked; DNS resolution disabled',sandbox:'Enabled normally, no sandbox/security disable flags'};
    const environment={...process.env,APPDATA:join(fresh,'appData'),LOCALAPPDATA:join(fresh,'localAppData')};delete environment.ELECTRON_RUN_AS_NODE;
    child=spawn(exe,[appDir,`--remote-debugging-port=${rendererPort}`,'--remote-debugging-address=127.0.0.1',`--inspect=127.0.0.1:${mainPort}`,'--enable-logging=stderr','--host-resolver-rules=MAP * ~NOTFOUND'],{
      cwd:dirname(exe),env:environment,stdio:['ignore','pipe','pipe'],
    });
    child.stdout.on('data',d=>{log+=d});child.stderr.on('data',d=>{log+=d});child.on('error',e=>{log+='\nSPAWN ERROR '+e;report.errors.push(String(e))});
    let mainTarget;
    await poll(async()=>{try{mainTarget=(await targets(mainPort)).find(t=>t.webSocketDebuggerUrl);return !!mainTarget}catch{return false}},'loopback main inspector',25);
    main=await connect(mainTarget.webSocketDebuggerUrl,true);
    await poll(()=>main.evaluate('!!globalThis.__preflight?.ready'),'synthetic windows initialized',30);
    report.mainInspector=await main.evaluate(`(()=>{const E=require('electron'),q=globalThis.__preflight;return {electron:process.versions.electron,chromium:process.versions.chrome,userData:E.app.getPath('userData'),expectedProfile:q.expectedProfile,profileSetBeforeSessions:q.profileSetBeforeSessions,pid:process.pid,ready:q.ready,targets:q.targets}})()`);
    assert.equal(report.mainInspector.electron,'44.6.0');assert.equal(report.mainInspector.userData,profile);assert.equal(report.mainInspector.expectedProfile,profile);assert.equal(report.mainInspector.profileSetBeforeSessions,true);assert.equal(report.mainInspector.pid,child.pid);
    let rendererTargets;
    await poll(async()=>{try{rendererTargets=await targets(rendererPort);return report.mainInspector.targets.every(t=>rendererTargets.some(r=>r.type==='page'&&r.url===t.url))}catch{return false}},'all synthetic renderer targets',20);
    report.targets=rendererTargets.map(({id,type,url,title})=>({id,type,url,title}));
    const locate=key=>{const expected=report.mainInspector.targets.find(t=>t.key===key);const matched=rendererTargets.filter(t=>t.type==='page'&&t.url===expected.url);assert.equal(matched.length,1,'Exactly one target for '+key);return matched[0]};
    desktop=await connect(locate('desktopWindow').webSocketDebuggerUrl);
    reference=await connect(locate('referenceWindow').webSocketDebuggerUrl);
    sentinel=await connect(locate('defaultWindow').webSocketDebuggerUrl);
    await check('main inspector, fresh profile, isolated sessions and target matching',async()=>{
      const sessions=await main.evaluate(`(()=>{const E=require('electron'),q=globalThis.__preflight;return {samePersistent:q.desktopWindow.webContents.session===E.session.fromPartition('persist:preflight-primary'),persistentIsDefault:q.desktopWindow.webContents.session===E.session.defaultSession,referenceIsDefault:q.referenceWindow.webContents.session===E.session.defaultSession,referenceIsPersistent:q.referenceWindow.webContents.session===q.desktopWindow.webContents.session,defaultIsDefault:q.defaultWindow.webContents.session===E.session.defaultSession,storage:{persistent:q.desktopWindow.webContents.session.storagePath,reference:q.referenceWindow.webContents.session.storagePath,default:E.session.defaultSession.storagePath},referencesUseDataURL:q.referenceWindow.webContents.getURL().startsWith('data:')&&q.defaultWindow.webContents.getURL().startsWith('data:'),interceptedSessions:q.interceptedSessions,constructorPreferences:q.constructorPreferences}})()`);
      assert(sessions.samePersistent&&sessions.defaultIsDefault&&sessions.referencesUseDataURL);assert(!sessions.persistentIsDefault&&!sessions.referenceIsDefault&&!sessions.referenceIsPersistent);assert.equal(sessions.storage.reference,null);assert(sessions.storage.persistent.startsWith(profile));assert.deepEqual(sessions.interceptedSessions,['persist:preflight-primary']);
      const identities=[];
      for(const [name,c] of [['primary',desktop],['reference',reference],['default',sentinel]]){
        const identity=await c.evaluate('({marker:document.body.dataset.preflight,url:location.href,requireType:typeof require,processType:typeof process})');
        assert.equal(identity.marker,name);assert.equal(identity.requireType,'undefined');assert.equal(identity.processType,'undefined');
        const frameTree=await c.rpc('Page.getFrameTree');const targetInfo=await c.rpc('Target.getTargetInfo');
        identities.push({name,...identity,frameId:frameTree.frameTree.frame.id,targetInfo:targetInfo.targetInfo,contexts:c.events.filter(e=>e.method==='Runtime.executionContextCreated')});
      }
      return {sessions,identities};
    });
    await check('core security preferences and functional devTools:false probe',async()=>{
      const preferences=await main.evaluate(`(()=>{const p=globalThis.__preflight.desktopWindow.webContents.getLastWebPreferences();return {nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation,sandbox:p.sandbox,webSecurity:p.webSecurity,preload:p.preload??null,preloadFieldPresent:Object.hasOwn(p,'preload'),constructorHasPreload:Object.hasOwn(globalThis.__preflight.constructorPreferences,'preload'),devToolsReported:Object.hasOwn(p,'devTools'),devToolsValue:p.devTools??null}})()`);
      assert.equal(preferences.nodeIntegration,false);assert.equal(preferences.contextIsolation,true);assert.equal(preferences.sandbox,true);assert.equal(preferences.webSecurity,true);assert.equal(preferences.constructorHasPreload,false);if(preferences.preloadFieldPresent)assert(!preferences.preload,'Unexpected preload reported');
      const probe=await main.evaluate(`(${probeDevToolsDisabled.toString()})(globalThis.__preflight.desktopWindow,()=>require('electron').webContents.getAllWebContents().map(w=>({id:w.id,type:w.getType()})))`);
      assert.equal(probe.passed,true,'Supported openDevTools API unexpectedly opened DevTools');return {preferences,probe};
    });
    // Negative no-gesture case comes BEFORE all mouse/keyboard dispatches.
    const backup=join(downloads,'accepted-allova-save.json'),expectedDefaultPath=join(downloads,'allova-save.json');
    async function observe(label) {
      const path=join(downloads,label+'-allova-save.json');await assert.rejects(stat(path),{code:'ENOENT'});
      const result=await main.evaluate(`(()=>{const q=globalThis.__preflight,s=q.desktopWindow.webContents.session,before=s.listeners('will-download');if(before.length!==1)throw Error('Expected only original policy before arming observer');q.attempt={desktopWindow:q.desktopWindow};const result=(${installExportObserver.toString()})(q.attempt,${JSON.stringify(path)},${JSON.stringify(expectedDefaultPath)});const added=s.listeners('will-download').filter(f=>!before.includes(f));if(added.length!==1||s.listeners('will-download')[0]!==before[0])throw Error('QA observer identity/order mismatch');q.observerCleanup={policy:before[0],observer:added[0]};return result})()`);
      attemptArmed=true;
      assert.equal(result.originalListenerCount,1);assert.equal(result.listenerCountAfter,2);return path;
    }
    async function evidence(done=false) {
      let e;
      await poll(async()=>{e=await main.evaluate('globalThis.__preflight.attempt.exportEvidence');if(done&&e.rejected)throw Error(e.rejected);return done?!!e.done:e.observed},done?'accepted export completion':'download policy observation',20);
      return e;
    }
    await check('no-gesture export is canceled without selecting any save path',async()=>{
      const path=await observe('no-gesture');
      const activation=await desktop.evaluate('({active:navigator.userActivation.isActive,ever:navigator.userActivation.hasBeenActive})');assert.equal(activation.active,false);
      await desktop.evaluate("window.exportSynthetic('application/json')",{userGesture:false});
      const e=await evidence();assert.equal(e.defaultPrevented,true);assert.notEqual(e.destinationSelected,true);assert.equal(e.gesture,false);await assert.rejects(stat(path),{code:'ENOENT'});
      return {activation,observer:e,policy:await main.evaluate('globalThis.__preflight.policyAttempts.at(-1)')};
    });
    await check('genuine mouse JSON Blob export passes policy and shared observer',async()=>{
      const path=await observe('accepted');assert.equal(path,backup);
      await click(desktop,'export');const e=await evidence(true);
      const gesture=await desktop.evaluate('window.preflightState.clicks.export');assert(gesture.trusted&&gesture.activation);
      assert.equal(e.defaultPrevented,false);assert.equal(e.originalStillFirst,true);assert.equal(e.destinationSelected,true);assert.equal(e.done,'completed');assert.equal(e.savedPath,path);assert.equal(e.initiator,config.origin);assert.equal(e.gesture,true);assert.equal(e.mime,'application/json');assert.equal(e.stateBefore,'progressing');assert.equal(e.pathBefore,'');
      assert.deepEqual(JSON.parse(await readFile(path,'utf8')),config.payload);return {gesture,observer:e,bytes:(await stat(path)).size,policy:await main.evaluate('globalThis.__preflight.policyAttempts.at(-1)')};
    });
    await check('genuine mouse bad-MIME export is canceled without a save destination',async()=>{
      const path=await observe('bad-mime');await click(desktop,'bad-mime');const e=await evidence();
      assert.equal(e.defaultPrevented,true);assert.notEqual(e.destinationSelected,true);assert.equal(e.mime,'text/plain');assert.equal(e.gesture,true);await assert.rejects(stat(path),{code:'ENOENT'});
      const gesture=await desktop.evaluate("window.preflightState.clicks['bad-mime']");assert(gesture.trusted&&gesture.activation);return {gesture,observer:e,policy:await main.evaluate('globalThis.__preflight.policyAttempts.at(-1)')};
    });
    await check('DOM.setFileInputFiles delivers the exact synthetic import and change event',async()=>{
      const imported={...config.payload,name:'Synthetic Import QA',value:29};const path=join(downloads,'import-copy.json');await writeFile(path,JSON.stringify(imported));
      const doc=await desktop.rpc('DOM.getDocument');const input=await desktop.rpc('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#import-save'});assert(input.nodeId);
      await desktop.rpc('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[path]});
      await poll(()=>desktop.evaluate('!!window.preflightState.imported'),'file input change event',5);
      const result=await desktop.evaluate('window.preflightState.imported');assert.deepEqual(result.json,imported);assert.equal(result.name,'import-copy.json');assert.equal(result.eventType,'change');return result;
    });
    await check('native matched viewport, foreground and PNG capture for both session types',async()=>{
      await main.evaluate("(()=>{for(const w of [globalThis.__preflight.desktopWindow,globalThis.__preflight.referenceWindow]){w.setContentSize(1008,655);w.webContents.setZoomLevel(0)}return true})()");
      return {primary:await capture(desktop,'desktopWindow','primary'),reference:await capture(reference,'referenceWindow','reference')};
    });
    await check('WebAudio events, genuine gesture source graph and advancing render clock',async()=>{
      assert(Array.isArray(desktop.events));await desktop.rpc('WebAudio.enable');await click(desktop,'audio');
      await poll(()=>desktop.evaluate("window.preflightState.audio?.state==='running'"),'genuine-gesture AudioContext running',8);
      await poll(async()=>desktop.events.some(e=>e.method==='WebAudio.contextCreated'&&e.params.context.contextType==='realtime'),'WebAudio contextCreated event',5);
      const contexts=new Map();for(const e of desktop.events)if(['WebAudio.contextCreated','WebAudio.contextChanged'].includes(e.method))contexts.set(e.params.context.contextId,e.params.context);
      const context=[...contexts.values()].find(c=>c.contextType==='realtime');assert(context);
      const first=(await desktop.rpc('WebAudio.getRealtimeData',{contextId:context.contextId})).realtimeData;await wait(500);const last=(await desktop.rpc('WebAudio.getRealtimeData',{contextId:context.contextId})).realtimeData;
      const events=desktop.events.filter(e=>e.method.startsWith('WebAudio.'));const nodes=events.filter(e=>e.method==='WebAudio.audioNodeCreated').map(e=>e.params.node);const connections=events.filter(e=>e.method==='WebAudio.nodesConnected').map(e=>e.params);
      const activation=await desktop.evaluate('window.preflightState.clicks.audio');assert(activation.trusted&&activation.activation);assert(last.currentTime-first.currentTime>0.05);assert(nodes.some(n=>/Oscillator/.test(n.nodeType)));assert(connections.length>0);
      return {activation,context,first,last,clockAdvance:last.currentTime-first.currentTime,nodes,connections,events};
    });
    await check('OfflineAudioContext decodes a generated 250 ms PCM WAV',async()=>{
      const result=await desktop.evaluate('window.decodeSyntheticWave()');assert.equal(result.channels,1);assert.equal(result.sampleRate,8000);assert.equal(result.frames,2000);assert(Math.abs(result.duration-0.25)<0.001);assert(result.peak>0.1);return result;
    });
    await check('DOM fullscreen enters by genuine click and exits by native-code Escape',async()=>{
      await click(desktop,'fullscreen');
      await poll(()=>desktop.evaluate('!!document.fullscreenElement'),'DOM fullscreen entered',8);
      const entered=await desktop.evaluate('({fullscreen:!!document.fullscreenElement,tag:document.fullscreenElement?.tagName,width:innerWidth,height:innerHeight,events:window.preflightState.fullscreenEvents})');
      const shot=await desktop.rpc('Page.captureScreenshot',{format:'png'});await writeFile(join(out,'api-preflight-fullscreen.png'),Buffer.from(shot.data,'base64'));report.screenshots.push({file:'api-preflight-fullscreen.png',entered});
      const fields={key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27};
      await desktop.rpc('Input.dispatchKeyEvent',{type:'rawKeyDown',...fields});await wait(75);await desktop.rpc('Input.dispatchKeyEvent',{type:'keyUp',...fields});
      await poll(()=>desktop.evaluate('!document.fullscreenElement'),'native Escape leaves DOM fullscreen',8);
      const after=await desktop.evaluate('({fullscreen:!!document.fullscreenElement,events:window.preflightState.fullscreenEvents,keys:window.preflightState.keys,click:window.preflightState.clicks.fullscreen})');assert(after.click.trusted&&after.click.activation);assert(after.events.some(e=>e.fullscreen)&&after.events.some(e=>!e.fullscreen));return {entered,after};
    });
    report.network=await main.evaluate('({requests:globalThis.__preflight.requests,blocked:globalThis.__preflight.blocked,permissions:globalThis.__preflight.permissions,policyAttempts:globalThis.__preflight.policyAttempts,errors:globalThis.__preflight.errors})');
    report.rendererErrors=await desktop.evaluate('window.preflightState.errors');
    if(report.network.errors.length||report.rendererErrors.length)report.errors.push('Synthetic application recorded errors: '+JSON.stringify({main:report.network.errors,renderer:report.rendererErrors}));
  } catch(error) {report.errors.push(String(error.stack||error))}
  finally {
    clearTimeout(watchdog);
    try{await closeConnections()}catch(error){report.errors.push('Inspector cleanup: '+error.message)}
    if(child?.pid){
      // The child watches this fresh local file. No inspector command can keep
      // Node's inspector attached while app.quit() waits for disconnection.
      const inspectorsClosed=connections.every(c=>c.ws.readyState===3);
      if(!inspectorsClosed)report.errors.push('Inspector socket did not confirm closed; skip app.quit and terminate only the owned process tree');
      if(shutdownFile&&inspectorsClosed)try{await writeFile(shutdownFile,'quit after inspector closure\n')}catch(error){report.errors.push('Shutdown request: '+error.message)}
      const end=Date.now()+5000;while(child.exitCode===null&&Date.now()<end)await wait(100);
      if(child.exitCode===null){report.cleanup.forcedOwnedProcessTree=true;spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore',timeout:4000})}
      report.cleanup.childPid=child.pid;report.cleanup.childExitCode=child.exitCode;
    }
    report.status=report.errors.length?'failed':'passed';report.finishedAt=new Date().toISOString();report.elapsedMs=Date.now()-started;
    await saveReport();
  }
  assert.equal(report.errors.length,0,'Public-runtime API preflight failed; see smoke-results/api-preflight-report.json: '+report.errors.join(' | '));
  return report;

  // This function is serialized into the synthetic app and has no outer scope.
  function syntheticMain(config) {
    'use strict';
    const E=require('electron'),fs=require('node:fs'),path=require('node:path');
    const {app,BrowserWindow,session}=E;
    app.setName('Allova API Preflight');
    app.setPath('userData',config.profile);app.setPath('sessionData',config.profile);app.setPath('downloads',config.downloads);
    app.enableSandbox();
    const q=globalThis.__preflight={expectedProfile:config.profile,profileSetBeforeSessions:!app.isReady(),ready:false,requests:[],blocked:[],permissions:[],policyAttempts:[],errors:[],targets:[],interceptedSessions:[]};
    process.on('uncaughtException',error=>{q.errors.push(String(error.stack||error));console.error(error)});
    process.on('unhandledRejection',error=>{q.errors.push(String(error?.stack||error));console.error(error)});
    const shutdown=setInterval(()=>{if(fs.existsSync(config.shutdownFile)){clearInterval(shutdown);app.quit()}},100);
    app.on('window-all-closed',()=>app.quit());
    app.whenReady().then(async()=>{
      const ses=session.fromPartition('persist:preflight-primary');
      const ref=session.fromPartition('preflight-reference-'+Date.now());
      const settings={nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,devTools:false};q.constructorPreferences=settings;
      function restrict(s,name,primary=false){
        s.setPermissionRequestHandler((contents,permission,callback,details)=>{
          const allowed=primary&&permission==='fullscreen'&&contents===q.desktopWindow?.webContents&&details?.isMainFrame===true&&new URL(details.requestingUrl).origin===config.origin;
          q.permissions.push({kind:'request',session:name,permission,allowed,details});callback(allowed);
        });
        s.setPermissionCheckHandler((contents,permission,origin,details)=>{
          const allowed=primary&&permission==='fullscreen'&&contents===q.desktopWindow?.webContents&&origin===config.origin&&details?.isMainFrame===true&&new URL(details.requestingUrl).origin===config.origin;
          q.permissions.push({kind:'check',session:name,permission,allowed,origin,details});return allowed;
        });
        s.setDevicePermissionHandler(()=>false);
        s.webRequest.onBeforeRequest((details,callback)=>{
          const u=new URL(details.url);const allowed=primary?(u.protocol==='https:'&&u.origin===config.origin)||(u.protocol==='blob:'&&u.origin===config.origin):u.protocol==='data:';
          if(!allowed)q.blocked.push({session:name,url:details.url,method:details.method});callback({cancel:!allowed});
        });
      }
      restrict(ses,'primary',true);restrict(ref,'reference');restrict(session.defaultSession,'default');
      const html=makeHTML('primary');
      ses.protocol.handle('https',request=>{
        q.requests.push({url:request.url,method:request.method});
        if(request.url!==config.origin+'/preflight.html')return new Response('Synthetic preflight: no route',{status:404});
        return new Response(html,{headers:{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'nonce-"+config.nonce+"'; style-src 'nonce-"+config.nonce+"'; img-src data:; connect-src 'self'; media-src blob:; object-src 'none'; base-uri 'none'"}});
      });q.interceptedSessions.push('persist:preflight-primary');
      function windowFor(s,key){
        const w=new BrowserWindow({width:1008,height:655,useContentSize:true,show:false,webPreferences:{...settings,session:s}});q[key]=w;w.setMenu(null);
        w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-attach-webview',e=>e.preventDefault());
        w.webContents.on('will-navigate',e=>e.preventDefault());return w;
      }
      const w=windowFor(ses,'desktopWindow');
      ses.on('will-download',(event,item,contents)=>{
        // Independent synthetic policy with the same predicates and dialog
        // contract as the candidate. No private packaged source is loaded.
        const row={beforePrevented:event.defaultPrevented,sameWindow:contents===w.webContents,url:item.getURL(),initiator:item.getInitiatorOrigin(),gesture:item.hasUserGesture(),mime:item.getMimeType(),filename:item.getFilename(),state:item.getState(),savePathBefore:item.getSavePath(),dialogConfigured:false};q.policyAttempts.push(row);
        const valid=contents===w.webContents&&item.getURL().startsWith('blob:'+config.origin+'/')&&item.getInitiatorOrigin()===config.origin&&item.hasUserGesture()&&item.getMimeType()==='application/json'&&/^[^/\\\x00-\x1f]+\.json$/i.test(item.getFilename());
        row.valid=valid;
        if(!valid){event.preventDefault();row.afterPrevented=event.defaultPrevented;return}
        item.setSaveDialogOptions({title:'Export Allova save backup',defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename())),filters:[{name:'Allova JSON save',extensions:['json']}],properties:['showOverwriteConfirmation']});row.dialogConfigured=true;row.afterPrevented=event.defaultPrevented;
      });
      const reference=windowFor(ref,'referenceWindow'),defaultWindow=windowFor(session.defaultSession,'defaultWindow');
      const primaryURL=config.origin+'/preflight.html',referenceURL='data:text/html;charset=utf-8,'+encodeURIComponent(makeHTML('reference')),defaultURL='data:text/html;charset=utf-8,'+encodeURIComponent(makeHTML('default'));
      await Promise.all([w.loadURL(primaryURL),reference.loadURL(referenceURL),defaultWindow.loadURL(defaultURL)]);
      q.targets=[{key:'desktopWindow',url:primaryURL},{key:'referenceWindow',url:referenceURL},{key:'defaultWindow',url:defaultURL}];q.ready=true;
    }).catch(error=>{q.errors.push(String(error.stack||error));console.error(error)});
    function makeHTML(marker){
      return '<!doctype html><html><head><meta charset="utf-8"><title>Synthetic API preflight '+marker+'</title><style nonce="'+config.nonce+'">body{margin:0;background:#143b46;color:#fff;font:18px system-ui}main{padding:32px}button,input{font:inherit;margin:10px;padding:12px}#pattern{height:160px;background:repeating-linear-gradient(45deg,#2d9091 0 24px,#204f69 24px 48px)}:fullscreen{background:#143b46}</style></head><body data-preflight="'+marker+'"><main><h1>Synthetic API preflight: '+marker+'</h1><p>Public runtime checks only. This is not the Allova game.</p><div id="pattern"></div><button id="export">Export synthetic JSON</button><button id="bad-mime">Reject plain text</button><button id="audio">Start synthetic tone</button><button id="fullscreen">Fullscreen</button><label>Import synthetic JSON<input id="import-save" type="file" accept=".json"></label></main><script nonce="'+config.nonce+'">('+renderer.toString()+')('+JSON.stringify(config.payload)+');</script></body></html>';
    }
    function renderer(payload){
      const state=window.preflightState={clicks:{},keys:[],fullscreenEvents:[],errors:[]};
      window.addEventListener('error',e=>state.errors.push(String(e.message)));window.addEventListener('unhandledrejection',e=>state.errors.push(String(e.reason)));
      document.addEventListener('keydown',e=>state.keys.push({key:e.key,code:e.code,keyCode:e.keyCode,trusted:e.isTrusted}));
      document.addEventListener('fullscreenchange',()=>state.fullscreenEvents.push({fullscreen:!!document.fullscreenElement,time:performance.now()}));
      window.exportSynthetic=(type)=>{
        const blob=new Blob([JSON.stringify(payload)],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='allova-save.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);return true;
      };
      function action(id,fn){document.getElementById(id).addEventListener('click',e=>{state.clicks[id]={trusted:e.isTrusted,activation:navigator.userActivation.isActive};Promise.resolve(fn()).catch(error=>state.errors.push(String(error)))})}
      action('export',()=>window.exportSynthetic('application/json'));action('bad-mime',()=>window.exportSynthetic('text/plain'));
      action('audio',async()=>{const context=new AudioContext(),oscillator=context.createOscillator(),gain=context.createGain();oscillator.frequency.value=220;gain.gain.value=0.03;oscillator.connect(gain).connect(context.destination);oscillator.start();await context.resume();window.syntheticAudio={context,oscillator,gain};state.audio={state:context.state,sampleRate:context.sampleRate}});
      action('fullscreen',()=>document.documentElement.requestFullscreen());
      document.getElementById('import-save').addEventListener('change',async e=>{try{const f=e.target.files[0];state.imported={name:f.name,bytes:f.size,eventType:e.type,trusted:e.isTrusted,json:JSON.parse(await f.text())}}catch(error){state.errors.push(String(error))}});
      window.decodeSyntheticWave=async()=>{
        const sampleRate=8000,frames=2000,buffer=new ArrayBuffer(44+frames*2),v=new DataView(buffer);const text=(offset,s)=>{for(let i=0;i<s.length;i++)v.setUint8(offset+i,s.charCodeAt(i))};
        text(0,'RIFF');v.setUint32(4,36+frames*2,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sampleRate,true);v.setUint32(28,sampleRate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,frames*2,true);
        for(let i=0;i<frames;i++)v.setInt16(44+i*2,Math.round(Math.sin(i*2*Math.PI*220/sampleRate)*8000),true);
        const context=new OfflineAudioContext(1,frames,sampleRate),decoded=await context.decodeAudioData(buffer);let peak=0;for(const n of decoded.getChannelData(0))peak=Math.max(peak,Math.abs(n));return {channels:decoded.numberOfChannels,sampleRate:decoded.sampleRate,frames:decoded.length,duration:decoded.duration,peak};
      };
    }
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.env.ALLOVA_PREFLIGHT==='1')await runAPIPreflight({CDP,installExportObserver,probeDevToolsDisabled,wait,until});
 else await run();
}

