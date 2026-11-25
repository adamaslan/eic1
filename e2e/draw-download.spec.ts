import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
async function exported(page:Page){
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:/^Download (PNG|JPG)$/}).click()]);
 const path=await download.path();if(!path)throw new Error('missing downloaded image');return readFile(path);
}
for(const format of ['PNG','JPG'])for(const placed of [false,true])test(`${format} download ${placed?'keeps placed':'excludes unplaced'} text`,async({page})=>{
 await page.setViewportSize({width:1280,height:1100});await page.goto('/unlock');await page.getByLabel('Passphrase',{exact:true}).fill('synthetic-paint-export');await page.getByLabel('Confirm passphrase').fill('synthetic-paint-export');await page.getByRole('button',{name:'Create vault'}).click();await expect(page.getByRole('navigation',{name:'Main navigation'})).toBeVisible();await page.goto('/draw');
 await page.getByRole('radio',{name:new RegExp('^'+format)}).check();
 const canvas=page.locator('canvas').first();await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();if(!box)throw new Error('no canvas');await page.mouse.move(box.x+30,box.y+40);await page.mouse.down();await page.mouse.move(box.x+65,box.y+65,{steps:5});await page.mouse.up();
 const baseline=await exported(page);
 await page.getByRole('button',{name:'Text',exact:true}).click();await canvas.click({position:{x:45,y:120}});await page.getByLabel('Text to place').fill('NOT PLACED');
 const preview=await canvas.evaluate((c:HTMLCanvasElement)=>c.toDataURL());
 if(placed)await page.getByRole('button',{name:'Place text',exact:true}).click();
 const bytes=await exported(page);
 if(placed)expect(bytes.equals(baseline)).toBe(false);else expect(bytes.equals(baseline)).toBe(true);
 // Decode the actual downloaded bytes in the browser, not a DOM proxy.
 const decoded=await page.evaluate(async(url)=>{const img=new Image();img.src=url;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d')!;ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;let ink=0;for(let i=0;i<data.length;i+=4)if(data[i]<200||data[i+1]<200||data[i+2]<200)ink++;return {w:img.naturalWidth,h:img.naturalHeight,ink};},`data:image/${format==='PNG'?'png':'jpeg'};base64,${bytes.toString('base64')}`);expect(decoded.w).toBe(192);expect(decoded.h).toBe(192);expect(decoded.ink).toBeGreaterThan(40);
 if(!placed)expect(await canvas.evaluate((c:HTMLCanvasElement)=>c.toDataURL())).not.toBe(preview);
 if(process.env.EIC_EXPECTED_BUILD)await expect(page.locator('body')).toContainText(process.env.EIC_EXPECTED_BUILD);
 if(process.env.EIC_EVIDENCE_DIR&&format==='PNG'&&!placed){await page.evaluate((url)=>{const n=document.createElement('div');n.style.cssText='background:white;color:black;border:3px solid blue;padding:8px';n.textContent=`SYNTHETIC PAINT DOWNLOAD CHECK | ${location.hostname} | unplaced text excluded from actual downloaded PNG; committed brush pixels preserved`;const img=new Image();img.src=url;img.alt='Decoded actual downloaded PNG, brush dots without unplaced text';img.style.cssText='display:block;width:192px;height:192px;border:1px solid black';n.append(img);document.body.append(n);},`data:image/png;base64,${bytes.toString('base64')}`);await page.screenshot({path:`${process.env.EIC_EVIDENCE_DIR}/eic140-${process.env.EIC_PRODUCTION?'production':'preview'}.png`,fullPage:true,animations:'disabled'});}
});
