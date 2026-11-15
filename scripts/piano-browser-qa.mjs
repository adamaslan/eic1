import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('apps/web/build/client'), dir=process.env.PIANO_EVIDENCE_DIR || '/tmp/eic-piano-evidence';await mkdir(dir,{recursive:true});
const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.json':'application/json'};
const server=createServer(async(req,res)=>{try{let p=path.join(root,decodeURI(req.url.split('?')[0]));if(!(await stat(p).catch(()=>null))?.isFile())p=path.join(root,'index.html');res.setHeader('Content-Type',mime[path.extname(p)]||'application/octet-stream');res.end(await readFile(p));}catch{res.statusCode=500;res.end('error');}});await new Promise(r=>server.listen(4179,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});const results=[];const errors=[];
function ok(value,label,detail){if(!value)throw new Error(label+' '+JSON.stringify(detail));results.push({test:label,pass:true,detail});}
try{
const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.on('pageerror',e=>errors.push(e.message));
const external=[];page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:4179'))external.push(r.url());});
await page.goto('http://127.0.0.1:4179/learn-piano');await page.getByRole('heading',{name:'Piano, one small phrase at a time.'}).waitFor();
await page.waitForFunction(()=>[...document.querySelectorAll('[style]')].filter(e=>e.style.opacity==='1').length>0);await page.waitForTimeout(250);await page.screenshot({path:dir+'/piano-mobile.png',fullPage:true});
ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'390px no page overflow');
await page.getByRole('button',{name:'Play D3',exact:true}).tap();ok(await page.getByTestId('target-note').innerText()==='C3','Wrong note does not advance');
for(const n of ['C3','F3','G3','A3','C3'])await page.getByRole('button',{name:'Play '+n,exact:true}).tap();
ok((await page.getByTestId('target-note').innerText()).includes('found'),'Touch sequence completes actual lesson');
await page.getByRole('button',{name:'Next drill',exact:false}).tap();ok(await page.getByTestId('target-note').innerText()==='C2','Next drill loads its exact bass octave');
await page.getByRole('button',{name:'Restart phrase'}).tap();
await page.getByRole('radio',{name:'Listen to my piano'}).check();
await page.evaluate(()=>{Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{throw new DOMException('Permission denied','NotAllowedError');}}});});
await page.getByRole('button',{name:'Start listening'}).tap();await page.getByRole('status').filter({hasText:'could not start'}).waitFor();ok(true,'Permission denied displays actionable fallback without advancing');
await page.close();
const micPage=await browser.newPage({viewport:{width:1280,height:900}});micPage.on('pageerror',e=>errors.push(e.message));
await micPage.addInitScript(()=>{
 window.__tone=null;window.__streams=[];
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{
  const c=new AudioContext(),o=c.createOscillator(),g=c.createGain(),d=c.createMediaStreamDestination();o.frequency.value=130.8128;g.gain.value=0;o.connect(g);g.connect(d);o.start();await c.resume();
  window.__tone={set(hz,amp){o.frequency.value=hz;g.gain.value=amp;},context:c};window.__streams.push(d.stream);
  for(const t of d.stream.getTracks()){const stop=t.stop.bind(t);t.stop=()=>{stop();void c.close();};}
  return d.stream;
 }}});
});
await micPage.goto('http://127.0.0.1:4179/learn-piano');await micPage.getByRole('radio',{name:'Listen to my piano'}).check();await micPage.getByRole('button',{name:'Start listening'}).click();await micPage.getByRole('button',{name:'Stop microphone'}).waitFor();
await micPage.evaluate(()=>window.__tone.set(130.8128,0.25));await micPage.getByTestId('target-note').filter({hasText:'F3'}).waitFor({timeout:5000});
ok(true,'Synthetic C3 stream traverses real AudioWorklet + real DSP and advances target to F3');
const timings=[];for(const [hz,next] of [[174.614,'G3'],[195.998,'A3'],[220,'C3']]){const elapsed=await micPage.evaluate(({hz,next})=>new Promise((resolve,reject)=>{const start=performance.now();const node=document.querySelector('[data-testid=target-note]');const observer=new MutationObserver(()=>{if(node.textContent===next){observer.disconnect();clearTimeout(timer);resolve(performance.now()-start);}});observer.observe(node,{childList:true,subtree:true,characterData:true});const timer=setTimeout(()=>{observer.disconnect();reject(Error('no target update'));},5000);window.__tone.set(hz,0.25);}),{hz,next});timings.push(Math.round(elapsed));}results.push({test:'Synthetic input to target-update intervals, not physical latency',detail:timings});
await micPage.waitForTimeout(250);ok(await micPage.getByTestId('target-note').innerText()==='C3','Held microphone note does not complete following target');
await micPage.screenshot({path:dir+'/piano-desktop-mic.png',fullPage:true});
await micPage.getByRole('button',{name:'Stop microphone'}).click();ok(await micPage.evaluate(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),'Stop releases microphone tracks');
await micPage.getByRole('button',{name:'Start listening'}).click();await micPage.getByRole('button',{name:'Stop microphone'}).waitFor();
await micPage.getByRole('link',{name:'EIC home'}).click();await micPage.waitForURL('http://127.0.0.1:4179/');await micPage.waitForFunction(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));ok(await micPage.evaluate(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),'Client navigation releases every microphone track');
await micPage.goto('http://127.0.0.1:4179/learn-piano');await micPage.setViewportSize({width:320,height:800});ok(await micPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'320px no page overflow');await micPage.waitForTimeout(250);await micPage.screenshot({path:dir+'/piano-320.png',fullPage:true});
// Cancellation race: permission can resolve after Stop. The eventual track must close.
const race=await browser.newPage();race.on('pageerror',e=>errors.push(e.message));
await race.addInitScript(()=>{window.__streams=[];Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>new Promise(resolve=>{window.__resolvePermission=()=>{const c=new AudioContext(),d=c.createMediaStreamDestination();const t=d.stream.getTracks()[0],stop=t.stop.bind(t);t.stop=()=>{stop();void c.close();};window.__streams.push(d.stream);resolve(d.stream);};})}});});
await race.goto('http://127.0.0.1:4179/learn-piano');await race.getByRole('radio',{name:'Listen to my piano'}).check();await race.getByRole('button',{name:'Start listening'}).click();await race.waitForFunction(()=>!!window.__resolvePermission);await race.getByRole('button',{name:'Cancel microphone request'}).click();await race.evaluate(()=>window.__resolvePermission());await race.waitForFunction(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));ok(true,'Cancelled permission result stops late-arriving tracks and never starts mic');ok(await race.getByRole('button',{name:'Start listening'}).isVisible(),'Cancel returns to off state');await race.close();
// Real worklet still owns the actual stream; exercise hidden-page and track-ended cleanup.
await micPage.setViewportSize({width:1280,height:900});await micPage.getByRole('radio',{name:'Listen to my piano'}).check();await micPage.getByRole('button',{name:'Start listening'}).click();await micPage.getByRole('button',{name:'Stop microphone'}).waitFor();
await micPage.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});await micPage.waitForFunction(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));ok(true,'Hidden-page event stops all active microphone tracks');await micPage.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,value:false}));
await micPage.getByRole('button',{name:'Start listening'}).click();await micPage.getByRole('button',{name:'Stop microphone'}).waitFor();await micPage.evaluate(()=>{const t=window.__streams.at(-1).getTracks()[0];t.dispatchEvent(new Event('ended'));});await micPage.getByRole('status').filter({hasText:'Microphone disconnected'}).waitFor();ok(await micPage.evaluate(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),'Device-ended event shows fallback and stops tracks');
ok(errors.length===0,'No page runtime errors',errors);ok(external.length===0,'No external requests during touch/denied-mic route',external);
await writeFile(dir+'/results.json',JSON.stringify({results,errors,scope:'Built app, synthetic oscillator MediaStream through real AudioWorklet. Not physical-mic/device latency proof.'},null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();server.close();}
