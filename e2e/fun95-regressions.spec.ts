import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
const musicCatalog=JSON.parse(readFileSync(new URL('../apps/web/app/data/music-library.json',import.meta.url),'utf8'));
async function create(p:Page){await p.goto('/');await p.getByRole('link',{name:'Create or open your vault'}).first().click();await p.getByLabel('Passphrase',{exact:true}).fill('synthetic-fun95-regression');await p.getByLabel('Confirm passphrase').fill('synthetic-fun95-regression');await p.getByRole('button',{name:'Create vault'}).click();await expect(p.getByRole('navigation',{name:'Main navigation'})).toBeVisible();}
test('minimize preserves the actual Paint canvas and bitmap',async({page})=>{await create(page);await page.goto('/draw');const c=page.locator('canvas').first();await expect(c).toBeVisible();await c.evaluate(c=>{c.dataset.regression='original';const x=c.getContext('2d')!;x.fillStyle='#123456';x.fillRect(20,20,8,8)});await page.getByRole('button',{name:'Minimize window',exact:true}).first().click();await expect(c).toHaveAttribute('data-regression','original');await expect(c.locator('xpath=ancestor::*[@inert][1]')).toHaveCount(1);await page.getByRole('button',{name:'Restore window',exact:true}).first().click();await expect(c).toBeVisible();expect(await c.evaluate(c=>[...c.getContext('2d')!.getImageData(22,22,1,1).data])).toEqual([18,52,86,255]);});
test('Display modal receives/traps focus, Escape closes and returns trigger',async({page})=>{await create(page);await page.goto('/draw');const trigger=page.getByRole('button',{name:'Display Properties',exact:true});await trigger.click();const dialog=page.getByRole('dialog',{name:'Display Properties'});await expect(dialog).toBeFocused();await page.keyboard.press('Shift+Tab');expect(await page.evaluate(()=>!!document.activeElement?.closest('[role=dialog]'))).toBe(true);await page.keyboard.press('Tab');expect(await page.evaluate(()=>!!document.activeElement?.closest('[role=dialog]'))).toBe(true);await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(trigger).toBeFocused();});
test('Still and OS reduced-motion freeze animated modal previews outside desktop',async({page})=>{await create(page);await page.goto('/draw');await page.getByRole('button',{name:'Display Properties',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('tab',{name:'Desktop',exact:true}).click();const previews=dialog.locator('[class*="w95-wall-"]');expect(await previews.count()).toBeGreaterThan(0);await page.emulateMedia({reducedMotion:'reduce'});expect(await previews.evaluateAll(es=>es.every(e=>getComputedStyle(e).animationName==='none'))).toBe(true);await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>document.documentElement.dataset.motion='off');expect(await previews.evaluateAll(es=>es.every(e=>getComputedStyle(e).animationName==='none'))).toBe(true);});
test('unlocked landing content scales without scaling navigation',async({page})=>{await create(page);await page.goto('/');await page.getByRole('button',{name:'Display Properties',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('tab',{name:'Desktop',exact:true}).click();const slider=dialog.locator('input[type=range]');await slider.fill('1.4');await slider.dispatchEvent('change');await page.keyboard.press('Escape');expect(await page.locator('.w95-zoom').first().evaluate(e=>getComputedStyle(e).zoom)).toBe('1.4');expect(await page.getByRole('navigation',{name:'Main navigation'}).evaluate(e=>getComputedStyle(e).zoom)).toBe('1');});
test('main integration retains unlocked playground and all gallery cards inside desktop zoom', async ({page}) => {
  await create(page);
  await page.goto('/');
  const desktop = page.locator('.w95-zoom').first();
  await expect(desktop.getByRole('region', {name: 'Make yourself a little world'})).toBeVisible();
  await expect(desktop.locator('.eic-feature-card')).toHaveCount(14);
  await expect(desktop.getByRole('link', {name: 'Make something', exact: false})).toBeVisible();
  await expect(desktop.locator('.eic-feature-card').filter({hasText: 'Open your vault to use'})).toHaveCount(0);
});
test('main integration retains all custom-color contrast checks and preset reset hint', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: '🎨 All the knobs'}).click();
  const dialog = page.getByRole('dialog', {name: 'Display Properties'});
  await dialog.getByRole('tab', {name: 'Colors', exact: true}).click();
  for (const label of ['Text on window face', 'Title text on title bar', 'Links on window face']) {
    await expect(dialog.getByText(label, {exact: false})).toBeVisible();
  }
  await expect(dialog.getByText('Picking a preset clears your changes.', {exact: false})).toBeVisible();
});
test('mobile landing keeps content within the viewport at every supported enlarged text scale', async ({page}) => {
  await page.setViewportSize({width:390,height:1100});
  await create(page);
  for (const scale of [1.15,1.4]) {
    await page.getByRole('button',{name:'Display Properties',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Display Properties'});
    await dialog.getByRole('tab',{name:'Desktop',exact:true}).click();
    const slider=dialog.locator('input[type=range]');await slider.fill(String(scale));await slider.dispatchEvent('change');
    await page.keyboard.press('Escape');
    expect(await page.locator('.w95-zoom').first().evaluate(e=>Number(getComputedStyle(e).zoom))).toBe(scale);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    for (const selector of ['.eic-playground h1','.eic-demo-desk','.eic-remix-window']) {
      const box=await page.locator(selector).boundingBox();expect(box).not.toBeNull();expect(box!.x+box!.width).toBeLessThanOrEqual(390);
    }
    await expect(page.getByRole('button',{name:'Vaporwave'})).toBeVisible();
    await expect(page.locator('.eic-feature-card')).toHaveCount(14);
  }
});
test('landing Party toggle has a stable accessible name across all motion states',async({page})=>{
  await page.goto('/');const toggle=page.getByRole('button',{name:'Party mode',exact:true});
  await expect(toggle).toHaveAttribute('aria-pressed','false');await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed','true');await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed','false');
});
test('taskbar keeps nested chat route instead of linking away to Feed',async({page})=>{
  await create(page);await page.goto('/chat/synthetic-counterpart');
  const task=page.locator('footer a[aria-current=page]');
  await expect(task).toHaveAttribute('href','/chat/synthetic-counterpart');await expect(task).toHaveText('Chat');
  await task.click();await expect(page).toHaveURL(/\/chat\/synthetic-counterpart$/);
});
test('landscape Start menu fits viewport and scrolls to every shortcut',async({page})=>{
  await page.setViewportSize({width:600,height:320});await create(page);await page.goto('/feed');
  await page.getByRole('button',{name:'Start',exact:true}).click();const menu=page.locator('#start-menu');
  await expect(menu).toBeVisible();await expect.poll(async()=>Math.round((await menu.boundingBox())!.y)).toBeGreaterThanOrEqual(0);await expect.poll(async()=>{const box=(await menu.boundingBox())!;return Math.round(box.y+box.height)}).toBeLessThanOrEqual(320);
  expect(await menu.evaluate(e=>getComputedStyle(e).overflowY)).toBe('auto');
  await menu.getByRole('link',{name:'Home',exact:true}).scrollIntoViewIfNeeded();await expect(menu.getByRole('link',{name:'Home',exact:true})).toBeInViewport();
  await menu.getByRole('button',{name:'Party mode',exact:false}).scrollIntoViewIfNeeded();await expect(menu.getByRole('button',{name:'Party mode',exact:false})).toBeInViewport();
});
test('Party mode visible label matches stable accessible name and shows state separately',async({page})=>{
  await page.goto('/');const toggle=page.getByRole('button',{name:'Party mode',exact:true});
  for(const state of ['Calm','Party on','Still']){
    await expect(page.getByRole('link',{name:`♫ Press play · ${musicCatalog.length} songs`,exact:true})).toHaveAttribute('href','/music-library');await expect(page.getByText('42b / SIDE A',{exact:true})).toBeVisible();await expect(toggle).toHaveText('Party mode');await expect(page.getByRole('status',{name:'Motion setting'})).toHaveText(state);await toggle.click();
  }
});
test('title contrast checks both gradient endpoints and reports the worse pair',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'🎨 All the knobs'}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('tab',{name:'Colors',exact:true}).click();
  for(const [name,color]of [['Title text','#ffffff'],['Title bar left','#000000'],['Title bar right','#ffffff']]){
    const field=dialog.getByLabel(name,{exact:true});await field.fill(color);
  }
  await expect(dialog.getByLabel('Title text on title bar contrast 1.0 to 1, ⚠️ fails',{exact:true})).toBeVisible();
  await dialog.getByLabel('Title bar left',{exact:false}).fill('#ffffff');await dialog.getByLabel('Title bar right',{exact:false}).fill('#000000');
  await expect(dialog.getByLabel('Title text on title bar contrast 1.0 to 1, ⚠️ fails',{exact:true})).toBeVisible();
});
