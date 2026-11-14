import { test, expect, type Page, type Route } from '@playwright/test';
import { createRelayHttpHandler } from '../packages/features/src/relay-http';
import type { RelayAtomicStore, StoreEntry } from '../packages/features/src/relay-adapter';

// This fixture needs a local endpoint-enabled app and intercepted transport. It
// must not run against the ordinary endpoint-unset production/deploy preview.
test.skip(process.env.EIC_LOCAL_RELAY_TEST !== '1', 'Opt-in local memory-backed relay fixture, not deployed Supabase evidence');
test.setTimeout(95000);
async function opts(page: Page) {
 const d=page.locator('details:has(summary:text("Relay options"))');
 if(!(await d.evaluate(el=>(el as HTMLDetailsElement).open))) await d.locator('summary').click();
}
async function create(page: Page, handle: string) {
 await page.addInitScript(() => {
  const shared: string[]=[]; (window as unknown as {__shared:string[]}).__shared=shared;
  Object.defineProperty(navigator,'share',{value:async ({text}:{text:string})=>{shared.push(text)},configurable:true});
  Object.defineProperty(navigator,'connection',{value:{type:'wifi'},configurable:true});
 });
 await page.goto('/'); await page.getByRole('link',{name:'Create or open your vault'}).first().click();
 await page.getByLabel('Passphrase',{exact:true}).fill('local-test-only-vault-20261108');
 await page.getByLabel('Confirm passphrase').fill('local-test-only-vault-20261108');
 await page.getByRole('button',{name:'Create vault'}).click();
 await expect(page.getByRole('navigation',{name:'Main navigation'})).toBeVisible();
 await page.goto('/connections'); await page.getByLabel('Handle').fill(handle); await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.getByText('Handle saved.')).toBeVisible();
}
async function connectLink(page: Page) {
 await page.goto('/connections'); await page.getByRole('button',{name:'Text my connect link'}).click();
 await expect(page.getByText(/Connect link shared/)).toBeVisible();
 return await page.evaluate(()=>(window as unknown as {__shared:string[]}).__shared.at(-1)!.match(/https?:\/\/\S+/)![0]);
}
async function accept(page: Page,link:string) {
 await page.goto(link); await page.getByRole('button',{name:'Add and open chat'}).click(); await expect(page).toHaveURL(/\/chat\//);
}

// In-memory relay with request accounting. Classification is by the action segment
// (publish/read/chunk); `inFlight` lets tests wait for a receive pass to SETTLE instead
// of asserting on counters while a pass is still mid-fetch.
function relayFixture() {
 const rows=new Map<string,StoreEntry>();let generation=0;const keys:string[]=[];
 const store:RelayAtomicStore={
  async get(key){return rows.get(key)??null},
  async compareAndSet(key,data,condition){const old=rows.get(key);if('createOnly'in condition?!!old:old?.generation!==condition.generation)return null;const next=String(++generation);rows.set(key,{data,generation:next});return next},
  async putObject(key,data){const old=rows.get(key);if(old&&old.data!==data)throw Error('immutable');rows.set(key,{data,generation:String(++generation)})},
  async list(prefix,options){return{keys:[...rows.keys()].filter(k=>k.startsWith(prefix)&&(!options?.cursor||k>options.cursor)).sort().slice(0,options?.limit??100)}},
  async delete(key){rows.delete(key)},
 };
 const state={relayRequests:0,inFlight:0,offline:false};
 const counts={read:0,chunk:0,publish:0,other:0};
 const handler=async(route:Route)=>{
  state.relayRequests++;state.inFlight++;
  try{
   const action=(route.request().url().split('/').pop()??'') as keyof typeof counts;
   if(action in counts)counts[action]++;else counts.other++;
   if(state.offline){await route.abort('internetdisconnected');return;}
   const request=route.request();
   // Synthetic test-only admission. This is not the production enrollment design.
   const body=request.postDataJSON();if(body?.pubkey&&!keys.includes(body.pubkey))keys.push(body.pubkey);
   const response=await createRelayHttpHandler(store,{enabled:true,keys:[...keys],origins:['http://localhost:5173'],maxPublishesPerWindow:10,windowMs:60000,now:()=>new Date(body?.ts ?? Date.now())})(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}));
   await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  }finally{state.inFlight--;}
 };
 return {rows,counts,state,handler};
}

// A pass fetches sequentially (read, then chunks), so inFlight can hit 0 between fetches
// of the SAME pass. Settle means: no request in flight for a sustained real-time window.
async function settle(fx: ReturnType<typeof relayFixture>) {
 await expect.poll(async()=>{
  if(fx.state.inFlight!==0)return false;
  await new Promise(r=>setTimeout(r,400));
  return fx.state.inFlight===0;
 },{timeout:15000,intervals:[100,450]}).toBe(true);
}

// With the page clock mocked, a tick suppressed by an in-flight pass reschedules past a
// single fastForward window, so advance in chunks until a receive pass demonstrably
// polls and settles. Only then are the request counters meaningful.
async function advanceUntilPoll(page: Page, fx: ReturnType<typeof relayFixture>) {
 const readsBefore=fx.counts.read;
 for(let i=0;i<6&&fx.counts.read===readsBefore;i++){
  await page.clock.fastForward(70_000);
  await expect.poll(()=>fx.counts.read,{timeout:3000,intervals:[200]}).toBeGreaterThan(readsBefore).catch(()=>{});
 }
 expect(fx.counts.read).toBeGreaterThan(readsBefore);
 await settle(fx);
}

