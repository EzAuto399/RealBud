await page.evaluate(() => { document.body.innerHTML = ''; });
return 'blanked len=' + (await page.evaluate(() => document.body.innerText.length));
