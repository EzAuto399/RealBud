await page.evaluate(() => { location.hash = '#/desk'; }); await page.waitForTimeout(1500);
const more = () => page.locator('main').getByText('More', {exact:true}).first();
const vis = () => page.getByText('Batch prepare', { exact: true }).isVisible();
const out = {};
for (const w of [1280, 390]) {
  await page.setViewportSize({ width: w, height: 844 }); await page.waitForTimeout(600);
  const r = {};
  await more().click(); await page.waitForTimeout(300); r.opened = await vis();
  await page.keyboard.press('Escape'); await page.waitForTimeout(300); r.afterEsc = await vis();
  await more().click(); await page.waitForTimeout(300);
  await page.locator('main h1').first().click(); await page.waitForTimeout(300); r.afterOutside = await vis();
  await more().click(); await page.waitForTimeout(300);
  if (w === 390) await shot('menu-open-390');
  await page.getByText('Activity', {exact:true}).first().click(); await page.waitForTimeout(600); r.afterChoose = await vis();
  // toggle activity back off
  await more().click(); await page.waitForTimeout(200); await page.getByText('Hide activity', {exact:true}).first().click().catch(()=>{}); await page.waitForTimeout(300);
  if (w === 390) await shot('menu-closed-390');
  out[w] = r;
}
await page.setViewportSize({ width: 1440, height: 920 });
return JSON.stringify(out);
