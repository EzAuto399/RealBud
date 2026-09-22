import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startCompanyPostgresFixture } from '../../server/company/testing-postgres.ts';
const root = process.cwd(), output = resolve(process.env.COMPANY_TEST_RECEIPT_DIR ?? 'outputs/enterprise-company-2026-09-21');
const pgBin = '/opt/homebrew/opt/postgresql@16/bin';
const temporary = await mkdtemp('/tmp/rbec-');
process.env.TMPDIR = temporary;
const files = process.argv.length > 2 ? process.argv.slice(2) : [
  ...(await readdir('server/company')).filter(name => name.endsWith('.test.ts')).map(name => `server/company/${name}`),
  ...(await readdir('server')).filter(name => /^company.*\.test\.ts$/.test(name)).map(name => `server/${name}`),
];
const started = Date.now(); let fixture, child, code, timer;
await mkdir(output, { recursive: true });
await writeFile(join(output,'tests.log'), 'Disposable PostgreSQL company verification\n');
try {
  fixture = await startCompanyPostgresFixture({ outputDirectory: join(output,'kernel'), postgresBinDirectory: pgBin });
  child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs','run',...files,'--no-file-parallelism','--maxWorkers=1','--reporter=default','--reporter=json',`--outputFile.json=${join(output,'vitest.json')}`], {
    cwd:root, detached:true, env:{PATH:`${resolve('/Users/yoda/.nvm/versions/node/v24.19.0/bin')}:${process.env.PATH??''}`,TMPDIR:temporary,TMP:temporary,TEMP:temporary,LANG:'C.UTF-8',CI:'1',REALBUD_COMPANY_TEST_URL:fixture.adminUrl,REALBUD_TEST_POSTGRES:'1',REALBUD_TEST_POSTGRES_BIN:pgBin},stdio:['ignore','pipe','pipe']
  });
  child.stdout.on('data',b=>appendFileSync(join(output,'tests.log'),b));child.stderr.on('data',b=>appendFileSync(join(output,'tests.log'),b));
  timer=setTimeout(()=>{ try{process.kill(-child.pid,'SIGTERM');}catch{} },240_000);
  code = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exit,signal)=>resolve({exit,signal}));});
  const report=JSON.parse(await readFile(join(output,'vitest.json'),'utf8'));
  const summary={startedAt:new Date(started).toISOString(),elapsedMs:Date.now()-started,postgres:fixture.version,files,exit:code,
    passed:report.numPassedTests,failed:report.numFailedTests,skipped:report.numPendingTests,total:report.numTotalTests,
    proof:'Disposable real PostgreSQL, restricted application role, synthetic agencies; no live customer data or remote deployment'};
  await writeFile(join(output,'result.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
  process.exitCode=code.exit===0&&report.numPendingTests===0?0:1;
} finally { clearTimeout(timer);await fixture?.stop();await rm(temporary,{recursive:true,force:true}); }
