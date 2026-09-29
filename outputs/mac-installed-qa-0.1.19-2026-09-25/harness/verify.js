await page.waitForLoadState('networkidle').catch(()=>{});
await page.waitForTimeout(1500);
const hash = await page.evaluate(()=>location.hash);
const welcome = (await page.locator('body').innerText()).includes('Make the desk yours');
if (!hash.includes('desk')) { await page.getByRole('button', { name: /^Desk/ }).first().click(); await page.waitForTimeout(1200); }
await page.getByRole('button', { name: /^Done · / }).click(); await page.waitForTimeout(800);
const d = await page.locator('main').innerText();
const done = (d.match(/Done · \d+/)||[''])[0];
const marker = d.includes('QA-EDIT-MARKER');
await page.locator('main').getByText('More', {exact:true}).first().click(); await page.waitForTimeout(400);
await page.getByText('Book · import & addresses', {exact:true}).click(); await page.waitForTimeout(1500);
const b = await page.locator('main').innerText();
const count = (b.match(/\d+ properties/)||[''])[0];
const birch = /3 Birch Cl, Watson ACT\n/.test(b);
const fiction = b.includes('77 Fiction Way');
// open options of fiction
const card = page.locator('main *').filter({ hasText: /^77 Fiction Way, Testville ACT/ }).filter({ has: page.getByRole('button', { name: 'Edit options' }) }).last();
await card.getByRole('button', { name: 'Edit options' }).click(); await page.waitForTimeout(600);
const grace = await page.getByLabel('Grace days').inputValue();
const notify = await page.getByLabel('Notify channel').inputValue();
await card.getByRole('button', { name: 'Hide options' }).click().catch(()=>{});
await shot('34-relaunch-persistence');
return JSON.stringify({hash, welcome, done, marker, count, birchListed: birch, fiction, grace, notify});
