await page.reload(); await page.waitForTimeout(3000);
await page.locator('main').getByText('More', {exact:true}).first().click(); await page.waitForTimeout(300);
await page.getByText('Book · import & addresses', {exact:true}).click(); await page.waitForTimeout(1500);
const body = await page.locator('main').innerText();
await shot('56-low-disk-after-reload');
const arch = body.indexOf('Archived');
return JSON.stringify({ count: (body.match(/\d+ properties/)||[''])[0], mentions: (body.match(/99 Full Disk Pde[^\n]*/g)||[]), archivedSection: arch>=0 ? body.slice(arch, arch+200) : null });
