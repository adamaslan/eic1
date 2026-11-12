import { test, expect, type Page } from '@playwright/test';
import { createRelayHttpHandler } from '../packages/features/src/relay-http';
import type { RelayAtomicStore, StoreEntry } from '../packages/features/src/relay-adapter';

// This fixture needs a local endpoint-enabled app and intercepted transport. It
// must not run against the ordinary endpoint-unset production/deploy preview.
test.skip(process.env.EIC_LOCAL_RELAY_TEST !== '1', 'Opt-in local memory-backed relay fixture, not deployed Supabase evidence');
test.setTimeout(240000);
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
test('local signed relay: two browser vaults exchange ciphertext, manual explicit controls',async({browser})=>{
 const aContext=await browser.newContext({viewport:{width:1280,height:900}}),bContext=await browser.newContext({viewport:{width:390,height:844}});
 const a=await aContext.newPage(),b=await bContext.newPage();
 const rows=new Map<string,StoreEntry>();let generation=0;const keys:string[]=[];
 const store:RelayAtomicStore={
  async get(key){return rows.get(key)??null},
  async compareAndSet(key,data,condition){const old=rows.get(key);if('createOnly'in condition?!!old:old?.generation!==condition.generation)return null;const next=String(++generation);rows.set(key,{data,generation:next});return next},
  async putObject(key,data){const old=rows.get(key);if(old&&old.data!==data)throw Error('immutable');rows.set(key,{data,generation:String(++generation)})},
  async list(prefix,options){return{keys:[...rows.keys()].filter(k=>k.startsWith(prefix)&&(!options?.cursor||k>options.cursor)).sort().slice(0,options?.limit??100)}},
  async delete(key){rows.delete(key)},
 };
 let relayRequests=0; let offline=false;
 for(const context of[aContext,bContext])await context.route('http://127.0.0.1:54321/**',async route=>{
  relayRequests++;
  if(offline){await route.abort("internetdisconnected");return;}
  const request=route.request();const response=await createRelayHttpHandler(store,{enabled:true,keys:[...keys],origins:['http://localhost:5173'],maxPublishesPerWindow:10,windowMs:60000,now:()=>new Date()})(new Request(request.url(),{method:request.method(),headers:request.headers(),body:request.method()==='POST'?request.postData():undefined}));
  await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
 });
 await create(a,'relay-alice');await create(b,'relay-bob');
 const firstA=await connectLink(a),firstB=await connectLink(b);await accept(a,firstB);await accept(b,firstA);
 for(const page of[a,b]){
  await opts(page);await page.getByRole('button',{name:'Set up relay feed'}).click();
  const notice=page.getByText(/Relay feed saved/);await expect(notice).toBeVisible();
  keys.push((await notice.textContent())!.match(/Signing public key: (\S+)\./)![1]);
 }
 expect(relayRequests).toBe(0);
 const finalA=await connectLink(a),finalB=await connectLink(b);await accept(a,finalB);await accept(b,finalA);
 await a.getByLabel('Message',{exact:true}).fill('synthetic desktop to mobile sealed message');await a.getByRole('button',{name:'Send',exact:true}).click();
 await expect(a.getByRole('button',{name:'Text a chat link'})).toHaveCount(0);
 await expect(a.getByText(/Encrypted snapshot committed/)).toBeVisible();
 await opts(b);await b.getByRole('button',{name:'Check for messages'}).click();await expect(b.getByText('synthetic desktop to mobile sealed message',{exact:true})).toBeVisible();
 await b.getByLabel('Message',{exact:true}).fill('synthetic mobile reply');await b.getByRole('button',{name:'Send',exact:true}).click();
 await expect(b.getByText(/Encrypted snapshot committed/)).toBeVisible();
 await opts(a);await a.getByRole('button',{name:'Check for messages'}).click();await expect(a.getByText('synthetic mobile reply',{exact:true})).toBeVisible();
 await opts(a);await a.getByRole('button',{name:'Check for messages'}).click();await expect(a.getByText('synthetic mobile reply',{exact:true})).toHaveCount(1);
 expect(JSON.stringify([...rows])).not.toContain('synthetic desktop');expect(JSON.stringify([...rows])).not.toContain('synthetic mobile reply');
 offline=true;
 await a.getByLabel('Message',{exact:true}).fill('synthetic offline saved message');
 await a.getByRole('button',{name:'Send',exact:true}).click();
 await expect(a.getByText(/Relay confirmation is pending/)).toBeVisible();
 await a.reload(); await expect(a.getByText('synthetic offline saved message',{exact:true})).toBeVisible();
 offline=false;
 await opts(a);await a.getByRole('button',{name:'Retry relay send'}).click();
 await expect(a.getByText(/Encrypted snapshot committed/)).toBeVisible();
 await opts(b);await b.getByRole('button',{name:'Check for messages'}).click();
 await expect(b.getByText('synthetic offline saved message',{exact:true})).toHaveCount(1);
 await a.screenshot({path:'/downloads/eic-relay-local-desktop.png',fullPage:true});await b.screenshot({path:'/downloads/eic-relay-local-mobile.png',fullPage:true});
 await aContext.close();await bContext.close();
});