test('local automatic chat: no manual setup or Check steps needed, synthetic admission only',async({browser})=>{
 const aContext=await browser.newContext({viewport:{width:1280,height:900}}),bContext=await browser.newContext({viewport:{width:390,height:844}});
 const a=await aContext.newPage(),b=await bContext.newPage();
 await a.clock.install();await b.clock.install();
 const fx=relayFixture();
 for(const context of[aContext,bContext])await context.route('http://127.0.0.1:54321/**',fx.handler);
 console.log('creating');await create(a,'relay-alice');await create(b,'relay-bob');console.log('created');
 const firstA=await connectLink(a),firstB=await connectLink(b);console.log('cards');
 await accept(a,firstB);await accept(b,firstA);console.log('connected');
 await a.getByLabel('Message',{exact:true}).fill('synthetic desktop to mobile sealed message');await a.getByRole('button',{name:'Send',exact:true}).click();
 await expect(a.getByRole('button',{name:'Text a chat link'})).toHaveCount(0);
 await expect(a.getByText(/Encrypted snapshot committed/)).toBeVisible();console.log('publishedA');
 await b.bringToFront();await b.clock.fastForward(130_000); await expect(b.getByText('synthetic desktop to mobile sealed message',{exact:true})).toBeVisible();console.log('arrivedB');
 await b.getByLabel('Message',{exact:true}).fill('synthetic mobile reply');await b.getByRole('button',{name:'Send',exact:true}).click();
 await expect(b.getByText(/Encrypted snapshot committed/)).toBeVisible();
 await a.bringToFront();await a.clock.fastForward(130_000);await expect(a.getByText('synthetic mobile reply',{exact:true})).toBeVisible();
 // Let the arrival pass settle before pinning the chunk counter: asserting while a pass
 // is still mid-fetch made the old steady-state check vacuous.
 await settle(fx);
 const chunksBefore=fx.counts.chunk;
 await a.bringToFront();
 await advanceUntilPoll(a,fx);
 await expect(a.getByText('synthetic mobile reply',{exact:true})).toHaveCount(1);
 expect(fx.counts.chunk).toBe(chunksBefore);
 expect(JSON.stringify([...fx.rows])).not.toContain('synthetic desktop');expect(JSON.stringify([...fx.rows])).not.toContain('synthetic mobile reply');
 await a.getByRole('button',{name:'Lock',exact:true}).click();
 const before=fx.state.relayRequests; await a.clock.fastForward(180_000);expect(fx.state.relayRequests).toBe(before);
 await aContext.close();await bContext.close();
});

test('two tabs on one chat: the lock loser refreshes when the winner applies (broadcast)',async({browser})=>{
 const friendContext=await browser.newContext({viewport:{width:1280,height:900}});
 const sharedContext=await browser.newContext({viewport:{width:390,height:844}});
 const fx=relayFixture();
 for(const context of[friendContext,sharedContext])await context.route('http://127.0.0.1:54321/**',fx.handler);
 const bob=await friendContext.newPage();await bob.clock.install();
 const tabA=await sharedContext.newPage();
 // tabA deterministically LOSES every catch-up lock acquisition: its ticks never run a
 // pass, so anything it shows after the winner's commit can only come from the applied
 // broadcast - an immediate lock-loss reload would land before the winner writes.
 await tabA.addInitScript(()=>{
  Object.defineProperty(navigator,'locks',{value:{request:async(_name:unknown,_options:unknown,callback:(held:unknown)=>Promise<void>)=>{await callback(null);}},configurable:true});
 });
 console.log('creating');await create(bob,'relay-bob');await create(tabA,'relay-alice');console.log('created');
 const bobLink=await connectLink(bob),aliceLink=await connectLink(tabA);
 await accept(tabA,bobLink);await accept(bob,aliceLink);console.log('connected');
 const chatUrl=tabA.url();
 // Second tab on the SAME vault (same context, shared storage) open on the same chat.
 const tabB=await sharedContext.newPage();await tabB.clock.install();
 await tabB.addInitScript(()=>{Object.defineProperty(navigator,'connection',{value:{type:'wifi'},configurable:true});});
 await tabB.goto(chatUrl);
 const passphrase=tabB.getByLabel('Passphrase',{exact:true});
 await passphrase.waitFor({state:'visible',timeout:3000}).catch(()=>{});
 if(await passphrase.isVisible()){
  await passphrase.fill('local-test-only-vault-20261108');
  await tabB.getByRole('button',{name:'Unlock',exact:true}).click();
 }
 await expect(tabB.getByLabel('Message',{exact:true})).toBeVisible();
 await bob.getByLabel('Message',{exact:true}).fill('sealed cross-tab broadcast message');await bob.getByRole('button',{name:'Send',exact:true}).click();
 await expect(bob.getByText(/Encrypted snapshot committed/)).toBeVisible();console.log('publishedBob');
 // The winner tab applies on its next tick and announces; the loser must refresh from
 // the announcement, exactly once, without ever running a pass itself.
 await tabB.bringToFront();
 await advanceUntilPoll(tabB,fx);
 await expect(tabB.getByText('sealed cross-tab broadcast message',{exact:true})).toBeVisible({timeout:15000});
 await expect(tabA.getByText('sealed cross-tab broadcast message',{exact:true})).toBeVisible();console.log('arrivedLoser');
 await expect(tabB.getByText('sealed cross-tab broadcast message',{exact:true})).toHaveCount(1);
 await expect(tabA.getByText('sealed cross-tab broadcast message',{exact:true})).toHaveCount(1);
 await tabA.bringToFront();await tabA.screenshot({path:'/downloads/eic-auto-crosstab-mobile-loser.png',fullPage:true});
 await friendContext.close();await sharedContext.close();
});
