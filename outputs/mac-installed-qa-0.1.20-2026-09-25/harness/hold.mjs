import { createServer } from 'node:http';
for (const p of [18799, 28799]) createServer((q, s) => s.end('not realbud')).listen(p, '127.0.0.1');
setTimeout(() => process.exit(0), 90000);
