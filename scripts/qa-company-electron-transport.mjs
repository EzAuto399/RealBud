#!/usr/bin/env node
// Run with ELECTRON_RUN_AS_NODE=1 and the packaged executable. Stock Node's
// TLS results do not establish Electron/BoringSSL compatibility.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.versions.electron, 'Use the Electron executable in Node mode');
const resources = resolve(process.argv[2] || 'dist-server');
const report = process.argv[3];
const { createHostCertificate } = await import(pathToFileURL(join(resources, 'server/company/host-certificate.js')));
const { requestCompanyHost, startCompanyTransport } = await import(pathToFileURL(join(resources, 'server/company/host-transport.js')));
const results = { at: new Date().toISOString(), electron: process.versions.electron, node: process.versions.node, ok: false, checks: [] };
let server;
try {
  const certificate = await createHostCertificate('localhost');
  const wrongCertificate = await createHostCertificate('localhost');
  let requests = 0;
  server = await startCompanyTransport({ host: '127.0.0.1', port: 0, ...certificate, handle: async () => { requests++; return { status: 200, body: { ok: true } }; } });
  const options = { origin: `https://localhost:${server.port}`, certificatePem: certificate.cert, path: '/api/company/status', method: 'GET', timeoutMs: 5000 };
  const response = await requestCompanyHost(options);
  assert.equal(response.status, 200); assert.equal(response.body.ok, true);
  results.checks.push('real Electron accepts the paired non-CA host certificate');
  await assert.rejects(requestCompanyHost({ ...options, certificatePem: wrongCertificate.cert, memberToken: 'synthetic-must-not-arrive' }));
  assert.equal(requests, 1);
  results.checks.push('wrong certificate rejected before any company request');
  await assert.rejects(requestCompanyHost({ ...options, origin: `https://127.0.0.1:${server.port}`, memberToken: 'synthetic-must-not-arrive' }));
  assert.equal(requests, 1);
  results.checks.push('wrong hostname rejected before any company request');
  results.ok = true;
  console.log('PASS Electron pinned company TLS, wrong-certificate denial and wrong-hostname denial');
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(results.error);
} finally {
  await server?.close();
  if (report) writeFileSync(report, JSON.stringify(results, null, 2));
}
