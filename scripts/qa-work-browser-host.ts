// macOS native proof using only a disposable profile and synthetic page.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WorkBrowserHost } from '../server/work-browser-host.ts';
import { HermesBrowserTransport } from '../server/hermes-browser-transport.ts';
if (!process.env.PLAYWRIGHT_MODULE || !process.env.REALBUD_QA_OUTPUT) throw new Error('Provide PLAYWRIGHT_MODULE and a fresh REALBUD_QA_OUTPUT directory.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
if (process.platform !== 'darwin') throw new Error('This headed native host fixture requires macOS.');
const root = await realpath(await mkdtemp('/private/tmp/rb-host-'));
const output = resolve(process.env.REALBUD_QA_OUTPUT);
await mkdir(output, { recursive: false });
const host = new WorkBrowserHost({root: join(root, 'host'), bundleRoot: resolve('dist-browser/hermes-native')}, {
  // Disposable QA profiles must never ask to create or unlock a real keychain.
  // Product launches keep their normal OS credential store and unchanged defaults.
  launch: (executable, args, env) => spawn(executable, [...args, '--use-mock-keychain', '--password-store=basic'], { env, stdio: ['ignore', 'ignore', 'pipe'] }),
});
let transport: HermesBrowserTransport | undefined; let browser: any; let failure: unknown; const checks: string[] = []; const cleanupErrors: string[]=[];
try {
  const connected = await host.ensureOpen();
  assert.equal((await host.status()).state, 'ready');
  checks.push('Headed work browser launched from RealBud-owned private profile and admitted matching owned process, CDP file, and loopback browser identity.');
  browser = await chromium.connectOverCDP(connected.endpoint);
  const context = browser.contexts()[0];
  await context.route('https://fictional-invoices.example/**', (route: any) => route.fulfill({contentType:'text/html', body:`<!doctype html><html><head><title>Fictional invoice work browser</title></head><body><header><button>Fictional office menu</button></header><main><h1>Fictional invoices</h1><label>Invoice search <input value="fictional initial"></label><label>Status <select><option>Open</option><option>Paid</option></select></label><table><thead><tr><th>Invoice</th><th>Amount</th></tr></thead><tbody><tr><td>FICTIONAL-001</td><td>100.00</td></tr></tbody></table><nav aria-label="Pagination"><button>Previous page</button><button>Next page</button></nav></main><dialog open aria-label="Fictional confirmation"><p>Review fictional invoice</p><button>Cancel</button></dialog><span hidden>fictional-hidden-marker</span></body></html>`}));
  const page = context.pages()[0]; await page.goto('https://fictional-invoices.example/');
  await context.addCookies([{name:'fictional-session',value:'fictional-cookie',url:'https://fictional-invoices.example',expires:Math.floor(Date.now()/1000)+3600}]);
  transport = new HermesBrowserTransport({root:join(root,'control'),bundle:connected.bundle,endpoint:connected.endpoint});
  await transport.start(); const tabs = await transport.step({kind:'tabs'});
  await writeFile(join(output,'native-tabs.json'),JSON.stringify(tabs,null,2));
  const current = (tabs.tabs as any[]).find(tab=>tab.url==='https://fictional-invoices.example/'); assert(current);
  const snapshot = await transport.step({kind:'read',tab:Number(current.tabId.slice(1))});
  await writeFile(join(output,'native-snapshot.json'),JSON.stringify(snapshot,null,2));
  assert.match(String(snapshot.snapshot),/Fictional invoices/);
  assert.doesNotMatch(String(snapshot.snapshot),/fictional-hidden-marker/);
  checks.push('Byte-admitted native engine attached, listed the owned fictional tab, and returned observed native accessibility snapshot with hidden content omitted.');
  await transport.stop(); assert.equal(page.isClosed(),false);
  await host.disconnect(); assert.equal((await host.status()).state,'disconnected');
  const reopened = await host.ensureOpen(); assert.equal(reopened.profileId,connected.profileId);
  browser=await chromium.connectOverCDP(reopened.endpoint);
  const cookies=await browser.contexts()[0].cookies('https://fictional-invoices.example/');
  assert(cookies.some((cookie:any)=>cookie.name==='fictional-session'&&cookie.value==='fictional-cookie'));
  checks.push('Confirmed native detach kept human work window open; owned browser then closed and reopened with same profile id and saved fictional session cookie.');
} catch(error) { failure=error; }
finally {
  try { await transport?.stop(); } catch(error){cleanupErrors.push(String(error));failure??=error;}
  try { await host.disconnect(); } catch(error){cleanupErrors.push(String(error));failure??=error;}
  try { await rm(root,{recursive:true,force:true}); }catch(error){cleanupErrors.push(String(error));failure??=error;}
}
const receipt={at:new Date().toISOString(),layer:'Native dedicated browser host plus pinned Hermes engine on macOS',result:failure?'failed':'passed',checks,cleanupCompleted:!cleanupErrors.length,cleanupErrors,limits:['Synthetic disposable profile and fictional website only; no customer, REI or personal-browser data.','No real account login, MFA or server-side session-expiry guarantee.','No model turn or invoice write.','No native Windows acceptance.'],...(failure?{error:String(failure)}:{})};
await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));if(failure)throw failure;
